import { Page } from 'playwright';
import { config } from './config';
import { logger } from './logger';

// Captcha service configuration
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || '';
const CAPTCHA_SERVICE = process.env.CAPTCHA_SERVICE || '2captcha'; // 2captcha or anticaptcha

interface CaptchaSolution {
  success: boolean;
  token?: string;
  error?: string;
}

// Detect if page has captcha and what type
export async function detectCaptcha(page: Page): Promise<{
  hasCaptcha: boolean;
  type: 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' | 'turnstile' | 'none';
  siteKey?: string;
}> {
  return page.evaluate(() => {
    // reCAPTCHA v2
    const recaptchaV2 = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (recaptchaV2) {
      const siteKey = recaptchaV2.getAttribute('data-sitekey') || '';
      return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey };
    }

    // reCAPTCHA v3 (invisible)
    const recaptchaV3Script = document.querySelector('script[src*="recaptcha/api.js?render="]');
    if (recaptchaV3Script) {
      const src = recaptchaV3Script.getAttribute('src') || '';
      const match = src.match(/render=([^&]+)/);
      return { hasCaptcha: true, type: 'recaptcha-v3' as const, siteKey: match?.[1] };
    }

    // Check for grecaptcha in textarea
    const recaptchaTextarea = document.querySelector('textarea[name="g-recaptcha-response"]');
    if (recaptchaTextarea) {
      // Try to find sitekey from scripts
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const match = script.textContent?.match(/sitekey['":\s]+['"]([^'"]+)['"]/i);
        if (match) {
          return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey: match[1] };
        }
      }
      return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey: '' };
    }

    // hCaptcha
    const hcaptcha = document.querySelector('.h-captcha, [data-hcaptcha-sitekey]');
    if (hcaptcha) {
      const siteKey = hcaptcha.getAttribute('data-sitekey') || hcaptcha.getAttribute('data-hcaptcha-sitekey') || '';
      return { hasCaptcha: true, type: 'hcaptcha' as const, siteKey };
    }

    // Cloudflare Turnstile
    const turnstile = document.querySelector('.cf-turnstile, [data-turnstile-sitekey]');
    if (turnstile) {
      const siteKey = turnstile.getAttribute('data-sitekey') || '';
      return { hasCaptcha: true, type: 'turnstile' as const, siteKey };
    }

    return { hasCaptcha: false, type: 'none' as const };
  });
}

// Solve reCAPTCHA v2 using 2captcha
async function solveRecaptchaV2(siteKey: string, pageUrl: string): Promise<CaptchaSolution> {
  if (!CAPTCHA_API_KEY) {
    return { success: false, error: 'CAPTCHA_API_KEY not configured' };
  }

  try {
    logger.info('Sending reCAPTCHA to 2captcha...');

    // Step 1: Submit captcha
    const submitUrl = `http://2captcha.com/in.php?key=${CAPTCHA_API_KEY}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
    const submitRes = await fetch(submitUrl);
    const submitData = await submitRes.json();

    if (submitData.status !== 1) {
      return { success: false, error: submitData.request || 'Submit failed' };
    }

    const requestId = submitData.request;
    logger.info(`Captcha submitted, ID: ${requestId}`);

    // Step 2: Poll for result (max 120 seconds)
    const resultUrl = `http://2captcha.com/res.php?key=${CAPTCHA_API_KEY}&action=get&id=${requestId}&json=1`;

    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds

      const resultRes = await fetch(resultUrl);
      const resultData = await resultRes.json();

      if (resultData.status === 1) {
        logger.info('Captcha solved!');
        return { success: true, token: resultData.request };
      }

      if (resultData.request !== 'CAPCHA_NOT_READY') {
        return { success: false, error: resultData.request };
      }

      logger.info(`Waiting for solution... (${(i + 1) * 5}s)`);
    }

    return { success: false, error: 'Timeout waiting for captcha solution' };

  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Solve hCaptcha using 2captcha
async function solveHCaptcha(siteKey: string, pageUrl: string): Promise<CaptchaSolution> {
  if (!CAPTCHA_API_KEY) {
    return { success: false, error: 'CAPTCHA_API_KEY not configured' };
  }

  try {
    logger.info('Sending hCaptcha to 2captcha...');

    const submitUrl = `http://2captcha.com/in.php?key=${CAPTCHA_API_KEY}&method=hcaptcha&sitekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
    const submitRes = await fetch(submitUrl);
    const submitData = await submitRes.json();

    if (submitData.status !== 1) {
      return { success: false, error: submitData.request || 'Submit failed' };
    }

    const requestId = submitData.request;
    logger.info(`hCaptcha submitted, ID: ${requestId}`);

    const resultUrl = `http://2captcha.com/res.php?key=${CAPTCHA_API_KEY}&action=get&id=${requestId}&json=1`;

    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const resultRes = await fetch(resultUrl);
      const resultData = await resultRes.json();

      if (resultData.status === 1) {
        logger.info('hCaptcha solved!');
        return { success: true, token: resultData.request };
      }

      if (resultData.request !== 'CAPCHA_NOT_READY') {
        return { success: false, error: resultData.request };
      }
    }

    return { success: false, error: 'Timeout' };

  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Solve Cloudflare Turnstile
async function solveTurnstile(siteKey: string, pageUrl: string): Promise<CaptchaSolution> {
  if (!CAPTCHA_API_KEY) {
    return { success: false, error: 'CAPTCHA_API_KEY not configured' };
  }

  try {
    logger.info('Sending Turnstile to 2captcha...');

    const submitUrl = `http://2captcha.com/in.php?key=${CAPTCHA_API_KEY}&method=turnstile&sitekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
    const submitRes = await fetch(submitUrl);
    const submitData = await submitRes.json();

    if (submitData.status !== 1) {
      return { success: false, error: submitData.request || 'Submit failed' };
    }

    const requestId = submitData.request;
    const resultUrl = `http://2captcha.com/res.php?key=${CAPTCHA_API_KEY}&action=get&id=${requestId}&json=1`;

    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const resultRes = await fetch(resultUrl);
      const resultData = await resultRes.json();

      if (resultData.status === 1) {
        logger.info('Turnstile solved!');
        return { success: true, token: resultData.request };
      }

      if (resultData.request !== 'CAPCHA_NOT_READY') {
        return { success: false, error: resultData.request };
      }
    }

    return { success: false, error: 'Timeout' };

  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Main function to solve any detected captcha
export async function solveCaptcha(page: Page): Promise<CaptchaSolution> {
  const detection = await detectCaptcha(page);

  if (!detection.hasCaptcha) {
    return { success: true }; // No captcha to solve
  }

  if (!detection.siteKey) {
    logger.warn('Captcha detected but siteKey not found');
    return { success: false, error: 'Could not find captcha siteKey' };
  }

  const pageUrl = page.url();
  logger.info(`Detected ${detection.type} captcha, siteKey: ${detection.siteKey.substring(0, 20)}...`);

  let solution: CaptchaSolution;

  switch (detection.type) {
    case 'recaptcha-v2':
    case 'recaptcha-v3':
      solution = await solveRecaptchaV2(detection.siteKey, pageUrl);
      break;
    case 'hcaptcha':
      solution = await solveHCaptcha(detection.siteKey, pageUrl);
      break;
    case 'turnstile':
      solution = await solveTurnstile(detection.siteKey, pageUrl);
      break;
    default:
      return { success: false, error: `Unsupported captcha type: ${detection.type}` };
  }

  if (solution.success && solution.token) {
    // Inject the solution token into the page
    await page.evaluate((token) => {
      // For reCAPTCHA
      const recaptchaTextarea = document.querySelector('textarea[name="g-recaptcha-response"]');
      if (recaptchaTextarea) {
        (recaptchaTextarea as HTMLTextAreaElement).value = token;
      }

      // For hCaptcha
      const hcaptchaTextarea = document.querySelector('textarea[name="h-captcha-response"]');
      if (hcaptchaTextarea) {
        (hcaptchaTextarea as HTMLTextAreaElement).value = token;
      }

      // For Turnstile
      const turnstileInput = document.querySelector('input[name="cf-turnstile-response"]');
      if (turnstileInput) {
        (turnstileInput as HTMLInputElement).value = token;
      }

      // Try to call callback if exists
      if (typeof (window as any).grecaptcha !== 'undefined') {
        try {
          (window as any).grecaptcha.callback?.(token);
        } catch { }
      }
    }, solution.token);

    logger.info('Captcha token injected into page');
  }

  return solution;
}

// Check 2captcha balance
export async function getCaptchaBalance(): Promise<number> {
  if (!CAPTCHA_API_KEY) return 0;

  try {
    const res = await fetch(`http://2captcha.com/res.php?key=${CAPTCHA_API_KEY}&action=getbalance&json=1`);
    const data = await res.json();
    return data.status === 1 ? parseFloat(data.request) : 0;
  } catch {
    return 0;
  }
}
