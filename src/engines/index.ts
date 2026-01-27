import { Page } from 'playwright';
import { detectEngine, EngineType, EngineSignature } from './detector';
import { BaseEngine, ExchangeFormData, CollectionResult } from './base';
import { VueSpaEngine } from './vue-spa';
import { MultipageEngine } from './multipage';
import { getBestSelectors, recordSuccess, recordFailure, initPatternsTable } from './learned-patterns';
import { logger } from '../logger';

// Registry of available engines
const engines: BaseEngine[] = [
  new VueSpaEngine(),
  new MultipageEngine()
];

export interface SmartCollectionResult extends CollectionResult {
  engineUsed?: string;
  detectedEngine?: EngineSignature;
}

// Initialize the engine system
export function initEngines(): void {
  initPatternsTable();
  logger.info(`Engine system initialized with ${engines.length} engines`);
}

// Detect and return appropriate engine for a page
export async function selectEngine(page: Page): Promise<{ engine: BaseEngine | null; signature: EngineSignature }> {
  const signature = await detectEngine(page);
  logger.info(`Detected engine: ${signature.type} (confidence: ${(signature.confidence * 100).toFixed(0)}%)`);
  logger.info(`Indicators: ${signature.indicators.join(', ')}`);

  // Find matching engine
  for (const engine of engines) {
    if (engine.type === signature.type) {
      return { engine, signature };
    }
  }

  // If no exact match, try each engine's canHandle
  for (const engine of engines) {
    if (await engine.canHandle(page)) {
      return { engine, signature };
    }
  }

  return { engine: null, signature };
}

// Smart collection with learning
export async function smartCollect(
  page: Page,
  domain: string,
  data: ExchangeFormData
): Promise<SmartCollectionResult> {
  const { engine, signature } = await selectEngine(page);

  if (!engine) {
    return {
      success: false,
      error: 'No suitable engine found for this page',
      detectedEngine: signature
    };
  }

  logger.info(`Using engine: ${engine.name} for ${domain}`);

  // Get learned selectors for this domain
  const learnedSelectors = {
    amount: getBestSelectors(domain, 'amount'),
    wallet: getBestSelectors(domain, 'wallet'),
    email: getBestSelectors(domain, 'email'),
    submit: getBestSelectors(domain, 'submit')
  };

  // Try collection
  const result = await engine.collectAddress(page, data);

  // Record learning
  if (result.success && result.selectors) {
    for (const [field, selector] of Object.entries(result.selectors)) {
      recordSuccess(domain, engine.type, field, selector);
    }
    logger.info(`Recorded successful patterns for ${domain}`);
  } else if (!result.success) {
    // Record failures for attempted selectors
    for (const field of Object.keys(learnedSelectors)) {
      const selectors = learnedSelectors[field as keyof typeof learnedSelectors];
      for (const selector of selectors) {
        recordFailure(domain, engine.type, field, selector);
      }
    }
  }

  return {
    ...result,
    engineUsed: engine.name,
    detectedEngine: signature
  };
}

// Get all registered engines
export function getEngines(): BaseEngine[] {
  return engines;
}

// Get engine by type
export function getEngineByType(type: EngineType): BaseEngine | undefined {
  return engines.find(e => e.type === type);
}

export { EngineType, EngineSignature, ExchangeFormData, CollectionResult, BaseEngine };
export { detectEngine } from './detector';
export * from './learned-patterns';
