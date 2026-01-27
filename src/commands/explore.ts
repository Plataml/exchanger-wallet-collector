import { chromium } from 'playwright';
import { config } from '../config';
import { initDb } from '../db';
import fs from 'fs';
import path from 'path';

interface ExploreResult {
  domain: string;
  url: string;
  title: string;
  screenshots: string[];
  forms: Array<{ action: string; inputs: Array<{ name: string; type: string; placeholder?: string }> }>;
  links: Array<{ text: string; href: string }>;
  selectors: string[];
}

async function explore(domain: string): Promise<void> {
  const exploreDir = path.join(config.dataPath, 'explore', domain);
  if (!fs.existsSync(exploreDir)) {
    fs.mkdirSync(exploreDir, { recursive: true });
  }

  console.log(`[EXPLORE] Starting exploration of ${domain}`);

  const launchOptions: { headless: boolean; proxy?: { server: string } } = {
    headless: config.headless
  };
  if (config.proxyUrl) {
    launchOptions.proxy = { server: config.proxyUrl };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  const page = await context.newPage();

  const result: ExploreResult = {
    domain,
    url: '',
    title: '',
    screenshots: [],
    forms: [],
    links: [],
    selectors: []
  };

  try {
    // Step 1: Load main page
    const url = `https://${domain}`;
    console.log(`[EXPLORE] Loading ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });

    result.url = page.url();
    result.title = await page.title();

    // Screenshot main page
    const mainScreenshot = path.join(exploreDir, '01_main.png');
    await page.screenshot({ path: mainScreenshot, fullPage: true });
    result.screenshots.push(mainScreenshot);
    console.log(`[EXPLORE] Screenshot: ${mainScreenshot}`);

    // Extract forms
    result.forms = await page.evaluate(() => {
      const forms: Array<{ action: string; inputs: Array<{ name: string; type: string; placeholder?: string }> }> = [];
      document.querySelectorAll('form').forEach((form: HTMLFormElement) => {
        const inputs: Array<{ name: string; type: string; placeholder?: string }> = [];
        form.querySelectorAll('input, select, textarea').forEach((el: Element) => {
          const inputEl = el as HTMLInputElement;
          inputs.push({
            name: inputEl.name || inputEl.id || '',
            type: inputEl.type || el.tagName.toLowerCase(),
            placeholder: inputEl.placeholder
          });
        });
        forms.push({ action: form.action, inputs });
      });
      return forms;
    });

    // Extract links with exchange-related keywords
    result.links = await page.evaluate(() => {
      const keywords = ['exchange', 'обмен', 'swap', 'trade', 'buy', 'sell', 'купить', 'продать'];
      const links: Array<{ text: string; href: string }> = [];
      document.querySelectorAll('a').forEach((a: HTMLAnchorElement) => {
        const text = a.textContent?.trim() || '';
        const href = a.href;
        if (keywords.some(k => text.toLowerCase().includes(k) || href.toLowerCase().includes(k))) {
          links.push({ text, href });
        }
      });
      return links.slice(0, 20);
    });

    // Extract useful selectors
    result.selectors = await page.evaluate(() => {
      const selectors: string[] = [];
      const keywords = ['amount', 'sum', 'wallet', 'address', 'card', 'email', 'submit', 'exchange', 'swap'];

      document.querySelectorAll('input, button, select, [class*="currency"], [class*="crypto"]').forEach((el: Element) => {
        const inputEl = el as HTMLInputElement;
        const id = el.id;
        const name = inputEl.name;
        const className = el.className;

        if (id) selectors.push(`#${id}`);
        if (name) selectors.push(`[name="${name}"]`);
        if (className && typeof className === 'string' && keywords.some(k => className.toLowerCase().includes(k))) {
          selectors.push(`.${className.split(' ')[0]}`);
        }
      });

      return [...new Set(selectors)].slice(0, 30);
    });

    // Save HTML structure
    const html = await page.content();
    fs.writeFileSync(path.join(exploreDir, 'page.html'), html);

    // Save exploration result
    fs.writeFileSync(
      path.join(exploreDir, 'result.json'),
      JSON.stringify(result, null, 2)
    );

    console.log(`[EXPLORE] Done. Results saved to ${exploreDir}`);
    console.log(`[EXPLORE] Title: ${result.title}`);
    console.log(`[EXPLORE] Forms found: ${result.forms.length}`);
    console.log(`[EXPLORE] Exchange links: ${result.links.length}`);
    console.log(`[EXPLORE] Selectors: ${result.selectors.length}`);

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[EXPLORE] Error: ${errorMsg}`);

    // Try to save error screenshot
    try {
      const errorScreenshot = path.join(exploreDir, 'error.png');
      await page.screenshot({ path: errorScreenshot });
      console.log(`[EXPLORE] Error screenshot: ${errorScreenshot}`);
    } catch {
      // Ignore screenshot errors
    }

  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let domain: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--domain=')) {
      domain = arg.split('=')[1];
    }
  }

  if (!domain) {
    console.error('Usage: npm run explore -- --domain=example.com');
    process.exit(1);
  }

  // Remove protocol if provided
  domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

  await initDb();
  await explore(domain);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
