import { Page } from 'playwright';
import { EngineType } from './detector';

export interface ExchangeFormData {
  fromCurrency: string;
  toCurrency: string;
  amount: number;
  wallet: string;
  email: string;
  // Optional extra fields
  cardNumber?: string;
  phone?: string;
  name?: string;
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
        const elements = document.querySelectorAll(selector);
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
