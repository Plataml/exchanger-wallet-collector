import { Page } from 'playwright';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * Get card/phone value based on target currency
 */
export function getCardForCurrency(toCurrency: string): string {
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

/**
 * Fill amount field
 */
export async function fillAmount(page: Page, amount: number): Promise<boolean> {
  const selectors = [
    'input[name="sum1"]',
    'input.js_summ1',
    '#sum1',
    '.xchange_sum_input input',
    '.sum_input input',
    'input[placeholder*="сумм"]',
    'input[placeholder*="amount"]',
    '.form-give input',
    '.amount-input'
  ];

  const filled = await page.evaluate(([amt, sels]: [number, string[]]) => {
    for (const sel of sels) {
      const input = document.querySelector(sel) as HTMLInputElement;
      if (input && input.offsetParent !== null) {
        input.value = String(amt);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return sel;
      }
    }
    return null;
  }, [amount, selectors] as [number, string[]]);

  if (filled) {
    logger.info(`Amount filled: ${filled}`);
    return true;
  }

  // Fallback to Playwright
  for (const selector of selectors) {
    try {
      const input = await page.$(selector);
      if (input) {
        await input.fill(String(amount));
        return true;
      }
    } catch { continue; }
  }

  return false;
}

/**
 * Fill recipient details (card/wallet)
 */
export async function fillRecipientDetails(page: Page, value: string): Promise<boolean> {
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
    logger.info('Recipient details filled');
    return true;
  }
  return false;
}

/**
 * Fill personal data (FIO, email)
 */
export async function fillPersonalData(page: Page, email: string): Promise<void> {
  // Fill FIO
  await page.evaluate((fio) => {
    const selectors = [
      'input[name="cf6"]',
      'input#cf6',
      'input[name*="fio"]',
      'input[placeholder*="ФИО"]',
      'input[placeholder*="имя"]'
    ];
    for (const sel of selectors) {
      const input = document.querySelector(sel) as HTMLInputElement;
      if (input) {
        input.value = fio;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        break;
      }
    }
  }, config.formFio);

  // Fill email
  await page.evaluate((emailVal) => {
    const selectors = [
      'input[name="email"]',
      'input[type="email"]',
      'input[placeholder*="email"]',
      '#email'
    ];
    for (const sel of selectors) {
      const input = document.querySelector(sel) as HTMLInputElement;
      if (input) {
        input.value = emailVal;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        break;
      }
    }
  }, email);

  logger.info('Personal data filled');
}

/**
 * Fallback fill method using old selectors
 */
export async function tryFallbackFill(
  page: Page,
  amount: number,
  toCurrency: string,
  email: string
): Promise<boolean> {
  logger.info('Using fallback fill method...');

  const amountFilled = await fillAmount(page, amount);
  if (!amountFilled) return false;

  const cardValue = getCardForCurrency(toCurrency);
  await fillRecipientDetails(page, cardValue);
  await fillPersonalData(page, email);

  return amountFilled;
}
