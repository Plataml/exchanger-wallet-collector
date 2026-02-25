import { Page } from 'playwright';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * Get card/phone value based on target currency and resolved URL
 * SBP (System for Quick Payments) requires phone number
 * Sberbank/card transfers require card number
 */
export function getCardForCurrency(toCurrency: string, resolvedUrl?: string): string {
  if (toCurrency.includes('UAH') || toCurrency.includes('CARDUAH')) {
    return config.formCardUA;
  }

  // URL-based detection is most reliable (resolvedUrl = actual exchange page URL)
  const url = (resolvedUrl || '').toLowerCase();
  if (url) {
    // Check for Sberbank first (sber* URLs need card number)
    if (url.includes('sber')) {
      logger.info(`getCardForCurrency: URL contains 'sber' → using card`);
      return config.formCard || config.formPhone;
    }
    // SBP URLs need phone number
    if (url.includes('sbp')) {
      logger.info(`getCardForCurrency: URL contains 'sbp' → using phone`);
      return config.formPhone;
    }
  }

  // Currency code fallback (when no URL or URL doesn't match)
  if (toCurrency.includes('SBER')) {
    return config.formCard || config.formPhone;
  }
  if (toCurrency.includes('SBP')) {
    return config.formPhone;
  }
  if (toCurrency.includes('CARD') || toCurrency.includes('RUB')) {
    return config.formCard || config.formPhone;
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
 * Note: cf* fields can be anything (email, FIO, etc.) — check labels first
 */
export async function fillPersonalData(page: Page, email: string): Promise<void> {
  // Fill FIO — only use selectors known to be FIO fields
  const fioFilled = await page.evaluate((fio) => {
    const selectors = [
      'input[name*="fio"]',
      'input[placeholder*="ФИО"]',
      'input[placeholder*="Фамилия"]',
      'input[placeholder*="имя"]',
      'input[placeholder*="ваше имя"]',
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

    // Check PremiumBox cf* fields by their <label> text
    const cfInputs = document.querySelectorAll('input[name^="cf"]');
    for (const el of Array.from(cfInputs)) {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden' || input.offsetParent === null || input.value) continue;
      if (input.name.startsWith('cfget')) continue; // phone fields
      // Check label
      const labelEl = document.querySelector(`label[for="${input.id}"]`);
      const labelText = (labelEl?.textContent || '').toLowerCase();
      if (labelText.includes('mail') || labelText.includes('почт')) continue; // email field, not FIO
      if (labelText.includes('фио') || labelText.includes('имя') || labelText.includes('name') || labelText.includes('фамил')) {
        input.focus();
        input.value = fio;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        return `${input.name} (label: ${labelText.trim()})`;
      }
    }

    return null;
  }, config.formFio);

  if (fioFilled) {
    logger.info(`Filled FIO field: ${fioFilled}`);
  }

  // Fill email — check exchange form fields and PremiumBox cf* email fields
  const emailFilled = await page.evaluate((emailVal) => {
    const selectors = [
      'input[name="email"]',
      'input[type="email"]',
      'input[placeholder*="email"]',
      'input[placeholder*="e-mail"]',
      '#email'
    ];

    // Also find PremiumBox cf* fields labeled as email
    const cfInputs = document.querySelectorAll('input[name^="cf"]');
    for (const el of Array.from(cfInputs)) {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden' || input.offsetParent === null || input.value) continue;
      if (input.name.startsWith('cfget')) continue;
      const labelEl = document.querySelector(`label[for="${input.id}"]`);
      const labelText = (labelEl?.textContent || '').toLowerCase();
      if (labelText.includes('mail') || labelText.includes('почт')) {
        selectors.unshift(`#${input.id}`); // Add to beginning with highest priority
      }
    }

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

}

/**
 * Fill any unselected <select> dropdowns (bank selector for SBP, etc.)
 * For bank selects, prefer Сбербанк; for others, pick the first meaningful option
 */
export async function fillSelectDropdowns(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const filled: string[] = [];
    const skipped: string[] = [];
    const selects = document.querySelectorAll('select');

    for (const sel of Array.from(selects)) {
      const htmlSel = sel as HTMLSelectElement;
      // Skip currency selectors (already chosen by navigation)
      const id = (htmlSel.id || '').toLowerCase();
      if (id === 'select_give' || id === 'select_get') continue;

      // Skip selects inside registration/profile forms (form_field_id-*)
      if (id.startsWith('form_field_id')) continue;
      if (htmlSel.closest('.userwalletsform, .rb_form, [id*="userwallets"]')) continue;

      // Skip if already has a meaningful value
      if (htmlSel.value && htmlSel.value !== '' && htmlSel.value !== '0') {
        skipped.push(`${htmlSel.name || htmlSel.id}=${htmlSel.value}`);
        continue;
      }

      const options = Array.from(htmlSel.options);
      if (options.length <= 1) continue;

      // Check if this is a bank selector
      const name = (htmlSel.name || '').toLowerCase();
      const labelEl = document.querySelector(`label[for="${htmlSel.id}"]`);
      const labelText = (labelEl?.textContent || '').toLowerCase();
      const context = `${name} ${id} ${labelText}`;
      const isBankSelector = context.includes('банк') || context.includes('bank') ||
        context.includes('платеж') || context.includes('payment') ||
        context.includes('получатель') || context.includes('sbp') || context.includes('сбп') ||
        name.startsWith('cfget');

      let selectedValue = '';

      if (isBankSelector) {
        // Prefer Sberbank for bank selectors
        const preferredBanks = ['сбербанк', 'sberbank', 'сбер', 'sber'];
        for (const bank of preferredBanks) {
          const match = options.find(o => o.text.toLowerCase().includes(bank));
          if (match && match.value && match.value !== '0') {
            selectedValue = match.value;
            break;
          }
        }
      }

      // Fallback: select first non-empty, non-placeholder option
      if (!selectedValue) {
        const meaningful = options.find(o =>
          o.value && o.value !== '' && o.value !== '0' &&
          !o.text.toLowerCase().includes('выбрать') &&
          !o.text.toLowerCase().includes('выберите') &&
          !o.text.toLowerCase().includes('не выбрано') &&
          !o.text.toLowerCase().includes('--')
        );
        if (meaningful) {
          selectedValue = meaningful.value;
        }
      }

      if (selectedValue) {
        htmlSel.value = selectedValue;
        htmlSel.dispatchEvent(new Event('change', { bubbles: true }));
        htmlSel.dispatchEvent(new Event('input', { bubbles: true }));
        const selectedText = options.find(o => o.value === selectedValue)?.text || selectedValue;
        filled.push(`${htmlSel.name || htmlSel.id}: ${selectedText.trim()}`);
      }
    }

    return { filled, skipped };
  });

  if (result.skipped.length > 0) {
    logger.debug(`Select dropdowns already filled: ${result.skipped.join(', ')}`);
  }
  if (result.filled.length > 0) {
    for (const f of result.filled) {
      logger.info(`Filled select: ${f}`);
    }
  } else {
    logger.debug(`No select dropdowns needed filling (found ${result.skipped.length} already filled)`);
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
