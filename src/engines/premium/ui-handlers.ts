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
 */
export async function checkAgreementCheckboxes(page: Page): Promise<void> {
  const jsChecked = await page.evaluate(() => {
    let count = 0;
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');

    checkboxes.forEach(cb => {
      const input = cb as HTMLInputElement;
      if (input.checked) return;

      const label = cb.closest('label')?.textContent?.toLowerCase() || '';
      const parent = cb.closest('div, p, span, td, tr')?.textContent?.toLowerCase() || '';
      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();

      const allText = `${label} ${parent}`;
      const isAgreement =
        allText.includes('согласен') || allText.includes('прочитал') ||
        allText.includes('принимаю') || allText.includes('agree') ||
        allText.includes('aml') || allText.includes('политик') ||
        name.includes('agree') || name.includes('aml') ||
        id.includes('agree') || id.includes('aml');

      if (isAgreement) {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        count++;
      }
    });

    return count;
  });

  if (jsChecked > 0) {
    logger.info(`Checked ${jsChecked} agreement checkbox(es)`);
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
  const [newPage] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 30000 }).catch(() => null),
    (async () => {
      const selectors = [
        'button:has-text("Перейти к оплате")',
        'a:has-text("Перейти к оплате")',
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

  if (newPage) {
    await newPage.waitForLoadState('domcontentloaded');
    return newPage;
  }

  return page;
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
