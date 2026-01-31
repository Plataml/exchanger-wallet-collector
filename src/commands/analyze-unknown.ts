/**
 * Deep analysis of unknown exchangers to discover new CMS patterns
 * Saves HTML, scripts, CSS patterns for manual review
 */

import { chromium, Browser, Page } from 'playwright';
import { initDb } from '../db';
import { logger } from '../logger';
import * as fs from 'fs';
import * as path from 'path';

interface AnalysisResult {
  domain: string;
  name: string;
  timestamp: string;

  // Page info
  title: string;
  generator?: string;

  // Script sources
  scripts: string[];
  inlineScriptPatterns: string[];

  // CSS info
  stylesheets: string[];
  cssClassPatterns: string[];

  // Form analysis
  forms: {
    action: string;
    method: string;
    fields: string[];
  }[];

  // Framework indicators
  frameworks: {
    name: string;
    confidence: number;
    evidence: string[];
  }[];

  // Meta tags
  metaTags: { name: string; content: string }[];

  // Unique patterns for CMS detection
  uniquePatterns: string[];

  error?: string;
}

interface UnknownExchanger {
  domain: string;
  name: string;
}

const TIMEOUT_MS = 30000;

async function analyzeExchanger(
  browser: Browser,
  exchanger: UnknownExchanger
): Promise<AnalysisResult> {
  const result: AnalysisResult = {
    domain: exchanger.domain,
    name: exchanger.name,
    timestamp: new Date().toISOString(),
    title: '',
    scripts: [],
    inlineScriptPatterns: [],
    stylesheets: [],
    cssClassPatterns: [],
    forms: [],
    frameworks: [],
    metaTags: [],
    uniquePatterns: []
  };

  let context = null;
  let page: Page | null = null;

  try {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true
    });
    page = await context.newPage();

    const url = `https://${exchanger.domain}/`;
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS
    });

    await page.waitForTimeout(3000);

    // Get full HTML for pattern search
    const html = await page.content();

    // Save HTML for manual review
    const htmlDir = 'data/unknown-html';
    if (!fs.existsSync(htmlDir)) {
      fs.mkdirSync(htmlDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(htmlDir, `${exchanger.domain}.html`),
      html
    );

    // Deep analysis
    const analysis = await page.evaluate(() => {
      const data: any = {};

      // Title
      data.title = document.title;

      // Generator meta
      const generator = document.querySelector('meta[name="generator"]');
      data.generator = generator?.getAttribute('content') || null;

      // All script sources
      data.scripts = Array.from(document.querySelectorAll('script[src]'))
        .map(s => (s as HTMLScriptElement).src)
        .filter(s => s);

      // Inline script patterns
      const inlineScripts = Array.from(document.querySelectorAll('script:not([src])'))
        .map(s => s.textContent || '');

      data.inlineScriptPatterns = [];
      for (const script of inlineScripts) {
        // Look for framework/CMS identifiers
        if (/window\.__NUXT__/.test(script)) data.inlineScriptPatterns.push('NUXT');
        if (/window\.__INITIAL_STATE__/.test(script)) data.inlineScriptPatterns.push('VUEX');
        if (/window\.Laravel/.test(script)) data.inlineScriptPatterns.push('Laravel');
        if (/window\.config\s*=/.test(script)) data.inlineScriptPatterns.push('window.config');
        if (/exchangeData|exchangerData/.test(script)) data.inlineScriptPatterns.push('exchangeData');
        if (/React\.createElement/.test(script)) data.inlineScriptPatterns.push('React');
        if (/angular\.module/.test(script)) data.inlineScriptPatterns.push('Angular');
        if (/new Vue\(/.test(script)) data.inlineScriptPatterns.push('Vue');
        if (/createApp/.test(script)) data.inlineScriptPatterns.push('Vue3');
        if (/jQuery|\\$\(/.test(script)) data.inlineScriptPatterns.push('jQuery');
        if (/bitrix/.test(script.toLowerCase())) data.inlineScriptPatterns.push('Bitrix');
        if (/wordpress|wp-/.test(script.toLowerCase())) data.inlineScriptPatterns.push('WordPress');
      }

      // Stylesheets
      data.stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .map(l => (l as HTMLLinkElement).href)
        .filter(h => h);

      // Unique CSS class patterns
      const allClasses = new Set<string>();
      document.querySelectorAll('[class]').forEach(el => {
        el.className.split(/\s+/).forEach(c => {
          if (c.length > 2) allClasses.add(c);
        });
      });

      // Find patterns in classes
      data.cssClassPatterns = [];
      const classArr = Array.from(allClasses);

      // Group by prefix
      const prefixes: Record<string, number> = {};
      for (const cls of classArr) {
        const match = cls.match(/^([a-z]+[-_])/i);
        if (match) {
          prefixes[match[1]] = (prefixes[match[1]] || 0) + 1;
        }
      }

      // Return most common prefixes
      data.cssClassPatterns = Object.entries(prefixes)
        .filter(([_, count]) => count >= 5)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([prefix, count]) => `${prefix}* (${count})`);

      // Forms analysis
      data.forms = Array.from(document.querySelectorAll('form')).map(form => ({
        action: form.action || '',
        method: form.method || 'get',
        fields: Array.from(form.querySelectorAll('input, select, textarea'))
          .map(f => `${f.tagName.toLowerCase()}[name="${f.getAttribute('name') || '?'}"]`)
      }));

      // Meta tags
      data.metaTags = Array.from(document.querySelectorAll('meta[name], meta[property]'))
        .slice(0, 20)
        .map(m => ({
          name: m.getAttribute('name') || m.getAttribute('property') || '',
          content: (m.getAttribute('content') || '').substring(0, 100)
        }));

      // Framework detection
      data.frameworks = [];

      // Check for common frameworks
      if ((window as any).__NUXT__) {
        data.frameworks.push({
          name: 'Nuxt.js',
          confidence: 100,
          evidence: ['window.__NUXT__']
        });
      }

      if ((window as any).Vue || document.querySelector('[data-v-]')) {
        data.frameworks.push({
          name: 'Vue.js',
          confidence: 80,
          evidence: ['Vue instance or data-v-* attributes']
        });
      }

      if ((window as any).React || document.querySelector('[data-reactroot]')) {
        data.frameworks.push({
          name: 'React',
          confidence: 80,
          evidence: ['React or data-reactroot']
        });
      }

      if ((window as any).angular || document.querySelector('[ng-app], [ng-controller]')) {
        data.frameworks.push({
          name: 'Angular',
          confidence: 80,
          evidence: ['Angular directives']
        });
      }

      if ((window as any).jQuery || (window as any).$) {
        data.frameworks.push({
          name: 'jQuery',
          confidence: 60,
          evidence: ['window.jQuery']
        });
      }

      // CMS-specific checks
      if (document.querySelector('link[href*="bitrix"], script[src*="bitrix"]')) {
        data.frameworks.push({
          name: '1C-Bitrix',
          confidence: 90,
          evidence: ['bitrix resources']
        });
      }

      if (document.querySelector('[class*="wp-"], [id*="wp-"]')) {
        data.frameworks.push({
          name: 'WordPress',
          confidence: 70,
          evidence: ['wp-* classes/ids']
        });
      }

      return data;
    });

    // Copy analysis to result
    result.title = analysis.title;
    result.generator = analysis.generator;
    result.scripts = analysis.scripts;
    result.inlineScriptPatterns = analysis.inlineScriptPatterns;
    result.stylesheets = analysis.stylesheets;
    result.cssClassPatterns = analysis.cssClassPatterns;
    result.forms = analysis.forms;
    result.frameworks = analysis.frameworks;
    result.metaTags = analysis.metaTags;

    // Search for unique patterns in HTML
    const patternChecks = [
      { pattern: /premiumexchanger|premiumbox/i, name: 'PremiumExchanger' },
      { pattern: /boxexchanger/i, name: 'BoxExchanger' },
      { pattern: /iexexchanger/i, name: 'iEXExchanger' },
      { pattern: /exchanger-cms/i, name: 'Exchanger-CMS' },
      { pattern: /obmennik\.ws|obmennik\.com/i, name: 'Obmennik' },
      { pattern: /bestchange/i, name: 'BestChange-widget' },
      { pattern: /kassa\.cc|kassa\.io/i, name: 'Kassa' },
      { pattern: /okchanger/i, name: 'OKchanger' },
      { pattern: /currate|currency-rate/i, name: 'CurrencyRate' },
      { pattern: /amlbot/i, name: 'AMLBot' },
      { pattern: /bitrix/i, name: 'Bitrix' },
      { pattern: /modx/i, name: 'MODX' },
      { pattern: /drupal/i, name: 'Drupal' },
      { pattern: /joomla/i, name: 'Joomla' },
      { pattern: /opencart/i, name: 'OpenCart' },
      { pattern: /laravel/i, name: 'Laravel' },
      { pattern: /symfony/i, name: 'Symfony' },
      { pattern: /django/i, name: 'Django' },
      { pattern: /express\.js|expressjs/i, name: 'Express.js' },
      { pattern: /fastify/i, name: 'Fastify' },
      { pattern: /next\.js|nextjs|__next/i, name: 'Next.js' },
      { pattern: /_nuxt|__NUXT__|nuxt/i, name: 'Nuxt.js' },
      { pattern: /gatsby/i, name: 'Gatsby' },
      { pattern: /svelte|sveltekit/i, name: 'Svelte' },
      { pattern: /tailwind/i, name: 'Tailwind CSS' },
      { pattern: /bootstrap/i, name: 'Bootstrap' },
      { pattern: /materialize/i, name: 'Materialize' },
      { pattern: /bulma/i, name: 'Bulma' },
    ];

    for (const { pattern, name } of patternChecks) {
      if (pattern.test(html)) {
        result.uniquePatterns.push(name);
      }
    }

    await context.close();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (context) {
      try { await context.close(); } catch {}
    }
  }

  return result;
}

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 30;

  // Load unknown exchangers from v2 results
  const v2ResultsPath = 'data/cms-detection-v2.json';
  if (!fs.existsSync(v2ResultsPath)) {
    console.error('cms-detection-v2.json not found. Run detect-cms first.');
    process.exit(1);
  }

  const v2Data = JSON.parse(fs.readFileSync(v2ResultsPath, 'utf-8'));
  const unknowns: UnknownExchanger[] = v2Data.results
    .filter((r: any) => r.cms === 'unknown' && !r.error && (!r.indicators || r.indicators.length === 0))
    .map((r: any) => ({ domain: r.domain, name: r.name }));

  const toAnalyze = limit > 0 ? unknowns.slice(0, limit) : unknowns;
  logger.info(`Analyzing ${toAnalyze.length} unknown exchangers (no indicators)...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results: AnalysisResult[] = [];

  try {
    for (let i = 0; i < toAnalyze.length; i++) {
      const exchanger = toAnalyze[i];
      logger.info(`[${i + 1}/${toAnalyze.length}] Analyzing ${exchanger.name} (${exchanger.domain})...`);

      const result = await analyzeExchanger(browser, exchanger);
      results.push(result);

      if (result.error) {
        logger.warn(`  ✗ Error: ${result.error.substring(0, 60)}`);
      } else {
        const frameworks = result.frameworks.map(f => f.name).join(', ') || 'none';
        const patterns = result.uniquePatterns.join(', ') || 'none';
        logger.info(`  ✓ Frameworks: ${frameworks}`);
        logger.info(`    Patterns: ${patterns}`);
        logger.info(`    CSS prefixes: ${result.cssClassPatterns.slice(0, 3).join(', ')}`);
      }

      // Small delay
      await new Promise(r => setTimeout(r, 1500));
    }
  } finally {
    await browser.close();
  }

  // Save results
  const outputFile = 'data/unknown-analysis.json';
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

  // Generate summary
  const summary: Record<string, string[]> = {};

  for (const r of results) {
    for (const pattern of r.uniquePatterns) {
      if (!summary[pattern]) summary[pattern] = [];
      summary[pattern].push(r.domain);
    }
    for (const fw of r.frameworks) {
      const key = `Framework: ${fw.name}`;
      if (!summary[key]) summary[key] = [];
      summary[key].push(r.domain);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('UNKNOWN ANALYSIS SUMMARY');
  console.log('='.repeat(60));
  console.log(`Analyzed: ${results.length}`);
  console.log(`Errors: ${results.filter(r => r.error).length}`);
  console.log('-'.repeat(60));
  console.log('Detected patterns:');

  for (const [pattern, domains] of Object.entries(summary).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${pattern}: ${domains.length} sites`);
    if (domains.length <= 5) {
      console.log(`    ${domains.join(', ')}`);
    }
  }

  console.log('='.repeat(60));
  console.log(`Results saved to: ${outputFile}`);
  console.log(`HTML files saved to: data/unknown-html/`);
}

main().catch(error => {
  logger.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
