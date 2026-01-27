import { Page } from 'playwright';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { EngineType } from './detector';

export class VueSpaEngine extends BaseEngine {
  type: EngineType = 'vue-spa';
  name = 'Vue SPA Exchange';

  async canHandle(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      return !!(
        document.querySelector('[class*="v-"], [id*="v-radio"]') ||
        document.querySelector('[name*="Requisites"]') ||
        document.querySelector('[class*="_"][class*="_"]')
      );
    });
  }

  async collectAddress(page: Page, data: ExchangeFormData): Promise<CollectionResult> {
    try {
      // Wait for Vue app to mount
      await page.waitForTimeout(2000);

      // Step 1: Select currencies (usually via dropdowns or clickable selectors)
      await this.selectCurrency(page, 'from', data.fromCurrency);
      await page.waitForTimeout(500);
      await this.selectCurrency(page, 'to', data.toCurrency);
      await page.waitForTimeout(500);

      // Step 2: Fill amount
      const amountFilled = await this.fillField(page, [
        '[name*="sum"], [name*="amount"]',
        '[class*="amount"] input, [class*="sum"] input',
        'input[placeholder*="сумм"], input[placeholder*="amount"]',
        'input[type="number"]'
      ], String(data.amount));

      if (!amountFilled) {
        return { success: false, error: 'Could not fill amount field' };
      }

      // Step 3: Fill wallet address
      const walletFilled = await this.fillField(page, [
        '[name*="wallet"], [name*="Requisites.wallet"]',
        '[placeholder*="кошел"], [placeholder*="wallet"], [placeholder*="адрес"]',
        '[class*="wallet"] input, [class*="address"] input'
      ], data.wallet);

      if (!walletFilled) {
        return { success: false, error: 'Could not fill wallet field' };
      }

      // Step 4: Fill email
      await this.fillField(page, [
        '[name="email"], [type="email"]',
        '[placeholder*="email"], [placeholder*="почт"]'
      ], data.email);

      // Step 5: Fill card number if needed
      if (data.cardNumber) {
        await this.fillField(page, [
          '[name*="card"], [name*="Requisites.card"]',
          '[placeholder*="карт"], [placeholder*="card"]'
        ], data.cardNumber);
      }

      // Step 6: Accept terms if checkbox exists
      await this.acceptTerms(page);

      // Step 7: Submit form
      const submitted = await this.clickElement(page, [
        'button[type="submit"]',
        '[class*="submit"], [class*="exchange"]',
        'button:has-text("Обменять"), button:has-text("Exchange")',
        'button:has-text("Создать"), button:has-text("Create")'
      ]);

      if (!submitted) {
        return { success: false, error: 'Could not find submit button' };
      }

      // Step 8: Wait for result page
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Step 9: Extract address
      const extracted = await this.extractAddress(page);

      if (!extracted.address) {
        return { success: false, error: 'Could not extract deposit address' };
      }

      return {
        success: true,
        address: extracted.address,
        network: extracted.network,
        memo: extracted.memo
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async selectCurrency(page: Page, direction: 'from' | 'to', currency: string): Promise<boolean> {
    // Try clicking on currency selector
    const selectors = direction === 'from'
      ? ['[class*="from"] [class*="currency"]', '[class*="give"] [class*="select"]', '.exchange-from']
      : ['[class*="to"] [class*="currency"]', '[class*="get"] [class*="select"]', '.exchange-to'];

    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await element.click();
          await page.waitForTimeout(300);

          // Try to find and click currency option
          const option = await page.$(`text=${currency}`);
          if (option) {
            await option.click();
            return true;
          }
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  private async acceptTerms(page: Page): Promise<void> {
    const checkboxSelectors = [
      '[type="checkbox"]:not(:checked)',
      '[class*="checkbox"]:not(.checked)',
      '[id*="agree"], [name*="agree"], [name*="terms"]'
    ];

    for (const selector of checkboxSelectors) {
      try {
        const checkbox = await page.$(selector);
        if (checkbox && await checkbox.isVisible()) {
          await checkbox.click();
        }
      } catch {
        continue;
      }
    }
  }
}
