import { Page } from 'playwright';
import { logger } from '../logger';

// In-memory cache for detected minimums
const amountCache = new Map<string, { amount: number; detectedAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export interface DetectionResult {
  amount: number;
  method: 'api' | 'validation' | 'html-attr' | 'ladder' | 'fallback';
  confidence: number;
}

const MIN_AMOUNT_KEYS = [
  'min_amount', 'minimum', 'min_sum', 'min', 'minAmount',
  'minimum_amount', 'min_value', 'from_min', 'amount_min',
];

const AMOUNT_INPUT_SELECTORS = [
  'input[name="sum1"]', 'input[name="sum"]', 'input[name="amount"]',
  'input.js_summ1', 'input[name="give_amount"]',
  '.give-amount input', '.amount-from input',
  'input[placeholder*="BTC"]', 'input[placeholder*="ETH"]',
  'input[placeholder*="USDT"]', 'input[placeholder*="сумм"]',
  'input[placeholder*="amount"]',
];

export class AmountDetector {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async detectMinimum(
    fromCurrency: string,
    toCurrency: string,
    fallbackAmount: number
  ): Promise<DetectionResult> {
    const cacheKey = `${this.getDomain()}:${fromCurrency}:${toCurrency}`;

    // Check cache
    const cached = amountCache.get(cacheKey);
    if (cached && Date.now() - cached.detectedAt < CACHE_TTL) {
      logger.info(`AmountDetector: cached amount ${cached.amount} for ${cacheKey}`);
      return { amount: cached.amount, method: 'fallback', confidence: 0.9 };
    }

    // Level 1: API interception (listen for exchange info responses)
    const apiResult = await this.detectFromApi();
    if (apiResult) {
      const amount = this.addMargin(apiResult);
      this.cacheResult(cacheKey, amount);
      logger.info(`AmountDetector: API detected min=${apiResult}, using ${amount}`);
      return { amount, method: 'api', confidence: 0.95 };
    }

    // Level 2: HTML attributes (placeholder, min)
    const htmlResult = await this.detectFromHtmlAttrs();
    if (htmlResult) {
      const amount = this.addMargin(htmlResult);
      this.cacheResult(cacheKey, amount);
      logger.info(`AmountDetector: HTML attr detected min=${htmlResult}, using ${amount}`);
      return { amount, method: 'html-attr', confidence: 0.7 };
    }

    // Level 3: UI validation parsing (enter tiny amount, read error)
    const validationResult = await this.detectFromValidation();
    if (validationResult) {
      const amount = this.addMargin(validationResult);
      this.cacheResult(cacheKey, amount);
      logger.info(`AmountDetector: validation detected min=${validationResult}, using ${amount}`);
      return { amount, method: 'validation', confidence: 0.85 };
    }

    // Level 4: Ladder method
    const ladderResult = await this.detectByLadder(fromCurrency);
    if (ladderResult) {
      const amount = this.addMargin(ladderResult);
      this.cacheResult(cacheKey, amount);
      logger.info(`AmountDetector: ladder detected min=${ladderResult}, using ${amount}`);
      return { amount, method: 'ladder', confidence: 0.6 };
    }

    // Fallback to provided default
    logger.info(`AmountDetector: using fallback amount ${fallbackAmount}`);
    return { amount: fallbackAmount, method: 'fallback', confidence: 0.3 };
  }

  private getDomain(): string {
    try {
      return new URL(this.page.url()).hostname;
    } catch {
      return 'unknown';
    }
  }

  private async detectFromApi(): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      let found: number | null = null;

      const timeout = setTimeout(() => {
        this.page.off('response', handler);
        resolve(found);
      }, 5000);

      const handler = async (response: any) => {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (!contentType.includes('json')) return;

          const body = await response.text().catch(() => '');
          if (!body) return;

          const json = JSON.parse(body);
          const minAmount = this.findMinAmountInJson(json);
          if (minAmount !== null && minAmount > 0) {
            found = minAmount;
            clearTimeout(timeout);
            this.page.off('response', handler);
            resolve(found);
          }
        } catch { /* ignore */ }
      };

      this.page.on('response', handler);

      // Trigger a rate refresh by interacting with amount field
      this.triggerRateRefresh().catch(() => {});
    });
  }

  private findMinAmountInJson(obj: any, depth = 0): number | null {
    if (depth > 8 || !obj) return null;

    if (typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        const lk = key.toLowerCase();
        if (MIN_AMOUNT_KEYS.some(k => lk.includes(k))) {
          const num = parseFloat(String(value));
          if (!isNaN(num) && num > 0) return num;
        }
        const nested = this.findMinAmountInJson(value, depth + 1);
        if (nested !== null) return nested;
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const nested = this.findMinAmountInJson(item, depth + 1);
        if (nested !== null) return nested;
      }
    }

    return null;
  }

  private async detectFromHtmlAttrs(): Promise<number | null> {
    return this.page.evaluate((selectors: string[]) => {
      for (const sel of selectors) {
        const inputs = document.querySelectorAll(sel);
        for (const input of Array.from(inputs)) {
          const el = input as HTMLInputElement;
          if (el.offsetParent === null) continue; // skip hidden

          // Check min attribute
          const minAttr = el.getAttribute('min');
          if (minAttr) {
            const num = parseFloat(minAttr);
            if (!isNaN(num) && num > 0) return num;
          }

          // Check placeholder for range: "0.001 – 10.5 BTC"
          const placeholder = el.placeholder || '';
          const rangeMatch = placeholder.match(/([0-9][0-9.,]*)\s*[–—\-]\s*[0-9.,]*/);
          if (rangeMatch) {
            const num = parseFloat(rangeMatch[1].replace(',', '.'));
            if (!isNaN(num) && num > 0) return num;
          }
        }
      }
      return null;
    }, AMOUNT_INPUT_SELECTORS);
  }

  private async detectFromValidation(): Promise<number | null> {
    try {
      const amountInput = await this.findAmountInput();
      if (!amountInput) return null;

      const currentValue = await amountInput.inputValue().catch(() => '');

      // Enter a tiny amount to trigger validation
      await amountInput.fill('0.00000001');
      await amountInput.dispatchEvent('input');
      await amountInput.dispatchEvent('change');
      await this.page.waitForTimeout(1500);

      // Look for validation error text
      const errorText = await this.page.evaluate(() => {
        const selectors = [
          '.error', '.validation-error', '.field-error', '.input-error',
          '[class*="error"]', '[class*="warning"]', '[class*="alert"]',
          '.hint', '.help-text', '.min-amount-hint',
        ];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of Array.from(els)) {
            const htmlEl = el as HTMLElement;
            if (htmlEl.offsetParent === null) continue; // skip hidden
            const text = htmlEl.innerText || '';
            if (text && /\d/.test(text)) return text;
          }
        }
        return '';
      });

      // Parse minimum from error text
      const minPatterns = [
        /(?:min|минимум|минимальн\w*|от)\s*[:=]?\s*([0-9][0-9.,]*)/i,
        /(?:не менее|не может быть менее)\s*([0-9][0-9.,]*)/i,
        /([0-9][0-9.,]*)\s*(?:–|—|-)\s*[0-9.,]*\s*(?:BTC|ETH|USDT|LTC)/i,
      ];

      for (const pattern of minPatterns) {
        const match = errorText.match(pattern);
        if (match) {
          const num = parseFloat(match[1].replace(',', '.'));
          if (!isNaN(num) && num > 0) {
            // Restore original value
            if (currentValue) await amountInput.fill(currentValue);
            return num;
          }
        }
      }

      // Restore original value
      if (currentValue) await amountInput.fill(currentValue);
      return null;
    } catch {
      return null;
    }
  }

  private async detectByLadder(currency: string): Promise<number | null> {
    try {
      const amountInput = await this.findAmountInput();
      if (!amountInput) return null;

      const currentValue = await amountInput.inputValue().catch(() => '');
      let testAmount = currency.includes('USDT') ? 1 : 0.0001;
      const maxIterations = 15;

      for (let i = 0; i < maxIterations; i++) {
        await amountInput.fill(String(testAmount));
        await amountInput.dispatchEvent('input');
        await this.page.waitForTimeout(800);

        // Check if submit button is enabled
        const submitEnabled = await this.page.evaluate(() => {
          const btns = document.querySelectorAll(
            'button[type="submit"], .xchange_submit, .js_exchange_link, .exchange-btn'
          );
          for (const btn of Array.from(btns)) {
            const el = btn as HTMLButtonElement;
            if (el.offsetParent !== null && !el.disabled) return true;
          }
          return false;
        });

        if (submitEnabled) {
          const minAmount = i === 0 ? testAmount : testAmount / 2;
          if (currentValue) await amountInput.fill(currentValue);
          return minAmount;
        }

        testAmount *= 2;
      }

      if (currentValue) await amountInput.fill(currentValue);
      return null;
    } catch {
      return null;
    }
  }

  private async findAmountInput() {
    for (const sel of AMOUNT_INPUT_SELECTORS) {
      const el = await this.page.$(sel);
      if (el && await el.isVisible().catch(() => false)) return el;
    }
    return null;
  }

  private async triggerRateRefresh(): Promise<void> {
    const input = await this.findAmountInput();
    if (input) {
      await input.click().catch(() => {});
      await this.page.waitForTimeout(300);
    }
  }

  private addMargin(amount: number): number {
    // +1% margin to avoid rounding issues
    return Math.ceil(amount * 1.01 * 100000000) / 100000000;
  }

  private cacheResult(key: string, amount: number): void {
    amountCache.set(key, { amount, detectedAt: Date.now() });
  }
}
