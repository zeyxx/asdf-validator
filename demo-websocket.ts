#!/usr/bin/env node
/**
 * WebSocket Real-time Demo
 *
 * Demonstrates real-time fee tracking using WebSocket subscriptions
 * instead of polling. Updates are received ~400ms instead of 5000ms.
 *
 * Usage:
 *   npx ts-node demo-websocket.ts <CREATOR_ADDRESS> [RPC_URL]
 */

import { PublicKey } from '@solana/web3.js';
import { RealtimeTracker, deriveBondingCurveVault, derivePumpSwapVault } from './daemon';

const LAMPORTS_PER_SOL = 1_000_000_000;

function formatSol(lamports: bigint): string {
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  return sol.toFixed(6);
}

function formatTime(date: Date): string {
  return date.toISOString().split('T')[1].split('.')[0];
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: npx ts-node demo-websocket.ts <CREATOR_ADDRESS> [RPC_URL]');
    console.log('');
    console.log('Example:');
    console.log('  npx ts-node demo-websocket.ts 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    process.exit(1);
  }

  const creatorAddress = args[0];
  const rpcUrl = args[1] || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        ASDF Validator - WebSocket Real-time Demo              ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    const creator = new PublicKey(creatorAddress);
    const bcVault = deriveBondingCurveVault(creator);
    const ammVault = derivePumpSwapVault(creator);

    console.log(`Creator:   ${creator.toBase58()}`);
    console.log(`BC Vault:  ${bcVault.toBase58()}`);
    console.log(`AMM Vault: ${ammVault.toBase58()}`);
    console.log(`RPC URL:   ${rpcUrl.substring(0, 50)}...`);
    console.log('');
    console.log('Connecting to WebSocket...');
    console.log('');

    const tracker = new RealtimeTracker({
      creator,
      bcVault,
      ammVault,
      rpcUrl,
      verbose: true,
      onFeeDetected: (record) => {
        console.log(`[${formatTime(new Date())}] FEE DETECTED`);
        console.log(`  Amount:  ${formatSol(record.amount)} SOL`);
        console.log(`  Vault:   ${record.symbol}`);
        console.log(`  Slot:    ${record.slot}`);
        console.log('');
      },
      onBalanceChange: (vault, oldBalance, newBalance) => {
        const delta = newBalance - oldBalance;
        const sign = delta >= 0n ? '+' : '';
        console.log(`[${formatTime(new Date())}] BALANCE CHANGE (${vault})`);
        console.log(`  Before:  ${formatSol(oldBalance)} SOL`);
        console.log(`  After:   ${formatSol(newBalance)} SOL`);
        console.log(`  Delta:   ${sign}${formatSol(delta)} SOL`);
        console.log('');
      },
    });

    // Event handlers
    tracker.on('connected', () => {
      console.log('');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('   WebSocket CONNECTED - Listening for real-time updates...');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('');
      console.log('   Polling interval: ~400ms (vs 5000ms with HTTP polling)');
      console.log('   Press Ctrl+C to stop');
      console.log('');
    });

    tracker.on('disconnected', () => {
      console.log('WebSocket disconnected');
    });

    tracker.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    tracker.on('claim', ({ vault, amount, slot }) => {
      console.log(`[${formatTime(new Date())}] CLAIM/WITHDRAWAL (${vault})`);
      console.log(`  Amount:  ${formatSol(amount)} SOL`);
      console.log(`  Slot:    ${slot}`);
      console.log('');
    });

    // Start tracking
    await tracker.start();

    // Display initial balances
    const balances = tracker.getBalances();
    console.log('Initial Balances:');
    console.log(`  BC:  ${formatSol(balances.bc)} SOL`);
    console.log(`  AMM: ${formatSol(balances.amm)} SOL`);
    console.log('');

    // Periodic stats
    setInterval(() => {
      const updateCount = tracker.getUpdateCount();
      const totalFees = tracker.getTotalFees();
      const currentBalances = tracker.getBalances();

      console.log(`[${formatTime(new Date())}] STATS`);
      console.log(`  Updates received: ${updateCount}`);
      console.log(`  Total fees:       ${formatSol(totalFees)} SOL`);
      console.log(`  BC balance:       ${formatSol(currentBalances.bc)} SOL`);
      console.log(`  AMM balance:      ${formatSol(currentBalances.amm)} SOL`);
      console.log('');
    }, 30000); // Every 30 seconds

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('');
      console.log('Shutting down...');
      await tracker.stop();

      console.log('');
      console.log('Final Stats:');
      console.log(`  Updates received: ${tracker.getUpdateCount()}`);
      console.log(`  Total fees:       ${formatSol(tracker.getTotalFees())} SOL`);
      console.log('');

      process.exit(0);
    });

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
