import { Page } from 'playwright';

export interface CryptoPair {
  from: string;
  to: string;
  network: string;
}

export interface CollectResult {
  address: string;
  network: string;
  screenshotPath: string;
}

export interface ExchangerAdapter {
  name: string;
  domain: string;
  collect(page: Page, pair: CryptoPair): Promise<CollectResult>;
}

export interface Exchanger {
  id: number;
  name: string;
  domain: string;
  is_active: number;
  created_at: string;
}

export interface Wallet {
  id: number;
  exchanger_id: number;
  pair: string;
  network: string;
  address: string;
  screenshot_path: string;
  collected_at: string;
}

export interface Attempt {
  id: number;
  exchanger_id: number;
  pair: string;
  status: 'success' | 'failed' | 'captcha' | 'blocked';
  error: string | null;
  created_at: string;
}
