import { Page } from 'playwright';

export interface ExtractedAddress {
  address?: string;
  network?: string;
  memo?: string;
}

const ADDRESS_PATTERNS = [
  /\b(bc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,           // BTC Bech32
  /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,       // BTC Legacy
  /\b(0x[a-fA-F0-9]{40})\b/,                      // ETH/ERC20
  /\b(T[a-zA-Z0-9]{33})\b/,                       // TRC20
  /\b([LM][a-km-zA-HJ-NP-Z1-9]{26,33})\b/,       // LTC Legacy
  /\b(ltc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,          // LTC Bech32
];

/**
 * Extract deposit address from payment page
 */
export async function extractDepositAddress(page: Page): Promise<ExtractedAddress> {
  await page.waitForTimeout(2000);

  return page.evaluate((patterns: string[]) => {
    const result: ExtractedAddress = {};
    const addressPatterns = patterns.map(p => new RegExp(p));

    // Look in copy buttons first
    const copySelectors = [
      '[data-clipboard-text]',
      '.copy-address',
      '.wallet-address',
      '.crypto-address',
      'input[readonly]',
      '.address-text',
      '[class*="address"]'
    ];

    for (const selector of copySelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of Array.from(elements)) {
        const text = (el as HTMLElement).getAttribute('data-clipboard-text') ||
                    (el as HTMLInputElement).value ||
                    (el as HTMLElement).innerText;
        for (const pattern of addressPatterns) {
          const match = text?.match(pattern);
          if (match) {
            result.address = match[1];
            break;
          }
        }
        if (result.address) break;
      }
      if (result.address) break;
    }

    // Fallback: scan all text
    if (!result.address) {
      const bodyText = document.body?.innerText || '';
      for (const pattern of addressPatterns) {
        const match = bodyText.match(pattern);
        if (match) {
          result.address = match[1];
          break;
        }
      }
    }

    // Detect network
    if (result.address) {
      if (result.address.startsWith('bc1') || result.address.startsWith('1') || result.address.startsWith('3')) {
        result.network = 'BTC';
      } else if (result.address.startsWith('T')) {
        result.network = 'TRC20';
      } else if (result.address.startsWith('0x')) {
        result.network = 'ERC20';
      } else if (result.address.startsWith('L') || result.address.startsWith('M') || result.address.startsWith('ltc1')) {
        result.network = 'LTC';
      }
    }

    return result;
  }, ADDRESS_PATTERNS.map(p => p.source));
}
