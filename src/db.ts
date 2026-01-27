import Database from 'better-sqlite3';
import { config } from './config';
import fs from 'fs';
import path from 'path';

let db: Database.Database;

export function initDb(): Database.Database {
  // Ensure data directory exists
  const dataDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS exchangers (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE,
      domain TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY,
      exchanger_id INTEGER,
      pair TEXT,
      network TEXT,
      address TEXT,
      screenshot_path TEXT,
      collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (exchanger_id) REFERENCES exchangers(id)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY,
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

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    return initDb();
  }
  return db;
}

// Exchanger operations
export function getActiveExchangers() {
  return getDb().prepare('SELECT * FROM exchangers WHERE is_active = 1').all();
}

export function getExchangerByDomain(domain: string) {
  return getDb().prepare('SELECT * FROM exchangers WHERE domain = ?').get(domain);
}

export function insertExchanger(name: string, domain: string) {
  return getDb().prepare(
    'INSERT OR IGNORE INTO exchangers (name, domain) VALUES (?, ?)'
  ).run(name, domain);
}

// Wallet operations
export function insertWallet(
  exchangerId: number,
  pair: string,
  network: string,
  address: string,
  screenshotPath: string
) {
  return getDb().prepare(
    'INSERT INTO wallets (exchanger_id, pair, network, address, screenshot_path) VALUES (?, ?, ?, ?, ?)'
  ).run(exchangerId, pair, network, address, screenshotPath);
}

export function getWalletCount() {
  const result = getDb().prepare('SELECT COUNT(*) as count FROM wallets').get() as { count: number };
  return result.count;
}

// Attempt operations
export function insertAttempt(
  exchangerId: number,
  pair: string,
  status: 'success' | 'failed' | 'captcha' | 'blocked',
  error?: string
) {
  return getDb().prepare(
    'INSERT INTO attempts (exchanger_id, pair, status, error) VALUES (?, ?, ?, ?)'
  ).run(exchangerId, pair, status, error || null);
}

export function getStats() {
  const db = getDb();

  const totalExchangers = (db.prepare('SELECT COUNT(*) as count FROM exchangers').get() as { count: number }).count;
  const activeExchangers = (db.prepare('SELECT COUNT(*) as count FROM exchangers WHERE is_active = 1').get() as { count: number }).count;
  const totalWallets = (db.prepare('SELECT COUNT(*) as count FROM wallets').get() as { count: number }).count;
  const uniqueAddresses = (db.prepare('SELECT COUNT(DISTINCT address) as count FROM wallets').get() as { count: number }).count;

  const attemptsByStatus = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM attempts
    GROUP BY status
  `).all() as { status: string; count: number }[];

  return {
    totalExchangers,
    activeExchangers,
    totalWallets,
    uniqueAddresses,
    attemptsByStatus
  };
}
