import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  // Proxy settings (ThorData residential)
  proxyHost: process.env.PROXY_HOST || '',
  proxyPort: parseInt(process.env.PROXY_PORT || '9999', 10),
  proxyUser: process.env.PROXY_USER || '',
  proxyPass: process.env.PROXY_PASS || '',

  get proxyUrl(): string {
    if (!this.proxyHost) return '';
    return `http://${this.proxyUser}:${this.proxyPass}@${this.proxyHost}:${this.proxyPort}`;
  },

  // Browser settings
  headless: process.env.HEADLESS !== 'false',

  // Delays (ms)
  delayMin: parseInt(process.env.DELAY_MIN || '30000', 10),
  delayMax: parseInt(process.env.DELAY_MAX || '120000', 10),

  // Paths
  dataPath: process.env.DATA_PATH || './data',

  get dbPath(): string {
    return path.join(this.dataPath, 'database.sqlite');
  },

  get screenshotsPath(): string {
    return path.join(this.dataPath, 'screenshots');
  },

  // Telegram
  telegramToken: process.env.TELEGRAM_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // Form data for creating orders
  formEmail: process.env.FORM_EMAIL || '',
  formWalletBTC: process.env.FORM_WALLET_BTC || '',
  formWalletETH: process.env.FORM_WALLET_ETH || '',
  formWalletUSDT: process.env.FORM_WALLET_USDT || '',
  formCard: process.env.FORM_CARD || ''
};

export function randomDelay(): number {
  return Math.floor(Math.random() * (config.delayMax - config.delayMin + 1)) + config.delayMin;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
