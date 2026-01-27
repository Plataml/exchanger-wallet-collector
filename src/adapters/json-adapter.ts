import { Page } from 'playwright';
import { ExchangerAdapter, CryptoPair, CollectResult } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import fs from 'fs';
import path from 'path';

export interface AdapterStep {
  action: 'goto' | 'click' | 'fill' | 'select' | 'wait' | 'screenshot' | 'extract';
  selector?: string;
  value?: string;           // For fill/select, supports placeholders: {pair.from}, {pair.to}, {pair.network}
  url?: string;             // For goto
  timeout?: number;         // For wait
  variable?: string;        // For extract - save result to variable
  description?: string;
}

export interface AdapterConfig {
  name: string;
  domain: string;
  pairs: { from: string; to: string; network: string }[];
  steps: AdapterStep[];
  addressSelector: string;  // Selector for the deposit address
}

export class JsonAdapter implements ExchangerAdapter {
  name: string;
  domain: string;
  private config: AdapterConfig;

  constructor(adapterConfig: AdapterConfig) {
    this.config = adapterConfig;
    this.name = adapterConfig.name;
    this.domain = adapterConfig.domain;
  }

  async collect(page: Page, pair: CryptoPair): Promise<CollectResult> {
    const variables: Record<string, string> = {};

    for (const step of this.config.steps) {
      await this.executeStep(page, step, pair, variables);
    }

    // Extract address
    logger.info(`Extracting address with selector: ${this.config.addressSelector}`);
    await page.waitForSelector(this.config.addressSelector, { timeout: 15000 });
    const address = await page.textContent(this.config.addressSelector);

    if (!address?.trim()) {
      throw new Error('Failed to extract address');
    }

    // Take screenshot
    const filename = `${this.domain}_${pair.from}-${pair.to}_${Date.now()}.png`;
    const screenshotPath = path.join(config.screenshotsPath, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return {
      address: address.trim(),
      network: pair.network,
      screenshotPath
    };
  }

  private async executeStep(
    page: Page,
    step: AdapterStep,
    pair: CryptoPair,
    variables: Record<string, string>
  ): Promise<void> {
    const desc = step.description || step.action;
    logger.debug(`Step: ${desc}`);

    // Random delay between actions
    await this.randomDelay(500, 1500);

    switch (step.action) {
      case 'goto':
        const url = this.replacePlaceholders(step.url || `https://${this.domain}`, pair, variables);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;

      case 'click':
        if (!step.selector) throw new Error('click requires selector');
        await page.waitForSelector(step.selector, { timeout: 10000 });
        await page.click(step.selector);
        break;

      case 'fill':
        if (!step.selector) throw new Error('fill requires selector');
        const fillValue = this.replacePlaceholders(step.value || '', pair, variables);
        await page.waitForSelector(step.selector, { timeout: 10000 });
        await page.fill(step.selector, fillValue);
        break;

      case 'select':
        if (!step.selector) throw new Error('select requires selector');
        const selectValue = this.replacePlaceholders(step.value || '', pair, variables);
        await page.waitForSelector(step.selector, { timeout: 10000 });
        await page.selectOption(step.selector, selectValue);
        break;

      case 'wait':
        if (step.selector) {
          await page.waitForSelector(step.selector, { timeout: step.timeout || 10000 });
        } else {
          await new Promise(r => setTimeout(r, step.timeout || 1000));
        }
        break;

      case 'screenshot':
        const ssFilename = `${this.domain}_step_${Date.now()}.png`;
        const ssPath = path.join(config.screenshotsPath, ssFilename);
        await page.screenshot({ path: ssPath, fullPage: true });
        logger.info(`Step screenshot: ${ssFilename}`);
        break;

      case 'extract':
        if (!step.selector || !step.variable) {
          throw new Error('extract requires selector and variable');
        }
        await page.waitForSelector(step.selector, { timeout: 10000 });
        const text = await page.textContent(step.selector);
        variables[step.variable] = text?.trim() || '';
        break;
    }
  }

  private replacePlaceholders(
    template: string,
    pair: CryptoPair,
    variables: Record<string, string>
  ): string {
    return template
      .replace(/{pair\.from}/g, pair.from)
      .replace(/{pair\.to}/g, pair.to)
      .replace(/{pair\.network}/g, pair.network)
      .replace(/{var\.(\w+)}/g, (_, name) => variables[name] || '');
  }

  private async randomDelay(min: number, max: number): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

// Load all JSON adapter configs from adapters/ directory
export function loadJsonAdapters(): JsonAdapter[] {
  const adaptersDir = path.join(process.cwd(), 'adapters');
  const adapters: JsonAdapter[] = [];

  if (!fs.existsSync(adaptersDir)) {
    fs.mkdirSync(adaptersDir, { recursive: true });
    return adapters;
  }

  const files = fs.readdirSync(adaptersDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));

  for (const file of files) {
    try {
      const configPath = path.join(adaptersDir, file);
      const content = fs.readFileSync(configPath, 'utf-8');
      const adapterConfig: AdapterConfig = JSON.parse(content);
      adapters.push(new JsonAdapter(adapterConfig));
      logger.info(`Loaded adapter: ${adapterConfig.name} (${adapterConfig.domain})`);
    } catch (error: any) {
      logger.error(`Failed to load adapter ${file}: ${error.message}`);
    }
  }

  return adapters;
}
