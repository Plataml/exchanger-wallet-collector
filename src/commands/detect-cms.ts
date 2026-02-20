/**
 * CMS Detection Script v2
 * Scans all exchangers and identifies which CMS they use
 * Supports: PremiumExchanger, BoxExchanger, iEXExchanger, Exchanger-CMS, Vue SPA
 */

import { chromium, Browser, Page } from 'playwright';
import { initDb, getActiveExchangers } from '../db';
import { logger } from '../logger';
import { detectEngine, EngineType } from '../engines/detector';
import * as fs from 'fs';
import * as path from 'path';

interface Exchanger {
  id: number;
  name: string;
  domain: string;
  is_active: number;
}

interface CMSDetectionResult {
  domain: string;
  name: string;
  cms: EngineType;
  confidence: number;
  indicators: string[];
  error?: string;
  errorType?: 'timeout' | 'blocked' | 'dns' | 'ssl' | 'other';
  retries?: number;
  timestamp: string;
}

interface DetectionStats {
  total: number;
  scanned: number;
  premiumExchanger: number;
  boxExchanger: number;
  iexExchanger: number;
  exchangerCms: number;
  vueSpa: number;
  multipage: number;
  cloudflareProtected: number;
  unknown: number;
  errors: number;
  errorsByType: Record<string, number>;
}

const MAX_RETRIES = 1;
const TIMEOUT_MS = 25000;
const RETRY_DELAY_MS = 2000;
const SCAN_TIMEOUT_MS = 60000; // Overall timeout per site

function classifyError(error: Error): CMSDetectionResult['errorType'] {
  const msg = error.message.toLowerCase();

  if (msg.includes('timeout') || msg.includes('exceeded')) {
    return 'timeout';
  }
  if (msg.includes('net::err_name_not_resolved') || msg.includes('dns')) {
    return 'dns';
  }
  if (msg.includes('ssl') || msg.includes('certificate') || msg.includes('net::err_cert')) {
    return 'ssl';
  }
  if (msg.includes('403') || msg.includes('blocked') || msg.includes('access denied')) {
    return 'blocked';
  }
  return 'other';
}

// Wrapper with overall timeout to prevent hanging
async function scanWithTimeout(
  browser: Browser,
  domain: string,
  name: string
): Promise<CMSDetectionResult> {
  const timeoutPromise = new Promise<CMSDetectionResult>((_, reject) => {
    setTimeout(() => reject(new Error('Scan timeout exceeded')), SCAN_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      scanExchanger(browser, domain, name),
      timeoutPromise
    ]);
  } catch (error) {
    return {
      domain,
      name,
      cms: 'unknown',
      confidence: 0,
      indicators: [],
      error: error instanceof Error ? error.message : String(error),
      errorType: 'timeout',
      timestamp: new Date().toISOString()
    };
  }
}

async function scanExchanger(
  browser: Browser,
  domain: string,
  name: string,
  retryCount = 0
): Promise<CMSDetectionResult> {
  const result: CMSDetectionResult = {
    domain,
    name,
    cms: 'unknown',
    confidence: 0,
    indicators: [],
    retries: retryCount,
    timestamp: new Date().toISOString()
  };

  let page: Page | null = null;
  let context = null;

  try {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true
    });
    page = await context.newPage();

    // Navigate to main page with extended timeout
    const url = `https://${domain}/`;
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS
    });

    // Wait for dynamic content
    await page.waitForTimeout(2500);

    // Use the unified detector
    const detection = await detectEngine(page);

    result.cms = detection.type;
    result.confidence = detection.confidence;
    result.indicators = detection.indicators;

    await context.close();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    result.error = err.message;
    result.errorType = classifyError(err);

    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    }

    // Retry on timeout or temporary errors
    if (retryCount < MAX_RETRIES && (result.errorType === 'timeout' || result.errorType === 'other')) {
      logger.info(`  Retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return scanExchanger(browser, domain, name, retryCount + 1);
    }
  }

  return result;
}

async function saveResults(
  file: string,
  results: CMSDetectionResult[],
  stats: DetectionStats
) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const data = {
    timestamp: new Date().toISOString(),
    stats,
    results
  };

  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
  const outputArg = args.find(a => a.startsWith('--output='));
  const outputFile = outputArg ? outputArg.split('=')[1] : 'data/cms-detection-v2.json';
  const onlyUnknown = args.includes('--only-unknown');
  const onlyErrors = args.includes('--only-errors');
  const resume = args.includes('--resume');

  // Initialize
  await initDb();
  let exchangers = getActiveExchangers() as Exchanger[];

  // Resume: load previous results and skip already scanned domains
  let previousResults: CMSDetectionResult[] = [];
  let previousStats: DetectionStats | null = null;

  if (resume && fs.existsSync(outputFile)) {
    const prevData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    previousResults = prevData.results as CMSDetectionResult[];
    previousStats = prevData.stats as DetectionStats;
    const scannedDomains = new Set(previousResults.map(r => r.domain));
    const before = exchangers.length;
    exchangers = exchangers.filter(e => !scannedDomains.has(e.domain));
    logger.info(`Resume mode: loaded ${previousResults.length} previous results, ${before - exchangers.length} skipped, ${exchangers.length} remaining`);
  }

  // Filter by previous results if requested
  if (onlyUnknown || onlyErrors) {
    const prevResultsPath = 'data/cms-detection.json';
    if (fs.existsSync(prevResultsPath)) {
      const prevData = JSON.parse(fs.readFileSync(prevResultsPath, 'utf-8'));
      const prevResults = prevData.results as CMSDetectionResult[];

      const filterDomains = new Set<string>();
      for (const r of prevResults) {
        if (onlyUnknown && r.cms === 'unknown' && !r.error) {
          filterDomains.add(r.domain);
        }
        if (onlyErrors && r.error) {
          filterDomains.add(r.domain);
        }
      }

      exchangers = exchangers.filter(e => filterDomains.has(e.domain));
      logger.info(`Filtered to ${exchangers.length} exchangers (${onlyUnknown ? 'unknown' : ''}${onlyErrors ? 'errors' : ''})`);
    }
  }

  const toScan = limit > 0 ? exchangers.slice(0, limit) : exchangers;
  logger.info(`Starting CMS detection v2 for ${toScan.length} exchangers...`);

  const stats: DetectionStats = previousStats || {
    total: toScan.length,
    scanned: 0,
    premiumExchanger: 0,
    boxExchanger: 0,
    iexExchanger: 0,
    exchangerCms: 0,
    vueSpa: 0,
    multipage: 0,
    cloudflareProtected: 0,
    unknown: 0,
    errors: 0,
    errorsByType: {}
  };

  if (resume) {
    stats.total = previousResults.length + toScan.length;
  }

  const results: CMSDetectionResult[] = [...previousResults];

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    for (const exchanger of toScan) {
      logger.info(`[${stats.scanned + 1}/${toScan.length}] Scanning ${exchanger.name} (${exchanger.domain})...`);

      const result = await scanWithTimeout(browser, exchanger.domain, exchanger.name);
      results.push(result);

      // Update stats
      stats.scanned++;

      if (result.error) {
        stats.errors++;
        const errType = result.errorType || 'other';
        stats.errorsByType[errType] = (stats.errorsByType[errType] || 0) + 1;
        logger.warn(`  ✗ Error (${errType}): ${result.error.substring(0, 60)}...`);
      } else {
        // Update CMS-specific stats
        switch (result.cms) {
          case 'premium-exchanger':
            stats.premiumExchanger++;
            logger.info(`  ✓ PremiumExchanger (${result.confidence}%) - ${result.indicators.join(', ')}`);
            break;
          case 'box-exchanger':
            stats.boxExchanger++;
            logger.info(`  ✓ BoxExchanger (${result.confidence}%) - ${result.indicators.join(', ')}`);
            break;
          case 'iex-exchanger':
            stats.iexExchanger++;
            logger.info(`  ✓ iEXExchanger (${result.confidence}%) - ${result.indicators.join(', ')}`);
            break;
          case 'exchanger-cms':
            stats.exchangerCms++;
            logger.info(`  ✓ Exchanger-CMS (${result.confidence}%) - ${result.indicators.join(', ')}`);
            break;
          case 'vue-spa':
            stats.vueSpa++;
            logger.info(`  ✓ Vue SPA (${result.confidence}%) - ${result.indicators.join(', ')}`);
            break;
          case 'multipage':
            stats.multipage++;
            logger.info(`  ✓ Multipage (${result.confidence}%) - ${result.indicators.join(', ')}`);
            break;
          case 'cloudflare-protected':
            stats.cloudflareProtected++;
            logger.info(`  ⚠ Cloudflare Protected (${result.confidence}%) - ${result.indicators.join(', ')}`);
            break;
          default:
            stats.unknown++;
            logger.info(`  ? Unknown CMS`);
        }
      }

      // Save intermediate results every 10 exchangers
      if (stats.scanned % 10 === 0) {
        await saveResults(outputFile, results, stats);
      }

      // Random delay between scans
      const delay = Math.floor(Math.random() * 2000) + 1500;
      await new Promise(r => setTimeout(r, delay));
    }
  } finally {
    await browser.close();
  }

  // Save final results
  await saveResults(outputFile, results, stats);

  // Save separate files per CMS type
  const cmsTypes: EngineType[] = [
    'premium-exchanger', 'box-exchanger', 'iex-exchanger',
    'exchanger-cms', 'vue-spa', 'multipage', 'cloudflare-protected'
  ];

  for (const cms of cmsTypes) {
    const cmsResults = results.filter(r => r.cms === cms);
    if (cmsResults.length > 0) {
      const cmsFile = outputFile.replace('.json', `-${cms}.json`);
      fs.writeFileSync(cmsFile, JSON.stringify(cmsResults, null, 2));
    }
  }

  // Save errors separately
  const errorResults = results.filter(r => r.error);
  if (errorResults.length > 0) {
    const errFile = outputFile.replace('.json', '-errors.json');
    fs.writeFileSync(errFile, JSON.stringify(errorResults, null, 2));
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('CMS DETECTION v2 SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total exchangers: ${stats.total}`);
  console.log(`Successfully scanned: ${stats.scanned - stats.errors}`);
  console.log(`Errors: ${stats.errors}`);

  if (Object.keys(stats.errorsByType).length > 0) {
    console.log('  Error breakdown:');
    for (const [type, count] of Object.entries(stats.errorsByType)) {
      console.log(`    - ${type}: ${count}`);
    }
  }

  console.log('-'.repeat(60));
  console.log('Detected CMS:');
  console.log(`  PremiumExchanger: ${stats.premiumExchanger} (${((stats.premiumExchanger / stats.scanned) * 100).toFixed(1)}%)`);
  console.log(`  BoxExchanger:     ${stats.boxExchanger} (${((stats.boxExchanger / stats.scanned) * 100).toFixed(1)}%)`);
  console.log(`  iEXExchanger:     ${stats.iexExchanger} (${((stats.iexExchanger / stats.scanned) * 100).toFixed(1)}%)`);
  console.log(`  Exchanger-CMS:    ${stats.exchangerCms} (${((stats.exchangerCms / stats.scanned) * 100).toFixed(1)}%)`);
  console.log(`  Vue SPA:          ${stats.vueSpa} (${((stats.vueSpa / stats.scanned) * 100).toFixed(1)}%)`);
  console.log(`  Multipage:        ${stats.multipage} (${((stats.multipage / stats.scanned) * 100).toFixed(1)}%)`);
  console.log(`  CF Protected:     ${stats.cloudflareProtected} (${((stats.cloudflareProtected / stats.scanned) * 100).toFixed(1)}%)`);
  console.log(`  Unknown:          ${stats.unknown} (${((stats.unknown / stats.scanned) * 100).toFixed(1)}%)`);
  console.log('='.repeat(60));
  console.log(`Results saved to: ${outputFile}`);
}

main().catch(error => {
  logger.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
