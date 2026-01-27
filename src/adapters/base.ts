import { Page } from 'playwright';
import { ExchangerAdapter, CryptoPair, CollectResult } from '../types';
import { config } from '../config';
import { logger } from '../logger';

export abstract class BaseAdapter implements ExchangerAdapter {
  abstract name: string;
  abstract domain: string;

  abstract collect(page: Page, pair: CryptoPair): Promise<CollectResult>;

  protected async navigateTo(page: Page, path: string = ''): Promise<void> {
    const url = `https://${this.domain}${path}`;
    logger.info(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  protected async screenshot(page: Page, prefix: string): Promise<string> {
    const filename = `${prefix}_${this.domain}_${Date.now()}.png`;
    const filepath = `${config.screenshotsPath}/${filename}`;
    await page.screenshot({ path: filepath, fullPage: true });
    logger.info(`Screenshot saved: ${filename}`);
    return filepath;
  }

  protected async randomDelay(min: number = 1000, max: number = 3000): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  protected async waitAndClick(page: Page, selector: string): Promise<void> {
    await page.waitForSelector(selector, { timeout: 10000 });
    await this.randomDelay(500, 1500);
    await page.click(selector);
  }

  protected async waitAndFill(page: Page, selector: string, value: string): Promise<void> {
    await page.waitForSelector(selector, { timeout: 10000 });
    await this.randomDelay(300, 800);
    await page.fill(selector, value);
  }

  protected async extractText(page: Page, selector: string): Promise<string> {
    await page.waitForSelector(selector, { timeout: 15000 });
    const text = await page.textContent(selector);
    return text?.trim() || '';
  }
}
