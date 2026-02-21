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
 * Fill personal data (FIO, email) — PremiumBox custom fields
 * PremiumBox CMS uses cf2, cf6, cf7 etc. for personal data fields
 */
export async function fillPersonalData(page: Page, email: string): Promise<void> {
  // Fill FIO — try PremiumBox custom fields + generic selectors
  const fioFilled = await page.evaluate((fio) => {
    const selectors = [
      'input[name="cf6"]',
      'input[name="cf2"]',
      'input[name="cf7"]',
      'input#cf6',
      'input#cf2',
      'input[name*="fio"]',
      'input[placeholder*="ФИО"]',
      'input[placeholder*="Фамилия"]',
      'input[placeholder*="имя"]',
      'input[placeholder*="ваше имя"]',
      'input[placeholder*="name"]',
    ];
    for (const sel of selectors) {
      const input = document.querySelector(sel) as HTMLInputElement;
      if (input && input.offsetParent !== null && !input.value) {
        input.focus();
        input.value = fio;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        return sel;
      }
    }
    return null;
  }, config.formFio);

  if (fioFilled) {
    logger.info(`Filled FIO field: ${fioFilled}`);
  }

  // Fill email (only if not already filled)
  const emailFilled = await page.evaluate((emailVal) => {
    const selectors = [
      'input[name="email"]',
      'input[type="email"]',
      'input[placeholder*="email"]',
      'input[placeholder*="e-mail"]',
      '#email'
    ];
    for (const sel of selectors) {
      const input = document.querySelector(sel) as HTMLInputElement;
      if (input && input.offsetParent !== null && !input.value) {
        input.focus();
        input.value = emailVal;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return sel;
      }
    }
    return null;
  }, email);

  if (emailFilled) {
    logger.info(`Filled email field: ${emailFilled}`);
  }

  // Fill any remaining empty visible PremiumBox cf* text fields with FIO
  // These are often required custom fields without recognizable names
  const extraFilled = await page.evaluate((fio) => {
    const filled: string[] = [];
    const cfInputs = document.querySelectorAll('input[name^="cf"]');
    for (const el of Array.from(cfInputs)) {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden' || input.type === 'checkbox' || input.type === 'radio') continue;
      if (input.offsetParent === null) continue; // hidden
      if (input.value) continue; // already filled
      // Skip phone fields (cfget* or has +7 placeholder)
      if (input.name.startsWith('cfget') || (input.placeholder || '').includes('+7')) continue;
      input.focus();
      input.value = fio;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      filled.push(input.name);
    }
    return filled;
  }, config.formFio);

  if (extraFilled.length > 0) {
    logger.info(`Filled extra PremiumBox fields: ${extraFilled.join(', ')}`);
  }
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
