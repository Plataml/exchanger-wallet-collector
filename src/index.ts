import { initDb } from './db';
import { runCollector } from './collector';

async function main(): Promise<void> {
  console.log('Exchanger Wallet Collector started');

  initDb();

  // Parse command line args
  const args = process.argv.slice(2);
  let targetDomain: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--domain=')) {
      targetDomain = arg.split('=')[1];
    }
  }

  // Run collector in loop
  while (true) {
    try {
      await runCollector(targetDomain);
    } catch (error) {
      console.error('Collector error:', error);
    }

    // Wait before next cycle
    const waitTime = 60 * 60 * 1000; // 1 hour
    console.log(`Waiting 1 hour before next cycle...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
}

main().catch(console.error);
