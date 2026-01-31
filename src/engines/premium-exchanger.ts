import { Page } from 'playwright';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { EngineType } from './detector';
import { detectCaptcha, solveCaptcha } from '../captcha';
import { config } from '../config';
import { logger } from '../logger';
import { createTempMailbox, getVerificationCode, deleteTempMailbox, TempMailbox } from '../tempmail';
import { SmartFormFiller } from './smart-form';
import {
  navigateToExchangePage,
  selectCurrenciesViaUI,
  getCurrencyVariations
} from './premium/navigation';
import {
  getCardForCurrency,
  tryFallbackFill
} from './premium/form-filler';
import {
  clickSubmitButton,
  handleConfirmationPopup,
  enterVerificationCode,
  checkAgreementCheckboxes,
  closeChatWidgets,
  acceptAmlPolicy,
  clickCreateOrderButton,
  goToPaymentPage,
  checkBlockingError
} from './premium/ui-handlers';
import { extractDepositAddress } from './premium/address-extractor';

/**
 * Engine for PremiumExchanger CMS
 * Flow: currencies -> amount -> card -> email -> captcha -> verify -> AML -> payment
 */
export class PremiumExchangerEngine extends BaseEngine {
  type: EngineType = 'premium-exchanger' as EngineType;
  name = 'PremiumExchanger CMS';

  async canHandle(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const hasPremiumBox = document.querySelector('script[src*="premiumbox"], link[href*="premiumbox"]') !== null;
      const hasJsSumm = document.querySelector('.js_summ1, .js_summ2') !== null;
      const hasExchangeUrl = /\/exchange_\w+_to_\w+\/?/.test(window.location.href);
      const hasWpContent = document.querySelector('link[href*="wp-content"]') !== null;
      return hasPremiumBox || (hasJsSumm && hasExchangeUrl) || (hasWpContent && hasJsSumm);
    });
  }

  async collectAddress(page: Page, data: ExchangeFormData): Promise<CollectionResult> {
    let tempMailbox: TempMailbox | null = null;

    try {
      tempMailbox = await createTempMailbox();
      logger.info(`Using email: ${tempMailbox.email}`);

      // Step 1: Navigate to exchange page
      const foundPage = await navigateToExchangePage(page, data.fromCurrency, data.toCurrency);
      if (!foundPage) {
        const baseUrl = new URL(page.url()).origin;
        await page.goto(`${baseUrl}/?from=${data.fromCurrency}&to=${data.toCurrency}`, {
          waitUntil: 'domcontentloaded', timeout: 30000
        });
        await selectCurrenciesViaUI(page, data.fromCurrency, data.toCurrency);
      }

      await page.waitForTimeout(2000);
      await this.saveDebugScreenshot(page, 'step1-after-load');

      // Check for blocks
      if (await this.checkCloudflare(page)) {
        await page.waitForTimeout(10000);
      }
      if (await this.checkGeoBlock(page)) {
        return { success: false, error: 'Geo-blocked' };
      }

      // Step 2: Fill form
      logger.info('Step 2: Filling form...');
      const smartFiller = new SmartFormFiller(page);
      await smartFiller.analyzeForm();

      const validation = smartFiller.hasRequiredFields();
      if (!validation.valid) {
        logger.warn(`Missing fields: ${validation.missing.join(', ')}`);
        const fallbackResult = await tryFallbackFill(page, data.amount, data.toCurrency, tempMailbox.email);
        if (!fallbackResult) {
          return { success: false, error: `Missing fields: ${validation.missing.join(', ')}` };
        }
      } else {
        const cardValue = getCardForCurrency(data.toCurrency);
        await smartFiller.fillForm({
          amount: data.amount,
          card: cardValue,
          wallet: data.wallet,
          email: tempMailbox.email,
          name: config.formFio,
          phone: config.formPhone
        });
      }

      // Step 3: Handle captcha
      const captcha = await detectCaptcha(page);
      if (captcha.hasCaptcha) {
        logger.info(`Solving ${captcha.type} captcha...`);
        const solution = await solveCaptcha(page);
        if (!solution.success) {
          return { success: false, error: `Captcha failed: ${solution.error}` };
        }
        await page.waitForTimeout(2000);
      }

      // Step 4: Submit form
      await checkAgreementCheckboxes(page);
      await closeChatWidgets(page);
      await this.saveDebugScreenshot(page, 'before-submit');

      await clickSubmitButton(page);
      await page.waitForTimeout(3000);
      await this.saveDebugScreenshot(page, 'after-submit');

      // Check for post-submit captcha
      const postCaptcha = await detectCaptcha(page);
      if (postCaptcha.hasCaptcha) {
        const solution = await solveCaptcha(page);
        if (solution.success) {
          await clickSubmitButton(page);
          await page.waitForTimeout(3000);
        }
      }

      // Check for blocking errors
      const blockError = await checkBlockingError(page);
      if (blockError) {
        return { success: false, error: `Blocked: ${blockError}` };
      }

      // Step 5: Handle popup
      await handleConfirmationPopup(page);
      await page.waitForTimeout(2000);

      // Step 6: Email verification
      logger.info('Step 6: Waiting for email...');
      const domain = new URL(page.url()).hostname;
      const code = await getVerificationCode(tempMailbox, new RegExp(domain, 'i'), 120000);

      if (!code) {
        await this.saveDebugScreenshot(page, 'no-email-code');
        return { success: false, error: 'Email verification failed' };
      }

      if (/^\d+$/.test(code)) {
        await enterVerificationCode(page, code);
      } else if (code.startsWith('http')) {
        await page.goto(code, { waitUntil: 'domcontentloaded' });
      }

      // Step 7-8: AML and create order
      await acceptAmlPolicy(page);
      await clickCreateOrderButton(page);
      await page.waitForTimeout(3000);

      // Step 9: Payment page
      const paymentPage = await goToPaymentPage(page);

      // Step 10: Extract address
      const extracted = await extractDepositAddress(paymentPage);
      if (!extracted.address) {
        await this.saveDebugScreenshot(paymentPage, 'no-address');
        return { success: false, error: 'Could not extract address' };
      }

      logger.info(`Success! Address: ${extracted.address}`);
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

  // Keep getCurrencyVariations for backward compatibility
  getCurrencyVariations(code: string): string[] {
    return getCurrencyVariations(code);
  }

  private async checkCloudflare(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      return document.body?.innerText?.includes('Checking your browser') ||
             !!document.querySelector('#challenge-form');
    });
  }

  private async checkGeoBlock(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const text = document.body?.innerText?.toLowerCase() || '';
      return text.includes('запрещён для вашей страны') || text.includes('not available in your');
    });
  }

  private async saveDebugScreenshot(page: Page, suffix: string): Promise<void> {
    try {
      const path = `debug-premium-${suffix}-${Date.now()}.png`;
      await page.screenshot({ path, fullPage: true });
      logger.info(`Screenshot: ${path}`);
    } catch { /* ignore */ }
  }
}
