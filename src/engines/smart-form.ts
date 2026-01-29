import { Page } from 'playwright';
import { logger } from '../logger';
import { config } from '../config';

/**
 * Detected form field with its purpose
 */
interface DetectedField {
  selector: string;
  purpose: 'amount_from' | 'amount_to' | 'wallet' | 'card' | 'email' | 'name' | 'phone' | 'submit' | 'unknown';
  confidence: number;
  element: {
    tag: string;
    type: string;
    name: string;
    id: string;
    placeholder: string;
    label: string;
  };
}

/**
 * Form data to fill
 */
export interface FormData {
  amount: number;
  wallet?: string;
  card?: string;
  email?: string;
  name?: string;
  phone?: string;
}

/**
 * Smart form analyzer and filler
 * Detects field purposes and fills them appropriately
 */
export class SmartFormFiller {
  private page: Page;
  private detectedFields: DetectedField[] = [];

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Analyze all form fields on the page
   */
  async analyzeForm(): Promise<DetectedField[]> {
    logger.info('SmartFormFiller: Analyzing form fields...');

    this.detectedFields = await this.page.evaluate(() => {
      const fields: any[] = [];

      // Get all input elements
      const inputs = document.querySelectorAll('input, textarea, select, button');

      inputs.forEach((el, index) => {
        const htmlEl = el as HTMLElement;
        const input = el as HTMLInputElement;

        // Skip hidden elements (but allow submit buttons)
        const isVisible = htmlEl.offsetParent !== null ||
          htmlEl.style.display !== 'none' ||
          input.type === 'submit';

        if (!isVisible && input.type !== 'hidden') return;

        const tag = el.tagName.toLowerCase();
        const type = input.type || '';
        const name = (input.name || '').toLowerCase();
        const id = (input.id || '').toLowerCase();
        const placeholder = (input.placeholder || '').toLowerCase();
        const className = (el.className || '').toString().toLowerCase();

        // Find associated label
        let label = '';
        const labelEl = document.querySelector(`label[for="${input.id}"]`);
        if (labelEl) {
          label = (labelEl.textContent || '').toLowerCase().trim();
        }
        // Check parent for label text
        const parent = el.closest('.form-group, .field, .input-wrap, div');
        if (parent && !label) {
          const labelInParent = parent.querySelector('label, .label, span');
          if (labelInParent) {
            label = (labelInParent.textContent || '').toLowerCase().trim();
          }
        }

        // Build selector
        let selector = tag;
        if (input.id) {
          selector = `#${input.id}`;
        } else if (input.name) {
          selector = `${tag}[name="${input.name}"]`;
        } else if (index < 20) {
          selector = `${tag}:nth-of-type(${index + 1})`;
        }

        // Determine purpose
        let purpose = 'unknown';
        let confidence = 0;

        // Skip hidden/technical fields
        if (type === 'hidden' || name.includes('direction_id') || name.includes('csrf') || name.includes('token')) {
          purpose = 'unknown';
          confidence = 0;
        }
        // Amount field detection - be more specific
        else if ((name === 'sum1' || name === 'sum' || name === 'amount' || name.includes('sumfrom')) ||
            (placeholder.includes('сумм') && !placeholder.includes('получ')) ||
            (placeholder.includes('amount') && !placeholder.includes('receive')) ||
            (label.includes('отдаёте') || label.includes('отдаете')) ||
            (className.includes('summ1') || className.includes('sum1'))) {
          purpose = 'amount_from';
          confidence = 0.95;
        }
        // Amount "to" field
        else if (name === 'sum2' || name.includes('sumto') || placeholder.includes('получ') ||
                 label.includes('получаете') || label.includes('получите') ||
                 className.includes('summ2') || className.includes('sum2')) {
          purpose = 'amount_to';
          confidence = 0.8;
        }
        // Bank card/requisites field - account2 for fiat receiving
        // For Crypto->Fiat: account2 is where we enter bank card/phone
        else if (name === 'account2' || id === 'account2' ||
                 placeholder.includes('карт') || placeholder.includes('card') ||
                 placeholder.includes('реквизит') || placeholder.includes('номер счета') ||
                 label.includes('карт') || label.includes('реквизит')) {
          purpose = 'card';
          confidence = 0.95;
        }
        // Crypto wallet field - account1 is crypto address (we DON'T fill it)
        // This is where deposit address will appear
        else if (name === 'account1' || id === 'account1') {
          // Skip - this is crypto address field, we don't fill it
          purpose = 'unknown';
          confidence = 0;
        }
        // Generic wallet/address field (but not account1)
        else if ((name.includes('wallet') || name.includes('address') ||
                 name.includes('requisite')) &&
                 !name.includes('account1') ||
                 placeholder.includes('кошел') || placeholder.includes('wallet') ||
                 placeholder.includes('адрес') || placeholder.includes('address') ||
                 label.includes('кошел') || label.includes('адрес')) {
          purpose = 'wallet';
          confidence = 0.9;
        }
        // Card field - additional patterns
        else if (placeholder.includes('номер карты') || placeholder.includes('card number')) {
          purpose = 'card';
          confidence = 0.9;
        }
        // Email field
        else if (type === 'email' || name.includes('email') || name.includes('mail') ||
                 placeholder.includes('email') || placeholder.includes('почт') ||
                 placeholder.includes('@') || label.includes('email')) {
          purpose = 'email';
          confidence = 0.95;
        }
        // Name/FIO field
        else if (name.includes('fio') || name.includes('name') ||
                 placeholder.includes('фио') || placeholder.includes('имя') ||
                 placeholder.includes('name') || label.includes('фио') ||
                 label.includes('имя')) {
          purpose = 'name';
          confidence = 0.85;
        }
        // Phone field
        else if (type === 'tel' || name.includes('phone') || name.includes('tel') ||
                 placeholder.includes('телефон') || placeholder.includes('phone') ||
                 label.includes('телефон')) {
          purpose = 'phone';
          confidence = 0.9;
        }
        // Submit button
        else if (type === 'submit' || tag === 'button' ||
                 className.includes('submit') || className.includes('btn') ||
                 (el.textContent || '').toLowerCase().includes('обменять') ||
                 (el.textContent || '').toLowerCase().includes('создать') ||
                 (el.textContent || '').toLowerCase().includes('exchange')) {
          purpose = 'submit';
          confidence = 0.8;
        }

        fields.push({
          selector,
          purpose,
          confidence,
          element: {
            tag,
            type,
            name: input.name || '',
            id: input.id || '',
            placeholder: input.placeholder || '',
            label
          }
        });
      });

      return fields.filter(f => f.purpose !== 'unknown' || f.element.type === 'text');
    });

    // Log detected fields
    for (const field of this.detectedFields) {
      if (field.purpose !== 'unknown') {
        logger.info(`  Found ${field.purpose}: ${field.selector} (${(field.confidence * 100).toFixed(0)}%)`);
      }
    }

    return this.detectedFields;
  }

  /**
   * Fill the form with provided data
   */
  async fillForm(data: FormData): Promise<{ success: boolean; filledFields: string[]; errors: string[] }> {
    const filledFields: string[] = [];
    const errors: string[] = [];

    if (this.detectedFields.length === 0) {
      await this.analyzeForm();
    }

    // Fill amount - find the best amount field
    // Prefer fields with specific names: sum1, sum, amount
    const amountFields = this.detectedFields.filter(f => f.purpose === 'amount_from');
    let amountField = amountFields.find(f =>
      f.element.name === 'sum1' || f.element.name === 'sum' || f.element.name === 'amount'
    );
    // Fallback to highest confidence field
    if (!amountField && amountFields.length > 0) {
      amountField = amountFields.sort((a, b) => b.confidence - a.confidence)[0];
    }

    if (amountField && data.amount) {
      const filled = await this.fillField(amountField.selector, String(data.amount));
      if (filled) {
        filledFields.push('amount');
        logger.info(`Filled amount: ${data.amount} (field: ${amountField.selector})`);
      } else {
        errors.push('Could not fill amount');
      }
    }

    // Wait for calculated values to update
    await this.page.waitForTimeout(1000);

    // Fill wallet/card (depending on what's available)
    // Priority: card field > wallet field (for fiat receiving)
    // For Crypto->Fiat: we need to fill bank card/phone in card field (account2)
    const cardField = this.detectedFields.find(f => f.purpose === 'card');
    const walletField = this.detectedFields.find(f => f.purpose === 'wallet');

    // Determine what value to use - prefer card data, fallback to wallet
    const cardValue = data.card || data.wallet;
    const walletValue = data.wallet;

    if (cardField && cardValue) {
      // Fill card field (account2) with card number or phone for СБП
      const filled = await this.fillField(cardField.selector, cardValue);
      if (filled) {
        filledFields.push('card');
        const displayValue = cardValue.length > 10 ? `${cardValue.substring(0, 4)}****` : `${cardValue.substring(0, 6)}...`;
        logger.info(`Filled card/bank details: ${displayValue}`);
      }
    }

    if (walletField && walletValue && !cardField) {
      // Only fill wallet field if no card field found
      // This is for Fiat->Crypto where we need to enter crypto address
      const filled = await this.fillField(walletField.selector, walletValue);
      if (filled) {
        filledFields.push('wallet');
        logger.info(`Filled wallet: ${walletValue.substring(0, 10)}...`);
      }
    }

    // Fill email
    const emailField = this.detectedFields.find(f => f.purpose === 'email');
    if (emailField && data.email) {
      const filled = await this.fillField(emailField.selector, data.email);
      if (filled) {
        filledFields.push('email');
        logger.info(`Filled email: ${data.email}`);
      }
    }

    // Fill name/FIO
    const nameField = this.detectedFields.find(f => f.purpose === 'name');
    if (nameField && data.name) {
      const filled = await this.fillField(nameField.selector, data.name);
      if (filled) {
        filledFields.push('name');
        logger.info(`Filled name: ${data.name}`);
      }
    }

    // Fill phone
    const phoneField = this.detectedFields.find(f => f.purpose === 'phone');
    if (phoneField && data.phone) {
      const filled = await this.fillField(phoneField.selector, data.phone);
      if (filled) {
        filledFields.push('phone');
        logger.info(`Filled phone: ${data.phone}`);
      }
    }

    return {
      success: filledFields.length > 0,
      filledFields,
      errors
    };
  }

  /**
   * Fill a single field
   */
  private async fillField(selector: string, value: string): Promise<boolean> {
    try {
      // Try JavaScript fill first
      const filled = await this.page.evaluate(([sel, val]: [string, string]) => {
        const input = document.querySelector(sel) as HTMLInputElement;
        if (!input) return false;

        input.focus();
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      }, [selector, value] as [string, string]);

      if (filled) return true;

      // Fallback to Playwright
      const el = await this.page.$(selector);
      if (el) {
        await el.scrollIntoViewIfNeeded();
        await el.fill(value);
        return true;
      }

      return false;
    } catch (error) {
      logger.warn(`Failed to fill ${selector}: ${error}`);
      return false;
    }
  }

  /**
   * Click submit button
   */
  async clickSubmit(): Promise<boolean> {
    const submitField = this.detectedFields.find(f => f.purpose === 'submit');

    if (!submitField) {
      // Try common submit selectors
      const fallbackSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        '.xchange_submit',
        '.exchange-btn',
        'button:has-text("Обменять")',
        'button:has-text("обменять")',
        'button:has-text("Создать")',
        '.submit-btn',
        'form button'
      ];

      for (const selector of fallbackSelectors) {
        try {
          const btn = await this.page.$(selector);
          if (btn && await btn.isVisible()) {
            await btn.click();
            logger.info(`Clicked submit via fallback: ${selector}`);
            return true;
          }
        } catch { continue; }
      }

      return false;
    }

    try {
      const btn = await this.page.$(submitField.selector);
      if (btn) {
        await btn.click();
        logger.info(`Clicked submit: ${submitField.selector}`);
        return true;
      }
    } catch (error) {
      logger.warn(`Failed to click submit: ${error}`);
    }

    return false;
  }

  /**
   * Get detected fields
   */
  getDetectedFields(): DetectedField[] {
    return this.detectedFields;
  }

  /**
   * Check if form has required fields for exchange
   */
  hasRequiredFields(): { valid: boolean; missing: string[] } {
    const required = ['amount_from'];
    const missing: string[] = [];

    for (const purpose of required) {
      if (!this.detectedFields.find(f => f.purpose === purpose)) {
        missing.push(purpose);
      }
    }

    // Need at least wallet OR card
    const hasRecipient = this.detectedFields.some(f =>
      f.purpose === 'wallet' || f.purpose === 'card'
    );
    if (!hasRecipient) {
      missing.push('wallet/card');
    }

    return {
      valid: missing.length === 0,
      missing
    };
  }
}

/**
 * Quick helper to fill form on a page
 */
export async function smartFillForm(page: Page, data: FormData): Promise<{ success: boolean; filledFields: string[] }> {
  const filler = new SmartFormFiller(page);
  await filler.analyzeForm();
  return filler.fillForm(data);
}
