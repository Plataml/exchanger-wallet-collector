import { Page } from 'playwright';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { EngineType } from './detector';
import { detectCaptcha, solveCaptcha } from '../captcha';
import { logger } from '../logger';

export class MultipageEngine extends BaseEngine {
  type: EngineType = 'multipage';
  name = 'Multi-page Exchange';

  async canHandle(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      // Check for URL-based exchange pair pattern
      const hasExchangeUrls = Array.from(document.querySelectorAll('a')).some(a =>
        /exchange_\w+_to_\w+|\/exchange\/\w+\/\w+/.test(a.href)
      );
      const hasSumFields = !!document.querySelector('[name="sum1"], [name="summ1"], .js_summ1, .js_summ2');
      return hasExchangeUrls || hasSumFields;
    });
  }

  async collectAddress(page: Page, data: ExchangeFormData): Promise<CollectionResult> {
    try {
      // Step 1: Navigate to specific exchange pair page
      const exchangeUrl = await this.findExchangePairUrl(page, data.fromCurrency, data.toCurrency);

      if (exchangeUrl) {
        await page.goto(exchangeUrl, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(1500);
      }

      // Step 2: Fill amount
      const amountFilled = await this.fillField(page, [
        '[name="sum1"], [name="summ1"], .js_summ1 input',
        '#sum1, #summ1, #amount',
        '[name="amount"], [name="sum"]',
        'input[placeholder*="сумм"], input[placeholder*="amount"]'
      ], String(data.amount));

      if (!amountFilled) {
        return { success: false, error: 'Could not fill amount field' };
      }

      // Wait for rate calculation
      await page.waitForTimeout(1000);

      // Step 3: Fill wallet/card for outgoing
      const outgoingFilled = await this.fillField(page, [
        '[name="wallet"], [name="account2"], [name="requisites"]',
        '#wallet, #account2, #requisites',
        '[placeholder*="кошел"], [placeholder*="wallet"], [placeholder*="адрес"]',
        '[name="card"], [name="cardnumber"]'
      ], data.wallet);

      if (!outgoingFilled) {
        return { success: false, error: 'Could not fill wallet/card field' };
      }

      // Step 4: Fill email
      await this.fillField(page, [
        '[name="email"], [type="email"]',
        '#email',
        '[placeholder*="email"], [placeholder*="почт"]'
      ], data.email);

      // Step 5: Fill name if required
      if (data.name) {
        await this.fillField(page, [
          '[name="fio"], [name="name"], [name="fullname"]',
          '[placeholder*="ФИО"], [placeholder*="имя"]'
        ], data.name);
      }

      // Step 6: Fill incoming card if required
      if (data.cardNumber) {
        await this.fillField(page, [
          '[name="card1"], [name="cardnumber"], [name="account1"]',
          '#card1, #cardnumber',
          '[placeholder*="карт"]'
        ], data.cardNumber);
      }

      // Step 7: Accept terms
      await this.acceptTerms(page);

      // Step 7.5: Solve captcha if present
      const captchaDetection = await detectCaptcha(page);
      if (captchaDetection.hasCaptcha) {
        logger.info(`Captcha detected: ${captchaDetection.type}`);
        const captchaSolution = await solveCaptcha(page);
        if (!captchaSolution.success) {
          return { success: false, error: `Captcha failed: ${captchaSolution.error}` };
        }
        logger.info('Captcha solved successfully');
      }

      // Step 8: Submit form
      const submitted = await this.clickElement(page, [
        'button[type="submit"]',
        '#submit, .submit, .btn-submit',
        '[name="submit"], [value="submit"]',
        'button:has-text("Обменять"), button:has-text("Создать заявку")',
        'input[type="submit"]'
      ]);

      if (!submitted) {
        return { success: false, error: 'Could not find submit button' };
      }

      // Step 9: Handle multi-step flow (some exchangers have confirmation page)
      await page.waitForTimeout(2000);

      // Check if there's a confirmation step
      const hasConfirmation = await page.$('button:has-text("Подтвердить"), button:has-text("Confirm")');
      if (hasConfirmation) {
        await hasConfirmation.click();
        await page.waitForTimeout(2000);
      }

      // Step 10: Wait for order/result page
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Step 11: Extract address
      const extracted = await this.extractAddress(page);

      if (!extracted.address) {
        // Maybe address is on a separate payment page
        const paymentLink = await page.$('a:has-text("Оплатить"), a:has-text("Pay"), a[href*="pay"]');
        if (paymentLink) {
          await paymentLink.click();
          await page.waitForTimeout(3000);
          const paymentExtracted = await this.extractAddress(page);
          if (paymentExtracted.address) {
            return {
              success: true,
              address: paymentExtracted.address,
              network: paymentExtracted.network,
              memo: paymentExtracted.memo
            };
          }
        }

        // Save debug screenshot
        const timestamp = Date.now();
        const screenshotPath = `debug-multipage-${timestamp}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`Debug screenshot saved: ${screenshotPath}`);

        // Also log the page URL and HTML snippet
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
    }
  }

  private async findExchangePairUrl(page: Page, from: string, to: string): Promise<string | null> {
    // Map common currency names to URL codes
    const currencyMap: Record<string, string[]> = {
      'BTC': ['BTC', 'bitcoin'],
      'ETH': ['ETH', 'ethereum'],
      'USDT': ['USDT', 'USDTTRC20', 'USDTERC20', 'tether'],
      'SBER': ['SBERRUB', 'SBPRUB', 'sberbank'],
      'CARD_RUB': ['CARDRUB', 'VISARUB', 'MCRUB'],
      'CARD_UAH': ['CARDUAH', 'VISAUAH']
    };

    const fromCodes = currencyMap[from] || [from];
    const toCodes = currencyMap[to] || [to];

    // Try to find matching link
    const links = await page.$$eval('a[href]', (anchors) =>
      anchors.map(a => ({ href: (a as HTMLAnchorElement).href, text: a.textContent || '' }))
    );

    for (const fromCode of fromCodes) {
      for (const toCode of toCodes) {
        const patterns = [
          new RegExp(`exchange_${fromCode}_to_${toCode}`, 'i'),
          new RegExp(`/exchange/${fromCode}/${toCode}`, 'i'),
          new RegExp(`/${fromCode}-to-${toCode}`, 'i')
        ];

        for (const link of links) {
          for (const pattern of patterns) {
            if (pattern.test(link.href)) {
              return link.href;
            }
          }
        }
      }
    }

    return null;
  }

  private async acceptTerms(page: Page): Promise<void> {
    const checkboxSelectors = [
      '#agree:not(:checked), [name="agree"]:not(:checked)',
      '[type="checkbox"][name*="rule"]:not(:checked)',
      '[type="checkbox"][name*="term"]:not(:checked)',
      'label:has-text("согласен") input:not(:checked)',
      'label:has-text("agree") input:not(:checked)'
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
