import { Page } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger';
import { config } from '../config';
import fs from 'fs';
import path from 'path';

// --- Interfaces ---

export interface FieldMapping {
  purpose: 'amount' | 'wallet' | 'card' | 'email' | 'name' | 'phone' | 'promo';
  selector: string;
  label: string;
  inputType: 'text' | 'number' | 'email' | 'tel' | 'select';
}

export interface CurrencySelector {
  selector: string;
  method: 'click' | 'select';
  searchable: boolean;
}

export interface PageAnalysis {
  fields: FieldMapping[];
  currencySelectors: {
    from?: CurrencySelector;
    to?: CurrencySelector;
  };
  submitButton?: { selector: string; text: string };
  layout: 'calculator' | 'step-by-step' | 'grid-select' | 'unknown';
  confidence: number;
}

export interface ActionStep {
  action: 'click' | 'fill' | 'type' | 'select' | 'wait';
  selector?: string;
  value?: string;
  description: string;
}

interface DomElement {
  tag: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  className: string;
  label: string;
  text: string;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
  selector: string;
}

// --- Cache ---

interface CacheEntry {
  analysis: PageAnalysis;
  timestamp: number;
}

const analysisCache = new Map<string, CacheEntry>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// --- Main Class ---

export class VisionAnalyzer {
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      if (!config.anthropicApiKey) {
        throw new Error('ANTHROPIC_API_KEY is not set');
      }
      this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    }
    return this.client;
  }

  /**
   * Full page analysis: DOM-first, Vision fallback
   */
  async analyzePage(
    page: Page,
    context: { fromCurrency: string; toCurrency: string }
  ): Promise<PageAnalysis> {
    const domain = new URL(page.url()).hostname;
    const cacheKey = `${domain}:${context.fromCurrency}:${context.toCurrency}`;

    // Check cache
    const cached = analysisCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      logger.info(`[VISION] Using cached analysis for ${domain}`);
      return cached.analysis;
    }

    // Level 1: DOM analysis
    logger.info(`[VISION] Analyzing page DOM for ${domain}...`);
    const domSnapshot = await this.collectDomSnapshot(page);
    let analysis = await this.analyzeWithDom(domSnapshot, context);

    // Level 2: Vision fallback if DOM analysis is weak
    if (analysis.confidence < 0.6) {
      logger.info(`[VISION] DOM confidence ${analysis.confidence.toFixed(2)} < 0.6, trying vision...`);
      const visionAnalysis = await this.analyzeWithVision(page, context);
      if (visionAnalysis && visionAnalysis.confidence > analysis.confidence) {
        analysis = visionAnalysis;
      }
    }

    // Cache result
    analysisCache.set(cacheKey, { analysis, timestamp: Date.now() });
    logger.info(`[VISION] Analysis complete: confidence=${analysis.confidence.toFixed(2)}, fields=${analysis.fields.length}, layout=${analysis.layout}`);

    return analysis;
  }

  /**
   * Plan currency selection actions for complex UIs
   */
  async planCurrencySelection(
    page: Page,
    direction: 'from' | 'to',
    currency: string,
    selectorInfo: CurrencySelector
  ): Promise<ActionStep[]> {
    // Take screenshot focused on the currency selector area
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const base64 = screenshot.toString('base64');

    const prompt = `This is a cryptocurrency exchange website. I need to select "${currency}" as the ${direction === 'from' ? 'source (give)' : 'target (receive)'} currency.

The currency selector element is: ${selectorInfo.selector}
Interaction method: ${selectorInfo.method}
Has search: ${selectorInfo.searchable}

Describe the exact steps to select this currency. Return JSON array:
[
  { "action": "click|fill|type|wait", "selector": "CSS selector", "value": "optional value", "description": "what this step does" }
]

Common patterns:
- Click dropdown → type currency name → click matching option
- Click currency icon in a grid
- Use native <select> dropdown
- Click tab/button for crypto category, then select currency

Keep selectors simple and robust. Prefer text content matching over class names.`;

    try {
      const client = this.getClient();
      const response = await client.messages.create({
        model: config.visionModel,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      return this.parseJsonFromResponse<ActionStep[]>(text) || [];
    } catch (error) {
      logger.error(`[VISION] Currency selection planning failed: ${error}`);
      return [];
    }
  }

  /**
   * Analyze result page to find deposit address
   */
  async analyzeResultPage(page: Page): Promise<{ address?: string; network?: string; memo?: string }> {
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    const base64 = screenshot.toString('base64');

    const prompt = `This is a cryptocurrency exchange order confirmation/payment page.

Find the deposit cryptocurrency address on this page. The address is where the user needs to send cryptocurrency.

Common address formats:
- Bitcoin (BTC): starts with bc1, 1, or 3 (26-62 characters)
- Ethereum/ERC20: starts with 0x (42 characters)
- TRON/TRC20: starts with T (34 characters)
- Litecoin: starts with L or ltc1

Return JSON:
{
  "address": "the crypto address or null if not found",
  "network": "BTC|ERC20|TRC20|LTC or null",
  "memo": "destination tag if present or null",
  "confidence": 0.0-1.0
}

If you can't find an address, return {"address": null, "confidence": 0}.`;

    try {
      const client = this.getClient();
      const response = await client.messages.create({
        model: config.visionModel,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const result = this.parseJsonFromResponse<{ address?: string; network?: string; memo?: string; confidence?: number }>(text);

      if (result?.address && result.confidence && result.confidence > 0.5) {
        logger.info(`[VISION] Found address via vision: ${result.address} (${result.network})`);
        return { address: result.address, network: result.network || undefined, memo: result.memo || undefined };
      }

      return {};
    } catch (error) {
      logger.error(`[VISION] Result page analysis failed: ${error}`);
      return {};
    }
  }

  // --- Private: DOM Snapshot ---

  private async collectDomSnapshot(page: Page): Promise<DomElement[]> {
    return page.evaluate(() => {
      const elements: any[] = [];
      const allElements = document.querySelectorAll(
        'input, textarea, select, button, [role="button"], [role="combobox"], [role="listbox"], ' +
        'a[class*="select"], div[class*="select"], div[class*="dropdown"], div[class*="currency"]'
      );

      allElements.forEach((el, index) => {
        const htmlEl = el as HTMLElement;
        const input = el as HTMLInputElement;
        const rect = htmlEl.getBoundingClientRect();

        // Skip off-screen or zero-size elements (except hidden inputs)
        if (rect.width === 0 && rect.height === 0 && input.type !== 'hidden') return;

        const tag = el.tagName.toLowerCase();
        const type = input.type || '';
        const name = input.name || '';
        const id = input.id || '';
        const placeholder = input.placeholder || '';
        const className = (el.className || '').toString();

        // Skip technical fields
        if (type === 'hidden' && !name.includes('direction') && !name.includes('currency')) return;
        if (name.includes('csrf') || name.includes('token') || name.includes('_method')) return;

        // Find label
        let label = '';
        if (id) {
          const labelEl = document.querySelector(`label[for="${id}"]`);
          if (labelEl) label = (labelEl.textContent || '').trim();
        }
        if (!label) {
          const parent = el.closest('.form-group, .field, .input-wrap, .form-row, div');
          if (parent) {
            const labelEl = parent.querySelector('label, .label, span.title, .field-label');
            if (labelEl && labelEl !== el) {
              label = (labelEl.textContent || '').trim().substring(0, 100);
            }
          }
        }

        // Build unique selector
        let selector = tag;
        if (id) {
          selector = `#${CSS.escape(id)}`;
        } else if (name) {
          selector = `${tag}[name="${CSS.escape(name)}"]`;
        } else if (index < 50) {
          // Use class-based or nth selector
          const classes = className.split(/\s+/).filter((c: string) => c.length > 2 && c.length < 40).slice(0, 2);
          if (classes.length > 0) {
            selector = `${tag}.${classes.map((c: string) => CSS.escape(c)).join('.')}`;
          }
        }

        const text = (el.textContent || '').trim().substring(0, 80);

        elements.push({
          tag,
          type,
          name,
          id,
          placeholder,
          className: className.substring(0, 200),
          label,
          text: tag === 'button' || tag === 'a' ? text : '',
          visible: rect.width > 0 && rect.height > 0,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          selector
        });
      });

      return elements;
    });
  }

  // --- Private: DOM-based LLM Analysis ---

  private async analyzeWithDom(domElements: DomElement[], context: { fromCurrency: string; toCurrency: string }): Promise<PageAnalysis> {
    // Filter to visible, relevant elements
    const relevant = domElements.filter(el =>
      el.visible || el.type === 'hidden' && (el.name.includes('direction') || el.name.includes('currency'))
    );

    if (relevant.length === 0) {
      return this.emptyAnalysis();
    }

    // Compact DOM for prompt (reduce token usage)
    const compactDom = relevant.map(el => ({
      tag: el.tag,
      type: el.type || undefined,
      name: el.name || undefined,
      id: el.id || undefined,
      placeholder: el.placeholder || undefined,
      label: el.label || undefined,
      text: el.text || undefined,
      class: el.className ? el.className.substring(0, 80) : undefined,
      selector: el.selector,
      pos: `${el.rect.x},${el.rect.y}`
    }));

    const prompt = `You are analyzing a cryptocurrency exchange website form.
Task: exchange ${context.fromCurrency} → ${context.toCurrency}

DOM elements on the page (visible interactive elements):
${JSON.stringify(compactDom, null, 1)}

Identify form elements and return ONLY valid JSON (no markdown, no explanation):
{
  "fields": [
    { "purpose": "amount|wallet|card|email|name|phone", "selector": "CSS selector", "label": "human-readable label", "inputType": "text|number|email|tel|select" }
  ],
  "currencySelectors": {
    "from": { "selector": "CSS selector for source currency picker", "method": "click|select", "searchable": true/false },
    "to": { "selector": "CSS selector for target currency picker", "method": "click|select", "searchable": true/false }
  },
  "submitButton": { "selector": "CSS selector", "text": "button text" },
  "layout": "calculator|step-by-step|grid-select|unknown",
  "confidence": 0.0-1.0
}

Rules:
- Use the exact "selector" value from the DOM elements above
- "amount" = field where user enters how much they give (Отдаёте, сумма, sum1, amount)
- "wallet"/"card" = where user enters recipient address/card (кошелёк, wallet, карта, реквизиты, account2)
- Currency selectors: identify how to change from/to currency (dropdowns, tabs, grid icons)
- Submit: "Обменять", "Далее", "Создать заявку", "Exchange", "Continue"
- Confidence: 0.9+ if form is clearly identified, 0.5-0.8 if partially, <0.5 if unsure
- Only include fields you're confident about`;

    try {
      const client = this.getClient();
      const response = await client.messages.create({
        model: config.visionModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const parsed = this.parseJsonFromResponse<PageAnalysis>(text);

      if (parsed) {
        // Validate selectors exist
        parsed.fields = parsed.fields?.filter(f => f.selector && f.purpose) || [];
        parsed.confidence = Math.min(parsed.confidence || 0, 1);
        return parsed;
      }
    } catch (error) {
      logger.error(`[VISION] DOM analysis LLM call failed: ${error}`);
    }

    return this.emptyAnalysis();
  }

  // --- Private: Vision-based Analysis ---

  private async analyzeWithVision(page: Page, context: { fromCurrency: string; toCurrency: string }): Promise<PageAnalysis | null> {
    try {
      const screenshot = await page.screenshot({ type: 'png', fullPage: false });
      const base64 = screenshot.toString('base64');

      const prompt = `This is a screenshot of a cryptocurrency exchange website form.
Task: exchange ${context.fromCurrency} → ${context.toCurrency}

Analyze the form layout and identify interactive elements. Return ONLY valid JSON:
{
  "fields": [
    { "purpose": "amount|wallet|card|email|name|phone", "selector": "best CSS selector guess", "label": "visible label text", "inputType": "text|number|email|tel|select" }
  ],
  "currencySelectors": {
    "from": { "selector": "CSS selector or description", "method": "click|select", "searchable": true/false },
    "to": { "selector": "CSS selector or description", "method": "click|select", "searchable": true/false }
  },
  "submitButton": { "selector": "CSS selector or description", "text": "button text" },
  "layout": "calculator|step-by-step|grid-select|unknown",
  "confidence": 0.0-1.0
}

For selectors, use what you can see:
- Text on buttons: button:has-text("exact text")
- Input placeholders: input[placeholder*="partial text"]
- Nearby labels to guess field names
- Visual position (first input = likely amount)

Key visual cues:
- "Отдаёте"/"Give" section = source currency + amount
- "Получаете"/"Receive" section = target currency + calculated amount
- Currency icons with dropdown arrows = currency selector
- Large colored button at bottom = submit`;

      const client = this.getClient();
      const response = await client.messages.create({
        model: config.visionModel,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const parsed = this.parseJsonFromResponse<PageAnalysis>(text);

      if (parsed) {
        parsed.fields = parsed.fields?.filter(f => f.selector && f.purpose) || [];
        parsed.confidence = Math.min(parsed.confidence || 0, 1);
        logger.info(`[VISION] Vision analysis: confidence=${parsed.confidence.toFixed(2)}, fields=${parsed.fields.length}`);
        return parsed;
      }
    } catch (error) {
      logger.error(`[VISION] Vision analysis failed: ${error}`);
    }

    return null;
  }

  // --- Helpers ---

  private parseJsonFromResponse<T>(text: string): T | null {
    try {
      // Try direct parse
      return JSON.parse(text) as T;
    } catch {
      // Extract JSON from markdown code block
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[1].trim()) as T;
        } catch { /* fall through */ }
      }

      // Try to find JSON object/array in text
      const braceMatch = text.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try {
          return JSON.parse(braceMatch[0]) as T;
        } catch { /* fall through */ }
      }

      const bracketMatch = text.match(/\[[\s\S]*\]/);
      if (bracketMatch) {
        try {
          return JSON.parse(bracketMatch[0]) as T;
        } catch { /* fall through */ }
      }
    }

    logger.warn(`[VISION] Failed to parse JSON from LLM response: ${text.substring(0, 200)}...`);
    return null;
  }

  private emptyAnalysis(): PageAnalysis {
    return {
      fields: [],
      currencySelectors: {},
      submitButton: undefined,
      layout: 'unknown',
      confidence: 0
    };
  }
}
