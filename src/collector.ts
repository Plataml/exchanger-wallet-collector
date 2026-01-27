import { Page } from 'playwright';
import { createPage, closeBrowser, takeScreenshot } from './browser';
import { getActiveExchangers, insertWallet, insertAttempt, getExchangerByDomain } from './db';
import { config, randomDelay, sleep } from './config';
import fs from 'fs';

export interface CryptoPair {
  from: string;
  to: string;
  network: string;
}

export interface CollectResult {
  address: string;
  network: string;
  screenshotPath: string;
}

export interface ExchangerAdapter {
  name: string;
  domain: string;
  collect(page: Page, pair: CryptoPair): Promise<CollectResult>;
}

// Default pairs to try
const DEFAULT_PAIRS: CryptoPair[] = [
  { from: 'USDT', to: 'BTC', network: 'TRC20' },
  { from: 'BTC', to: 'USDT', network: 'BTC' },
  { from: 'ETH', to: 'USDT', network: 'ERC20' }
];

// Registry for adapters
const adapters: Map<string, ExchangerAdapter> = new Map();

export function registerAdapter(adapter: ExchangerAdapter): void {
  adapters.set(adapter.domain, adapter);
}

export function getAdapter(domain: string): ExchangerAdapter | undefined {
  return adapters.get(domain);
}

export async function collectFromExchanger(
  exchanger: { id: number; name: string; domain: string },
  pairs: CryptoPair[] = DEFAULT_PAIRS
): Promise<void> {
  const adapter = getAdapter(exchanger.domain);

  if (!adapter) {
    console.log(`[SKIP] No adapter for ${exchanger.domain}`);
    return;
  }

  for (const pair of pairs) {
    let page: Page | null = null;

    try {
      console.log(`[${exchanger.name}] Collecting ${pair.from}-${pair.to} (${pair.network})`);

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
      console.log(`[${exchanger.name}] Success: ${result.address}`);

    } catch (error: any) {
      const errorMsg = error.message || String(error);
      const status = errorMsg.includes('captcha') ? 'captcha' :
                     errorMsg.includes('blocked') ? 'blocked' : 'failed';

      insertAttempt(exchanger.id, `${pair.from}-${pair.to}`, status, errorMsg);
      console.error(`[${exchanger.name}] ${status}: ${errorMsg}`);

    } finally {
      if (page) {
        await page.context().close();
      }
    }

    // Delay between pairs
    const delay = randomDelay();
    console.log(`[DELAY] Waiting ${Math.round(delay / 1000)}s...`);
    await sleep(delay);
  }
}

export async function runCollector(targetDomain?: string): Promise<void> {
  // Ensure screenshots directory exists
  if (!fs.existsSync(config.screenshotsPath)) {
    fs.mkdirSync(config.screenshotsPath, { recursive: true });
  }

  try {
    let exchangers;

    if (targetDomain) {
      const exchanger = getExchangerByDomain(targetDomain);
      exchangers = exchanger ? [exchanger] : [];
    } else {
      exchangers = getActiveExchangers();
    }

    if (exchangers.length === 0) {
      console.log('No exchangers to process');
      return;
    }

    console.log(`Processing ${exchangers.length} exchanger(s)...`);

    for (const exchanger of exchangers as any[]) {
      await collectFromExchanger(exchanger);

      // Delay between exchangers
      const delay = randomDelay();
      console.log(`[DELAY] Waiting ${Math.round(delay / 1000)}s before next exchanger...`);
      await sleep(delay);
    }

  } finally {
    await closeBrowser();
  }

  console.log('Collection complete');
}
