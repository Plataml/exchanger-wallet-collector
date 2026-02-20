import { Page } from 'playwright';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { EngineType } from './detector';
import { detectCaptcha, solveCaptcha } from '../captcha';
import { logger } from '../logger';
import { config } from '../config';
import { humanClick } from '../utils/human-mouse';

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
    const interceptor = this.createInterceptor(page);

    try {
      // Wait for Vue app to mount
      await page.waitForTimeout(2000);

      // Step 0: Select currencies via UI (URL params often don't work)
      logger.info(`Selecting currencies: ${data.fromCurrency} -> ${data.toCurrency}`);
      await this.selectCurrencyViaUI(page, 'from', data.fromCurrency);
      await page.waitForTimeout(1000);
      await this.selectCurrencyViaUI(page, 'to', data.toCurrency);
      await page.waitForTimeout(1000);

      // Step 1: Fill amount (crypto amount like 0.003 BTC)
      // 365cash uses textbox with placeholder like "0.00235518 – 0.09420711 BTC"
      const amountSelectors = [
        'input[placeholder*="BTC"], input[placeholder*="ETH"], input[placeholder*="USDT"]',
        '[name*="sum"], [name*="amount"]',
        '[class*="amount"] input, [class*="sum"] input',
        'input[type="number"]:first-of-type',
        '.give input, .from input'
      ];

      let amountFilled = false;
      for (const selector of amountSelectors) {
        try {
          const inputs = await page.$$(selector);
          for (const input of inputs) {
            if (await input.isVisible()) {
              await input.fill(String(data.amount));
              amountFilled = true;
              logger.info(`Amount filled: ${data.amount}`);
              break;
            }
          }
          if (amountFilled) break;
        } catch { continue; }
      }

      if (!amountFilled) {
        // Try by placeholder text pattern (365cash style)
        try {
          const textbox = await page.$('input[placeholder*="–"]');
          if (textbox && await textbox.isVisible()) {
            await textbox.fill(String(data.amount));
            amountFilled = true;
            logger.info(`Amount filled via placeholder pattern: ${data.amount}`);
          }
        } catch {}
      }
      await page.waitForTimeout(500);

      // Step 2: Fill phone number for СБП transfers (Crypto -> Fiat direction)
      if (data.phone) {
        const phoneSelectors = [
          '[name*="phone"], [name*="Requisites.phone"]',
          '[placeholder*="телефон"], [placeholder*="phone"]',
          '[type="tel"]',
          'input[placeholder*="9"]'
        ];

        let phoneFilled = false;
        for (const selector of phoneSelectors) {
          try {
            const input = await page.$(selector);
            if (input && await input.isVisible()) {
              // Phone may need +7 prefix
              const phoneValue = data.phone.startsWith('+') ? data.phone : `+7${data.phone}`;
              await input.fill(phoneValue);
              phoneFilled = true;
              logger.info(`Phone number filled: ${phoneValue}`);
              break;
            }
          } catch { continue; }
        }
      }

      // Step 3: Select bank from combobox/dropdown
      if (data.bank) {
        const bankSelected = await this.selectBankFromCombobox(page, data.bank);
        if (bankSelected) {
          logger.info(`Bank selected: ${data.bank}`);
        }
      }

      // Step 4: Fill email
      await this.fillField(page, [
        '[name="email"], [type="email"]',
        '[placeholder*="email"], [placeholder*="почт"]',
        '[name*="Requisites.email"]'
      ], data.email);
      logger.info('Email filled');

      // Step 5: Accept terms checkbox if exists
      await this.acceptTerms(page);

      // Step 6: First try to submit WITHOUT solving captcha
      // Many sites show captcha but don't require it, or solve it client-side
      logger.info('Attempting form submission...');

      // Step 7: Submit main form - click "Обменять" button
      interceptor.start();
      let submitted = false;

      // Try multiple approaches to click the submit button
      const submitSelectors = [
        'button:has-text("Обменять")',
        'button:has-text("Exchange")',
        'button[type="submit"]',
        'text=Обменять'
      ];

      for (const selector of submitSelectors) {
        try {
          const btn = await page.$(selector);
          if (btn && await btn.isVisible()) {
            await humanClick(page, btn, { enabled: config.humanMouse });
            submitted = true;
            logger.info('Clicked submit button');
            break;
          }
        } catch { continue; }
      }

      // Fallback: try clicking by role
      if (!submitted) {
        try {
          await page.getByRole('button', { name: 'Обменять' }).click();
          submitted = true;
          logger.info('Clicked submit via getByRole');
        } catch {}
      }

      if (!submitted) {
        return { success: false, error: 'Could not find submit button' };
      }

      // Step 8: Wait for page transition
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Check if we need to solve captcha (still on main page)
      const currentUrl = page.url();
      const stillOnMainPage = !currentUrl.includes('/order/');

      if (stillOnMainPage) {
        // Try solving captcha and submitting again
        const captchaDetection = await detectCaptcha(page);
        if (captchaDetection.hasCaptcha) {
          logger.info(`Page didn't transition, solving captcha: ${captchaDetection.type}`);
          const captchaSolution = await solveCaptcha(page);
          if (captchaSolution.success) {
            logger.info('Captcha solved, retrying submit...');
            await page.waitForTimeout(1000);

            // Try clicking submit again
            for (const selector of ['button:has-text("Обменять")', 'text=Обменять']) {
              try {
                const btn = await page.$(selector);
                if (btn && await btn.isVisible()) {
                  await btn.click();
                  logger.info('Clicked submit after captcha');
                  break;
                }
              } catch { continue; }
            }

            await page.waitForTimeout(3000);
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          }
        }
      }

      // Step 9: Handle intermediate terms/confirmation page (2-step flow)
      const handledIntermediate = await this.handleIntermediatePage(page);
      if (handledIntermediate) {
        logger.info('Handled intermediate confirmation page');
        await page.waitForTimeout(3000);
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      }

      // Step 10: Extract deposit address from order page (cascade: DOM -> iframe -> API)
      let extracted = await this.extractDepositAddress(page);

      if (!extracted.address) {
        const enhanced = await this.extractAddressEnhanced(page, interceptor);
        if (enhanced.address) {
          extracted = { address: enhanced.address, network: enhanced.network, memo: enhanced.memo };
        }
      }

      if (!extracted.address) {
        // Save debug screenshot
        const timestamp = Date.now();
        const screenshotPath = `debug-vue-spa-${timestamp}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`Debug screenshot saved: ${screenshotPath}`);

        // Log page URL and text for debugging
        const currentUrl = page.url();
        const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '');
        logger.info(`Current URL: ${currentUrl}`);
        logger.info(`Page text preview: ${bodyText.substring(0, 500)}...`);

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
    } finally {
      interceptor.stop();
    }
  }

  // Handle intermediate confirmation/terms page (365cash style)
  private async handleIntermediatePage(page: Page): Promise<boolean> {
    try {
      // Check if we're on intermediate page with terms
      const hasTermsPage = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        return text.includes('Информация о выполняемом обмене') ||
               text.includes('Порядок действий') ||
               (text.includes('Согласен') && text.includes('Правилами'));
      });

      if (!hasTermsPage) {
        return false;
      }

      logger.info('Detected intermediate confirmation page');

      // 365cash.co style: click on agreement text (not checkbox)
      // The text "Согласен с Правилами сайта..." is clickable
      try {
        const agreementText = await page.$('text=Согласен с');
        if (agreementText && await agreementText.isVisible()) {
          await agreementText.click();
          logger.info('Clicked agreement text');
          await page.waitForTimeout(500);
        }
      } catch {}

      // Also try standard checkboxes
      await this.acceptTerms(page);
      await page.waitForTimeout(500);

      // Click the submit/exchange button
      const submitSelectors = [
        'button:has-text("Обменять")',
        'button:has-text("Подтвердить")',
        'button:has-text("Продолжить")',
        'button:has-text("Создать заявку")',
        'button[type="submit"]'
      ];

      for (const selector of submitSelectors) {
        try {
          const btn = await page.$(selector);
          if (btn && await btn.isVisible()) {
            await btn.click();
            logger.info('Clicked submit on intermediate page');
            return true;
          }
        } catch { continue; }
      }

      return false;
    } catch (error) {
      logger.warn(`Error handling intermediate page: ${error}`);
      return false;
    }
  }

  // Extract deposit address from order page (e.g., "Переводите 0.003 BTC на кошелек ADDRESS")
  private async extractDepositAddress(page: Page): Promise<{ address?: string; network?: string; memo?: string }> {
    return page.evaluate(() => {
      const result: { address?: string; network?: string; memo?: string } = {};

      // Crypto address patterns
      const addressPatterns = [
        // Bitcoin (Legacy, SegWit, Native SegWit)
        /\b(bc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
        /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,
        // Ethereum/ERC20
        /\b(0x[a-fA-F0-9]{40})\b/,
        // Tron/TRC20
        /\b(T[a-zA-Z0-9]{33})\b/,
        // Litecoin
        /\b([LM][a-km-zA-HJ-NP-Z1-9]{26,33})\b/,
        /\b(ltc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
        // TON
        /\b(EQ[a-zA-Z0-9_-]{46,48})\b/,
        /\b(UQ[a-zA-Z0-9_-]{46,48})\b/,
      ];

      // First try: Look for address in specific context (Russian exchanger patterns)
      const bodyText = document.body?.innerText || '';

      // Pattern: "на кошелек ADDRESS" or "на адрес ADDRESS"
      const walletMatch = bodyText.match(/на\s+(?:кошел[её]к|адрес)\s*[:\s]*([a-zA-Z0-9_-]{26,62})/i);
      if (walletMatch) {
        const potentialAddress = walletMatch[1];
        // Validate it matches a crypto pattern
        for (const pattern of addressPatterns) {
          if (pattern.test(potentialAddress)) {
            result.address = potentialAddress;
            break;
          }
        }
      }

      // Second try: Look for copy buttons/elements
      if (!result.address) {
        const copySelectors = [
          '[data-copy], [data-clipboard-text]',
          '.copy-address, .wallet-address, .crypto-address',
          '[class*="address"] [class*="copy"]',
          'button[class*="copy"]'
        ];

        for (const selector of copySelectors) {
          const elements = Array.from(document.querySelectorAll(selector));
          for (const el of elements) {
            const text = el.getAttribute('data-clipboard-text') ||
                        (el as HTMLElement).innerText ||
                        el.getAttribute('data-copy') || '';
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
      }

      // Third try: Scan all text for address patterns
      if (!result.address) {
        for (const pattern of addressPatterns) {
          const match = bodyText.match(pattern);
          if (match) {
            result.address = match[1];
            break;
          }
        }
      }

      // Fourth try: Look in input fields (readonly/disabled)
      if (!result.address) {
        const inputs = Array.from(document.querySelectorAll('input[readonly], input[disabled], input.readonly'));
        for (const input of inputs) {
          const value = (input as HTMLInputElement).value;
          for (const pattern of addressPatterns) {
            const match = value.match(pattern);
            if (match) {
              result.address = match[1];
              break;
            }
          }
          if (result.address) break;
        }
      }

      // Try to detect network from context
      if (result.address) {
        const lowerText = bodyText.toLowerCase();
        if (lowerText.includes('trc20') || lowerText.includes('tron')) {
          result.network = 'TRC20';
        } else if (lowerText.includes('erc20') || lowerText.includes('ethereum')) {
          result.network = 'ERC20';
        } else if (lowerText.includes('bep20') || lowerText.includes('bsc')) {
          result.network = 'BEP20';
        } else if (result.address.startsWith('bc1') || result.address.startsWith('1') || result.address.startsWith('3')) {
          result.network = 'BTC';
        } else if (result.address.startsWith('T')) {
          result.network = 'TRC20';
        } else if (result.address.startsWith('0x')) {
          result.network = 'ERC20';
        } else if (result.address.startsWith('EQ') || result.address.startsWith('UQ')) {
          result.network = 'TON';
        }
      }

      // Look for memo/tag
      const memoMatch = bodyText.match(/(?:memo|tag|destination)[:\s]*(\d+)/i);
      if (memoMatch) {
        result.memo = memoMatch[1];
      }

      return result;
    });
  }

  // Select currency via UI clicks (for sites where URL params don't work)
  private async selectCurrencyViaUI(page: Page, direction: 'from' | 'to', currency: string): Promise<boolean> {
    try {
      // Map currency codes to display names
      const currencyNames: Record<string, string[]> = {
        'BTC': ['Bitcoin', 'BTC'],
        'ETH': ['Ethereum', 'ETH'],
        'USDTTRC20': ['Tether TRC20', 'USDT TRC20', 'Tether (TRC20)'],
        'USDTERC20': ['Tether ERC20', 'USDT ERC20', 'Tether (ERC20)'],
        'USDT': ['Tether', 'USDT'],
        'SBPRUB': ['СБП RUB', 'СБП', 'SBP RUB'],
        'SBERRUB': ['Сбербанк RUB', 'Сбербанк', 'Sberbank'],
        'TINKOFFRUB': ['Т-Банк', 'Тинькофф', 'Tinkoff']
      };

      // Determine which section to look in
      const isFromSection = direction === 'from';
      const sectionText = isFromSection ? 'Отдаете' : 'Получаете';

      // First, try to find the section by looking for headers
      const sections = await page.$$('text=' + sectionText);

      // For crypto currencies, first click on "КРИПТОВАЛЮТЫ" tab
      const isCrypto = ['BTC', 'ETH', 'USDTTRC20', 'USDTERC20', 'USDT', 'LTC'].includes(currency);
      const isFiat = ['SBPRUB', 'SBERRUB', 'TINKOFFRUB', 'RUB'].includes(currency);

      if (isCrypto) {
        // Click on "КРИПТОВАЛЮТЫ" tab in the appropriate section
        const cryptoTab = isFromSection
          ? await page.$('text=КРИПТОВАЛЮТЫ >> nth=0')
          : await page.$('text=КРИПТОВАЛЮТЫ >> nth=1');
        if (cryptoTab && await cryptoTab.isVisible()) {
          await cryptoTab.click();
          await page.waitForTimeout(500);
          logger.info(`Clicked КРИПТОВАЛЮТЫ tab (${direction})`);
        }
      } else if (isFiat) {
        // Click on "СБП" or appropriate fiat tab
        const sbpTab = isFromSection
          ? await page.$('text=СБП >> nth=0')
          : await page.$('text=СБП >> nth=1');
        if (sbpTab && await sbpTab.isVisible()) {
          await sbpTab.click();
          await page.waitForTimeout(500);
          logger.info(`Clicked СБП tab (${direction})`);
        }
      }

      // Now click on the specific currency
      const names = currencyNames[currency] || [currency];
      for (const name of names) {
        // Try to find and click the currency option
        const options = await page.$$(`text=${name}`);
        for (const option of options) {
          if (await option.isVisible()) {
            // Check if this is in the correct section (from or to)
            const box = await option.boundingBox();
            if (box) {
              // Simple heuristic: "from" section is on the left half, "to" on right
              const pageWidth = await page.evaluate(() => window.innerWidth);
              const isLeftSide = box.x < pageWidth / 2;

              if ((isFromSection && isLeftSide) || (!isFromSection && !isLeftSide)) {
                await option.click();
                logger.info(`Selected currency: ${name} (${direction})`);
                return true;
              }
            }
          }
        }
      }

      // Fallback: try clicking any matching text
      for (const name of names) {
        try {
          await page.click(`text=${name}`, { timeout: 2000 });
          logger.info(`Selected currency (fallback): ${name}`);
          return true;
        } catch {
          continue;
        }
      }

      logger.warn(`Could not select currency: ${currency} (${direction})`);
      return false;
    } catch (error) {
      logger.warn(`Error selecting currency: ${error}`);
      return false;
    }
  }

  // Select bank from combobox (365cash.co style)
  private async selectBankFromCombobox(page: Page, bank: string): Promise<boolean> {
    try {
      // Try native select/combobox first
      const combobox = await page.$('select, [role="combobox"]');
      if (combobox) {
        const tagName = await combobox.evaluate(el => el.tagName.toLowerCase());
        if (tagName === 'select') {
          // Try exact match first, then partial
          try {
            await combobox.selectOption({ label: bank });
            return true;
          } catch {
            // Try partial match
            const options = await combobox.$$('option');
            for (const opt of options) {
              const text = await opt.textContent();
              if (text && text.includes('Сбербанк')) {
                await combobox.selectOption({ label: text });
                return true;
              }
            }
          }
        }
      }

      // Fallback: click on bank selector dropdown
      const bankSelectors = [
        '[class*="bank"] select',
        '[placeholder*="банк"]',
        '[class*="select"][class*="bank"]'
      ];

      for (const selector of bankSelectors) {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          await element.click();
          await page.waitForTimeout(300);
          const option = await page.$(`text=${bank}`);
          if (option) {
            await option.click();
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private async selectBank(page: Page, bank: string): Promise<boolean> {
    return this.selectBankFromCombobox(page, bank);
  }

  private async acceptTerms(page: Page): Promise<void> {
    const checkboxSelectors = [
      '[type="checkbox"]:not(:checked)',
      '[class*="checkbox"]:not(.checked)',
      '[id*="agree"], [name*="agree"], [name*="terms"]',
      '[class*="v-checkbox"]:not(.checked)',
      'label:has-text("согласен") input[type="checkbox"]'
    ];

    for (const selector of checkboxSelectors) {
      try {
        const checkboxes = await page.$$(selector);
        for (const checkbox of checkboxes) {
          if (await checkbox.isVisible()) {
            await checkbox.click().catch(() => {});
            await page.waitForTimeout(100);
          }
        }
      } catch {
        continue;
      }
    }
  }
}
