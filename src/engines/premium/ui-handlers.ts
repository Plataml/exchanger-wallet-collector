import { Page } from 'playwright';
import { logger } from '../../logger';

/**
 * Click submit button
 */
export async function clickSubmitButton(page: Page): Promise<boolean> {
  const clicked = await page.evaluate(() => {
    const selectors = [
      'input.xchange_submit[type="submit"]',
      '.xchange_submit',
      '.js_exchange_link',
      'button[type="submit"]',
      'input[type="submit"]',
      'input[value="Обменять"]',
      'input[value="Продолжить"]'
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

    // Fallback: find by text
    const buttons = document.querySelectorAll('button, input[type="submit"]');
    for (const btn of Array.from(buttons)) {
      const text = (btn as HTMLElement).innerText?.toLowerCase() ||
                   (btn as HTMLInputElement).value?.toLowerCase() || '';
      if (text.includes('обменять') || text.includes('продолжить') ||
          text.includes('создать') || text.includes('далее')) {
        if ((btn as HTMLElement).offsetParent !== null) {
          (btn as HTMLElement).click();
          return 'text-match';
        }
      }
    }
    return null;
  });

  if (clicked) {
    logger.info(`Submit clicked: ${clicked}`);
    return true;
  }

  // Playwright fallback
  const textLocators = ['Продолжить', 'Обменять', 'Создать заявку', 'Далее'];
  for (const text of textLocators) {
    try {
      const btn = page.locator(`text="${text}"`).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        return true;
      }
    } catch { continue; }
  }

  return false;
}

/**
 * Handle confirmation popup (SweetAlert2, etc)
 */
export async function handleConfirmationPopup(page: Page): Promise<boolean> {
  await page.waitForTimeout(1500);

  const okSelectors = [
    '.swal2-confirm',
    '.swal2-actions button',
    'button.swal2-confirm',
    '.sweet-alert button.confirm',
    'button:has-text("ок")',
    'button:has-text("OK")',
    'button:has-text("Да")',
    '.confirm-btn',
    '.modal-footer button.btn-primary'
  ];

  for (const selector of okSelectors) {
    try {
      const btn = await page.$(selector);
      if (btn && await btn.isVisible()) {
        await btn.click();
        logger.info(`Popup confirmed: ${selector}`);
        return true;
      }
    } catch { continue; }
  }

  // JS fallback
  const clicked = await page.evaluate(() => {
    const swalBtn = document.querySelector('.swal2-confirm') as HTMLElement;
    if (swalBtn) {
      swalBtn.click();
      return true;
    }
    return false;
  });

  if (clicked) {
    logger.info('Popup confirmed via JS');
    return true;
  }

  await page.keyboard.press('Enter');
  return false;
}

/**
 * Enter verification code
 */
export async function enterVerificationCode(page: Page, code: string): Promise<void> {
  const selectors = [
    'input[name*="code"]',
    'input[placeholder*="код"]',
    'input[placeholder*="code"]',
    '.verification-input input'
  ];

  for (const selector of selectors) {
    try {
      const input = await page.$(selector);
      if (input && await input.isVisible()) {
        await input.fill(code);
        logger.info('Verification code entered');

        const okBtn = await page.$('button:has-text("OK"), button:has-text("Подтвердить")');
        if (okBtn && await okBtn.isVisible()) {
          await okBtn.click();
        }
        return;
      }
    } catch { continue; }
  }
}

/**
 * Check agreement checkboxes
 * Handles PremiumBox jcheckbox (hidden inputs with styled labels)
 */
export async function checkAgreementCheckboxes(page: Page): Promise<void> {
  const jsChecked = await page.evaluate(() => {
    let count = 0;
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');

    checkboxes.forEach(cb => {
      const input = cb as HTMLInputElement;
      if (input.checked) return;

      const labelEl = cb.closest('label');
      const parentEl = cb.closest('div, p, span, td, tr');
      const labelText = (labelEl?.textContent || '').toLowerCase();
      const parentText = (parentEl?.textContent || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();

      const allText = `${labelText} ${parentText}`;
      const isAgreement =
        allText.includes('согласен') || allText.includes('прочитал') ||
        allText.includes('принимаю') || allText.includes('agree') ||
        allText.includes('aml') || allText.includes('политик') ||
        allText.includes('ознакомлен') || allText.includes('правил') ||
        name.includes('agree') || name.includes('aml') ||
        name.includes('check_rule') || name.includes('tos') ||
        id.includes('agree') || id.includes('aml');

      if (isAgreement) {
        // For hidden jcheckbox inputs, click the parent label via JS
        if (labelEl) {
          labelEl.click();
        } else {
          input.checked = true;
          input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        count++;
      }
    });

    return count;
  });

  if (jsChecked > 0) {
    logger.info(`Clicked ${jsChecked} agreement checkbox label(s)`);
    await page.waitForTimeout(500);

    // Verify and force-set any still unchecked
    const fixed = await page.evaluate(() => {
      let count = 0;
      const cbs = document.querySelectorAll('input[type="checkbox"]');
      cbs.forEach(cb => {
        const input = cb as HTMLInputElement;
        if (input.checked) return;
        const name = (input.name || '').toLowerCase();
        if (name.includes('check') || name.includes('agree') || name.includes('rule') || name.includes('aml')) {
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
      });
      return count;
    });

    if (fixed > 0) {
      logger.warn(`Force-checked ${fixed} still-unchecked checkbox(es)`);
    }
  }
}

/**
 * Close chat widgets
 */
export async function closeChatWidgets(page: Page): Promise<void> {
  await page.evaluate(() => {
    const closeSelectors = [
      '.jivo-close-btn', '[class*="jivo"] [class*="close"]',
      '.tawk-min-container', '[class*="tawk"] [class*="close"]',
      '[class*="chat"][class*="widget"] [class*="close"]'
    ];

    for (const selector of closeSelectors) {
      try {
        const btns = document.querySelectorAll(selector);
        btns.forEach(btn => {
          if ((btn as HTMLElement).offsetParent !== null) {
            (btn as HTMLElement).click();
          }
        });
      } catch { /* ignore */ }
    }

    // Hide chat containers
    const containers = document.querySelectorAll(
      '[class*="jivo"], [class*="tawk"], [class*="crisp"], [class*="chat-widget"]'
    );
    containers.forEach(el => {
      (el as HTMLElement).style.display = 'none';
    });
  });
}

/**
 * Accept AML policy
 */
export async function acceptAmlPolicy(page: Page): Promise<void> {
  const selectors = [
    'input[name*="aml"]',
    'input[name*="agree"]',
    'input[type="checkbox"]:not(:checked)',
    '.aml-checkbox input'
  ];

  for (const selector of selectors) {
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

/**
 * Click create order button
 */
export async function clickCreateOrderButton(page: Page): Promise<void> {
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

/**
 * Go to payment page (handles new tab)
 */
export async function goToPaymentPage(page: Page): Promise<Page> {
  // First check if there are any payment buttons/links visible
  const paymentSelectors = [
    'button:has-text("Перейти к оплате")',
    'a:has-text("Перейти к оплате")',
    'button:has-text("Оплатить")',
    'a:has-text("Оплатить")',
    '.payment-btn',
    'a[href*="payment"]',
    'a[href*="pay"]',
    'a[href*="order"]'
  ];

  let buttonFound = false;
  for (const selector of paymentSelectors) {
    try {
      const btn = await page.$(selector);
      if (btn && await btn.isVisible()) {
        buttonFound = true;
        // Wait for potential new tab when clicking
        const [newPage] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null),
          btn.click()
        ]);

        if (newPage) {
          await newPage.waitForLoadState('domcontentloaded');
          logger.info(`Opened payment page in new tab`);
          return newPage;
        }
        // Button clicked but no new tab — page might have navigated
        await page.waitForTimeout(2000);
        break;
      }
    } catch { continue; }
  }

  if (!buttonFound) {
    logger.debug('No payment button found — staying on current page');
  }

  return page;
}

/**
 * Analyze post-submit page state for diagnostics
 */
export async function analyzePostSubmitState(page: Page): Promise<{
  state: 'email_verification' | 'order_created' | 'payment_page' | 'error' | 'unknown';
  details: string;
}> {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const url = window.location.href.toLowerCase();

    // Check for email verification prompts
    const emailKeywords = [
      'подтвердите', 'подтверждение', 'verification',
      'код подтверждения', 'проверьте почту', 'check your email',
      'отправили письмо', 'sent.*email', 'введите код',
      'enter.*code', 'verify your email'
    ];
    for (const kw of emailKeywords) {
      if (text.includes(kw)) {
        return { state: 'email_verification' as const, details: `Keyword: "${kw}"` };
      }
    }

    // Check for order/payment page indicators
    const orderKeywords = ['заявка создана', 'заказ создан', 'order created', 'order #', 'заявка №'];
    for (const kw of orderKeywords) {
      if (text.includes(kw)) {
        return { state: 'order_created' as const, details: `Keyword: "${kw}"` };
      }
    }

    // Check for payment page (deposit address should be here)
    const paymentKeywords = [
      'оплат', 'переведите', 'отправьте', 'deposit', 'send',
      'адрес кошелька', 'wallet address', 'qr', 'адрес для оплаты'
    ];
    for (const kw of paymentKeywords) {
      if (text.includes(kw)) {
        return { state: 'payment_page' as const, details: `Keyword: "${kw}"` };
      }
    }

    // Check URL for clues
    if (url.includes('order') || url.includes('payment') || url.includes('pay')) {
      return { state: 'payment_page' as const, details: `URL: ${url}` };
    }

    // Check for errors
    const errorKeywords = ['ошибка', 'error', 'не удалось', 'failed'];
    for (const kw of errorKeywords) {
      if (text.includes(kw)) {
        return { state: 'error' as const, details: `Keyword: "${kw}"` };
      }
    }

    // Get first 200 chars of visible text for diagnostics
    const visibleText = text.substring(0, 200).replace(/\s+/g, ' ').trim();
    return { state: 'unknown' as const, details: `Page text: "${visibleText}"` };
  });
}

/**
 * Check for blocking errors
 */
export async function checkBlockingError(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const errorTexts = [
      'не можете проводить транзакции',
      'вы заблокированы',
      'доступ заблокирован',
      'подозрительная активность',
      'временно заблокирован',
      'bot detected',
      'слишком много попыток',
      'email не принимается',
      'временный email'
    ];

    const bodyText = document.body?.innerText?.toLowerCase() || '';

    for (const errorText of errorTexts) {
      if (bodyText.includes(errorText)) {
        return errorText;
      }
    }

    return null;
  });
}
