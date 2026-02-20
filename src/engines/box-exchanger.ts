import { Page } from 'playwright';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { EngineType } from './detector';
import { detectCaptcha, solveCaptcha } from '../captcha';
import { logger } from '../logger';
import { createTempMailbox, getVerificationCode, deleteTempMailbox, TempMailbox } from '../tempmail';
import { config } from '../config';
import { humanClick } from '../utils/human-mouse';

/**
 * Engine for BoxExchanger CMS
 * Nuxt.js SPA with exchange-calculator
 */
export class BoxExchangerEngine extends BaseEngine {
  type: EngineType = 'box-exchanger' as EngineType;
  name = 'BoxExchanger CMS';

  async canHandle(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const hasBoxDomain = /boxexchanger\.net/i.test(html);
      const hasBoxName = /box-exchanger/i.test(html);
      const hasNuxt = typeof (window as any).__NUXT__ !== 'undefined';
      const hasCalculator = !!document.querySelector('.exchange-calculator');
      return hasBoxDomain || hasBoxName || (hasNuxt && hasCalculator);
    });
  }

  async collectAddress(page: Page, data: ExchangeFormData): Promise<CollectionResult> {
    let tempMailbox: TempMailbox | null = null;
    const interceptor = this.createInterceptor(page);

    try {
      tempMailbox = await createTempMailbox();
      logger.info(`[BOX] Using email: ${tempMailbox.email}`);

      // Step 1: Navigate and wait for Nuxt to load
      const baseUrl = new URL(page.url()).origin;
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      await this.saveDebugScreenshot(page, 'step1');

      // Step 2: Select currencies (Nuxt-based selectors)
      logger.info('[BOX] Step 2: Selecting currencies...');
      await this.selectCurrencies(page, data.fromCurrency, data.toCurrency);
      await page.waitForTimeout(2000);

      // Step 3: Fill amount
      logger.info('[BOX] Step 3: Filling amount...');
      await this.fillAmount(page, data.amount);
      await page.waitForTimeout(1500);

      // Step 4: Fill recipient details
      logger.info('[BOX] Step 4: Filling recipient...');
      await this.fillRecipientDetails(page, data);

      // Step 5: Fill email and personal data
      logger.info('[BOX] Step 5: Filling personal data...');
      await this.fillPersonalData(page, tempMailbox.email);

      await this.saveDebugScreenshot(page, 'before-submit');

      // Step 6: Handle captcha
      const captcha = await detectCaptcha(page);
      if (captcha.hasCaptcha) {
        logger.info(`[BOX] Solving ${captcha.type} captcha...`);
        const solution = await solveCaptcha(page);
        if (!solution.success) {
          return { success: false, error: `Captcha failed: ${solution.error}` };
        }
      }

      // Step 7: Accept agreements
      await this.acceptAgreements(page);

      // Step 8: Submit
      logger.info('[BOX] Step 8: Submitting...');
      interceptor.start();
      await this.clickSubmitButton(page);
      await page.waitForTimeout(5000);

      await this.saveDebugScreenshot(page, 'after-submit');

      // Step 9: Email verification if needed
      const needsEmailVerification = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || '';
        return text.includes('код') || text.includes('email') || text.includes('подтвердите');
      });

      if (needsEmailVerification) {
        logger.info('[BOX] Waiting for email verification...');
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
      }

      // Step 10: Extract deposit address (cascade: DOM -> iframe -> API)
      logger.info('[BOX] Step 10: Extracting address...');
      let extracted = await this.extractDepositAddress(page);

      if (!extracted.address) {
        const enhanced = await this.extractAddressEnhanced(page, interceptor);
        if (enhanced.address) {
          extracted = { address: enhanced.address, network: enhanced.network, memo: enhanced.memo };
        }
      }

      if (!extracted.address) {
        await this.saveDebugScreenshot(page, 'no-address');
        return { success: false, error: 'Could not extract deposit address' };
      }

      logger.info(`[BOX] Success! Address: ${extracted.address}`);
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
      interceptor.stop();
      if (tempMailbox) {
        await deleteTempMailbox(tempMailbox).catch(() => {});
      }
    }
  }

  private async selectCurrencies(page: Page, from: string, to: string): Promise<void> {
    // BoxExchanger uses Nuxt with custom dropdown components
    const fromSelectors = [
      '.give-select', '.currency-give', '.from-currency',
      '[data-testid="give-currency"]', '.exchange-calculator .give'
    ];

    for (const selector of fromSelectors) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          await el.click();
          await page.waitForTimeout(500);

          // Search in dropdown
          const option = await page.$(`text=${from}`);
          if (option) {
            await option.click();
            logger.info(`[BOX] Selected from: ${from}`);
            break;
          }
        }
      } catch { continue; }
    }

    await page.waitForTimeout(1000);

    const toSelectors = [
      '.get-select', '.currency-get', '.to-currency',
      '[data-testid="get-currency"]', '.exchange-calculator .get'
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
            logger.info(`[BOX] Selected to: ${to}`);
            break;
          }
        }
      } catch { continue; }
    }
  }

  private async fillAmount(page: Page, amount: number): Promise<void> {
    const selectors = [
      'input[name="give"]', 'input[name="amount"]',
      '.give-input input', '.amount-give input',
      'input[placeholder*="сумм"]', 'input[type="number"]:first-of-type'
    ];

    for (const selector of selectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(String(amount));
          await input.dispatchEvent('input');
          logger.info(`[BOX] Amount filled: ${amount}`);
          return;
        }
      } catch { continue; }
    }
  }

  private async fillRecipientDetails(page: Page, data: ExchangeFormData): Promise<void> {
    const isCryptoToFiat = data.toCurrency.includes('RUB') || data.toCurrency.includes('UAH');
    const value = isCryptoToFiat ? (config.formCard || config.formPhone) : data.wallet;

    const selectors = [
      'input[name="requisites"]', 'input[name="wallet"]',
      'input[name="account"]', 'input[name="card"]',
      '.requisites input', '.wallet-input input',
      'input[placeholder*="кошел"]', 'input[placeholder*="карт"]'
    ];

    for (const selector of selectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(value || '');
          logger.info(`[BOX] Recipient filled`);
          return;
        }
      } catch { continue; }
    }
  }

  private async fillPersonalData(page: Page, email: string): Promise<void> {
    // Email
    const emailSelectors = [
      'input[name="email"]', 'input[type="email"]',
      'input[placeholder*="email"]', '.email-input input'
    ];

    for (const selector of emailSelectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(email);
          logger.info(`[BOX] Email filled`);
          break;
        }
      } catch { continue; }
    }

    // Name
    const nameSelectors = [
      'input[name="name"]', 'input[name="fio"]',
      'input[placeholder*="имя"]', 'input[placeholder*="ФИО"]'
    ];

    for (const selector of nameSelectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(config.formFio || 'Иванов Иван');
          logger.info(`[BOX] Name filled`);
          break;
        }
      } catch { continue; }
    }

    // Phone
    const phoneSelectors = [
      'input[name="phone"]', 'input[type="tel"]',
      'input[placeholder*="телефон"]'
    ];

    for (const selector of phoneSelectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(config.formPhone || '9991234567');
          logger.info(`[BOX] Phone filled`);
          break;
        }
      } catch { continue; }
    }
  }

  private async acceptAgreements(page: Page): Promise<void> {
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
    logger.info(`[BOX] Agreements accepted`);
  }

  private async clickSubmitButton(page: Page): Promise<void> {
    const selectors = [
      'button[type="submit"]', '.exchange-btn', '.submit-btn',
      'button:has-text("Обменять")', 'button:has-text("Создать")',
      'button:has-text("Продолжить")', '.nuxt-link-exact-active'
    ];

    for (const selector of selectors) {
      try {
        const btn = await page.$(selector);
        if (btn && await btn.isVisible()) {
          await humanClick(page, btn, { enabled: config.humanMouse });
          logger.info(`[BOX] Submit clicked`);
          return;
        }
      } catch { continue; }
    }

    // Text fallback
    const texts = ['Обменять', 'Создать заявку', 'Продолжить', 'Далее'];
    for (const text of texts) {
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
      'input[name*="code"]', 'input[placeholder*="код"]',
      '.code-input input', '.verification input'
    ];

    for (const selector of selectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(code);
          logger.info(`[BOX] Code entered`);

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

      const selectors = [
        '[data-clipboard-text]', '.wallet-address', '.crypto-address',
        '.address-text', 'input[readonly]', '.deposit-address', '.qr-address'
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
      const path = `debug-box-${suffix}-${Date.now()}.png`;
      await page.screenshot({ path, fullPage: true });
      logger.info(`[BOX] Screenshot: ${path}`);
    } catch { /* ignore */ }
  }
}
