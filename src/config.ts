import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  proxyUrl: process.env.PROXY_URL || '',
  headless: process.env.HEADLESS !== 'false',
  delayMin: parseInt(process.env.DELAY_MIN || '30000', 10),
  delayMax: parseInt(process.env.DELAY_MAX || '120000', 10),
  dataPath: process.env.DATA_PATH || './data',

  get dbPath(): string {
    return path.join(this.dataPath, 'database.sqlite');
  },

  get screenshotsPath(): string {
    return path.join(this.dataPath, 'screenshots');
  }
};

export function randomDelay(): number {
  return Math.floor(Math.random() * (config.delayMax - config.delayMin + 1)) + config.delayMin;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
