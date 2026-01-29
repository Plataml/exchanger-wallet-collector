import { Page } from 'playwright';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { EngineType } from './detector';
import { detectCaptcha, solveCaptcha } from '../captcha';
import { config } from '../config';
import { logger } from '../logger';
import { createTempMailbox, getVerificationCode, deleteTempMailbox, TempMailbox } from '../tempmail';
import { SmartFormFiller } from './smart-form';

/**
 * Engine for PremiumExchanger CMS
 * Full flow based on mine.exchange:
 * 1. Main page: select currencies + amount → "обменять"
 * 2. Second page: card details + personal data (name, email) → "обменять"
 * 3. Popup: confirm name → "ок"
 * 4. Email verification → enter code from email
 * 5. AML checkbox → "создать заявку"
 * 6. "Перейти к оплате" button
 * 7. New tab with deposit address
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
      // Create temp email for verification
      tempMailbox = await createTempMailbox();
      logger.info(`Using temp email: ${tempMailbox.email}`);

      // Step 1: Navigate to exchange page
      // Try direct URLs with different currency code variations
      const baseUrl = new URL(page.url()).origin;
      const fromVariations = this.getCurrencyVariations(data.fromCurrency);
      const toVariations = this.getCurrencyVariations(data.toCurrency);

      let foundValidPage = false;

      // Try different URL variations
      for (const fromCode of fromVariations) {
        if (foundValidPage) break;
        for (const toCode of toVariations) {
          const directUrl = `${baseUrl}/exchange_${fromCode}_to_${toCode}/`;
          logger.info(`Step 1: Trying URL: ${directUrl}`);

          try {
            await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);

            // Check if we got valid exchange page (not 404)
            const is404 = await page.evaluate(() => {
              const text = document.body?.innerText?.toLowerCase() || '';
              const title = document.title?.toLowerCase() || '';
              return text.includes('404') || text.includes('не найден') ||
                     text.includes('not found') || title.includes('404') ||
                     (document.body?.innerText?.length || 0) < 500;
            });

            if (!is404) {
              logger.info(`Found valid exchange page: ${directUrl}`);
              foundValidPage = true;
              break;
            }
          } catch {
            // URL failed, try next
            continue;
          }
        }
      }

      // Fallback to main page with query params and UI selection
      if (!foundValidPage) {
        const fallbackUrl = `${baseUrl}/?from=${data.fromCurrency}&to=${data.toCurrency}`;
        logger.info(`No direct URL worked, trying fallback: ${fallbackUrl}`);
        await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Select currencies via UI
        await this.selectCurrenciesViaUI(page, data.fromCurrency, data.toCurrency);
      }

      // Wait for form to be ready
      await page.waitForTimeout(2000);

      // Debug screenshot
      await this.saveDebugScreenshot(page, 'step1-after-load');

      // Check for Cloudflare challenge
      const hasCloudflare = await page.evaluate(() => {
        return document.body?.innerText?.includes('Checking your browser') ||
               document.body?.innerText?.includes('Verifying') ||
               !!document.querySelector('#challenge-form');
      });

      if (hasCloudflare) {
        logger.info('Cloudflare challenge detected, waiting...');
        await page.waitForTimeout(10000);
        await this.saveDebugScreenshot(page, 'step1-cloudflare');
      }

      // Check for geo-block
      const isGeoBlocked = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || '';
        return text.includes('запрещён для вашей страны') ||
               text.includes('prohibited') ||
               text.includes('not available in your');
      });

      if (isGeoBlocked) {
        return { success: false, error: 'Geo-blocked: exchange prohibited for this country' };
      }

      // Wait for form to be ready
      await page.waitForTimeout(2000);

      // Step 2: Use SmartFormFiller to analyze and fill form
      logger.info('Step 2: Analyzing form with SmartFormFiller...');
      const smartFiller = new SmartFormFiller(page);
      await smartFiller.analyzeForm();

      // Check if form has required fields
      const validation = smartFiller.hasRequiredFields();
      if (!validation.valid) {
        await this.saveDebugScreenshot(page, 'missing-fields');
        logger.warn(`Missing fields: ${validation.missing.join(', ')}`);

        // Try fallback to old selectors
        logger.info('Trying fallback selectors...');
        const fallbackResult = await this.tryFallbackFill(page, data, tempMailbox.email);
        if (!fallbackResult.success) {
          return { success: false, error: `Form missing fields: ${validation.missing.join(', ')}` };
        }
      } else {
        // Fill form using smart detection
        const cardValue = this.getCardForCurrency(data.toCurrency);
        const fillResult = await smartFiller.fillForm({
          amount: data.amount,
          card: cardValue,
          wallet: data.wallet,
          email: tempMailbox.email,
          name: config.formFio,
          phone: config.formPhone
        });

        if (!fillResult.success) {
          await this.saveDebugScreenshot(page, 'fill-failed');
          return { success: false, error: 'Could not fill form fields' };
        }

        logger.info(`Filled fields: ${fillResult.filledFields.join(', ')}`);
      }

      await page.waitForTimeout(1000);

      // Verify fields are filled
      const fieldValues = await page.evaluate(() => {
        const result: Record<string, string> = {};
        const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"]');
        inputs.forEach((el) => {
          const input = el as HTMLInputElement;
          if (input.value && input.offsetParent !== null) {
            const key = input.name || input.id || input.placeholder?.substring(0, 20) || 'unnamed';
            result[key] = input.value.substring(0, 20) + (input.value.length > 20 ? '...' : '');
          }
        });
        return result;
      });
      logger.info(`Field values: ${JSON.stringify(fieldValues)}`);

      // Step 3: Handle captcha if present
      const captchaDetection = await detectCaptcha(page);
      logger.info(`Step 3: Captcha check - hasCaptcha: ${captchaDetection.hasCaptcha}, type: ${captchaDetection.type}, siteKey: ${captchaDetection.siteKey?.substring(0, 20) || 'none'}`);

      if (captchaDetection.hasCaptcha) {
        logger.info(`Step 3: Solving ${captchaDetection.type} captcha...`);
        const captchaSolution = await solveCaptcha(page);
        if (!captchaSolution.success) {
          logger.error(`Captcha solving failed: ${captchaSolution.error}`);
          return { success: false, error: `Captcha failed: ${captchaSolution.error}` };
        }
        logger.info('Captcha solved successfully!');
        await page.waitForTimeout(2000);
      } else {
        // Try to find captcha elements manually for debugging
        const captchaDebug = await page.evaluate(() => {
          const results: string[] = [];
          if (document.querySelector('.g-recaptcha')) results.push('found .g-recaptcha');
          if (document.querySelector('[data-sitekey]')) results.push('found [data-sitekey]');
          if (document.querySelector('textarea[name="g-recaptcha-response"]')) results.push('found g-recaptcha-response textarea');
          if (document.querySelector('iframe[src*="recaptcha"]')) results.push('found recaptcha iframe');
          if (document.querySelector('script[src*="recaptcha"]')) results.push('found recaptcha script');
          if (document.querySelector('.h-captcha')) results.push('found .h-captcha');
          return results;
        });
        if (captchaDebug.length > 0) {
          logger.warn(`Captcha elements found but not detected: ${captchaDebug.join(', ')}`);
        }
      }

      // Save screenshot before submit
      await this.saveDebugScreenshot(page, 'before-submit');

      // Step 3.5: Check agreement checkbox before submit
      logger.info('Step 3.5: Checking agreement checkboxes...');
      await this.checkAgreementCheckboxes(page);

      // Check for VISIBLE validation errors only
      const errors = await page.evaluate(() => {
        const errorElements = document.querySelectorAll('.js_error, .error-message');
        const errors: string[] = [];
        errorElements.forEach(el => {
          const htmlEl = el as HTMLElement;
          const text = htmlEl.innerText?.trim();
          // Only count visible errors with actual content
          if (text && text.length > 0 && text.length < 100 && htmlEl.offsetParent !== null) {
            errors.push(text);
          }
        });
        return errors;
      });

      if (errors.length > 0) {
        logger.warn(`Form validation errors: ${errors.join('; ')}`);
        // Don't submit if there are real validation errors
        if (errors.some(e => e.includes('ошибка') || e.includes('error'))) {
          await this.saveDebugScreenshot(page, 'validation-error');
          return { success: false, error: `Form validation failed: ${errors.join('; ')}` };
        }
      }

      // Step 3.6: Close any chat widgets that might interfere
      await this.closeChatWidgets(page);

      // Step 3.7: Check if form is valid (no blocking errors)
      const formValid = await page.evaluate(() => {
        // Check if there are blocking validation errors
        const errorElements = document.querySelectorAll('.js_error, .error-message, .field-error');
        let hasBlockingError = false;

        errorElements.forEach(el => {
          const text = (el as HTMLElement).innerText?.trim() || '';
          const isVisible = (el as HTMLElement).offsetParent !== null;
          // Skip "max/min" limit messages that are just informational
          if (isVisible && text && !text.includes('max') && !text.includes('min') && text.length < 100) {
            hasBlockingError = true;
          }
        });

        // Also check HTML5 validation
        const form = document.querySelector('form.xchange_form, form') as HTMLFormElement;
        const isFormValid = form ? form.checkValidity() : true;

        return { hasBlockingError, isFormValid };
      });

      if (formValid.hasBlockingError) {
        logger.warn('Form has blocking validation errors');
      }
      if (!formValid.isFormValid) {
        logger.warn('Form HTML5 validation failed');
      }

      // Step 4: Click "Обменять" submit button
      logger.info('Step 4: Clicking submit button');
      const urlBeforeSubmit = page.url();

      // Set up network request monitoring for AJAX detection
      const ajaxRequests: string[] = [];
      const responseHandler = (response: any) => {
        const url = response.url();
        if (url.includes('exchange') || url.includes('order') || url.includes('submit') || url.includes('ajax')) {
          ajaxRequests.push(`${response.status()} ${url}`);
        }
      };
      page.on('response', responseHandler);

      // Try to wait for navigation OR AJAX response after clicking submit
      try {
        await Promise.race([
          Promise.all([
            page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => null),
            this.clickSubmitButton(page)
          ]),
          // Wait for AJAX response
          page.waitForResponse(resp =>
            resp.url().includes('exchange') || resp.url().includes('order'), { timeout: 10000 }
          ).catch(() => null),
          page.waitForTimeout(10000)
        ]);
      } catch {
        // Navigation didn't happen, just click and wait
        await this.clickSubmitButton(page);
        await page.waitForTimeout(3000);
      }

      // Log AJAX requests
      if (ajaxRequests.length > 0) {
        logger.info(`AJAX requests after submit: ${ajaxRequests.join(', ')}`);
      } else {
        logger.warn('No AJAX requests detected after submit');
      }
      page.off('response', responseHandler);

      // Debug: screenshot immediately after submit
      await this.saveDebugScreenshot(page, 'after-submit');

      // Check current URL - did we navigate?
      const urlAfterSubmit = page.url();
      logger.info(`URL after submit: ${urlAfterSubmit}`);

      // Check for validation errors after submit
      const postSubmitErrors = await page.evaluate(() => {
        const results: string[] = [];
        // Check for error classes on inputs
        const errorInputs = document.querySelectorAll('.error, .is-invalid, [class*="error"], input:invalid');
        errorInputs.forEach(el => {
          const name = (el as HTMLInputElement).name || (el as HTMLElement).className;
          const parent = el.closest('.xchange_sum_input, .form-group');
          const errorMsg = parent?.querySelector('.js_error')?.textContent?.trim();
          if (errorMsg) {
            results.push(`${name}: ${errorMsg}`);
          }
        });
        // Also check for visible error messages
        const visibleErrors = document.querySelectorAll('.js_error:not(:empty)');
        visibleErrors.forEach(el => {
          const text = (el as HTMLElement).innerText?.trim();
          if (text && text.length > 0 && (el as HTMLElement).offsetParent !== null) {
            results.push(text);
          }
        });
        return results;
      });

      if (postSubmitErrors.length > 0) {
        logger.warn(`Post-submit errors: ${postSubmitErrors.join('; ')}`);
      }

      // Step 4.5: Check for captcha AFTER submit (some sites show captcha after first submit)
      logger.info('Step 4.5: Checking for captcha after submit...');
      const postSubmitCaptcha = await detectCaptcha(page);
      logger.info(`Post-submit captcha check - hasCaptcha: ${postSubmitCaptcha.hasCaptcha}, type: ${postSubmitCaptcha.type}, siteKey: ${postSubmitCaptcha.siteKey?.substring(0, 20) || 'none'}`);

      if (postSubmitCaptcha.hasCaptcha) {
        logger.info(`Solving ${postSubmitCaptcha.type} captcha after submit...`);
        const captchaSolution = await solveCaptcha(page);
        if (!captchaSolution.success) {
          logger.error(`Captcha solving failed: ${captchaSolution.error}`);
          return { success: false, error: `Captcha failed: ${captchaSolution.error}` };
        }
        logger.info('Captcha solved! Re-clicking submit...');
        await page.waitForTimeout(2000);
        // Re-click submit after solving captcha
        await this.clickSubmitButton(page);
        await page.waitForTimeout(3000);
        await this.saveDebugScreenshot(page, 'after-captcha-submit');
      }

      // Step 4.6: Check for BLOCKING errors (bot detection, geo-block, temp email block)
      const blockingError = await page.evaluate(() => {
        const errorTexts = [
          'не можете проводить транзакции',
          'вы заблокированы',
          'доступ заблокирован',
          'access denied',
          'подозрительная активность',
          'suspicious activity',
          'временно заблокирован',
          'temporarily blocked',
          'bot detected',
          'автоматический запрос',
          'automated request',
          'слишком много попыток',
          'too many attempts',
          'email не принимается',
          'email запрещен',
          'временный email',
          'temp email',
          'disposable email'
        ];

        // These are AML warnings shown to ALL users, not actual blocks
        const amlWarnings = [
          'запрещенными платформами',
          'capitalist',
          'aml политик',
          'правила обмена',
          'отмывание денег'
        ];

        const bodyText = document.body?.innerText?.toLowerCase() || '';

        // Check for error messages in alerts/popups
        const alertElements = document.querySelectorAll('.swal2-popup, .alert, .error, [class*="error"], [role="alert"]');
        let alertText = '';
        alertElements.forEach(el => {
          if ((el as HTMLElement).offsetParent !== null) {
            alertText += ' ' + (el as HTMLElement).innerText?.toLowerCase();
          }
        });

        const allText = bodyText + ' ' + alertText;

        for (const errorText of errorTexts) {
          if (allText.includes(errorText)) {
            // Check if this is just an AML warning (shown to everyone)
            const isAmlWarning = amlWarnings.some(w => allText.includes(w));

            // Skip AML warnings - they are informational, not blocking
            if (isAmlWarning && !allText.includes('не можете') && !allText.includes('заблокирован')) {
              continue;
            }

            // Find the exact error message
            const errorMatch = allText.match(new RegExp(`.{0,30}${errorText}.{0,50}`, 'i'));
            return errorMatch ? errorMatch[0].trim() : errorText;
          }
        }

        return null;
      });

      if (blockingError) {
        logger.error(`Transaction blocked by exchanger: ${blockingError}`);
        await this.saveDebugScreenshot(page, 'transaction-blocked');
        return { success: false, error: `Exchanger blocked transaction: ${blockingError}` };
      }

      // Step 5: Handle confirmation popup (ФИО confirmation)
      // Wait for popup to appear (SweetAlert2 or similar)
      logger.info('Step 5: Looking for confirmation popup...');

      // Try to find and click confirm button in popup
      const popupHandled = await this.handleConfirmationPopup(page);
      if (popupHandled) {
        logger.info('Popup confirmed');
      } else {
        logger.info('No popup found or already handled');
      }
      await page.waitForTimeout(2000);

      // Debug: screenshot after popup handling
      await this.saveDebugScreenshot(page, 'after-popup-handling');

      // Save screenshot after popup
      await this.saveDebugScreenshot(page, 'after-popup');

      // Step 6: Wait for email and enter verification code
      logger.info('Step 6: Waiting for verification email...');
      const domain = new URL(page.url()).hostname;
      const verificationCode = await getVerificationCode(tempMailbox, new RegExp(domain, 'i'), 120000);

      if (!verificationCode) {
        await this.saveDebugScreenshot(page, 'no-email-code');
        return { success: false, error: 'Email verification code not received' };
      }

      logger.info(`Step 6: Got verification code: ${verificationCode}`);

      // Enter code if it's a numeric code (not a link)
      if (/^\d+$/.test(verificationCode)) {
        await this.enterVerificationCode(page, verificationCode);
        await page.waitForTimeout(2000);
      } else if (verificationCode.startsWith('http')) {
        // It's a confirmation link - navigate to it
        await page.goto(verificationCode, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
      }

      // Step 7: Accept AML policy checkbox
      logger.info('Step 7: Accepting AML policy');
      await this.acceptAmlPolicy(page);
      await page.waitForTimeout(1000);

      // Step 8: Click "Создать заявку" button
      logger.info('Step 8: Creating order');
      await this.clickCreateOrderButton(page);
      await page.waitForTimeout(3000);

      // Step 9: Click "Перейти к оплате" and handle new tab
      logger.info('Step 9: Going to payment page');
      const paymentPage = await this.goToPaymentPage(page);

      // Step 10: Extract deposit address from payment page
      logger.info('Step 10: Extracting deposit address');
      const extracted = await this.extractDepositAddress(paymentPage);

      if (!extracted.address) {
        await this.saveDebugScreenshot(paymentPage, 'no-address');
        return { success: false, error: 'Could not extract deposit address' };
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
      // Cleanup temp mailbox
      if (tempMailbox) {
        await deleteTempMailbox(tempMailbox).catch(() => {});
      }
    }
  }

  private buildExchangeUrl(baseUrl: string, fromCurrency: string, toCurrency: string): string {
    const url = new URL(baseUrl);
    // Normalize currency codes for different CMS variations
    const normalizedFrom = this.normalizeCurrencyCode(fromCurrency);
    const normalizedTo = this.normalizeCurrencyCode(toCurrency);
    return `${url.origin}/exchange_${normalizedFrom}_to_${normalizedTo}/`;
  }

  /**
   * Normalize currency codes for different CMS variations
   * Different exchangers use different codes for the same currencies
   */
  private normalizeCurrencyCode(code: string): string {
    const mappings: Record<string, string[]> = {
      // Original code -> [alternatives to try]
      'SBPRUB': ['SBERRUB', 'SBPRUB', 'SBRUB', 'CARDSBERRUB'],
      'CARDRUB': ['CARDRUB', 'TCSBRUB', 'ACRUB', 'SBERRUB'],
      'BTC': ['BTC', 'BITCOIN'],
      'ETH': ['ETH', 'ETHEREUM'],
      'USDTTRC20': ['USDTTRC20', 'USDTTRC', 'USDTTRX', 'TRCUSDT'],
      'USDTERC20': ['USDTERC20', 'USDTERC', 'USDTETH', 'ERCUSDT'],
    };

    // Return original if no mapping found
    return mappings[code]?.[0] || code;
  }

  /**
   * Get alternative currency code variations to try
   */
  private getCurrencyVariations(code: string): string[] {
    const variations: Record<string, string[]> = {
      'SBPRUB': ['SBERRUB', 'SBPRUB', 'SBRUB', 'CARDSBERRUB', 'SBERBANKSPP'],
      'CARDRUB': ['CARDRUB', 'TCSBRUB', 'ACRUB', 'SBERRUB', 'CARDSBERRUB'],
      'BTC': ['BTC', 'BITCOIN'],
      'ETH': ['ETH', 'ETHEREUM', 'ETHERC20'],
      'USDTTRC20': ['USDTTRC20', 'USDTTRC', 'USDTTRX', 'TRCUSDT', 'USDTRON'],
      'USDTERC20': ['USDTERC20', 'USDTERC', 'USDTETH', 'ERCUSDT', 'USDETH'],
    };
    return variations[code] || [code];
  }

  private async selectCurrenciesViaUI(page: Page, fromCurrency: string, toCurrency: string): Promise<void> {
    logger.info(`Selecting currencies via UI: ${fromCurrency} -> ${toCurrency}`);

    // Map currency codes to readable names for search
    const currencyNames: Record<string, string[]> = {
      'BTC': ['BTC', 'Bitcoin', 'Биткоин'],
      'ETH': ['ETH', 'Ethereum', 'Эфириум'],
      'USDTTRC20': ['USDT TRC20', 'Tether TRC20', 'USDT TRC-20', 'TRC20', 'USDT'],
      'USDTERC20': ['USDT ERC20', 'Tether ERC20', 'USDT ERC-20', 'ERC20'],
      'LTC': ['LTC', 'Litecoin', 'Лайткоин'],
      'CARDUAH': ['UAH', 'Приватбанк', 'Карта UAH', 'ПриватБанк', 'Monobank', 'Visa UAH', 'Украина'],
      'SBPRUB': ['Сбербанк', 'СБП', 'SBP', 'Сбербанк RUB', 'SBER'],
      'CARDRUB': ['Тинькофф', 'Tinkoff', 'Альфа-Банк', 'Alfa', 'Карта RUB', 'Card RUB']
    };

    const fromNames = currencyNames[fromCurrency] || [fromCurrency];
    const toNames = currencyNames[toCurrency] || [toCurrency];

    // Strategy 1: Classic dropdown selectors
    let selected = await this.tryDropdownSelection(page, fromCurrency, toCurrency);
    if (selected) return;

    // Strategy 2: List-based UI (click currency in list, then direction)
    selected = await this.tryListBasedSelection(page, fromNames, toNames);
    if (selected) return;

    // Strategy 3: Click on elements containing currency text
    selected = await this.tryTextBasedSelection(page, fromNames, toNames);
    if (selected) return;

    logger.warn('Could not select currencies via UI');
  }

  private async tryDropdownSelection(page: Page, fromCurrency: string, toCurrency: string): Promise<boolean> {
    // Classic dropdown selectors
    const fromSelectors = [
      '.xchange_select1 .cur_label',
      '.from-currency .cur_label',
      '#select1 .cur_label',
      '.select_cur1',
      '[data-currency-from]'
    ];

    for (const selector of fromSelectors) {
      try {
        const fromSelect = await page.$(selector);
        if (fromSelect && await fromSelect.isVisible()) {
          await fromSelect.click();
          await page.waitForTimeout(500);

          const fromOption = await page.$(`[data-cur="${fromCurrency}"], [data-currency="${fromCurrency}"], .cur_item:has-text("${fromCurrency}")`);
          if (fromOption) {
            await fromOption.click();
            logger.info(`Selected from currency via dropdown: ${fromCurrency}`);
            await page.waitForTimeout(1000);

            // Now select "to" currency
            const toSelectors = ['.xchange_select2 .cur_label', '.to-currency .cur_label', '#select2 .cur_label'];
            for (const toSel of toSelectors) {
              const toSelect = await page.$(toSel);
              if (toSelect && await toSelect.isVisible()) {
                await toSelect.click();
                await page.waitForTimeout(500);
                const toOption = await page.$(`[data-cur="${toCurrency}"], [data-currency="${toCurrency}"], .cur_item:has-text("${toCurrency}")`);
                if (toOption) {
                  await toOption.click();
                  logger.info(`Selected to currency via dropdown: ${toCurrency}`);
                  await page.waitForTimeout(2000);
                  return true;
                }
              }
            }
          }
        }
      } catch { continue; }
    }
    return false;
  }

  private async tryListBasedSelection(page: Page, fromNames: string[], toNames: string[]): Promise<boolean> {
    // List-based UI: currencies listed on the left, directions on the right
    // First find and click the "from" currency in the LEFT list
    for (const name of fromNames) {
      try {
        // Look for currency in LEFT column/list only
        const leftListSelectors = [
          `.currency-list:first-child li:has-text("${name}")`,
          `.left-column li:has-text("${name}")`,
          `.cur_list:first-of-type .cur_item:has-text("${name}")`,
          `nav li:has-text("${name}")`,
          `.sidebar li:has-text("${name}")`,
          // Generic but prefer first/left elements
          `li:has-text("${name}")`
        ];

        for (const selector of leftListSelectors) {
          const el = await page.$(selector);
          if (el && await el.isVisible()) {
            await el.click();
            logger.info(`Clicked from currency in left list: ${name}`);
            await page.waitForTimeout(2000); // Wait for right panel to update

            // Now look for "to" direction in RIGHT column only
            // The right column should now show exchange directions
            for (const toName of toNames) {
              // Search specifically in right/second column
              const rightSelectors = [
                // Right column specific selectors
                `.right-column a:has-text("${toName}")`,
                `.directions a:has-text("${toName}")`,
                `.exchange-directions a:has-text("${toName}")`,
                `table td a:has-text("${toName}")`,
                // Look for links in the main content area (not sidebar)
                `main a:has-text("${toName}")`,
                `.content a:has-text("${toName}")`,
                // Table-based layouts - look in table rows
                `tr a:has-text("${toName}")`,
                `tr:has-text("${toName}") a`,
                // Generic links containing the target
                `a[href*="exchange"][href*="${toName.toLowerCase().replace(/\s+/g, '')}"]`,
                `a[href*="to-${toName.toLowerCase().replace(/\s+/g, '')}"]`
              ];

              for (const toSel of rightSelectors) {
                try {
                  const toEl = await page.$(toSel);
                  if (toEl && await toEl.isVisible()) {
                    // Make sure this is not the same element we clicked before
                    const href = await toEl.getAttribute('href');
                    if (href && !href.includes(`-to-${name.toLowerCase()}`)) {
                      await toEl.click();
                      logger.info(`Clicked direction in right panel: ${toName}`);
                      await page.waitForTimeout(2000);
                      return true;
                    }
                  }
                } catch { continue; }
              }
            }
            break;
          }
        }
      } catch { continue; }
    }
    return false;
  }

  private async tryTextBasedSelection(page: Page, fromNames: string[], toNames: string[]): Promise<boolean> {
    // Generic text-based clicking - but smarter
    // First click on "from" currency, then find exchange LINK to "to" direction
    for (const fromName of fromNames) {
      try {
        // Find clickable element with "from" currency name
        // Prefer elements in nav, sidebar, or currency lists (LEFT side)
        const fromSelectors = [
          `nav li:has-text("${fromName}")`,
          `.sidebar li:has-text("${fromName}")`,
          `.currency-list li:has-text("${fromName}")`,
          `.cur_list li:has-text("${fromName}")`,
          `li:has-text("${fromName}")`,
          `a:has-text("${fromName}")`
        ];

        let fromClicked = false;
        for (const sel of fromSelectors) {
          try {
            const el = await page.$(sel);
            if (el && await el.isVisible()) {
              await el.click();
              logger.info(`Clicked from currency: ${fromName}`);
              fromClicked = true;
              await page.waitForTimeout(2000); // Wait for directions to appear
              break;
            }
          } catch { continue; }
        }

        if (!fromClicked) {
          // Fallback to simple text match
          const el = await page.locator(`text=${fromName}`).first();
          if (await el.isVisible()) {
            await el.click();
            logger.info(`Clicked from text: ${fromName}`);
            fromClicked = true;
            await page.waitForTimeout(2000);
          }
        }

        if (!fromClicked) continue;

        // Now find exchange LINK (not just text) to "to" direction
        // The link should lead to exchange page like /exchange-btc-to-sber/
        for (const toName of toNames) {
          // Build possible URL patterns
          const fromCode = fromName.toLowerCase().replace(/\s+/g, '');
          const toCode = toName.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');

          // Search for links that lead to the exchange direction
          const linkSelectors = [
            // Links containing exchange direction in href
            `a[href*="-to-${toCode}"]`,
            `a[href*="-to-sber"]`,
            `a[href*="_to_${toCode}"]`,
            `a[href*="exchange"][href*="${toCode}"]`,
            // Links in right/main content area (not sidebar)
            `main a:has-text("${toName}")`,
            `.content a:has-text("${toName}")`,
            `.directions a:has-text("${toName}")`,
            `table a:has-text("${toName}")`,
            // Links with both currencies in href (btc-to-sber pattern)
            `a[href*="${fromCode}"][href*="${toCode}"]`
          ];

          for (const linkSel of linkSelectors) {
            try {
              const links = await page.$$(linkSel);
              for (const link of links) {
                if (await link.isVisible()) {
                  const href = await link.getAttribute('href') || '';
                  // Make sure it's the right direction (from -> to, not to -> from)
                  const isCorrectDirection =
                    href.includes(`${fromCode}-to-`) ||
                    href.includes(`${fromCode}_to_`) ||
                    href.includes(`exchange-${fromCode}`) ||
                    href.includes(`exchange_${fromCode}`);

                  // Avoid clicking on the wrong direction
                  const isWrongDirection =
                    href.includes(`${toCode}-to-`) ||
                    href.includes(`${toCode}_to_`) ||
                    href.includes(`exchange-${toCode}`) ||
                    href.includes(`exchange_${toCode}`);

                  if (!isWrongDirection || isCorrectDirection) {
                    await link.click();
                    logger.info(`Clicked exchange link: ${href}`);
                    await page.waitForTimeout(2000);
                    return true;
                  }
                }
              }
            } catch { continue; }
          }
        }
      } catch { continue; }
    }
    return false;
  }

  /**
   * Fallback method using old hardcoded selectors
   */
  private async tryFallbackFill(page: Page, data: ExchangeFormData, email: string): Promise<{ success: boolean }> {
    logger.info('Using fallback fill method...');

    // Try old selectors for amount
    const amountFilled = await this.fillAmount(page, data.amount);
    if (!amountFilled) {
      return { success: false };
    }

    // Try old selectors for card/wallet
    const cardValue = this.getCardForCurrency(data.toCurrency);
    const recipientFilled = await this.fillRecipientDetails(page, cardValue);

    // Try old selectors for personal data
    await this.fillPersonalData(page, email);

    return { success: amountFilled };
  }

  private getCardForCurrency(toCurrency: string): string {
    if (toCurrency.includes('UAH') || toCurrency.includes('CARDUAH')) {
      return config.formCardUA;
    }
    if (toCurrency.includes('SBER') || toCurrency.includes('CARD') || toCurrency.includes('RUB')) {
      return config.formCard || config.formPhone;
    }
    if (toCurrency.includes('SBP')) {
      return config.formPhone;
    }
    return config.formWalletBTC;
  }

  private async fillAmount(page: Page, amount: number): Promise<boolean> {
    // Extended selectors for amount field
    const amountSelectors = [
      'input[name="sum1"]',
      'input.js_summ1',
      '#sum1',
      '.xchange_sum_input input',
      '.sum_input input',
      'input[placeholder*="сумм"]',
      'input[placeholder*="amount"]',
      '.exchange-form input[type="text"]:first-of-type',
      '.form-give input',
      'input.give-amount',
      '[data-field="amount"] input',
      '.amount-input'
    ];

    // Try to fill via JavaScript first (more reliable)
    const filled = await page.evaluate(([amt, sels]: [number, string[]]) => {
      for (const sel of sels) {
        const input = document.querySelector(sel) as HTMLInputElement;
        if (input && input.offsetParent !== null) { // Check if visible
          input.value = String(amt);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
          return sel;
        }
      }
      return null;
    }, [amount, amountSelectors] as [number, string[]]);

    if (filled) {
      logger.info(`Amount filled via JS using selector: ${filled}`);
      await page.waitForTimeout(1000);
      return true;
    }

    // Fallback to Playwright methods
    const selectors = amountSelectors;

    for (const selector of selectors) {
      try {
        const input = await page.$(selector);
        if (input) {
          await input.scrollIntoViewIfNeeded();
          await input.click({ force: true });
          await input.fill(String(amount));
          return true;
        }
      } catch (e) {
        logger.info(`Selector ${selector} failed: ${e}`);
        continue;
      }
    }

    return false;
  }

  private async fillRecipientDetails(page: Page, value: string): Promise<boolean> {
    // Try JavaScript first
    const filled = await page.evaluate((val) => {
      const selectors = [
        'input[name="account2"]',
        'input#account2',
        'input.js_account2',
        'input.cardaccount'
      ];
      for (const sel of selectors) {
        const input = document.querySelector(sel) as HTMLInputElement;
        if (input) {
          input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, value);

    if (filled) {
      logger.info('Recipient details filled via JS');
      return true;
    }

    // Fallback
    const selectors = [
      'input[name="account2"]',
      'input#account2',
      'input.js_account2',
      'input.cardaccount'
    ];

    for (const selector of selectors) {
      try {
        const input = await page.$(selector);
        if (input) {
          await input.scrollIntoViewIfNeeded();
          await input.click({ force: true });
          await input.fill(value);
          return true;
        }
      } catch { continue; }
    }
    return false;
  }

  private async fillPersonalData(page: Page, email: string): Promise<void> {
    // Fill name/FIO via JavaScript
    await page.evaluate((fio) => {
      const nameSelectors = [
        'input[name="cf6"]',
        'input#cf6',
        'input[name*="fio"]',
        'input[placeholder*="ФИО"]',
        'input[placeholder*="имя"]'
      ];
      for (const sel of nameSelectors) {
        const input = document.querySelector(sel) as HTMLInputElement;
        if (input) {
          input.value = fio;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    }, config.formFio);
    logger.info('FIO filled via JS');

    // Fill email via JavaScript
    await page.evaluate((emailVal) => {
      const emailSelectors = [
        'input[name="email"]',
        'input[type="email"]',
        'input[placeholder*="email"]',
        '#email'
      ];
      for (const sel of emailSelectors) {
        const input = document.querySelector(sel) as HTMLInputElement;
        if (input) {
          input.value = emailVal;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    }, email);
    logger.info('Email filled via JS');
  }

  private async clickSubmitButton(page: Page): Promise<boolean> {
    // Try JavaScript click first
    const clicked = await page.evaluate(() => {
      const selectors = [
        'input.xchange_submit[type="submit"]',
        '.xchange_submit',
        '.js_exchange_link',
        'button[type="submit"]',
        'input[type="submit"]',
        'input[value="Обменять"]',
        'input[value="Продолжить"]',
        'button:contains("Продолжить")',
        'input[value="продолжить"]'
      ];

      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel) as HTMLElement;
          if (btn && btn.offsetParent !== null) {
            btn.click();
            return sel;
          }
        } catch { /* ignore */ }
      }

      // Fallback: find button by text content
      const buttons = document.querySelectorAll('button, input[type="submit"]');
      for (const btn of Array.from(buttons)) {
        const text = (btn as HTMLElement).innerText?.toLowerCase() ||
                     (btn as HTMLInputElement).value?.toLowerCase() || '';
        if (text.includes('обменять') || text.includes('продолжить') ||
            text.includes('создать') || text.includes('далее')) {
          if ((btn as HTMLElement).offsetParent !== null) {
            (btn as HTMLElement).click();
            return 'text-match: ' + text.substring(0, 20);
          }
        }
      }

      return null;
    });

    if (clicked) {
      logger.info(`Submit button clicked via JS: ${clicked}`);
      return true;
    }

    // Fallback to Playwright - try text-based locators first (most reliable)
    const textLocators = ['Продолжить', 'Обменять', 'Создать заявку', 'Далее', 'Submit'];
    for (const text of textLocators) {
      try {
        const btn = page.locator(`text="${text}"`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          logger.info(`Submit clicked via Playwright text locator: ${text}`);
          return true;
        }
      } catch { /* continue */ }
    }

    // Try CSS selectors
    const submitSelectors = [
      'input.xchange_submit[type="submit"]',
      '.xchange_submit',
      '.js_exchange_link',
      'input[type="submit"]',
      'button[type="submit"]',
      'form button',
      '.exchange-btn'
    ];

    for (const selector of submitSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn && await btn.isVisible()) {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ force: true });
          logger.info(`Submit clicked via Playwright CSS selector: ${selector}`);
          return true;
        }
      } catch { continue; }
    }

    // Last resort: try form.submit()
    const submitted = await page.evaluate(() => {
      const form = document.querySelector('form.xchange_form, form');
      if (form) {
        (form as HTMLFormElement).submit();
        return true;
      }
      return false;
    });
    if (submitted) {
      logger.info('Form submitted via form.submit()');
      return true;
    }

    return false;
  }

  private async handleConfirmationPopup(page: Page): Promise<boolean> {
    // Wait for popup to appear
    await page.waitForTimeout(1500);

    // Look for OK/Confirm button in popup (SweetAlert2, custom popups)
    const okSelectors = [
      '.swal2-confirm',           // SweetAlert2
      '.swal2-actions button',
      'button.swal2-confirm',
      '.sweet-alert button.confirm',
      'button:has-text("ок")',
      'button:has-text("OK")',
      'button:has-text("Да")',
      '.confirm-btn',
      '[data-action="confirm"]',
      '.modal-footer button.btn-primary',
      '.popup-confirm'
    ];

    for (const selector of okSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn && await btn.isVisible()) {
          logger.info(`Found popup button: ${selector}`);
          await btn.click();
          return true;
        }
      } catch { continue; }
    }

    // Try JavaScript click on swal2 confirm
    const clicked = await page.evaluate(() => {
      // SweetAlert2
      const swalBtn = document.querySelector('.swal2-confirm') as HTMLElement;
      if (swalBtn) {
        swalBtn.click();
        return true;
      }
      // Generic confirm button
      const confirmBtn = document.querySelector('[class*="confirm"]') as HTMLElement;
      if (confirmBtn && confirmBtn.offsetParent !== null) {
        confirmBtn.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      logger.info('Popup confirmed via JS');
      return true;
    }

    // Try pressing Enter as fallback
    await page.keyboard.press('Enter');
    return false;
  }

  private async enterVerificationCode(page: Page, code: string): Promise<void> {
    const codeSelectors = [
      'input[name*="code"]',
      'input[placeholder*="код"]',
      'input[placeholder*="code"]',
      'input[type="text"]:visible',
      '.verification-input input'
    ];

    for (const selector of codeSelectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await input.fill(code);
          logger.info('Verification code entered');

          // Click OK button if present
          const okBtn = await page.$('button:has-text("OK"), button:has-text("Подтвердить")');
          if (okBtn && await okBtn.isVisible()) {
            await okBtn.click();
          }
          return;
        }
      } catch { continue; }
    }
  }

  private async checkAgreementCheckboxes(page: Page): Promise<void> {
    // Use JavaScript approach - faster and more reliable
    const jsChecked = await page.evaluate(() => {
      let count = 0;
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      const results: string[] = [];

      checkboxes.forEach(cb => {
        const input = cb as HTMLInputElement;
        // Skip if already checked
        if (input.checked) {
          results.push(`checkbox ${input.name || input.id || 'unnamed'}: already checked`);
          return;
        }

        // Get context to determine if it's an agreement checkbox
        // Check label element
        const label = cb.closest('label')?.textContent?.toLowerCase() || '';

        // Check parent container (div, p, span, td)
        const parent = cb.closest('div, p, span, td, tr, form');
        const parentText = parent?.textContent?.toLowerCase() || '';

        // Check next sibling text
        const nextSibling = cb.nextSibling;
        const nextText = nextSibling?.textContent?.toLowerCase() || '';

        // Check for label with for attribute pointing to this checkbox
        const forLabel = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
        const forLabelText = forLabel?.textContent?.toLowerCase() || '';

        // Get name and id
        const name = (input.name || '').toLowerCase();
        const id = (input.id || '').toLowerCase();

        // Check all text sources for agreement keywords
        const allText = `${label} ${parentText} ${nextText} ${forLabelText}`;
        const isAgreement =
          allText.includes('согласен') || allText.includes('прочитал') ||
          allText.includes('принимаю') || allText.includes('agree') ||
          allText.includes('правил') || allText.includes('услови') ||
          allText.includes('aml') || allText.includes('политик') ||
          name.includes('agree') || name.includes('terms') ||
          name.includes('policy') || name.includes('rules') ||
          name.includes('aml') || name.includes('sog') ||
          id.includes('agree') || id.includes('terms') ||
          id.includes('aml') || id.includes('sog');

        results.push(`checkbox ${input.name || input.id || 'unnamed'}: isAgreement=${isAgreement}, text="${allText.substring(0, 50)}..."`);

        if (isAgreement) {
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('click', { bubbles: true }));
          // Also try clicking the label if it exists
          const clickableLabel = cb.closest('label') || forLabel;
          if (clickableLabel) {
            (clickableLabel as HTMLElement).click();
          }
          count++;
        }
      });

      // Log results for debugging
      console.log('Checkbox detection results:', results);
      return count;
    });

    if (jsChecked > 0) {
      logger.info(`Checked ${jsChecked} agreement checkbox(es) via JS`);
    } else {
      logger.info('No agreement checkboxes found via JS, trying all visible checkboxes...');

      // Fallback: check ALL visible unchecked checkboxes in form (aggressive approach)
      const checkedAll = await page.evaluate(() => {
        let count = 0;
        const checkboxes = document.querySelectorAll('form input[type="checkbox"], .xchange_form input[type="checkbox"]');
        checkboxes.forEach(cb => {
          const input = cb as HTMLInputElement;
          if (!input.checked && input.offsetParent !== null) {
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            count++;
          }
        });
        return count;
      });

      if (checkedAll > 0) {
        logger.info(`Checked ${checkedAll} checkbox(es) via aggressive fallback`);
      } else {
        // Last resort: try Playwright click
        try {
          const formCheckboxes = await page.$$('.xchange_form input[type="checkbox"], form input[type="checkbox"]');
          let clicked = 0;
          for (const cb of formCheckboxes.slice(0, 5)) {
            try {
              const isChecked = await cb.isChecked();
              if (!isChecked) {
                await cb.click({ timeout: 2000 });
                clicked++;
              }
            } catch { /* ignore */ }
          }
          if (clicked > 0) {
            logger.info(`Checked ${clicked} checkbox(es) via Playwright click`);
          }
        } catch (e) {
          logger.warn(`Checkbox fallback failed: ${e}`);
        }
      }
    }
  }

  private async closeChatWidgets(page: Page): Promise<void> {
    // Close common chat widgets that might interfere with form submission
    const closed = await page.evaluate(() => {
      const closedWidgets: string[] = [];

      // Common chat widget close button selectors
      const closeSelectors = [
        // Jivo Chat
        '.jivo-close-btn', 'button[data-jivo-close]', '.jivo_close_btn',
        '[class*="jivo"] [class*="close"]', '[id*="jivo"] [class*="close"]',
        // Tawk.to
        '.tawk-min-container', '[class*="tawk"] [class*="close"]',
        // Crisp
        '[data-chat-close]', '.crisp-client [class*="close"]',
        // LiveChat
        '[class*="livechat"] [class*="close"]', '.lc-1g17fy5',
        // Generic close buttons in chat-like widgets
        '[class*="chat"][class*="widget"] [class*="close"]',
        '[class*="chat"] button[class*="close"]',
        '[id*="chat"] [class*="close"]',
        // Minimize buttons
        '[class*="chat"][class*="minimize"]', '[class*="chat"] [class*="min"]'
      ];

      for (const selector of closeSelectors) {
        try {
          const buttons = document.querySelectorAll(selector);
          buttons.forEach(btn => {
            if ((btn as HTMLElement).offsetParent !== null) {
              (btn as HTMLElement).click();
              closedWidgets.push(selector);
            }
          });
        } catch { /* ignore */ }
      }

      // Try to hide chat containers completely
      const chatContainers = document.querySelectorAll(
        '[class*="jivo"], [id*="jivo"], [class*="tawk"], [id*="tawk"], ' +
        '[class*="crisp"], [id*="crisp"], [class*="livechat"], ' +
        '[class*="chat-widget"], [class*="chat-container"]'
      );
      chatContainers.forEach(el => {
        (el as HTMLElement).style.display = 'none';
        closedWidgets.push('hidden: ' + el.className.substring(0, 30));
      });

      return closedWidgets;
    });

    if (closed.length > 0) {
      logger.info(`Closed/hidden chat widgets: ${closed.join(', ')}`);
    }
  }

  private async acceptAmlPolicy(page: Page): Promise<void> {
    const checkboxSelectors = [
      'input[name*="aml"]',
      'input[name*="agree"]',
      'input[type="checkbox"]:not(:checked)',
      '.aml-checkbox input',
      'label:has-text("AML") input'
    ];

    for (const selector of checkboxSelectors) {
      try {
        const checkbox = await page.$(selector);
        if (checkbox) {
          const isChecked = await checkbox.isChecked();
          if (!isChecked) {
            await checkbox.click();
            logger.info('AML checkbox accepted');
          }
        }
      } catch { continue; }
    }
  }

  private async clickCreateOrderButton(page: Page): Promise<void> {
    const selectors = [
      'button:has-text("создать заявку")',
      'button:has-text("Создать заявку")',
      'input[value*="Создать"]',
      '.create-order-btn',
      'button[type="submit"]'
    ];

    for (const selector of selectors) {
      try {
        const btn = await page.$(selector);
        if (btn && await btn.isVisible()) {
          await btn.click();
          return;
        }
      } catch { continue; }
    }
  }

  private async goToPaymentPage(page: Page): Promise<Page> {
    // Listen for new tab/popup
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 30000 }).catch(() => null),
      (async () => {
        const selectors = [
          'button:has-text("Перейти к оплате")',
          'a:has-text("Перейти к оплате")',
          'button:has-text("перейти к оплате")',
          '.payment-btn',
          'a[href*="payment"]'
        ];

        for (const selector of selectors) {
          try {
            const btn = await page.$(selector);
            if (btn && await btn.isVisible()) {
              await btn.click();
              return;
            }
          } catch { continue; }
        }
      })()
    ]);

    // Return new page if opened, otherwise current page
    if (newPage) {
      await newPage.waitForLoadState('domcontentloaded');
      return newPage;
    }

    return page;
  }

  private async extractDepositAddress(page: Page): Promise<{ address?: string; network?: string; memo?: string }> {
    // Wait for content to load
    await page.waitForTimeout(2000);

    return page.evaluate(() => {
      const result: { address?: string; network?: string; memo?: string } = {};

      const addressPatterns = [
        /\b(bc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
        /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,
        /\b(0x[a-fA-F0-9]{40})\b/,
        /\b(T[a-zA-Z0-9]{33})\b/,
        /\b([LM][a-km-zA-HJ-NP-Z1-9]{26,33})\b/,
        /\b(ltc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
      ];

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
    });
  }

  private async saveDebugScreenshot(page: Page, suffix: string): Promise<void> {
    try {
      const timestamp = Date.now();
      const screenshotPath = `debug-premium-${suffix}-${timestamp}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info(`Debug screenshot saved: ${screenshotPath}`);
    } catch { /* ignore */ }
  }
}
