import { ExchangerAdapter } from '../types';

// Registry of all adapters
const adapters: Map<string, ExchangerAdapter> = new Map();

export function registerAdapter(adapter: ExchangerAdapter): void {
  adapters.set(adapter.domain, adapter);
}

export function getAdapter(domain: string): ExchangerAdapter | undefined {
  return adapters.get(domain);
}

export function getAllAdapters(): ExchangerAdapter[] {
  return Array.from(adapters.values());
}

export function hasAdapter(domain: string): boolean {
  return adapters.has(domain);
}

// Import and register adapters here
// Example:
// import { exampleAdapter } from './example';
// registerAdapter(exampleAdapter);
