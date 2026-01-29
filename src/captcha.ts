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

// Detect simple image captcha (text from image)
export async function detectSimpleCaptcha(page: Page): Promise<{
  hasCaptcha: boolean;
  imageSelector?: string;
  inputSelector?: string;
  imageBase64?: string;
}> {
  return page.evaluate(() => {
    // Look for captcha image near input field
    const captchaPatterns = [
      // Input field patterns
      { input: 'input[name*="captcha"]', imgNear: 'img' },
      { input: 'input[name*="code"]', imgNear: 'img[src*="captcha"]' },
      { input: 'input[placeholder*="код"]', imgNear: 'img' },
      { input: 'input[placeholder*="code"]', imgNear: 'img' },
      { input: '.captcha-input input', imgNear: 'img' },
      { input: '#captcha', imgNear: 'img' },
    ];

    // Find captcha by looking for text like "защитный код" or "captcha" near image
    const allImages = Array.from(document.querySelectorAll('img'));
    for (const img of allImages) {
      const src = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      const parent = img.closest('div, td, span, label');
      const parentText = parent?.textContent?.toLowerCase() || '';

      // Check if it's a captcha image
      const isCaptchaImage =
        src.includes('captcha') ||
        src.includes('securimage') ||
        src.includes('verify') ||
        alt.includes('captcha') ||
        parentText.includes('защитный код') ||
        parentText.includes('captcha') ||
        parentText.includes('код с картинки') ||
        parentText.includes('введите код');

      if (isCaptchaImage) {
        // Find nearby input field
        const nearbyInput = parent?.querySelector('input[type="text"]') ||
                           parent?.parentElement?.querySelector('input[type="text"]') ||
                           document.querySelector('input[name*="captcha"], input[placeholder*="код"]');

        if (nearbyInput) {
          return {
            hasCaptcha: true,
            imageSelector: img.className ? `.${img.className.split(' ').join('.')}` : 'img[src*="captcha"]',
            inputSelector: (nearbyInput as HTMLInputElement).name ?
              `input[name="${(nearbyInput as HTMLInputElement).name}"]` :
              (nearbyInput as HTMLInputElement).id ? `#${(nearbyInput as HTMLInputElement).id}` : 'input[type="text"]'
          };
        }
      }
    }

    // Fallback: look for common captcha containers
    const captchaContainers = document.querySelectorAll('.captcha, .captcha-container, [class*="captcha"]');
    for (const container of Array.from(captchaContainers)) {
      const img = container.querySelector('img');
      const input = container.querySelector('input[type="text"]');
      if (img && input) {
        return {
          hasCaptcha: true,
          imageSelector: 'img',
          inputSelector: 'input[type="text"]'
        };
      }
    }

    return { hasCaptcha: false };
  });
}

// Detect if page has captcha and what type
export async function detectCaptcha(page: Page): Promise<{
  hasCaptcha: boolean;
  type: 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' | 'turnstile' | 'image' | 'none';
  siteKey?: string;
  imageSelector?: string;
  inputSelector?: string;
}> {
  return page.evaluate(() => {
    let siteKey = '';

    // reCAPTCHA v2 - check various sources for siteKey
    const recaptchaV2 = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (recaptchaV2) {
      siteKey = recaptchaV2.getAttribute('data-sitekey') || '';
      if (siteKey) {
        return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey };
      }
    }

    // Check for reCAPTCHA iframes (most reliable for siteKey)
    const recaptchaIframes = Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]'));
    for (const iframe of recaptchaIframes) {
      const src = (iframe as HTMLIFrameElement).src;
      // Try k= parameter first
      let match = src.match(/[?&]k=([^&]+)/);
      if (match) {
        return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey: match[1] };
      }
      // Try sitekey= parameter
      match = src.match(/[?&]sitekey=([^&]+)/);
      if (match) {
        return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey: match[1] };
      }
    }

    // reCAPTCHA v3 (invisible)
    const recaptchaV3Script = document.querySelector('script[src*="recaptcha/api.js?render="]');
    if (recaptchaV3Script) {
      const src = recaptchaV3Script.getAttribute('src') || '';
      const match = src.match(/render=([^&]+)/);
      return { hasCaptcha: true, type: 'recaptcha-v3' as const, siteKey: match?.[1] };
    }

    // Check for recaptcha scripts with sitekey
    const recaptchaScripts = Array.from(document.querySelectorAll('script[src*="recaptcha"]'));
    for (const script of recaptchaScripts) {
      const src = script.getAttribute('src') || '';
      // Check for render parameter (v3)
      const match = src.match(/render=([^&]+)/);
      if (match && match[1] !== 'explicit') {
        return { hasCaptcha: true, type: 'recaptcha-v3' as const, siteKey: match[1] };
      }
    }

    // Check for grecaptcha in textarea - indicates reCAPTCHA is on page
    const recaptchaTextarea = document.querySelector('textarea[name="g-recaptcha-response"]');
    if (recaptchaTextarea) {
      // Try to find sitekey from inline scripts
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const script of scripts) {
        const text = script.textContent || '';
        // Look for various patterns
        let match = text.match(/sitekey['":\s]+['"]([^'"]{20,})['"]/i);
        if (match) {
          return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey: match[1] };
        }
        match = text.match(/grecaptcha\.render\([^,]+,\s*\{[^}]*sitekey['":\s]+['"]([^'"]+)['"]/i);
        if (match) {
          return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey: match[1] };
        }
        // Look for data-sitekey in string
        match = text.match(/data-sitekey['"=]+['"]([^'"]+)['"]/i);
        if (match) {
          return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey: match[1] };
        }
      }

      // Even if siteKey not found, we know captcha exists
      return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey: '' };
    }

    // Check if grecaptcha object exists
    if (typeof (window as any).grecaptcha !== 'undefined') {
      // Try to get siteKey from grecaptcha
      try {
        const widgets = (window as any).grecaptcha?.getResponse ? true : false;
        if (widgets) {
          // grecaptcha is loaded, find siteKey from DOM
          const captchaDiv = document.querySelector('[data-sitekey]');
          if (captchaDiv) {
            return { hasCaptcha: true, type: 'recaptcha-v2' as const, siteKey: captchaDiv.getAttribute('data-sitekey') || '' };
          }
        }
      } catch { }
    }

    // hCaptcha
    const hcaptcha = document.querySelector('.h-captcha, [data-hcaptcha-sitekey]');
    if (hcaptcha) {
      siteKey = hcaptcha.getAttribute('data-sitekey') || hcaptcha.getAttribute('data-hcaptcha-sitekey') || '';
      return { hasCaptcha: true, type: 'hcaptcha' as const, siteKey };
    }

    // Cloudflare Turnstile
    const turnstile = document.querySelector('.cf-turnstile, [data-turnstile-sitekey]');
    if (turnstile) {
      siteKey = turnstile.getAttribute('data-sitekey') || '';
      return { hasCaptcha: true, type: 'turnstile' as const, siteKey };
    }

    // Simple image captcha detection
    const allImages = Array.from(document.querySelectorAll('img'));
    for (const img of allImages) {
      const src = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      const parent = img.closest('div, td, span, label, form');
      const parentText = parent?.textContent?.toLowerCase() || '';

      const isCaptchaImage =
        src.includes('captcha') ||
        src.includes('securimage') ||
        src.includes('verify') ||
        alt.includes('captcha') ||
        parentText.includes('защитный код') ||
        parentText.includes('captcha') ||
        parentText.includes('код с картинки') ||
        parentText.includes('введите код');

      if (isCaptchaImage) {
        const nearbyInput = parent?.querySelector('input[type="text"]') ||
                           parent?.parentElement?.querySelector('input[type="text"]') ||
                           document.querySelector('input[name*="captcha"], input[placeholder*="код"]');

        if (nearbyInput) {
          return {
            hasCaptcha: true,
            type: 'image' as const,
            imageSelector: src,
            inputSelector: (nearbyInput as HTMLInputElement).name ?
              `input[name="${(nearbyInput as HTMLInputElement).name}"]` :
              (nearbyInput as HTMLInputElement).id ? `#${(nearbyInput as HTMLInputElement).id}` : 'input[type="text"]'
          };
        }
      }
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

// Solve simple image captcha - get image and send to 2captcha
async function solveSimpleImageCaptcha(page: Page, imageSelector?: string, inputSelector?: string): Promise<CaptchaSolution> {
  try {
    // Find captcha image on page
    const imageData = await page.evaluate((selector) => {
      // Try to find captcha image
      let img: HTMLImageElement | null = null;

      // If selector provided, try it first
      if (selector && selector.startsWith('http')) {
        // It's a URL, find img with this src
        img = document.querySelector(`img[src*="${selector.split('/').pop()}"]`) as HTMLImageElement;
      }

      // Fallback: find any captcha image
      if (!img) {
        const allImages = Array.from(document.querySelectorAll('img'));
        for (const i of allImages) {
          const src = i.getAttribute('src') || '';
          const alt = i.getAttribute('alt') || '';
          const parent = i.closest('div, td, span, label, form');
          const parentText = parent?.textContent?.toLowerCase() || '';

          if (src.includes('captcha') || src.includes('securimage') || src.includes('verify') ||
              alt.includes('captcha') || parentText.includes('защитный код') ||
              parentText.includes('captcha') || parentText.includes('код с картинки')) {
            img = i as HTMLImageElement;
            break;
          }
        }
      }

      if (!img) {
        return { error: 'Captcha image not found' };
      }

      // Try to get image as base64
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          return { base64: dataUrl.replace(/^data:image\/\w+;base64,/, '') };
        }
      } catch (e) {
        // CORS might block this, return URL instead
        return { url: img.src };
      }

      return { url: img.src };
    }, imageSelector);

    if ('error' in imageData) {
      return { success: false, error: imageData.error };
    }

    let imageBase64: string;

    if ('base64' in imageData && imageData.base64) {
      imageBase64 = imageData.base64;
    } else if ('url' in imageData && imageData.url) {
      // Fetch image from URL
      logger.info(`Fetching captcha image from: ${imageData.url}`);
      try {
        // Try to take screenshot of the image element instead
        const imgElement = await page.$(`img[src*="${imageData.url.split('/').pop()}"]`);
        if (imgElement) {
          const screenshot = await imgElement.screenshot({ type: 'png' });
          imageBase64 = screenshot.toString('base64');
        } else {
          return { success: false, error: 'Could not capture captcha image' };
        }
      } catch (e) {
        return { success: false, error: `Failed to capture captcha: ${e}` };
      }
    } else {
      return { success: false, error: 'Could not extract captcha image' };
    }

    // Send to 2captcha for solving
    return await solveImageCaptcha(imageBase64);

  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Solve simple image captcha using 2captcha
async function solveImageCaptcha(imageBase64: string): Promise<CaptchaSolution> {
  if (!CAPTCHA_API_KEY) {
    return { success: false, error: 'CAPTCHA_API_KEY not configured' };
  }

  try {
    logger.info('Sending image captcha to 2captcha...');

    // Step 1: Submit captcha image
    const submitUrl = 'http://2captcha.com/in.php';
    const formData = new URLSearchParams();
    formData.append('key', CAPTCHA_API_KEY);
    formData.append('method', 'base64');
    formData.append('body', imageBase64);
    formData.append('json', '1');

    const submitRes = await fetch(submitUrl, {
      method: 'POST',
      body: formData
    });
    const submitData = await submitRes.json();

    if (submitData.status !== 1) {
      return { success: false, error: submitData.request || 'Submit failed' };
    }

    const requestId = submitData.request;
    logger.info(`Image captcha submitted, ID: ${requestId}`);

    // Step 2: Poll for result (max 60 seconds for simple captcha)
    const resultUrl = `http://2captcha.com/res.php?key=${CAPTCHA_API_KEY}&action=get&id=${requestId}&json=1`;

    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds

      const resultRes = await fetch(resultUrl);
      const resultData = await resultRes.json();

      if (resultData.status === 1) {
        logger.info(`Image captcha solved: ${resultData.request}`);
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

  const pageUrl = page.url();
  logger.info(`Detected ${detection.type} captcha`);

  let solution: CaptchaSolution;

  switch (detection.type) {
    case 'recaptcha-v2':
    case 'recaptcha-v3':
      if (!detection.siteKey) {
        logger.warn('reCAPTCHA detected but siteKey not found');
        return { success: false, error: 'Could not find captcha siteKey' };
      }
      logger.info(`siteKey: ${detection.siteKey.substring(0, 20)}...`);
      solution = await solveRecaptchaV2(detection.siteKey, pageUrl);
      break;
    case 'hcaptcha':
      if (!detection.siteKey) {
        return { success: false, error: 'Could not find hCaptcha siteKey' };
      }
      solution = await solveHCaptcha(detection.siteKey, pageUrl);
      break;
    case 'turnstile':
      if (!detection.siteKey) {
        return { success: false, error: 'Could not find Turnstile siteKey' };
      }
      solution = await solveTurnstile(detection.siteKey, pageUrl);
      break;
    case 'image':
      // Handle simple image captcha
      logger.info('Solving simple image captcha...');
      solution = await solveSimpleImageCaptcha(page, detection.imageSelector, detection.inputSelector);
      if (solution.success && solution.token) {
        // Fill in the captcha input field
        const inputSelector = detection.inputSelector || 'input[name*="captcha"], input[placeholder*="код"]';
        await page.evaluate(([selector, value]) => {
          const input = document.querySelector(selector) as HTMLInputElement;
          if (input) {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, [inputSelector, solution.token] as [string, string]);
        logger.info('Captcha code filled into input field');
      }
      return solution;
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
