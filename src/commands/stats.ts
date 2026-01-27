import { initDb, getStats } from '../db';

function main(): void {
  initDb();

  const stats = getStats();

  console.log('\n=== Exchanger Wallet Collector Stats ===\n');
  console.log(`Exchangers: ${stats.activeExchangers} active / ${stats.totalExchangers} total`);
  console.log(`Wallets collected: ${stats.totalWallets}`);
  console.log(`Unique addresses: ${stats.uniqueAddresses}`);

  console.log('\nAttempts by status:');
  if (stats.attemptsByStatus.length === 0) {
    console.log('  No attempts yet');
  } else {
    for (const { status, count } of stats.attemptsByStatus) {
      console.log(`  ${status}: ${count}`);
    }
  }

  console.log('');
}

main();
