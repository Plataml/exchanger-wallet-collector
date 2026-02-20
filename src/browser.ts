import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { config } from './config';
import { logger } from './logger';

let browser: Browser | null = null;

export async function launchBrowser(): Promise<Browser> {
  if (browser) {
    return browser;
  }

  const launchOptions: any = {
    headless: config.headless
  };

  if (config.proxyUrl) {
    launchOptions.proxy = {
      server: config.proxyUrl
    };
  }

  browser = await chromium.launch(launchOptions);
  return browser;
}

export async function createContext(): Promise<BrowserContext> {
  const b = await launchBrowser();
  return b.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
}

export async function createPage(): Promise<Page> {
  const context = await createContext();
  return context.newPage();
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export async function clearBrowserStorage(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    });
    await page.context().clearCookies();
    logger.debug('Browser storage cleared');
  } catch (err) {
    logger.debug(`Failed to clear storage: ${err}`);
  }
}

export async function takeScreenshot(page: Page, filename: string): Promise<string> {
  const screenshotPath = `${config.screenshotsPath}/${filename}`;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}
