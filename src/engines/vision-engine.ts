import { Page } from 'playwright';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { EngineType } from './detector';
import { VisionAnalyzer, PageAnalysis, FieldMapping, ActionStep } from '../utils/vision-analyzer';
import { detectCaptcha, solveCaptcha } from '../captcha';
import { createTempMailbox, getVerificationCode, deleteTempMailbox, TempMailbox } from '../tempmail';
import { logger } from '../logger';
import { config } from '../config';
import { humanClick } from '../utils/human-mouse';

/**
 * Universal Vision-based engine
 * Uses Claude API to analyze page structure and interact with forms.
 * Acts as last-resort fallback when no specialized engine matches.
 */
export class VisionEngine extends BaseEngine {
  type: EngineType = 'vision';
  name = 'Vision AI Engine';

  private analyzer = new VisionAnalyzer();

  async canHandle(page: Page): Promise<boolean> {
    // Always true — this is the universal fallback
    return config.visionEnabled && !!config.anthropicApiKey;
  }

  async collectAddress(page: Page, data: ExchangeFormData): Promise<CollectionResult> {
    let tempMailbox: TempMailbox | null = null;
    const interceptor = this.createInterceptor(page);

    try {
      // Step 1: Analyze page structure via LLM
      logger.info(`[VISION] Step 1: Analyzing page structure...`);
      const analysis = await this.analyzer.analyzePage(page, {
        fromCurrency: data.fromCurrency,
        toCurrency: data.toCurrency
      });

      if (analysis.confidence < 0.3) {
        await this.saveDebugScreenshot(page, 'low-confidence');
        return { success: false, error: `Page analysis confidence too low: ${analysis.confidence.toFixed(2)}` };
      }

      logger.info(`[VISION] Analysis: layout=${analysis.layout}, confidence=${analysis.confidence.toFixed(2)}, fields=${analysis.fields.length}`);

      // Step 2: Select currencies
      logger.info(`[VISION] Step 2: Selecting currencies ${data.fromCurrency} → ${data.toCurrency}...`);
      await this.selectCurrencies(page, data.fromCurrency, data.toCurrency, analysis);
      await page.waitForTimeout(2000);

      // Step 3: Create temp email if needed
      const emailField = analysis.fields.find(f => f.purpose === 'email');
      if (emailField) {
        tempMailbox = await createTempMailbox();
        logger.info(`[VISION] Using email: ${tempMailbox.email}`);
      }

      // Step 4: Fill form fields
      logger.info(`[VISION] Step 4: Filling ${analysis.fields.length} form fields...`);
      for (const field of analysis.fields) {
        const value = this.getValueForField(field, data, tempMailbox?.email);
        if (value) {
          await this.fillFieldSmart(page, field, value);
          await page.waitForTimeout(500);
        }
      }

      await page.waitForTimeout(1000);
      await this.saveDebugScreenshot(page, 'before-submit');

      // Step 5: Accept terms/checkboxes
      await this.acceptAllCheckboxes(page);

      // Step 6: Handle captcha
      const captcha = await detectCaptcha(page);
      if (captcha.hasCaptcha) {
        logger.info(`[VISION] Solving ${captcha.type} captcha...`);
        const solution = await solveCaptcha(page);
        if (!solution.success) {
          return { success: false, error: `Captcha failed: ${solution.error}` };
        }
      }

      // Step 7: Submit form
      logger.info(`[VISION] Step 7: Submitting form...`);
      interceptor.start();

      if (analysis.submitButton) {
        const clicked = await this.clickSubmit(page, analysis.submitButton.selector, analysis.submitButton.text);
        if (!clicked) {
          return { success: false, error: 'Could not click submit button' };
        }
      } else {
        // Fallback submit attempts
        const clicked = await this.clickElement(page, [
          'button[type="submit"]',
          'button:has-text("Обменять")',
          'button:has-text("Далее")',
          'button:has-text("Создать")',
          'button:has-text("Exchange")',
          'input[type="submit"]'
        ]);
        if (!clicked) {
          return { success: false, error: 'Could not find submit button' };
        }
      }

      await page.waitForTimeout(5000);
      await this.saveDebugScreenshot(page, 'after-submit');

      // Step 8: Email verification if needed
      if (tempMailbox) {
        const needsVerification = await page.evaluate(() => {
          const text = (document.body?.innerText || '').toLowerCase();
          return text.includes('код') || text.includes('подтвердите') || text.includes('verification');
        });

        if (needsVerification) {
          logger.info(`[VISION] Waiting for email verification...`);
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
      }

      // Step 9: Handle confirmation page
      await this.handleConfirmation(page);

      // Step 10: Wait for result page
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Step 11: Extract address (existing cascade + vision fallback)
      logger.info(`[VISION] Step 11: Extracting deposit address...`);
      let extracted = await this.extractAddressEnhanced(page, interceptor);

      if (!extracted.address) {
        // Vision fallback: LLM analyzes the result page screenshot
        logger.info(`[VISION] DOM extraction failed, trying vision analysis...`);
        const visionResult = await this.analyzer.analyzeResultPage(page);
        if (visionResult.address) {
          extracted = visionResult;
        }
      }

      if (!extracted.address) {
        await this.saveDebugScreenshot(page, 'no-address');
        return { success: false, error: 'Could not extract deposit address' };
      }

      logger.info(`[VISION] Success! Address: ${extracted.address} (${extracted.network || 'unknown'})`);
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

  // --- Currency Selection ---

  private async selectCurrencies(
    page: Page,
    from: string,
    to: string,
    analysis: PageAnalysis
  ): Promise<void> {
    // Try "from" currency
    if (analysis.currencySelectors.from) {
      await this.selectSingleCurrency(page, 'from', from, analysis.currencySelectors.from);
      await page.waitForTimeout(1500);
    }

    // Try "to" currency
    if (analysis.currencySelectors.to) {
      await this.selectSingleCurrency(page, 'to', to, analysis.currencySelectors.to);
      await page.waitForTimeout(1500);
    }
  }

  private async selectSingleCurrency(
    page: Page,
    direction: 'from' | 'to',
    currency: string,
    selectorInfo: { selector: string; method: string; searchable: boolean }
  ): Promise<void> {
    try {
      if (selectorInfo.method === 'select') {
        // Native <select>
        const select = await page.$(selectorInfo.selector);
        if (select) {
          await select.selectOption({ label: currency });
          logger.info(`[VISION] Selected ${direction} currency: ${currency} via native select`);
          return;
        }
      }

      // Click to open dropdown
      const el = await page.$(selectorInfo.selector);
      if (!el) {
        logger.warn(`[VISION] Currency selector not found: ${selectorInfo.selector}`);
        // Try LLM-guided approach
        const steps = await this.analyzer.planCurrencySelection(page, direction, currency, selectorInfo as any);
        await this.executeSteps(page, steps);
        return;
      }

      await el.click();
      await page.waitForTimeout(800);

      // If searchable, type currency name
      if (selectorInfo.searchable) {
        const searchInput = await page.$('input[type="search"], input[type="text"]:focus, input[placeholder*="поиск"], input[placeholder*="search"]');
        if (searchInput) {
          await searchInput.fill(currency);
          await page.waitForTimeout(500);
        }
      }

      // Click matching option
      const currencyNames = this.getCurrencyAliases(currency);
      for (const name of currencyNames) {
        try {
          const option = await page.$(`text="${name}"`);
          if (option && await option.isVisible()) {
            await option.click();
            logger.info(`[VISION] Selected ${direction} currency: ${currency} (matched: ${name})`);
            return;
          }
        } catch { continue; }
      }

      // Fallback: try partial text match
      for (const name of currencyNames) {
        try {
          const option = page.locator(`text=${name}`).first();
          if (await option.isVisible({ timeout: 1000 })) {
            await option.click();
            logger.info(`[VISION] Selected ${direction} currency: ${currency} (partial: ${name})`);
            return;
          }
        } catch { continue; }
      }

      logger.warn(`[VISION] Could not select ${direction} currency: ${currency}`);
    } catch (error) {
      logger.error(`[VISION] Currency selection error: ${error}`);
    }
  }

  private getCurrencyAliases(currency: string): string[] {
    const aliases: Record<string, string[]> = {
      'BTC': ['Bitcoin', 'BTC', 'Биткоин'],
      'ETH': ['Ethereum', 'ETH', 'Эфириум'],
      'USDTTRC20': ['Tether TRC20', 'USDT TRC20', 'USDT (TRC20)', 'TRC20'],
      'USDTERC20': ['Tether ERC20', 'USDT ERC20', 'USDT (ERC20)', 'ERC20'],
      'SBPRUB': ['СБП', 'SBP', 'Сбербанк', 'Sberbank'],
      'SBERRUB': ['Сбербанк', 'Sberbank', 'Сбер'],
      'CARDRUB': ['Карта RUB', 'Visa/MC RUB', 'Банковская карта'],
      'LTC': ['Litecoin', 'LTC', 'Лайткоин'],
      'XRP': ['Ripple', 'XRP', 'Рипл'],
    };
    return aliases[currency] || [currency];
  }

  // --- Form Field Filling ---

  private getValueForField(field: FieldMapping, data: ExchangeFormData, email?: string): string | null {
    switch (field.purpose) {
      case 'amount':
        return String(data.amount);
      case 'wallet':
        return data.wallet;
      case 'card':
        return data.cardNumber || config.formCard || config.formPhone;
      case 'email':
        return email || data.email || config.formEmail;
      case 'name':
        return data.name || config.formFio;
      case 'phone':
        return data.phone || config.formPhone;
      default:
        return null;
    }
  }

  private async fillFieldSmart(page: Page, field: FieldMapping, value: string): Promise<boolean> {
    try {
      const el = await page.$(field.selector);
      if (!el) {
        logger.warn(`[VISION] Field not found: ${field.selector} (${field.purpose})`);
        return false;
      }

      if (field.inputType === 'select') {
        await (el as any).selectOption(value);
      } else {
        // Clear and fill
        await el.click();
        await page.waitForTimeout(100);
        await el.fill(value);
        await el.dispatchEvent('input');
        await el.dispatchEvent('change');
      }

      logger.info(`[VISION] Filled ${field.purpose}: ${field.selector} = ${value.substring(0, 20)}${value.length > 20 ? '...' : ''}`);
      return true;
    } catch (error) {
      logger.warn(`[VISION] Failed to fill ${field.purpose} (${field.selector}): ${error}`);

      // Fallback: try JavaScript fill
      try {
        await page.evaluate(([sel, val]: [string, string]) => {
          const input = document.querySelector(sel) as HTMLInputElement;
          if (input) {
            input.focus();
            input.value = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, [field.selector, value] as [string, string]);
        return true;
      } catch {
        return false;
      }
    }
  }

  // --- Submit ---

  private async clickSubmit(page: Page, selector: string, text: string): Promise<boolean> {
    try {
      const btn = await page.$(selector);
      if (btn && await btn.isVisible()) {
        await humanClick(page, btn, { enabled: config.humanMouse });
        logger.info(`[VISION] Clicked submit: ${selector}`);
        return true;
      }
    } catch { /* try fallback */ }

    // Fallback: try by text
    if (text) {
      try {
        const btn = page.locator(`text="${text}"`).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          logger.info(`[VISION] Clicked submit by text: "${text}"`);
          return true;
        }
      } catch { /* fall through */ }
    }

    return false;
  }

  // --- Helpers ---

  private async acceptAllCheckboxes(page: Page): Promise<void> {
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

  private async handleConfirmation(page: Page): Promise<void> {
    const confirmSelectors = [
      'button:has-text("Подтвердить")',
      'button:has-text("Confirm")',
      'button:has-text("Продолжить")',
      'button:has-text("Continue")',
    ];

    for (const selector of confirmSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn && await btn.isVisible()) {
          await btn.click();
          logger.info(`[VISION] Clicked confirmation: ${selector}`);
          await page.waitForTimeout(2000);
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
          logger.info(`[VISION] Verification code entered`);

          const confirmBtn = await page.$('button:has-text("Подтвердить"), button:has-text("OK"), button[type="submit"]');
          if (confirmBtn) await confirmBtn.click();
          return;
        }
      } catch { continue; }
    }
  }

  private async executeSteps(page: Page, steps: ActionStep[]): Promise<void> {
    for (const step of steps) {
      try {
        logger.info(`[VISION] Executing: ${step.description}`);

        switch (step.action) {
          case 'click':
            if (step.selector) {
              const el = await page.$(step.selector);
              if (el) await el.click();
            }
            break;
          case 'fill':
          case 'type':
            if (step.selector && step.value) {
              const el = await page.$(step.selector);
              if (el) {
                if (step.action === 'type') {
                  await el.type(step.value, { delay: 50 });
                } else {
                  await el.fill(step.value);
                }
              }
            }
            break;
          case 'wait':
            await page.waitForTimeout(parseInt(step.value || '1000'));
            break;
        }

        await page.waitForTimeout(300);
      } catch (error) {
        logger.warn(`[VISION] Step failed: ${step.description} — ${error}`);
      }
    }
  }

  private async saveDebugScreenshot(page: Page, suffix: string): Promise<void> {
    try {
      const screenshotPath = `debug-vision-${suffix}-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info(`[VISION] Screenshot: ${screenshotPath}`);
    } catch { /* ignore */ }
  }
}
