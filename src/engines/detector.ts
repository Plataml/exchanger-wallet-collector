import { Page } from 'playwright';

export type EngineType =
  | 'premium-exchanger'
  | 'box-exchanger'
  | 'iex-exchanger'
  | 'exchanger-cms'
  | 'vue-spa'
  | 'multipage'
  | 'cloudflare-protected'
  | 'unknown';

export interface EngineSignature {
  type: EngineType;
  confidence: number;
  indicators: string[];
}

export async function detectEngine(page: Page): Promise<EngineSignature> {
  const indicators: string[] = [];
  let scores: Record<EngineType, number> = {
    'premium-exchanger': 0,
    'box-exchanger': 0,
    'iex-exchanger': 0,
    'exchanger-cms': 0,
    'vue-spa': 0,
    'multipage': 0,
    'cloudflare-protected': 0,
    'unknown': 0
  };

  // Get full HTML for pattern matching
  const html = await page.content();

  // Analyze page structure
  const analysis = await page.evaluate(() => {
    const result = {
      // Vue.js indicators
      hasVueElements: !!document.querySelector('[class*="v-"], [id*="v-radio"], [id*="v-checkbox"]'),
      hasCssModules: !!document.querySelector('[class*="_"][class*="_"]'),
      hasVueRequisites: !!document.querySelector('[name*="Requisites"]'),
      hasDataVAttributes: document.querySelectorAll('[data-v-]').length > 0 ||
        Array.from(document.querySelectorAll('*')).some(el =>
          Array.from(el.attributes).some(attr => attr.name.startsWith('data-v-'))
        ),

      // Multi-page indicators
      hasExchangeUrls: Array.from(document.querySelectorAll('a')).some(a =>
        /exchange_\w+_to_\w+/.test(a.href)
      ),
      hasSumFields: !!document.querySelector('[name="sum1"], [name="summ1"], .js_summ1'),

      // PremiumExchanger CMS indicators (selectors)
      hasJsExchangeLink: !!document.querySelector('.js_exchange_link, .xtp_submit'),
      hasJsSummClasses: !!document.querySelector('.js_summ1, .js_summ2, .js_amount'),
      hasSum1Field: !!document.querySelector('input[name="sum1"]'),
      hasAccount2Field: !!document.querySelector('input[name="account2"]'),

      // BoxExchanger indicators
      hasNuxtWindow: typeof (window as any).__NUXT__ !== 'undefined',
      hasBoxExchangerMeta: !!document.querySelector('meta[name*="boxexchanger"], meta[content*="boxexchanger"]'),

      // iEXExchanger indicators
      hasSanctumAuth: !!document.querySelector('meta[name="csrf-token"]'),
      hasIexPatterns: !!document.querySelector('.iex-exchange, .iex-calculator, [class*="iex-"]'),

      // Exchanger-CMS indicators
      hasExchangerCmsAuth: !!document.querySelector('a[href*="/auth/login"], a[href*="/auth/register"]'),
      hasExchangerCmsPatterns: !!document.querySelector('.exchange-form, .exchanger-widget'),

      // Cloudflare indicators
      hasCloudflare: !!document.querySelector('[name*="cf-turnstile"], [id*="cf-chl-widget"]'),
      hasCaptcha: !!document.querySelector('[name*="captcha"], [class*="captcha"], .g-recaptcha'),
      hasCloudflareChallenge: document.title.includes('Just a moment') ||
        !!document.querySelector('#challenge-running, #challenge-form'),

      // Common exchange indicators
      hasWalletField: !!document.querySelector('[name*="wallet"], [placeholder*="кошел"], [placeholder*="wallet"]'),
      hasEmailField: !!document.querySelector('[name="email"], [type="email"]'),
      hasAmountField: !!document.querySelector('[name*="sum"], [name*="amount"], [placeholder*="сумм"]'),

      // Registration requirement
      requiresAuth: !!document.querySelector('[href*="login"], [href*="register"], [href*="signin"]'),

      // Framework detection
      scripts: Array.from(document.querySelectorAll('script[src]')).map(s => (s as HTMLScriptElement).src),

      // Links for pattern detection
      links: Array.from(document.querySelectorAll('link[href]')).map(l => (l as HTMLLinkElement).href),

      // Form count
      formCount: document.querySelectorAll('form').length
    };
    return result;
  });

  // ============================================
  // PremiumExchanger Detection (Priority Check)
  // ============================================

  // GUARANTEED indicators - if found, it's 100% PremiumExchanger
  const peGuaranteedPatterns = [
    { pattern: /\/wp-content\/plugins\/premiumbox\//i, name: 'premiumbox-plugin' },
    { pattern: /\/wp-content\/pn_uploads\//i, name: 'pn-uploads' },
    { pattern: /\/premiumbox\//i, name: 'premiumbox-path' },
    { pattern: /\/wp-content\/themes\/newexchanger/i, name: 'newexchanger-theme' },
    { pattern: /\/wp-content\/themes\/flavor\//i, name: 'flavor-theme' },
  ];

  let isPremiumExchangerGuaranteed = false;
  for (const { pattern, name } of peGuaranteedPatterns) {
    if (pattern.test(html)) {
      indicators.push(name);
      scores['premium-exchanger'] = 100;
      isPremiumExchangerGuaranteed = true;
      break;
    }
  }

  // If not guaranteed, check other PremiumExchanger indicators
  if (!isPremiumExchangerGuaranteed) {
    if (analysis.hasJsExchangeLink) { scores['premium-exchanger'] += 35; indicators.push('pe-js-exchange-link'); }
    if (analysis.hasJsSummClasses) { scores['premium-exchanger'] += 40; indicators.push('pe-js-summ-classes'); }
    if (analysis.hasSum1Field) { scores['premium-exchanger'] += 30; indicators.push('pe-sum1-field'); }
    if (analysis.hasAccount2Field) { scores['premium-exchanger'] += 30; indicators.push('pe-account2-field'); }

    if (/premiumbox|premiumjs/i.test(html)) {
      scores['premium-exchanger'] += 50;
      indicators.push('pe-premiumbox');
    }

    if (/wp-content\/themes\/exchanger/i.test(html)) {
      scores['premium-exchanger'] += 30;
      indicators.push('pe-wp-exchanger-theme');
    }

    if (analysis.hasExchangeUrls) {
      scores['premium-exchanger'] += 20;
      indicators.push('pe-exchange-urls');
    }
  }

  // ============================================
  // BoxExchanger Detection
  // ============================================

  // Guaranteed BoxExchanger patterns
  const boxGuaranteedPatterns = [
    { pattern: /boxexchanger\.net/i, name: 'box-domain' },
    { pattern: /licence\.boxexchanger/i, name: 'box-licence' },
    { pattern: /box-exchanger/i, name: 'box-name' },
  ];

  let isBoxExchangerGuaranteed = false;
  for (const { pattern, name } of boxGuaranteedPatterns) {
    if (pattern.test(html)) {
      indicators.push(name);
      scores['box-exchanger'] = 100;
      isBoxExchangerGuaranteed = true;
      break;
    }
  }

  if (!isBoxExchangerGuaranteed) {
    // BoxExchanger uses Nuxt.js with specific patterns
    if (analysis.hasNuxtWindow) {
      scores['box-exchanger'] += 25;
      indicators.push('box-nuxt-window');
    }

    // Check for BoxExchanger-specific CSS/JS patterns
    if (/develop\.exchange/i.test(html)) {
      scores['box-exchanger'] += 40;
      indicators.push('box-develop-exchange');
    }

    // BoxExchanger specific class patterns
    if (/class="[^"]*exchange-calculator[^"]*"/i.test(html) && analysis.hasNuxtWindow) {
      scores['box-exchanger'] += 30;
      indicators.push('box-calculator-class');
    }

    // AMLBot integration (common in BoxExchanger)
    if (/amlbot/i.test(html)) {
      scores['box-exchanger'] += 15;
      indicators.push('box-amlbot');
    }
  }

  // ============================================
  // iEXExchanger Detection
  // ============================================

  // Guaranteed iEXExchanger patterns
  const iexGuaranteedPatterns = [
    { pattern: /iexexchanger\.com/i, name: 'iex-domain' },
    { pattern: /iexexchanger/i, name: 'iex-name' },
  ];

  let isIexExchangerGuaranteed = false;
  for (const { pattern, name } of iexGuaranteedPatterns) {
    if (pattern.test(html)) {
      indicators.push(name);
      scores['iex-exchanger'] = 100;
      isIexExchangerGuaranteed = true;
      break;
    }
  }

  if (!isIexExchangerGuaranteed) {
    // iEXExchanger uses Vue 3 + Nuxt with Sanctum auth
    if (analysis.hasDataVAttributes && analysis.hasSanctumAuth) {
      scores['iex-exchanger'] += 35;
      indicators.push('iex-vue-sanctum');
    }

    if (analysis.hasIexPatterns) {
      scores['iex-exchanger'] += 40;
      indicators.push('iex-class-patterns');
    }

    // Check for specific iEX API patterns
    if (/\/frontend\/api\/v1/i.test(html) || /sanctum\/csrf-cookie/i.test(html)) {
      scores['iex-exchanger'] += 45;
      indicators.push('iex-api-pattern');
    }

    // iEX specific storage pattern
    if (/app\.iexexchanger\.com\/storage/i.test(html)) {
      scores['iex-exchanger'] += 50;
      indicators.push('iex-storage');
    }
  }

  // ============================================
  // Exchanger-CMS Detection
  // ============================================

  // Guaranteed Exchanger-CMS patterns
  const ecmsGuaranteedPatterns = [
    { pattern: /exchanger-cms\.com/i, name: 'ecms-domain' },
    { pattern: /powered by exchanger-cms/i, name: 'ecms-powered' },
  ];

  let isExchangerCmsGuaranteed = false;
  for (const { pattern, name } of ecmsGuaranteedPatterns) {
    if (pattern.test(html)) {
      indicators.push(name);
      scores['exchanger-cms'] = 100;
      isExchangerCmsGuaranteed = true;
      break;
    }
  }

  if (!isExchangerCmsGuaranteed) {
    // Exchanger-CMS auth patterns
    if (analysis.hasExchangerCmsAuth) {
      scores['exchanger-cms'] += 30;
      indicators.push('ecms-auth-links');
    }

    // Check for PHP-based exchanger patterns
    if (/\/auth\/login|\/auth\/register|\/auth\/forgot-password/i.test(html)) {
      scores['exchanger-cms'] += 35;
      indicators.push('ecms-auth-routes');
    }

    // Exchanger-CMS specific patterns
    if (analysis.hasExchangerCmsPatterns) {
      scores['exchanger-cms'] += 25;
      indicators.push('ecms-widget-patterns');
    }

    // Rate export patterns (XML/JSON)
    if (/\/export\/rates|rates\.xml|rates\.json/i.test(html)) {
      scores['exchanger-cms'] += 20;
      indicators.push('ecms-rate-export');
    }
  }

  // ============================================
  // Vue SPA Detection (generic, not specific CMS)
  // ============================================

  // Only score Vue SPA if not already detected as a specific CMS
  const detectedSpecificCms = isPremiumExchangerGuaranteed || isBoxExchangerGuaranteed ||
    isIexExchangerGuaranteed || isExchangerCmsGuaranteed;

  if (!detectedSpecificCms) {
    if (analysis.hasVueElements) {
      scores['vue-spa'] += 30;
      indicators.push('vue-elements');
    }
    if (analysis.hasCssModules) {
      scores['vue-spa'] += 20;
      indicators.push('vue-css-modules');
    }
    if (analysis.hasVueRequisites) {
      scores['vue-spa'] += 25;
      indicators.push('vue-requisites');
    }
    if (analysis.hasDataVAttributes) {
      scores['vue-spa'] += 25;
      indicators.push('vue-data-v');
    }

    const hasVueScript = analysis.scripts.some(s => /vue|nuxt/i.test(s));
    if (hasVueScript) {
      scores['vue-spa'] += 15;
      indicators.push('vue-script');
    }
  }

  // ============================================
  // Multi-page Detection
  // ============================================
  if (!detectedSpecificCms) {
    if (analysis.hasExchangeUrls) {
      scores['multipage'] += 40;
      indicators.push('mp-exchange-urls');
    }
    if (analysis.hasSumFields) {
      scores['multipage'] += 20;
      indicators.push('mp-sum-fields');
    }
  }

  // ============================================
  // Cloudflare Protection Detection
  // ============================================
  if (analysis.hasCloudflareChallenge) {
    scores['cloudflare-protected'] = 100;
    indicators.push('cf-challenge');
  } else {
    if (analysis.hasCloudflare) {
      scores['cloudflare-protected'] += 50;
      indicators.push('cf-turnstile');
    }
    if (analysis.hasCaptcha) {
      scores['cloudflare-protected'] += 20;
      indicators.push('cf-captcha');
    }
  }

  // ============================================
  // Determine Winner
  // ============================================
  const maxScore = Math.max(...Object.values(scores));
  let detectedType: EngineType = 'unknown';

  if (maxScore >= 30) {
    detectedType = Object.entries(scores).find(([_, score]) => score === maxScore)?.[0] as EngineType || 'unknown';
  }

  const confidence = maxScore > 0 ? Math.min(maxScore, 100) : 0;

  return {
    type: detectedType,
    confidence,
    indicators
  };
}
