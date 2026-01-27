import initSqlJs, { Database } from 'sql.js';
import { config } from './config';
import fs from 'fs';
import path from 'path';

let db: Database | null = null;

export async function initDb(): Promise<Database> {
  if (db) return db;

  // Ensure data directory exists
  const dataDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const SQL = await initSqlJs();

  // Load existing database or create new
  if (fs.existsSync(config.dbPath)) {
    const buffer = fs.readFileSync(config.dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS exchangers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      domain TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchanger_id INTEGER,
      pair TEXT,
      network TEXT,
      address TEXT,
      screenshot_path TEXT,
      collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (exchanger_id) REFERENCES exchangers(id)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchanger_id INTEGER,
      pair TEXT,
      status TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (exchanger_id) REFERENCES exchangers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_exchanger ON wallets(exchanger_id);
    CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
    CREATE INDEX IF NOT EXISTS idx_attempts_exchanger ON attempts(exchanger_id);
  `);

  saveDb();
  return db;
}

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function saveDb(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.dbPath, buffer);
}

// Helper to run query and get results as objects
function queryAll<T>(sql: string, params: any[] = []): T[] {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

function queryOne<T>(sql: string, params: any[] = []): T | undefined {
  const results = queryAll<T>(sql, params);
  return results[0];
}

function runQuery(sql: string, params: any[] = []): { changes: number } {
  getDb().run(sql, params);
  saveDb();
  return { changes: getDb().getRowsModified() };
}

// Exchanger operations
export function getActiveExchangers() {
  return queryAll('SELECT * FROM exchangers WHERE is_active = 1');
}

export function getExchangerByDomain(domain: string) {
  return queryOne('SELECT * FROM exchangers WHERE domain = ?', [domain]);
}

export function insertExchanger(name: string, domain: string) {
  return runQuery('INSERT OR IGNORE INTO exchangers (name, domain) VALUES (?, ?)', [name, domain]);
}

// Wallet operations
export function insertWallet(
  exchangerId: number,
  pair: string,
  network: string,
  address: string,
  screenshotPath: string
) {
  return runQuery(
    'INSERT INTO wallets (exchanger_id, pair, network, address, screenshot_path) VALUES (?, ?, ?, ?, ?)',
    [exchangerId, pair, network, address, screenshotPath]
  );
}

export function getWalletCount(): number {
  const result = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM wallets');
  return result?.count || 0;
}

// Attempt operations
export function insertAttempt(
  exchangerId: number,
  pair: string,
  status: 'success' | 'failed' | 'captcha' | 'blocked',
  error?: string
) {
  return runQuery(
    'INSERT INTO attempts (exchanger_id, pair, status, error) VALUES (?, ?, ?, ?)',
    [exchangerId, pair, status, error || null]
  );
}

export function getStats() {
  const totalExchangers = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM exchangers')?.count || 0;
  const activeExchangers = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM exchangers WHERE is_active = 1')?.count || 0;
  const totalWallets = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM wallets')?.count || 0;
  const uniqueAddresses = queryOne<{ count: number }>('SELECT COUNT(DISTINCT address) as count FROM wallets')?.count || 0;

  const attemptsByStatus = queryAll<{ status: string; count: number }>(`
    SELECT status, COUNT(*) as count
    FROM attempts
    GROUP BY status
  `);

  return {
    totalExchangers,
    activeExchangers,
    totalWallets,
    uniqueAddresses,
    attemptsByStatus
  };
}
