import { Page, Response } from 'playwright';
import { logger } from '../logger';

const ADDRESS_PATTERNS = [
  /\b(bc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
  /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,
  /\b(0x[a-fA-F0-9]{40})\b/,
  /\b(T[a-zA-Z0-9]{33})\b/,
  /\b([LM][a-km-zA-HJ-NP-Z1-9]{26,33})\b/,
  /\b(ltc1[a-zA-HJ-NP-Z0-9]{39,59})\b/,
  /\b(r[0-9a-zA-Z]{24,34})\b/,
];

const INTERESTING_URL_PATTERNS = [
  /\/api\//i,
  /\/exchange\//i,
  /\/order/i,
  /\/ajax\//i,
  /wallet/i,
  /payout/i,
  /address/i,
  /deposit/i,
  /invoice/i,
  /payment/i,
  /confirm/i,
  /frontend\/api/i,
];

const SKIP_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico|map)(\?|$)/i;

const ADDRESS_KEYS = [
  'address', 'wallet', 'deposit_address', 'crypto_address',
  'payout_address', 'wallet_address', 'addr', 'requisite',
  'account', 'destination', 'to_address', 'from_address',
  'payee_account', 'payment_details', 'deposit_wallet',
];

const MEMO_KEYS = ['memo', 'tag', 'destination_tag', 'extra_id', 'payment_id'];
const NETWORK_KEYS = ['network', 'chain', 'blockchain', 'protocol'];

export interface InterceptedAddress {
  address: string;
  network?: string;
  memo?: string;
  source: 'api-json' | 'api-header' | 'api-text';
  url: string;
}

export interface InterceptedMinAmount {
  minAmount: number;
  maxAmount?: number;
  rate?: number;
  url: string;
}

const MIN_AMOUNT_KEYS = [
  'min_amount', 'minimum', 'min_sum', 'min', 'minAmount',
  'minimum_amount', 'min_value', 'from_min', 'amount_min',
];

export class NetworkInterceptor {
  private page: Page;
  private interceptedAddresses: InterceptedAddress[] = [];
  private interceptedMinAmounts: InterceptedMinAmount[] = [];
  private isListening = false;
  private responseHandler: ((response: Response) => void) | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  start(): void {
    if (this.isListening) return;

    this.interceptedAddresses = [];
    this.interceptedMinAmounts = [];
    this.responseHandler = (response: Response) => {
      this.handleResponse(response).catch(() => {});
    };

    this.page.on('response', this.responseHandler);
    this.isListening = true;
    logger.info('NetworkInterceptor: started listening');
  }

  stop(): void {
    if (!this.isListening || !this.responseHandler) return;

    this.page.off('response', this.responseHandler);
    this.responseHandler = null;
    this.isListening = false;
    logger.info(`NetworkInterceptor: stopped. Found ${this.interceptedAddresses.length} addresses, ${this.interceptedMinAmounts.length} min amounts`);
  }

  getAddresses(): InterceptedAddress[] {
    return [...this.interceptedAddresses];
  }

  getBestAddress(): InterceptedAddress | null {
    return this.interceptedAddresses[0] || null;
  }

  getMinAmounts(): InterceptedMinAmount[] {
    return [...this.interceptedMinAmounts];
  }

  getBestMinAmount(): InterceptedMinAmount | null {
    return this.interceptedMinAmounts[0] || null;
  }

  async waitForAddress(timeoutMs = 15000): Promise<InterceptedAddress | null> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (this.interceptedAddresses.length > 0) {
        return this.interceptedAddresses[0];
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return null;
  }

  private async handleResponse(response: Response): Promise<void> {
    try {
      const url = response.url();
      const status = response.status();

      if (status < 200 || status >= 400) return;
      if (SKIP_EXTENSIONS.test(url)) return;

      const isInteresting = INTERESTING_URL_PATTERNS.some(p => p.test(url));
      const contentType = response.headers()['content-type'] || '';
      const isJsonOrText = contentType.includes('json') || contentType.includes('text/plain');

      if (!isInteresting && !isJsonOrText) return;

      // Check response headers for addresses
      this.checkHeaders(response, url);

      const body = await response.text().catch(() => '');
      if (!body) return;

      if (contentType.includes('json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
        try {
          const json = JSON.parse(body);
          this.searchJsonForAddresses(json, url);
          this.searchJsonForMinAmount(json, url);
        } catch {
          this.searchTextForAddresses(body, url);
        }
      } else if (isInteresting) {
        this.searchTextForAddresses(body, url);
      }
    } catch {
      // Ignore errors silently
    }
  }

  private checkHeaders(response: Response, url: string): void {
    const headers = response.headers();
    for (const [, value] of Object.entries(headers)) {
      if (!value) continue;
      for (const pattern of ADDRESS_PATTERNS) {
        const match = value.match(pattern);
        if (match) {
          this.addAddress({ address: match[1], source: 'api-header', url });
        }
      }
    }
  }

  private searchJsonForAddresses(obj: any, url: string, depth = 0): void {
    if (depth > 10 || !obj) return;

    if (typeof obj === 'string') {
      for (const pattern of ADDRESS_PATTERNS) {
        const match = obj.match(pattern);
        if (match) {
          this.addAddress({ address: match[1], source: 'api-json', url });
        }
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        this.searchJsonForAddresses(item, url, depth + 1);
      }
      return;
    }

    if (typeof obj === 'object') {
      let networkValue: string | undefined;
      let memoValue: string | undefined;

      // First pass: extract network and memo context
      for (const [key, value] of Object.entries(obj)) {
        const lk = key.toLowerCase();
        if (NETWORK_KEYS.some(k => lk.includes(k)) && typeof value === 'string') {
          networkValue = value;
        }
        if (MEMO_KEYS.some(k => lk.includes(k)) && (typeof value === 'string' || typeof value === 'number')) {
          memoValue = String(value);
        }
      }

      // Second pass: find addresses with context
      for (const [key, value] of Object.entries(obj)) {
        const lk = key.toLowerCase();

        if (typeof value === 'string' && ADDRESS_KEYS.some(k => lk.includes(k))) {
          for (const pattern of ADDRESS_PATTERNS) {
            const match = value.match(pattern);
            if (match) {
              this.addAddress({
                address: match[1],
                network: networkValue,
                memo: memoValue,
                source: 'api-json',
                url,
              });
              return; // High confidence match in known key
            }
          }
        }

        // Recurse into nested objects
        if (typeof value === 'object' && value !== null) {
          this.searchJsonForAddresses(value, url, depth + 1);
        }
      }
    }
  }

  private searchJsonForMinAmount(obj: any, url: string, depth = 0): void {
    if (depth > 8 || !obj) return;

    if (typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        const lk = key.toLowerCase();
        if (MIN_AMOUNT_KEYS.some(k => lk.includes(k))) {
          const num = parseFloat(String(value));
          if (!isNaN(num) && num > 0) {
            const existing = this.interceptedMinAmounts.find(m => m.url === url);
            if (!existing) {
              this.interceptedMinAmounts.push({ minAmount: num, url });
              logger.info(`NetworkInterceptor: found min_amount=${num} in key "${key}" from ${url}`);
            }
          }
        }
        if (typeof value === 'object' && value !== null) {
          this.searchJsonForMinAmount(value, url, depth + 1);
        }
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        this.searchJsonForMinAmount(item, url, depth + 1);
      }
    }
  }

  private searchTextForAddresses(text: string, url: string): void {
    for (const pattern of ADDRESS_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        this.addAddress({ address: match[1], source: 'api-text', url });
      }
    }
  }

  private addAddress(addr: InterceptedAddress): void {
    if (this.interceptedAddresses.some(a => a.address === addr.address)) return;

    if (!addr.network) {
      addr.network = this.detectNetwork(addr.address);
    }

    this.interceptedAddresses.push(addr);
    logger.info(`NetworkInterceptor: found address ${addr.address} (${addr.network || '?'}) from ${addr.source} @ ${addr.url}`);
  }

  private detectNetwork(address: string): string | undefined {
    if (address.startsWith('bc1') || address.startsWith('1') || address.startsWith('3')) return 'BTC';
    if (address.startsWith('T')) return 'TRC20';
    if (address.startsWith('0x')) return 'ERC20';
    if (address.startsWith('L') || address.startsWith('M') || address.startsWith('ltc1')) return 'LTC';
    if (address.startsWith('r')) return 'XRP';
    return undefined;
  }
}
