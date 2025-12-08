
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
  const CREATOR = new PublicKey('5F2nKU9cYYBZeceMm9aBjoELiiu7RUC8U8HKS8FM5xPB');
  const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  
  console.log('🚀 Starting Validation Test for Creator:', CREATOR.toBase58());
  console.log('RPC:', RPC_URL.includes('helius') ? 'Using Helius RPC' : 'Using Public RPC');

  // 1. Setup
  const rpcManager = new RpcManager(RPC_URL);
  const tokenManager = new TokenManager(rpcManager);
  
  const bcVault = deriveBondingCurveVault(CREATOR);
  const ammVault = derivePumpSwapVault(CREATOR);
  const ammVaultATA = await getAssociatedTokenAddress(WSOL_MINT, ammVault, true);

  console.log('BC Vault:', bcVault.toBase58());
  console.log('AMM Vault:', ammVault.toBase58());
  console.log('AMM Vault ATA:', ammVaultATA.toBase58());

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
  console.log(`\n⏱  Running FeeTracker for 60 seconds...`);
  
  const tracker = new FeeTracker(
    {
      creator: CREATOR,
      bcVault,
      ammVault,
      pollIntervalMs: 5000,
      verbose: true,
      onFeeDetected: (record) => {
        console.log(`  [FEE] +${Number(record.amount)/1e9} SOL on ${record.symbol} (${record.mint})`);
      },
      onTokenDiscovered: (token) => {
        console.log(`  [NEW] Discovered ${token.symbol} (${token.mint})`);
      }
    },
    rpcManager,
    tokenManager
  );

  await tracker.start();

  await new Promise(resolve => setTimeout(resolve, 60000));

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
  
  console.log(`\n✅ Results Comparison:`);
  console.log(`  On-Chain Delta: ${Number(totalDelta) / 1e9} SOL`);
  console.log(`  Tracker Fees:   ${Number(trackerFees) / 1e9} SOL`);
  console.log(`  (Includes Orphans: ${Number(orphanFees) / 1e9} SOL)`);
  
  const diff = totalDelta - trackerFees;
  console.log(`  Difference:     ${Number(diff) / 1e9} SOL`);

  // We consider it a match if diff is 0 or very small (though bigint means exact)
  // If delta_onchain > tracker_fees, it means we missed fees or there are other deposits.
  // If delta_onchain < tracker_fees, it means there were withdrawals.
  
  if (diff === 0n) {
      console.log(`\n🎉 PERFECT MATCH! The validator is 100% accurate.`);
  } else if (diff < 0n) {
      console.log(`\n⚠️  On-chain balance increased LESS than tracked fees.`);
      console.log(`   Likely cause: Withdrawals by creator during the test.`);
      console.log(`   (Validator tracked +${Number(trackerFees)/1e9}, but wallet only grew +${Number(totalDelta)/1e9})`);
  } else {
      console.log(`\n⚠️  On-chain balance increased MORE than tracked fees.`);
      console.log(`   Possible causes: Missed transactions, rent deposits, or transfers not recognized as fees.`);
  }

  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
