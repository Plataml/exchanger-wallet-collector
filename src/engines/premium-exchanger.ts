import { Page } from 'playwright';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { EngineType } from './detector';
import { detectCaptcha, solveCaptcha } from '../captcha';
import { config } from '../config';
import { logger } from '../logger';
import { createTempMailbox, getVerificationCode, deleteTempMailbox, isEmailConfigured, TempMailbox } from '../tempmail';
import { SmartFormFiller } from './smart-form';
import { NetworkInterceptor } from '../utils/network-interceptor';
import { humanClick } from '../utils/human-mouse';
import {
  navigateToExchangePage,
  selectCurrenciesViaUI,
  getCurrencyVariations
} from './premium/navigation';
import {
  getCardForCurrency,
  tryFallbackFill,
  fillPersonalData
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
    const interceptor = this.createInterceptor(page);
    const hasEmail = isEmailConfigured();
    const emailForForm = hasEmail ? '' : config.formEmail; // Use form email if IMAP not available

    try {
      if (hasEmail) {
        tempMailbox = await createTempMailbox();
        logger.info(`Using IMAP email: ${tempMailbox.email}`);
      } else {
        logger.warn('IMAP not configured — email verification will be skipped');
      }

      const formEmail = tempMailbox?.email || emailForForm || 'test@example.com';

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
        const fallbackResult = await tryFallbackFill(page, data.amount, data.toCurrency, formEmail);
        if (!fallbackResult) {
          return { success: false, error: `Missing fields: ${validation.missing.join(', ')}` };
        }
      } else {
        const cardValue = getCardForCurrency(data.toCurrency);
        await smartFiller.fillForm({
          amount: data.amount,
          card: cardValue,
          wallet: data.wallet,
          email: formEmail,
          name: config.formFio,
          phone: config.formPhone
        });
      }

      // Fill PremiumBox custom fields (cf6=FIO, etc.) that SmartFormFiller may miss
      await fillPersonalData(page, formEmail);

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

      // Start network interception before submit
      interceptor.start();

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

      // Check for form validation errors (AJAX forms stay on same page)
      const validationError = await page.evaluate(() => {
        const errorSelectors = [
          '.error:not(:empty)', '.field-error:not(:empty)', '.xchange_error:not(:empty)',
          '[class*="error"]:not(script):not(style)', '.alert-danger', '.form-error'
        ];
        for (const sel of errorSelectors) {
          const els = document.querySelectorAll(sel);
          for (const el of Array.from(els)) {
            const htmlEl = el as HTMLElement;
            if (htmlEl.offsetParent !== null && htmlEl.innerText?.trim()) {
              const text = htmlEl.innerText.trim();
              if (text.length > 5 && text.length < 300 &&
                  !text.includes('©') && !text.includes('cookie')) {
                return text;
              }
            }
          }
        }
        return null;
      });
      if (validationError) {
        logger.warn(`Post-submit validation error: ${validationError}`);
      }

      // Step 5: Handle popup
      await handleConfirmationPopup(page);
      await page.waitForTimeout(2000);

      // Step 6: Email verification (only if IMAP configured)
      if (tempMailbox) {
        logger.info('Step 6: Waiting for verification email...');
        const domain = new URL(page.url()).hostname;
        const code = await getVerificationCode(tempMailbox, new RegExp(domain, 'i'), 120000);

        if (!code) {
          await this.saveDebugScreenshot(page, 'no-email-code');
          logger.warn('Email verification failed — continuing without it');
        } else if (/^\d+$/.test(code)) {
          await enterVerificationCode(page, code);
        } else if (code.startsWith('http')) {
          await page.goto(code, { waitUntil: 'domcontentloaded' });
        }
      } else {
        logger.info('Step 6: Skipping email verification (IMAP not configured)');
        // Wait a bit for page to settle after submit
        await page.waitForTimeout(3000);
      }

      // Step 7-8: AML and create order
      await acceptAmlPolicy(page);
      await clickCreateOrderButton(page);
      await page.waitForTimeout(3000);

      // Step 9: Try extracting address from CURRENT page first (AJAX forms)
      let extracted = await extractDepositAddress(page);
      if (!extracted.address) {
        // Check network interceptor for addresses found in API responses
        const apiAddr = interceptor.getAddresses();
        if (apiAddr.length > 0) {
          extracted = { address: apiAddr[0].address, network: apiAddr[0].network };
          logger.info(`Address found via API interceptor: ${apiAddr[0].address}`);
        }
      }

      // If no address on current page, try payment page navigation
      if (!extracted.address) {
        const paymentPage = await goToPaymentPage(page);

        extracted = await extractDepositAddress(paymentPage);
        if (!extracted.address) {
          // Fallback: try iframe and network interceptor
          const enhanced = await this.extractAddressEnhanced(paymentPage, interceptor);
          if (enhanced.address) {
            extracted = { address: enhanced.address, network: enhanced.network, memo: enhanced.memo };
          }
        }
        if (!extracted.address) {
          await this.saveDebugScreenshot(paymentPage, 'no-address');
        }
      }

      if (!extracted.address) {
        await this.saveDebugScreenshot(page, 'no-address');
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
      interceptor.stop();
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
