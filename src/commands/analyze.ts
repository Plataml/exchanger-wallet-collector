import { chromium, Page } from 'playwright';
import { config } from '../config';
import { initDb } from '../db';
import { detectEngine } from '../engines/detector';
import { recordSuccess } from '../engines/learned-patterns';
import fs from 'fs';
import path from 'path';

interface AnalysisResult {
  domain: string;
  engineType: string;
  confidence: number;
  indicators: string[];
  fields: Record<string, {
    selector: string;
    found: boolean;
    value?: string;
  }>;
  exchangePairs: string[];
  screenshots: string[];
}

async function analyzeExchanger(domain: string): Promise<void> {
  const analyzeDir = path.join(config.dataPath, 'analyze', domain);
  if (!fs.existsSync(analyzeDir)) {
    fs.mkdirSync(analyzeDir, { recursive: true });
  }

  console.log(`\n🔍 Analyzing ${domain}...\n`);

  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const result: AnalysisResult = {
    domain,
    engineType: 'unknown',
    confidence: 0,
    indicators: [],
    fields: {},
    exchangePairs: [],
    screenshots: []
  };

  try {
    // Load page
    console.log('📄 Loading page...');
    await page.goto(`https://${domain}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Screenshot
    const screenshot1 = path.join(analyzeDir, '01_main.png');
    await page.screenshot({ path: screenshot1, fullPage: true });
    result.screenshots.push(screenshot1);
    console.log(`📸 Screenshot: ${screenshot1}`);

    // Detect engine
    const signature = await detectEngine(page);
    result.engineType = signature.type;
    result.confidence = signature.confidence;
    result.indicators = signature.indicators;
    console.log(`\n🔧 Engine: ${signature.type} (${(signature.confidence * 100).toFixed(0)}%)`);
    console.log(`   Indicators: ${signature.indicators.join(', ')}`);

    // Find all form fields with smart detection
    console.log('\n📝 Analyzing form fields...');
    const fields = await analyzeFormFields(page);
    result.fields = fields;

    // Print found fields
    for (const [fieldType, info] of Object.entries(fields)) {
      if (info.found) {
        console.log(`   ✅ ${fieldType}: ${info.selector}`);
        // Record successful selector
        recordSuccess(domain, signature.type, fieldType, info.selector);
      } else {
        console.log(`   ❌ ${fieldType}: not found`);
      }
    }

    // Find exchange pair URLs
    console.log('\n🔗 Finding exchange pairs...');
    result.exchangePairs = await findExchangePairs(page);
    if (result.exchangePairs.length > 0) {
      console.log(`   Found ${result.exchangePairs.length} exchange pairs`);
      result.exchangePairs.slice(0, 5).forEach(url => console.log(`   - ${url}`));
    }

    // If multipage, try navigating to a specific pair
    if (result.exchangePairs.length > 0) {
      const testUrl = result.exchangePairs[0];
      console.log(`\n🔀 Testing exchange page: ${testUrl}`);
      await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const screenshot2 = path.join(analyzeDir, '02_exchange.png');
      await page.screenshot({ path: screenshot2, fullPage: true });
      result.screenshots.push(screenshot2);

      // Analyze fields on exchange page
      const exchangeFields = await analyzeFormFields(page);
      console.log('\n📝 Exchange page fields:');
      for (const [fieldType, info] of Object.entries(exchangeFields)) {
        if (info.found && !result.fields[fieldType]?.found) {
          result.fields[fieldType] = info;
          console.log(`   ✅ ${fieldType}: ${info.selector}`);
          recordSuccess(domain, signature.type, fieldType, info.selector);
        }
      }
    }

    // Save analysis
    fs.writeFileSync(
      path.join(analyzeDir, 'analysis.json'),
      JSON.stringify(result, null, 2)
    );

    console.log(`\n✨ Analysis complete! Results saved to ${analyzeDir}`);

  } catch (error) {
    console.error(`\n❌ Error: ${error instanceof Error ? error.message : error}`);
  } finally {
    await browser.close();
  }
}

async function analyzeFormFields(page: Page): Promise<Record<string, { selector: string; found: boolean }>> {
  return page.evaluate(() => {
    const fields: Record<string, { selector: string; found: boolean }> = {
      amount: { selector: '', found: false },
      wallet: { selector: '', found: false },
      email: { selector: '', found: false },
      card: { selector: '', found: false },
      name: { selector: '', found: false },
      submit: { selector: '', found: false }
    };

    // Amount field patterns
    const amountSelectors = [
      '[name*="sum"], [name*="amount"]',
      '[placeholder*="сумм"], [placeholder*="amount"]',
      '[class*="amount"] input, [class*="sum"] input',
      '#sum1, #sum, #amount, #sumFrom',
      '.js_summ1 input, .js_summ2 input'
    ];

    // Wallet field patterns
    const walletSelectors = [
      '[name*="wallet"], [name*="address"]',
      '[placeholder*="кошел"], [placeholder*="wallet"], [placeholder*="адрес"]',
      '[name*="Requisites.wallet"], [name="account2"]',
      '#wallet, #address'
    ];

    // Email field patterns
    const emailSelectors = [
      '[name="email"], [type="email"]',
      '[placeholder*="email"], [placeholder*="почт"]',
      '#email'
    ];

    // Card field patterns
    const cardSelectors = [
      '[name*="card"], [name*="Requisites.card"]',
      '[placeholder*="карт"]',
      '#card, #cardnumber'
    ];

    // Name field patterns
    const nameSelectors = [
      '[name*="fio"], [name*="name"], [name*="Requisites.fio"]',
      '[placeholder*="ФИО"], [placeholder*="имя"]',
      '#fio, #name'
    ];

    // Submit button patterns
    const submitSelectors = [
      'button[type="submit"]',
      '[class*="submit"], [class*="exchange-btn"]',
      'button:not([type="button"])',
      'input[type="submit"]'
    ];

    function findField(selectors: string[]): { selector: string; found: boolean } {
      for (const selector of selectors) {
        try {
          const el = document.querySelector(selector);
          if (el && (el as HTMLElement).offsetParent !== null) {
            return { selector, found: true };
          }
        } catch { }
      }
      return { selector: '', found: false };
    }

    fields.amount = findField(amountSelectors);
    fields.wallet = findField(walletSelectors);
    fields.email = findField(emailSelectors);
    fields.card = findField(cardSelectors);
    fields.name = findField(nameSelectors);
    fields.submit = findField(submitSelectors);

    return fields;
  });
}

async function findExchangePairs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const patterns = [
      /exchange_\w+_to_\w+/i,
      /\/exchange\/\w+\/\w+/i,
      /\w+-to-\w+/i
    ];

    const pairs: string[] = [];
    const anchors = document.querySelectorAll('a[href]');

    anchors.forEach(a => {
      const href = (a as HTMLAnchorElement).href;
      for (const pattern of patterns) {
        if (pattern.test(href) && !pairs.includes(href)) {
          pairs.push(href);
          break;
        }
      }
    });

    return pairs.slice(0, 20);
  });
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
    console.error('Usage: npm run analyze -- --domain=example.com');
    process.exit(1);
  }

  domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

  await initDb();
  await analyzeExchanger(domain);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
