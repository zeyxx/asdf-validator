#!/usr/bin/env node
/**
 * asdf-validator CLI
 *
 * Simple CLI to run a validator daemon for your creator address.
 *
 * Usage:
 *   npx asdf-validator --creator <ADDRESS>
 *   asdf-validator -c <ADDRESS> --verbose
 */

import {
  ValidatorDaemon,
  TokenConfig,
  deriveBondingCurveVault,
  derivePumpSwapVault,
  HistoryEntry,
  HistoryEventType,
  HistoryLog,
  verifyHistoryChain,
  loadHistoryLog,
  GENESIS_HASH
} from './daemon';
import { PublicKey, Connection } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Argument Parsing
// ============================================================================

interface CLIArgs {
  creatorAddress: string | null;
  rpcUrl: string;
  tokensFile: string | null;
  verbose: boolean;
  showHelp: boolean;
  pollInterval: number;
  historyFile: string | null;
  verifyFile: string | null;
}

function parseArgs(args: string[]): CLIArgs {
  const result: CLIArgs = {
    creatorAddress: null,
    rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    tokensFile: null,
    verbose: false,
    showHelp: false,
    pollInterval: 5000,
    historyFile: null,
    verifyFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.showHelp = true;
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true;
    } else if (arg === '--creator' || arg === '-c') {
      result.creatorAddress = args[++i];
    } else if (arg === '--rpc' || arg === '-r') {
      result.rpcUrl = args[++i];
    } else if (arg === '--tokens' || arg === '-t') {
      result.tokensFile = args[++i];
    } else if (arg === '--interval' || arg === '-i') {
      result.pollInterval = parseInt(args[++i], 10) * 1000;
    } else if (arg === '--history' || arg === '-H') {
      result.historyFile = args[++i];
    } else if (arg === '--verify' || arg === '-V') {
      result.verifyFile = args[++i];
    } else if (arg.startsWith('--creator=')) {
      result.creatorAddress = arg.split('=')[1];
    } else if (arg.startsWith('--rpc=')) {
      result.rpcUrl = arg.split('=')[1];
    } else if (arg.startsWith('--history=')) {
      result.historyFile = arg.split('=')[1];
    } else if (arg.startsWith('--verify=')) {
      result.verifyFile = arg.split('=')[1];
    }
  }

  return result;
}

function showHelp(): void {
  console.log(`
🔥 asdf-validator

Track creator fees for your Pump.fun tokens with Proof-of-History.

USAGE:
  asdf-validator --creator <ADDRESS> [options]
  asdf-validator --verify <FILE>

REQUIRED:
  --creator, -c <ADDRESS>   Your creator wallet address

OPTIONS:
  --rpc, -r <URL>           RPC URL (default: mainnet public)
  --tokens, -t <FILE>       JSON file with token configs
  --interval, -i <SECONDS>  Poll interval (default: 5)
  --history, -H <FILE>      Enable Proof-of-History, save to FILE
  --verify, -V <FILE>       Verify a Proof-of-History file (standalone)
  --verbose, -v             Enable verbose logging
  --help, -h                Show this help

ENVIRONMENT:
  RPC_URL                   Default RPC URL

EXAMPLES:
  # Basic usage - monitor your creator vault
  npx asdf-validator -c 5ABC...xyz

  # With Proof-of-History enabled (recommended)
  npx asdf-validator -c 5ABC...xyz -H history.json -v

  # Verify an existing history file
  npx asdf-validator --verify history.json

  # With custom RPC and verbose logging
  npx asdf-validator -c 5ABC...xyz -r https://my-rpc.com -v

PROOF-OF-HISTORY:
  When --history is enabled, all fee events are recorded with:
  • SHA-256 hash of event data
  • Chain linking (each entry references previous hash)
  • Solana slot number for on-chain verification
  • Timestamps and balance snapshots

  Anyone can verify the integrity with --verify <FILE>

HOW IT WORKS:
  1. Monitors your creator vault(s) for balance changes
  2. Detects fee accumulation from trading activity
  3. Creates cryptographic proof for each fee event
  4. Reports stats every 60 seconds

Press Ctrl+C to stop and see final stats.
`);
}

// ============================================================================
// Token Loading
// ============================================================================

function loadTokens(filePath: string): TokenConfig[] {
  try {
    const fullPath = path.resolve(filePath);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const data = JSON.parse(content);

    if (Array.isArray(data)) {
      return data.map((t: any) => ({
        mint: t.mint,
        symbol: t.symbol || t.name || 'UNKNOWN',
        bondingCurve: t.bondingCurve || t.pool,
        poolType: t.poolType || 'bonding_curve',
      }));
    }

    // Single token object
    return [{
      mint: data.mint,
      symbol: data.symbol || data.name || 'UNKNOWN',
      bondingCurve: data.bondingCurve || data.pool,
      poolType: data.poolType || 'bonding_curve',
    }];
  } catch (error) {
    console.error(`Error loading tokens from ${filePath}:`, error);
    return [];
  }
}

// ============================================================================
// Main
// ============================================================================

// ============================================================================
// Verify Command
// ============================================================================

function verifyHistoryFile(filePath: string): void {
  console.log('\n🔍 PROOF-OF-HISTORY VERIFICATION');
  console.log('═'.repeat(55));
  console.log(`File: ${filePath}\n`);

  // Load the file
  let log: HistoryLog;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    log = JSON.parse(content) as HistoryLog;
  } catch (error) {
    console.error(`❌ Failed to load file: ${error}`);
    process.exit(1);
  }

  // Display metadata
  console.log('📋 METADATA');
  console.log('─'.repeat(40));
  console.log(`Version:     ${log.version}`);
  console.log(`Creator:     ${log.creator}`);
  console.log(`BC Vault:    ${log.bcVault}`);
  console.log(`AMM Vault:   ${log.ammVault}`);
  console.log(`Started:     ${log.startedAt}`);
  console.log(`Last Update: ${log.lastUpdated}`);
  console.log(`Total Fees:  ${(Number(log.totalFees) / 1e9).toFixed(9)} SOL`);
  console.log(`Entries:     ${log.entryCount}`);
  console.log(`Latest Hash: ${log.latestHash.slice(0, 16)}...`);
  console.log('');

  // Verify chain
  console.log('🔗 CHAIN VERIFICATION');
  console.log('─'.repeat(40));

  const result = verifyHistoryChain(log);

  if (result.valid) {
    console.log('✅ All hashes valid');
    console.log('✅ Chain linkage verified');
    console.log('✅ Sequence numbers correct');
    console.log('');
    console.log('═'.repeat(55));
    console.log('✅ PROOF-OF-HISTORY VERIFIED SUCCESSFULLY');
    console.log('═'.repeat(55));
  } else {
    console.log(`❌ Verification FAILED at entry ${result.entryIndex}`);
    console.log(`   Error: ${result.error}`);
    console.log('');
    console.log('═'.repeat(55));
    console.log('❌ PROOF-OF-HISTORY VERIFICATION FAILED');
    console.log('═'.repeat(55));
    process.exit(1);
  }

  // Show recent entries
  if (log.entries.length > 0) {
    console.log('\n📜 RECENT ENTRIES (last 5)');
    console.log('─'.repeat(40));
    const recent = log.entries.slice(-5);
    for (const entry of recent) {
      const amount = BigInt(entry.amount);
      const sol = (Number(amount < 0n ? -amount : amount) / 1e9).toFixed(6);
      const eventType = entry.eventType || 'FEE'; // Backward compat
      const sign = eventType === 'CLAIM' ? '-' : '+';
      const icon = eventType === 'CLAIM' ? '📤' : '💰';
      console.log(`#${entry.sequence} [${entry.date.slice(0, 19)}] ${icon} ${entry.vaultType}: ${sign}${sol} SOL (${eventType})`);
      console.log(`   Hash: ${entry.hash.slice(0, 32)}...`);
    }
  }

  console.log('');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Handle --verify mode (standalone)
  if (args.verifyFile) {
    verifyHistoryFile(args.verifyFile);
    process.exit(0);
  }

  if (args.showHelp || !args.creatorAddress) {
    showHelp();
    process.exit(args.showHelp ? 0 : 1);
  }

  // Validate creator address
  let creator: PublicKey;
  try {
    creator = new PublicKey(args.creatorAddress);
  } catch {
    console.error('❌ Invalid creator address');
    process.exit(1);
  }

  // Derive vault addresses for display
  const bcVault = deriveBondingCurveVault(creator);
  const ammVault = derivePumpSwapVault(creator);

  console.log('\n🔥 ASDF VALIDATOR DAEMON');
  console.log('═'.repeat(55));
  console.log(`Creator:    ${creator.toBase58()}`);
  console.log(`BC Vault:   ${bcVault.toBase58()}`);
  console.log(`AMM Vault:  ${ammVault.toBase58()}`);
  console.log(`RPC:        ${args.rpcUrl.slice(0, 50)}...`);
  console.log(`Poll:       ${args.pollInterval / 1000}s`);
  if (args.historyFile) {
    console.log(`PoH:        ${args.historyFile} ✓`);
  }
  console.log('═'.repeat(55));

  // Load tokens if file provided
  let tokens: TokenConfig[] = [];
  if (args.tokensFile) {
    tokens = loadTokens(args.tokensFile);
    console.log(`\n📦 Loaded ${tokens.length} token(s):`);
    for (const t of tokens) {
      console.log(`   • ${t.symbol} (${t.poolType})`);
    }
  }

  // Create daemon
  const daemon = new ValidatorDaemon({
    rpcUrl: args.rpcUrl,
    creatorAddress: args.creatorAddress,
    tokens: tokens.length > 0 ? tokens : undefined,
    pollInterval: args.pollInterval,
    verbose: args.verbose,
    historyFile: args.historyFile || undefined,

    onFeeDetected: (record) => {
      const sol = Number(record.amount) / 1e9;
      const time = new Date().toISOString().slice(11, 19);
      console.log(`[${time}] 💰 ${record.symbol}: +${sol.toFixed(6)} SOL`);
    },

    onHistoryEntry: args.historyFile ? (entry) => {
      const icon = entry.eventType === 'CLAIM' ? '📤' : '🔗';
      console.log(`         ${icon} Hash: ${entry.hash.slice(0, 16)}... (${entry.eventType} #${entry.sequence})`);
    } : undefined,

    onStats: (stats) => {
      const total = stats.reduce((sum, s) => sum + Number(s.totalFees), 0);
      console.log('\n📊 STATS');
      console.log('─'.repeat(40));
      console.log(`Total: ${(total / 1e9).toFixed(6)} SOL`);
      for (const s of stats) {
        if (s.totalFees > 0n) {
          const pct = total > 0 ? (Number(s.totalFees) / total * 100).toFixed(1) : '0';
          console.log(`  ${s.symbol}: ${(Number(s.totalFees) / 1e9).toFixed(6)} SOL (${pct}%)`);
        }
      }
      console.log('─'.repeat(40) + '\n');
    },
  });

  // Handle shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\n\n🛑 Shutting down...');
    daemon.stop();

    const total = daemon.getTotalFees();
    const stats = daemon.getStats();
    const historyLog = daemon.getHistoryLog();

    console.log('\n📊 FINAL STATS');
    console.log('═'.repeat(40));
    console.log(`Total fees tracked: ${(Number(total) / 1e9).toFixed(6)} SOL`);

    for (const s of stats) {
      if (s.totalFees > 0n) {
        console.log(`  ${s.symbol}: ${(Number(s.totalFees) / 1e9).toFixed(6)} SOL`);
      }
    }

    // Show PoH summary if enabled
    if (historyLog && args.historyFile) {
      console.log('');
      console.log('🔗 PROOF-OF-HISTORY');
      console.log('─'.repeat(40));
      console.log(`Entries:     ${historyLog.entryCount}`);
      console.log(`Latest hash: ${historyLog.latestHash.slice(0, 32)}...`);
      console.log(`Saved to:    ${args.historyFile}`);
      console.log('');
      console.log('Verify with: npx asdf-validator --verify ' + args.historyFile);
    }

    console.log('═'.repeat(40));
    console.log('\n✅ Goodbye!\n');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start daemon
  console.log('\n▶ Starting daemon...\n');
  await daemon.start();
  console.log('✅ Daemon running. Press Ctrl+C to stop.\n');
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
