import { Page } from 'playwright';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { EngineType } from './detector';
import { detectCaptcha, solveCaptcha } from '../captcha';
import { logger } from '../logger';
import { createTempMailbox, getVerificationCode, deleteTempMailbox, TempMailbox } from '../tempmail';
import { config } from '../config';

/**
 * Engine for iEXExchanger CMS
 * Vue 3 SPA with Sanctum auth
 * API-based exchange flow
 */
export class IexExchangerEngine extends BaseEngine {
  type: EngineType = 'iex-exchanger' as EngineType;
  name = 'iEXExchanger CMS';

  async canHandle(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      // Check for iexexchanger patterns
      const hasIexDomain = /iexexchanger\.com/i.test(html);
      const hasSanctum = !!document.querySelector('meta[name="csrf-token"]');
      const hasIexApi = /\/frontend\/api\/v1/i.test(html);
      const hasAuthRoutes = /\/auth\/login|\/auth\/register/i.test(html);
      return hasIexDomain || (hasSanctum && hasIexApi) || (hasSanctum && hasAuthRoutes);
    });
  }

  async collectAddress(page: Page, data: ExchangeFormData): Promise<CollectionResult> {
    let tempMailbox: TempMailbox | null = null;

    try {
      tempMailbox = await createTempMailbox();
      logger.info(`[IEX] Using email: ${tempMailbox.email}`);

      // Step 1: Navigate to main page and find exchange form
      const baseUrl = new URL(page.url()).origin;
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      await this.saveDebugScreenshot(page, 'step1');

      // Step 2: Select currencies
      logger.info('[IEX] Step 2: Selecting currencies...');
      await this.selectCurrencies(page, data.fromCurrency, data.toCurrency);
      await page.waitForTimeout(2000);

      // Step 3: Fill amount
      logger.info('[IEX] Step 3: Filling amount...');
      await this.fillAmount(page, data.amount);
      await page.waitForTimeout(1000);

      // Step 4: Fill recipient details
      logger.info('[IEX] Step 4: Filling recipient details...');
      await this.fillRecipientDetails(page, data);
      await page.waitForTimeout(1000);

      // Step 5: Fill personal data (email, name)
      logger.info('[IEX] Step 5: Filling personal data...');
      await this.fillPersonalData(page, tempMailbox.email);

      await this.saveDebugScreenshot(page, 'before-submit');

      // Step 6: Handle captcha if present
      const captcha = await detectCaptcha(page);
      if (captcha.hasCaptcha) {
        logger.info(`[IEX] Solving ${captcha.type} captcha...`);
        const solution = await solveCaptcha(page);
        if (!solution.success) {
          return { success: false, error: `Captcha failed: ${solution.error}` };
        }
      }

      // Step 7: Submit exchange
      logger.info('[IEX] Step 7: Submitting exchange...');
      await this.clickSubmitButton(page);
      await page.waitForTimeout(5000);

      await this.saveDebugScreenshot(page, 'after-submit');

      // Step 8: Wait for email verification
      logger.info('[IEX] Step 8: Waiting for email verification...');
      const domain = new URL(page.url()).hostname;
      const code = await getVerificationCode(tempMailbox, new RegExp(domain, 'i'), 120000);

      if (code) {
        if (/^\d+$/.test(code)) {
          await this.enterVerificationCode(page, code);
        } else if (code.startsWith('http')) {
          await page.goto(code, { waitUntil: 'domcontentloaded' });
        }
        await page.waitForTimeout(3000);
      }

      // Step 9: Extract deposit address
      logger.info('[IEX] Step 9: Extracting deposit address...');
      const extracted = await this.extractDepositAddress(page);

      if (!extracted.address) {
        await this.saveDebugScreenshot(page, 'no-address');
        return { success: false, error: 'Could not extract deposit address' };
      }

      logger.info(`[IEX] Success! Address: ${extracted.address}`);
      return {
        success: true,
        address: extracted.address,
        network: extracted.network,
        memo: extracted.memo
      };

    } catch (error) {
      await this.saveDebugScreenshot(page, 'error');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (tempMailbox) {
        await deleteTempMailbox(tempMailbox).catch(() => {});
      }
    }
  }

  private async selectCurrencies(page: Page, from: string, to: string): Promise<void> {
    // iEXExchanger typically uses dropdown selects or clickable lists
    // Try common Vue-based currency selector patterns

    // Pattern 1: Dropdown with v-select or similar
    const fromSelectors = [
      '.currency-from .v-select',
      '.give-currency .select',
      '[data-currency-from]',
      '.exchange-from select',
      '.from-currency'
    ];

    for (const selector of fromSelectors) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          await el.click();
          await page.waitForTimeout(500);

          // Search for currency in dropdown
          const option = await page.$(`text=${from}`);
          if (option) {
            await option.click();
            logger.info(`[IEX] Selected from: ${from}`);
            break;
          }
        }
      } catch { continue; }
    }

    // Select "to" currency
    const toSelectors = [
      '.currency-to .v-select',
      '.get-currency .select',
      '[data-currency-to]',
      '.exchange-to select',
      '.to-currency'
    ];

    for (const selector of toSelectors) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          await el.click();
          await page.waitForTimeout(500);

          const option = await page.$(`text=${to}`);
          if (option) {
            await option.click();
            logger.info(`[IEX] Selected to: ${to}`);
            break;
          }
        }
      } catch { continue; }
    }
  }

  private async fillAmount(page: Page, amount: number): Promise<void> {
    const selectors = [
      'input[name="amount"]',
      'input[name="give_amount"]',
      '.give-amount input',
      '.amount-from input',
      'input[placeholder*="сумм"]',
      'input[placeholder*="amount"]',
      '.exchange-form input[type="number"]:first-of-type'
    ];

    for (const selector of selectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(String(amount));
          await input.dispatchEvent('input');
          await input.dispatchEvent('change');
          logger.info(`[IEX] Amount filled: ${amount}`);
          return;
        }
      } catch { continue; }
    }
  }

  private async fillRecipientDetails(page: Page, data: ExchangeFormData): Promise<void> {
    // Determine what to fill based on target currency
    const isCryptoToFiat = data.toCurrency.includes('RUB') || data.toCurrency.includes('UAH');
    const value = isCryptoToFiat ? (config.formCard || config.formPhone) : data.wallet;

    const selectors = [
      'input[name="requisites"]',
      'input[name="wallet"]',
      'input[name="account"]',
      'input[name="card"]',
      '.requisites input',
      'input[placeholder*="кошел"]',
      'input[placeholder*="карт"]',
      'input[placeholder*="реквизит"]'
    ];

    for (const selector of selectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(value || '');
          logger.info(`[IEX] Recipient filled`);
          return;
        }
      } catch { continue; }
    }
  }

  private async fillPersonalData(page: Page, email: string): Promise<void> {
    // Fill email
    const emailSelectors = [
      'input[name="email"]',
      'input[type="email"]',
      'input[placeholder*="email"]',
      '.email input'
    ];

    for (const selector of emailSelectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(email);
          logger.info(`[IEX] Email filled`);
          break;
        }
      } catch { continue; }
    }

    // Fill name if required
    const nameSelectors = [
      'input[name="name"]',
      'input[name="fio"]',
      'input[placeholder*="имя"]',
      'input[placeholder*="ФИО"]'
    ];

    for (const selector of nameSelectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(config.formFio || 'Иванов Иван');
          logger.info(`[IEX] Name filled`);
          break;
        }
      } catch { continue; }
    }

    // Accept agreements
    await page.evaluate(() => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(cb => {
        const input = cb as HTMLInputElement;
        if (!input.checked) {
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    });
  }

  private async clickSubmitButton(page: Page): Promise<void> {
    const selectors = [
      'button[type="submit"]',
      '.exchange-btn',
      '.submit-btn',
      'button:has-text("Обменять")',
      'button:has-text("Создать")',
      'button:has-text("Продолжить")',
      '.v-btn--primary'
    ];

    for (const selector of selectors) {
      try {
        const btn = await page.$(selector);
        if (btn && await btn.isVisible()) {
          await btn.click();
          logger.info(`[IEX] Submit clicked`);
          return;
        }
      } catch { continue; }
    }

    // Fallback: click by text
    const textButtons = ['Обменять', 'Создать заявку', 'Продолжить', 'Submit'];
    for (const text of textButtons) {
      try {
        const btn = page.locator(`text="${text}"`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          return;
        }
      } catch { continue; }
    }
  }

  private async enterVerificationCode(page: Page, code: string): Promise<void> {
    const selectors = [
      'input[name*="code"]',
      'input[placeholder*="код"]',
      '.verification-code input',
      '.code-input'
    ];

    for (const selector of selectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(code);
          logger.info(`[IEX] Verification code entered`);

          // Click confirm button
          const confirmBtn = await page.$('button:has-text("Подтвердить"), button:has-text("OK")');
          if (confirmBtn) await confirmBtn.click();
          return;
        }
      } catch { continue; }
    }
  }

  private async extractDepositAddress(page: Page): Promise<{ address?: string; network?: string; memo?: string }> {
    return page.evaluate(() => {
      const result: { address?: string; network?: string; memo?: string } = {};

      const patterns = [
        /\b(bc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
        /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,
        /\b(0x[a-fA-F0-9]{40})\b/,
        /\b(T[a-zA-Z0-9]{33})\b/,
      ];

      // Check copy buttons and address fields
      const selectors = [
        '[data-clipboard-text]',
        '.wallet-address',
        '.crypto-address',
        '.address-text',
        'input[readonly]',
        '.deposit-address'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of Array.from(elements)) {
          const text = (el as HTMLElement).getAttribute('data-clipboard-text') ||
                      (el as HTMLInputElement).value ||
                      (el as HTMLElement).innerText;
          for (const pattern of patterns) {
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

      // Fallback: scan page text
      if (!result.address) {
        const bodyText = document.body?.innerText || '';
        for (const pattern of patterns) {
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
        }
      }

      return result;
    });
  }

  private async saveDebugScreenshot(page: Page, suffix: string): Promise<void> {
    try {
      const path = `debug-iex-${suffix}-${Date.now()}.png`;
      await page.screenshot({ path, fullPage: true });
      logger.info(`[IEX] Screenshot: ${path}`);
    } catch { /* ignore */ }
  }
}
