import { initDb } from '../db';
import { runCollector } from '../collector';

async function main(): Promise<void> {
  await initDb();

  // Parse --domain argument
  const args = process.argv.slice(2);
  let targetDomain: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--domain=')) {
      targetDomain = arg.split('=')[1];
    }
  }

  await runCollector(targetDomain);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
