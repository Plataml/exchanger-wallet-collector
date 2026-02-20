import { Page, Frame } from 'playwright';
import { EngineType } from './detector';
import { NetworkInterceptor, InterceptedAddress } from '../utils/network-interceptor';
import { logger } from '../logger';

export interface ExchangeFormData {
  fromCurrency: string;
  toCurrency: string;
  amount: number;
  wallet: string;       // Crypto wallet OR phone number for fiat
  email: string;
  // Optional extra fields
  cardNumber?: string;
  phone?: string;       // Phone number for СБП transfers
  name?: string;
  bank?: string;        // Bank name for fiat transfers
}

export interface CollectionResult {
  success: boolean;
  address?: string;
  network?: string;
  memo?: string;
  screenshot?: string;
  error?: string;
  // For learning
  selectors?: Record<string, string>;
}

export abstract class BaseEngine {
  abstract type: EngineType;
  abstract name: string;

  // Check if this engine can handle the page
  abstract canHandle(page: Page): Promise<boolean>;

  // Fill the exchange form and submit to get deposit address
  abstract collectAddress(page: Page, data: ExchangeFormData): Promise<CollectionResult>;

  // Extract deposit address from result page
  protected async extractAddress(page: Page): Promise<{ address?: string; network?: string; memo?: string }> {
    return page.evaluate(() => {
      const result: { address?: string; network?: string; memo?: string } = {};

      // Common patterns for crypto addresses
      const addressPatterns = [
        // Bitcoin
        /\b(bc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
        /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,
        // Ethereum/ERC20
        /\b(0x[a-fA-F0-9]{40})\b/,
        // Tron/TRC20
        /\b(T[a-zA-Z0-9]{33})\b/,
        // Litecoin
        /\b([LM][a-km-zA-HJ-NP-Z1-9]{26,33})\b/,
        /\b(ltc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
        // Ripple
        /\b(r[0-9a-zA-Z]{24,34})\b/,
      ];

      // Try common selectors first
      const addressSelectors = [
        '[data-copy], [data-clipboard-text]',
        '.wallet-address, .crypto-address, .deposit-address',
        '[class*="address"], [class*="wallet"]',
        'input[readonly][value*="0x"], input[readonly][value*="bc1"], input[readonly][value*="T"]',
        '.monospace, .mono, code'
      ];

      for (const selector of addressSelectors) {
        const elements = Array.from(document.querySelectorAll(selector));
        for (const el of elements) {
          const text = (el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('data-clipboard-text') || '';
          for (const pattern of addressPatterns) {
            const match = text.match(pattern);
            if (match) {
              result.address = match[1];
              break;
            }
          }
          if (result.address) break;
        }
        if (result.address) break;
      }

      // If not found by selectors, scan page text
      if (!result.address) {
        const bodyText = document.body.innerText;
        for (const pattern of addressPatterns) {
          const match = bodyText.match(pattern);
          if (match) {
            result.address = match[1];
            break;
          }
        }
      }

      // Try to find memo/tag (for XRP, XLM, etc.)
      const memoSelectors = ['[class*="memo"], [class*="tag"], [class*="destination"]'];
      for (const selector of memoSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const text = (el as HTMLElement).innerText || (el as HTMLInputElement).value;
          if (text && /^\d+$/.test(text.trim())) {
            result.memo = text.trim();
            break;
          }
        }
      }

      return result;
    });
  }

  // Create a network interceptor for the page
  protected createInterceptor(page: Page): NetworkInterceptor {
    return new NetworkInterceptor(page);
  }

  // Search for addresses inside iframes (payment gateways)
  protected async extractAddressFromFrames(page: Page): Promise<{ address?: string; network?: string; memo?: string }> {
    const frames = page.frames();
    const FRAME_URL_KEYWORDS = ['checkout', 'pay', 'invoice', 'gateway', 'payment', 'deposit', 'wallet', 'order', 'crypto'];
    const FRAME_CONTENT_KEYWORDS = ['bitcoin', 'ethereum', 'tether', 'usdt', 'btc', 'eth', 'wallet', 'address', 'deposit', 'кошелёк', 'адрес'];

    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;

      const frameUrl = frame.url().toLowerCase();
      const isRelevantUrl = FRAME_URL_KEYWORDS.some(kw => frameUrl.includes(kw));

      if (!isRelevantUrl) {
        try {
          const hasContent = await frame.evaluate((keywords: string[]) => {
            const text = document.body?.innerText?.toLowerCase() || '';
            return keywords.some(kw => text.includes(kw));
          }, FRAME_CONTENT_KEYWORDS);
          if (!hasContent) continue;
        } catch {
          continue;
        }
      }

      try {
        const result = await frame.evaluate(() => {
          const res: { address?: string; network?: string; memo?: string } = {};
          const patterns = [
            /\b(bc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
            /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,
            /\b(0x[a-fA-F0-9]{40})\b/,
            /\b(T[a-zA-Z0-9]{33})\b/,
            /\b([LM][a-km-zA-HJ-NP-Z1-9]{26,33})\b/,
            /\b(ltc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
            /\b(r[0-9a-zA-Z]{24,34})\b/,
          ];
          const selectors = [
            '[data-clipboard-text]', '[data-copy]',
            '.wallet-address, .crypto-address, .deposit-address',
            'input[readonly]', '.address-text', '[class*="address"]',
          ];

          for (const sel of selectors) {
            const elements = Array.from(document.querySelectorAll(sel));
            for (const el of elements) {
              const text = (el as HTMLElement).getAttribute('data-clipboard-text') ||
                          (el as HTMLInputElement).value ||
                          (el as HTMLElement).innerText || '';
              for (const p of patterns) {
                const m = text.match(p);
                if (m) { res.address = m[1]; break; }
              }
              if (res.address) break;
            }
            if (res.address) break;
          }

          if (!res.address) {
            const bodyText = document.body?.innerText || '';
            for (const p of patterns) {
              const m = bodyText.match(p);
              if (m) { res.address = m[1]; break; }
            }
          }

          if (res.address) {
            if (res.address.startsWith('bc1') || res.address.startsWith('1') || res.address.startsWith('3')) res.network = 'BTC';
            else if (res.address.startsWith('T')) res.network = 'TRC20';
            else if (res.address.startsWith('0x')) res.network = 'ERC20';
            else if (res.address.startsWith('L') || res.address.startsWith('ltc1')) res.network = 'LTC';
          }

          return res;
        });

        if (result.address) {
          logger.info(`Found address in iframe: ${frame.url()}`);
          return result;
        }
      } catch {
        continue;
      }
    }

    return {};
  }

  // Enhanced address extraction: DOM -> Iframe -> Network API (cascading strategy)
  protected async extractAddressEnhanced(
    page: Page,
    interceptor?: NetworkInterceptor
  ): Promise<{ address?: string; network?: string; memo?: string; source?: string }> {
    // Level 1: DOM extraction (existing method)
    const domResult = await this.extractAddress(page);
    if (domResult.address) {
      return { ...domResult, source: 'dom' };
    }

    // Level 2: Iframe extraction
    const iframeResult = await this.extractAddressFromFrames(page);
    if (iframeResult.address) {
      return { ...iframeResult, source: 'iframe' };
    }

    // Level 3: Network interception
    if (interceptor) {
      const networkResult = interceptor.getBestAddress();
      if (networkResult) {
        return {
          address: networkResult.address,
          network: networkResult.network,
          memo: networkResult.memo,
          source: networkResult.source,
        };
      }
    }

    return {};
  }

  // Wait for form to be ready
  protected async waitForForm(page: Page, timeout = 10000): Promise<boolean> {
    try {
      await page.waitForSelector('form, [class*="exchange"], [class*="calculator"]', { timeout });
      return true;
    } catch {
      return false;
    }
  }

  // Smart field filling with multiple selector attempts
  protected async fillField(page: Page, selectors: string[], value: string): Promise<boolean> {
    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          await element.fill(value);
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  // Click element with fallbacks
  protected async clickElement(page: Page, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          await element.click();
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }
}
