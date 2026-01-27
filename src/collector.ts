import { Page } from 'playwright';
import { createPage, closeBrowser } from './browser';
import { getActiveExchangers, insertWallet, insertAttempt, getExchangerByDomain } from './db';
import { config, randomDelay, sleep } from './config';
import { getAdapter } from './adapters';
import { CryptoPair, Exchanger } from './types';
import { logger } from './logger';
import { notifySuccess, notifyError } from './telegram';
import fs from 'fs';

// Default pairs to try
const DEFAULT_PAIRS: CryptoPair[] = [
  { from: 'USDT', to: 'BTC', network: 'TRC20' },
  { from: 'BTC', to: 'USDT', network: 'BTC' },
  { from: 'ETH', to: 'USDT', network: 'ERC20' }
];

export async function collectFromExchanger(
  exchanger: Exchanger,
  pairs: CryptoPair[] = DEFAULT_PAIRS
): Promise<{ success: number; failed: number }> {
  const adapter = getAdapter(exchanger.domain);
  let success = 0;
  let failed = 0;

  if (!adapter) {
    logger.warn(`No adapter for ${exchanger.domain}, skipping`);
    return { success, failed };
  }

  for (const pair of pairs) {
    let page: Page | null = null;

    try {
      logger.info(`[${exchanger.name}] Collecting ${pair.from}->${pair.to} (${pair.network})`);

      page = await createPage();
      const result = await adapter.collect(page, pair);

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
