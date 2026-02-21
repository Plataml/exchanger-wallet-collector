import { Page } from 'playwright';
import { createPage, closeBrowser, clearBrowserStorage } from './browser';
import { getActiveExchangers, insertWallet, insertAttempt, getExchangerByDomain } from './db';
import { config, randomDelay, sleep } from './config';
import { getAdapter } from './adapters';
import { smartCollect, initEngines, ExchangeFormData } from './engines';
import { CryptoPair, Exchanger } from './types';
import { logger } from './logger';
import { notifySuccess, notifyError } from './telegram';
import { AmountDetector } from './utils/amount-detector';
import fs from 'fs';

// Initialize engine system
let enginesInitialized = false;

// Default pairs to try - CRYPTO -> FIAT direction to get deposit addresses
// We send crypto, receive fiat - this shows us the deposit address for crypto
const DEFAULT_PAIRS: CryptoPair[] = [
  { from: 'BTC', to: 'SBPRUB', network: 'BTC' },       // BTC -> Сбербанк RUB
  { from: 'USDTTRC20', to: 'SBPRUB', network: 'TRC20' }, // USDT TRC20 -> Сбербанк RUB
  { from: 'ETH', to: 'SBPRUB', network: 'ERC20' }     // ETH -> Сбербанк RUB
];

// Alternative pairs for RU exchangers
const RU_PAIRS: CryptoPair[] = [
  { from: 'BTC', to: 'SBPRUB', network: 'BTC' },      // BTC -> СБП RUB
  { from: 'USDTTRC20', to: 'SBPRUB', network: 'TRC20' }, // USDT TRC20 -> СБП RUB
  { from: 'ETH', to: 'SBPRUB', network: 'ERC20' }     // ETH -> СБП RUB
];

export async function collectFromExchanger(
  exchanger: Exchanger,
  pairs: CryptoPair[] = DEFAULT_PAIRS
): Promise<{ success: number; failed: number }> {
  const adapter = getAdapter(exchanger.domain);
  let success = 0;
  let failed = 0;

  // Initialize engines if needed
  if (!enginesInitialized) {
    initEngines();
    enginesInitialized = true;
  }

  for (const pair of pairs) {
    let page: Page | null = null;

    try {
      logger.info(`[${exchanger.name}] Collecting ${pair.from}->${pair.to} (${pair.network})`);

      page = await createPage();
      await clearBrowserStorage(page);

      let result: { address: string; network: string; screenshotPath: string };

      // Try adapter first if available
      if (adapter) {
        result = await adapter.collect(page, pair);
      } else {
        // Use smart engine system
        logger.info(`[${exchanger.name}] No adapter, using smart engine`);

        // Navigate to exchanger with proper URL parameters for exchange direction
        // For 365cash.co style: ?from=BTC&to=SBPRUB
        const exchangeUrl = buildExchangeUrl(exchanger.domain, pair.from, pair.to);
        logger.info(`Navigating to: ${exchangeUrl}`);
        await page.goto(exchangeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000); // Wait for JS to initialize

        // Prepare form data
        // For Crypto -> Fiat: we provide phone/bank to receive fiat
        // The exchanger will show us the crypto deposit address
        const isCryptoToFiat = pair.to.includes('RUB') || pair.to.includes('UAH');

        // Detect minimum amount dynamically instead of using hardcoded values
        let amount: number;
        if (isCryptoToFiat) {
          const detector = new AmountDetector(page);
          const detected = await detector.detectMinimum(pair.from, pair.to, getAmountForCrypto(pair.from));
          amount = detected.amount;
          logger.info(`Amount for ${pair.from}: ${amount} (method: ${detected.method}, confidence: ${(detected.confidence * 100).toFixed(0)}%)`);
        } else {
          amount = config.formAmount || 1000;
        }

        const formData: ExchangeFormData = {
          fromCurrency: pair.from,
          toCurrency: pair.to,
          amount,
          wallet: isCryptoToFiat ? (config.formPhone || '+79261234567') : getWalletForCurrency(pair.to),
          email: config.formEmail,
          phone: config.formPhone || '+79261234567',
          bank: 'Сбербанк RUB'
        };

        // Try smart collection
        const engineResult = await smartCollect(page, exchanger.domain, formData);

        if (!engineResult.success) {
          throw new Error(engineResult.error || 'Smart collection failed');
        }

        // Take screenshot
        const screenshotPath = `${config.screenshotsPath}/${exchanger.domain}_${pair.from}_${pair.to}_${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });

        result = {
          address: engineResult.address!,
          network: engineResult.network || pair.network,
          screenshotPath
        };

        logger.info(`[${exchanger.name}] Engine: ${engineResult.engineUsed}`);
      }

      insertWallet(
        exchanger.id,
        `${pair.from}-${pair.to}`,
        result.network,
        result.address,
        result.screenshotPath
      );

      insertAttempt(exchanger.id, `${pair.from}-${pair.to}`, 'success');
      logger.info(`[${exchanger.name}] Success: ${result.address}`);

      // Telegram notification
      await notifySuccess(exchanger.name, result.address, `${pair.from}->${pair.to}`);
      success++;

    } catch (error: any) {
      const errorMsg = error.message || String(error);
      const status = errorMsg.toLowerCase().includes('captcha') ? 'captcha' :
                     errorMsg.toLowerCase().includes('blocked') ? 'blocked' : 'failed';

      insertAttempt(exchanger.id, `${pair.from}-${pair.to}`, status, errorMsg);
      logger.error(`[${exchanger.name}] ${status}: ${errorMsg}`);

      // Telegram notification only for critical errors
      if (status === 'blocked') {
        await notifyError(exchanger.name, errorMsg);
      }
      failed++;

    } finally {
      if (page) {
        await page.context().close();
      }
    }

    // Delay between pairs
    const delay = randomDelay();
    logger.info(`Waiting ${Math.round(delay / 1000)}s before next pair...`);
    await sleep(delay);
  }

  return { success, failed };
}

// Helper to get wallet address for a currency
function getWalletForCurrency(currency: string): string {
  const wallets: Record<string, string> = {
    'BTC': config.formWalletBTC || 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    'ETH': config.formWalletETH || '0x742d35Cc6634C0532925a3b844Bc9e7595f5bE12',
    'USDT': config.formWalletUSDT || 'TN2DKuFEQz3mVsXVL4kAkGzFwfpVNvP8Ep',
    'LTC': 'ltc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
  };
  return wallets[currency] || wallets['USDT'];
}

// Build URL with exchange direction parameters
function buildExchangeUrl(domain: string, fromCurrency: string, toCurrency: string): string {
  // Most exchangers support URL parameters for pre-selecting exchange direction
  // Common formats:
  // - ?from=BTC&to=SBPRUB (365cash.co style)
  // - ?send=BTC&receive=RUB
  // - /exchange/btc-to-rub

  // Default to query parameter style (most common for Vue SPA exchangers)
  return `https://${domain}/?from=${fromCurrency}&to=${toCurrency}`;
}

// Helper to get minimum amount for crypto (for Crypto -> Fiat exchanges)
// Note: Many exchangers have minimum ~50000 RUB, so amounts should be higher
function getAmountForCrypto(currency: string): number {
  const amounts: Record<string, number> = {
    'BTC': 0.01,           // ~$1000 at $100k/BTC - meets most minimums
    'ETH': 0.3,            // ~$1000 at $3.3k/ETH
    'USDTTRC20': 1000,     // 1000 USDT - meets 50000 RUB minimum
    'USDTERC20': 1000,
    'USDT': 1000,
    'LTC': 5               // ~$500 at $100/LTC
  };
  return amounts[currency] || 1000;
}

export async function runCollector(targetDomain?: string): Promise<void> {
  // Ensure directories exist
  if (!fs.existsSync(config.screenshotsPath)) {
    fs.mkdirSync(config.screenshotsPath, { recursive: true });
  }

  let totalSuccess = 0;
  let totalFailed = 0;

  try {
    let exchangers: Exchanger[];

    if (targetDomain) {
      const exchanger = getExchangerByDomain(targetDomain) as Exchanger | undefined;
      exchangers = exchanger ? [exchanger] : [];
      if (!exchanger) {
        logger.warn(`Exchanger not found: ${targetDomain}`);
      }
    } else {
      exchangers = getActiveExchangers() as Exchanger[];
    }

    if (exchangers.length === 0) {
      logger.info('No exchangers to process');
      return;
    }

    logger.info(`Processing ${exchangers.length} exchanger(s)...`);

    for (const exchanger of exchangers) {
      const { success, failed } = await collectFromExchanger(exchanger);
      totalSuccess += success;
      totalFailed += failed;

      // Delay between exchangers
      const delay = randomDelay();
      logger.info(`Waiting ${Math.round(delay / 1000)}s before next exchanger...`);
      await sleep(delay);
    }

  } finally {
    await closeBrowser();
  }

  logger.info(`Collection cycle complete. Success: ${totalSuccess}, Failed: ${totalFailed}`);
}
