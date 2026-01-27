import { ExchangerAdapter } from '../types';
import { loadJsonAdapters } from './json-adapter';

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

export function getAdapterCount(): number {
  return adapters.size;
}

// Load JSON-based adapters from adapters/ directory
export function initAdapters(): void {
  const jsonAdapters = loadJsonAdapters();
  for (const adapter of jsonAdapters) {
    registerAdapter(adapter);
  }
}

// Auto-init on import
initAdapters();
