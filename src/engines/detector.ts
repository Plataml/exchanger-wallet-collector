import { Page } from 'playwright';

export type EngineType = 'vue-spa' | 'multipage' | 'cloudflare-protected' | 'unknown';

export interface EngineSignature {
  type: EngineType;
  confidence: number;
  indicators: string[];
}

export async function detectEngine(page: Page): Promise<EngineSignature> {
  const indicators: string[] = [];
  let scores: Record<EngineType, number> = {
    'vue-spa': 0,
    'multipage': 0,
    'cloudflare-protected': 0,
    'unknown': 0
  };

  // Analyze page structure
  const analysis = await page.evaluate(() => {
    const result = {
      // Vue.js indicators
      hasVueElements: !!document.querySelector('[class*="v-"], [id*="v-radio"], [id*="v-checkbox"]'),
      hasCssModules: !!document.querySelector('[class*="_"][class*="_"]'),
      hasVueRequisites: !!document.querySelector('[name*="Requisites"]'),

      // Multi-page indicators
      hasExchangeUrls: Array.from(document.querySelectorAll('a')).some(a =>
        /exchange_\w+_to_\w+/.test(a.href)
      ),
      hasSumFields: !!document.querySelector('[name="sum1"], [name="summ1"], .js_summ1'),

      // Cloudflare indicators
      hasCloudflare: !!document.querySelector('[name*="cf-turnstile"], [id*="cf-chl-widget"]'),
      hasCaptcha: !!document.querySelector('[name*="captcha"], [class*="captcha"], .g-recaptcha'),

      // Common exchange indicators
      hasWalletField: !!document.querySelector('[name*="wallet"], [placeholder*="кошел"], [placeholder*="wallet"]'),
      hasEmailField: !!document.querySelector('[name="email"], [type="email"]'),
      hasAmountField: !!document.querySelector('[name*="sum"], [name*="amount"], [placeholder*="сумм"]'),

      // Registration requirement
      requiresAuth: !!document.querySelector('[href*="login"], [href*="register"], [href*="signin"]'),

      // Framework detection
      scripts: Array.from(document.querySelectorAll('script[src]')).map(s => (s as HTMLScriptElement).src),

      // Form count
      formCount: document.querySelectorAll('form').length
    };
    return result;
  });

  // Score Vue SPA
  if (analysis.hasVueElements) { scores['vue-spa'] += 30; indicators.push('vue-elements'); }
  if (analysis.hasCssModules) { scores['vue-spa'] += 20; indicators.push('css-modules'); }
  if (analysis.hasVueRequisites) { scores['vue-spa'] += 25; indicators.push('vue-requisites'); }

  // Score Multi-page
  if (analysis.hasExchangeUrls) { scores['multipage'] += 40; indicators.push('exchange-urls'); }
  if (analysis.hasSumFields) { scores['multipage'] += 20; indicators.push('sum-fields'); }

  // Score Cloudflare protected
  if (analysis.hasCloudflare) { scores['cloudflare-protected'] += 50; indicators.push('cloudflare-turnstile'); }
  if (analysis.hasCaptcha) { scores['cloudflare-protected'] += 20; indicators.push('captcha'); }

  // Check for Vue/Nuxt in scripts
  const hasVueScript = analysis.scripts.some(s => /vue|nuxt/i.test(s));
  if (hasVueScript) { scores['vue-spa'] += 15; indicators.push('vue-script'); }

  // Determine winner
  const maxScore = Math.max(...Object.values(scores));
  let detectedType: EngineType = 'unknown';

  if (maxScore >= 30) {
    detectedType = Object.entries(scores).find(([_, score]) => score === maxScore)?.[0] as EngineType || 'unknown';
  }

  const confidence = maxScore > 0 ? Math.min(maxScore / 100, 1) : 0;

  return {
    type: detectedType,
    confidence,
    indicators
  };
}
