import { initDb, insertExchanger } from '../db';
import fs from 'fs';
import path from 'path';

interface ExchangerEntry {
  name: string;
  domain: string;
}

function main(): void {
  const exchangersPath = path.join(process.cwd(), 'exchangers.json');

  if (!fs.existsSync(exchangersPath)) {
    console.error('exchangers.json not found');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(exchangersPath, 'utf-8')) as ExchangerEntry[];

  if (!Array.isArray(data)) {
    console.error('exchangers.json must be an array');
    process.exit(1);
  }

  initDb();

  let imported = 0;
  for (const entry of data) {
    if (!entry.name || !entry.domain) {
      console.warn(`Skipping invalid entry: ${JSON.stringify(entry)}`);
      continue;
    }

    const result = insertExchanger(entry.name, entry.domain);
    if (result.changes > 0) {
      imported++;
      console.log(`Imported: ${entry.name} (${entry.domain})`);
    } else {
      console.log(`Exists: ${entry.name} (${entry.domain})`);
    }
  }

  console.log(`\nDone. Imported ${imported} new exchanger(s).`);
}

main();
