import { getDb, saveDb } from '../db';

export interface LearnedPattern {
  id?: number;
  domain: string;
  engine_type: string;
  field_name: string;
  selector: string;
  success_count: number;
  fail_count: number;
  last_used: string;
}

// Initialize patterns table
export function initPatternsTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS learned_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      engine_type TEXT NOT NULL,
      field_name TEXT NOT NULL,
      selector TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      last_used TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(domain, field_name, selector)
    );

    CREATE INDEX IF NOT EXISTS idx_patterns_domain ON learned_patterns(domain);
    CREATE INDEX IF NOT EXISTS idx_patterns_success ON learned_patterns(success_count DESC);
  `);
  saveDb();
}

// Get best selectors for a domain and field
export function getBestSelectors(domain: string, fieldName: string): string[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT selector FROM learned_patterns
    WHERE domain = ? AND field_name = ?
    AND success_count > fail_count
    ORDER BY (success_count - fail_count) DESC, last_used DESC
    LIMIT 5
  `);
  stmt.bind([domain, fieldName]);

  const selectors: string[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as { selector: string };
    selectors.push(row.selector);
  }
  stmt.free();
  return selectors;
}

// Get all patterns for a domain
export function getDomainPatterns(domain: string): LearnedPattern[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM learned_patterns
    WHERE domain = ?
    ORDER BY field_name, success_count DESC
  `);
  stmt.bind([domain]);

  const patterns: LearnedPattern[] = [];
  while (stmt.step()) {
    patterns.push(stmt.getAsObject() as LearnedPattern);
  }
  stmt.free();
  return patterns;
}

// Record a successful selector usage
export function recordSuccess(domain: string, engineType: string, fieldName: string, selector: string): void {
  const db = getDb();
  db.run(`
    INSERT INTO learned_patterns (domain, engine_type, field_name, selector, success_count, last_used)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(domain, field_name, selector) DO UPDATE SET
      success_count = success_count + 1,
      last_used = CURRENT_TIMESTAMP
  `, [domain, engineType, fieldName, selector]);
  saveDb();
}

// Record a failed selector attempt
export function recordFailure(domain: string, engineType: string, fieldName: string, selector: string): void {
  const db = getDb();
  db.run(`
    INSERT INTO learned_patterns (domain, engine_type, field_name, selector, fail_count, last_used)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(domain, field_name, selector) DO UPDATE SET
      fail_count = fail_count + 1,
      last_used = CURRENT_TIMESTAMP
  `, [domain, engineType, fieldName, selector]);
  saveDb();
}

// Get patterns that work across multiple domains (universal patterns)
export function getUniversalPatterns(fieldName: string, minSuccessRate = 0.7): string[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT selector, SUM(success_count) as total_success, SUM(fail_count) as total_fail
    FROM learned_patterns
    WHERE field_name = ?
    GROUP BY selector
    HAVING CAST(total_success AS FLOAT) / (total_success + total_fail + 1) >= ?
    ORDER BY total_success DESC
    LIMIT 10
  `);
  stmt.bind([fieldName, minSuccessRate]);

  const selectors: string[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as { selector: string };
    selectors.push(row.selector);
  }
  stmt.free();
  return selectors;
}

// Export patterns for backup/sharing
export function exportPatterns(): LearnedPattern[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM learned_patterns ORDER BY domain, field_name');
  const patterns: LearnedPattern[] = [];
  while (stmt.step()) {
    patterns.push(stmt.getAsObject() as LearnedPattern);
  }
  stmt.free();
  return patterns;
}

// Import patterns from backup
export function importPatterns(patterns: LearnedPattern[]): number {
  const db = getDb();
  let imported = 0;

  for (const pattern of patterns) {
    try {
      db.run(`
        INSERT INTO learned_patterns (domain, engine_type, field_name, selector, success_count, fail_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, field_name, selector) DO UPDATE SET
          success_count = success_count + excluded.success_count,
          fail_count = fail_count + excluded.fail_count
      `, [
        pattern.domain,
        pattern.engine_type,
        pattern.field_name,
        pattern.selector,
        pattern.success_count,
        pattern.fail_count
      ]);
      imported++;
    } catch {
      // Skip invalid patterns
    }
  }

  saveDb();
  return imported;
}
