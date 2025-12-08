
import { PublicKey, Connection } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import { RpcManager } from './lib/rpc-manager';
import { TokenManager, deriveBondingCurveVault, derivePumpSwapVault } from './lib/token-manager';
import { FeeTracker } from './lib/fee-tracker';
import { WSOL_MINT } from './lib/utils';

// Simple env parser
function loadEnv() {
  try {
    let content = '';
    // Check root and parent (in case running from dist)
    if (fs.existsSync('.env')) {
        content = fs.readFileSync('.env', 'utf8');
    } else if (fs.existsSync('../.env')) {
        content = fs.readFileSync('../.env', 'utf8');
    } else if (fs.existsSync(path.join(__dirname, '../.env'))) {
        content = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
    }
    
    if (content) {
      content.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join('=').trim();
          if (key && value) {
            process.env[key] = value;
          }
        }
      });
    }
  } catch (e) {
    console.warn('Could not load .env file');
  }
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const durationSec = args[0] ? parseInt(args[0]) : 300; // Default 5 mins

  const CREATOR = new PublicKey('5F2nKU9cYYBZeceMm9aBjoELiiu7RUC8U8HKS8FM5xPB');
  const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  
  console.log('🚀 Starting Long Validation Test');
  console.log(`Creator: ${CREATOR.toBase58()}`);
  console.log(`Duration: ${durationSec} seconds`);
  console.log('RPC:', RPC_URL.includes('helius') ? 'Using Helius RPC' : 'Using Public RPC');

  // 1. Setup
  const rpcManager = new RpcManager(RPC_URL);
  const tokenManager = new TokenManager(rpcManager);
  
  const bcVault = deriveBondingCurveVault(CREATOR);
  const ammVault = derivePumpSwapVault(CREATOR);
  const ammVaultATA = await getAssociatedTokenAddress(WSOL_MINT, ammVault, true);

  // 2. Initial State
  const getBalance = async (pubkey: PublicKey, isToken: boolean) => {
    try {
      if (isToken) {
        const bal = await rpcManager.getTokenAccountBalance(pubkey);
        return bal;
      } else {
        const bal = await rpcManager.getBalance(pubkey);
        return BigInt(bal);
      }
    } catch {
      return 0n;
    }
  };

  const initBc = await getBalance(bcVault, false);
  const initAmm = await getBalance(ammVaultATA, true);

  console.log(`\n📊 Initial State:`);
  console.log(`  BC Balance: ${Number(initBc) / 1e9} SOL`);
  console.log(`  AMM Balance: ${Number(initAmm) / 1e9} SOL`);

  // 3. Run Tracker
  console.log(`\n⏱  Running FeeTracker...`);
  
  const tracker = new FeeTracker(
    {
      creator: CREATOR,
      bcVault,
      ammVault,
      pollIntervalMs: 2000, // Faster polling for precision
      verbose: false, // Reduce noise, only show key events
      onFeeDetected: (record) => {
        // console.log(`  [FEE] +${Number(record.amount)/1e9} SOL on ${record.symbol}`);
      },
      onTokenDiscovered: (token) => {
        console.log(`  [NEW] Discovered ${token.symbol} (${token.mint})`);
      }
    },
    rpcManager,
    tokenManager
  );

  await tracker.start();

  // Progress bar
  const interval = setInterval(() => {
    const stats = tracker.getStats();
    const total = tracker.getTotalFees();
    const orphans = tracker.getOrphanFees();
    process.stdout.write(`\r⏳ Tracking... Total: ${(Number(total)/1e9).toFixed(4)} SOL (Orphans: ${(Number(orphans)/1e9).toFixed(4)}) | Tokens Active: ${stats.length}   `);
  }, 1000);

  await new Promise(resolve => setTimeout(resolve, durationSec * 1000));
  clearInterval(interval);
  process.stdout.write('\n');

  tracker.stop();
  console.log(`\n🛑 Tracker stopped.`);

  // 4. Final State
  const finalBc = await getBalance(bcVault, false);
  const finalAmm = await getBalance(ammVaultATA, true);

  console.log(`\n📊 Final State:`);
  console.log(`  BC Balance: ${Number(finalBc) / 1e9} SOL`);
  console.log(`  AMM Balance: ${Number(finalAmm) / 1e9} SOL`);

  // 5. Verification
  const deltaBc = finalBc - initBc;
  const deltaAmm = finalAmm - initAmm;
  const totalDelta = deltaBc + deltaAmm;

  const trackerFees = tracker.getTotalFees();
  const orphanFees = tracker.getOrphanFees();
  const tokenFees = trackerFees - orphanFees;
  
  console.log(`\n✅ Results Comparison:`);
  console.log(`  On-Chain Delta: ${Number(totalDelta) / 1e9} SOL`);
  console.log(`  Tracker Fees:   ${Number(trackerFees) / 1e9} SOL`);
  console.log(`  --------------------------------`);
  console.log(`  Attributed to Tokens: ${Number(tokenFees) / 1e9} SOL (${(Number(tokenFees) / Number(trackerFees || 1n) * 100).toFixed(1)}%)`);
  console.log(`  Orphan / System Fees: ${Number(orphanFees) / 1e9} SOL (${(Number(orphanFees) / Number(trackerFees || 1n) * 100).toFixed(1)}%)`);
  
  const diff = totalDelta - trackerFees;
  console.log(`\n  Difference:     ${Number(diff) / 1e9} SOL`);

  // Token Breakdown
  console.log(`\n📦 Top Tokens:`);
  const stats = tracker.getStats().sort((a, b) => Number(b.totalFees - a.totalFees)).slice(0, 5);
  for (const s of stats) {
     console.log(`  ${s.symbol}: ${(Number(s.totalFees)/1e9).toFixed(6)} SOL (${s.feeCount} txs)`);
  }

  if (diff === 0n) {
      console.log(`\n🎉 PERFECT MATCH!`);
  } else {
      console.log(`\n⚠️  Difference detected.`);
  }

  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
