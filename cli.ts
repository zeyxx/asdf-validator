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
  TokenStats,
  FeeRecord,
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

// Load .env file if it exists
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=');
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

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
  liveMode: boolean;
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
    liveMode: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.showHelp = true;
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true;
    } else if (arg === '--live' || arg === '-l') {
      result.liveMode = true;
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
  --live, -l                Enable live dashboard mode (in-line updates)
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
// Live Dashboard
// ============================================================================

interface LastFeeInfo {
  symbol: string;
  amount: bigint;
  vaultType: string;
  timestamp: number;
}

interface TokenFeeData {
  symbol: string;
  totalFees: bigint;
  feeCount: number;
  lastFeeTime: number;
}

class LiveDashboard {
  private startTime: number = Date.now();
  private feeCount: number = 0;
  private lastFee: LastFeeInfo | null = null;
  private bcBalance: bigint = 0n;
  private pohEntries: number = 0;
  private updateInterval: NodeJS.Timeout | null = null;
  private tokenFees: Map<string, TokenFeeData> = new Map();

  constructor(
    private creator: string,
    private bcVault: string,
    private ammVault: string,
    private historyEnabled: boolean
  ) {}

  start(): void {
    // Hide cursor and clear screen
    process.stdout.write('\x1b[?25l\x1b[2J\x1b[H');
    this.render();
    // Update every second
    this.updateInterval = setInterval(() => this.render(), 1000);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    // Show cursor
    process.stdout.write('\x1b[?25h');
  }

  setPohEntries(count: number): void {
    this.pohEntries = count;
  }

  logFee(record: FeeRecord): void {
    this.feeCount++;
    this.lastFee = {
      symbol: record.symbol,
      amount: record.amount,
      vaultType: 'BC', // Default, could be enhanced
      timestamp: Date.now(),
    };

    // Accumulate per-token fees
    const key = record.symbol;
    const existing = this.tokenFees.get(key);
    if (existing) {
      existing.totalFees += record.amount;
      existing.feeCount++;
      existing.lastFeeTime = Date.now();
    } else {
      this.tokenFees.set(key, {
        symbol: record.symbol,
        totalFees: record.amount,
        feeCount: 1,
        lastFeeTime: Date.now(),
      });
    }

    // Update BC balance (accumulated fees)
    this.bcBalance += record.amount;
  }

  private formatUptime(): string {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  }

  private formatSOL(lamports: bigint): string {
    return (Number(lamports) / 1e9).toFixed(6);
  }

  private formatTimeAgo(timestamp: number): string {
    const secs = Math.floor((Date.now() - timestamp) / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ago`;
  }

  private render(): void {
    const W = 64; // Width
    const lines: string[] = [];

    // Move cursor to top-left
    process.stdout.write('\x1b[H');

    // Header
    lines.push('┌' + '─'.repeat(W - 2) + '┐');
    const title = `🔥 ASDF VALIDATOR - LIVE`;
    const uptime = `⏱ ${this.formatUptime()}`;
    const headerContent = `  ${title}${' '.repeat(W - 6 - title.length - uptime.length)}${uptime}  `;
    lines.push('│' + headerContent.slice(0, W - 2) + '│');
    lines.push('├' + '─'.repeat(W - 2) + '┤');

    // Fees accumulated section
    const bcStr = `Total Fees: ${this.formatSOL(this.bcBalance)} SOL`;
    const countStr = `${this.feeCount} transactions`;
    const vaultLine = `  ${bcStr}${' '.repeat(Math.max(1, 32 - bcStr.length))}${countStr}`;
    lines.push('│' + vaultLine.padEnd(W - 2) + '│');
    lines.push('├' + '─'.repeat(W - 2) + '┤');

    // Tokens header
    lines.push('│' + '  TOKEN              │  TOTAL FEES   │ COUNT │  LAST     '.padEnd(W - 2) + '│');
    lines.push('│' + '  ───────────────────┼───────────────┼───────┼───────────'.padEnd(W - 2) + '│');

    // Token rows (up to 8) - use accumulated tokenFees
    const tokenList = Array.from(this.tokenFees.values())
      .sort((a, b) => Number(b.totalFees - a.totalFees))
      .slice(0, 8);

    if (tokenList.length === 0) {
      lines.push('│' + '  (waiting for fees...)'.padEnd(W - 2) + '│');
    } else {
      for (const t of tokenList) {
        const symbol = t.symbol.slice(0, 18).padEnd(18);
        const fees = this.formatSOL(t.totalFees).padStart(12);
        const count = t.feeCount.toString().padStart(5);
        const lastTime = t.lastFeeTime > 0
          ? this.formatTimeAgo(t.lastFeeTime).padEnd(9)
          : '-'.padEnd(9);
        const row = `  ${symbol} │ ${fees} SOL │ ${count} │ ${lastTime}`;
        lines.push('│' + row.slice(0, W - 2).padEnd(W - 2) + '│');
      }
    }

    // Fill empty rows if less than 3 tokens
    const minRows = 3;
    for (let i = tokenList.length; i < minRows && tokenList.length > 0; i++) {
      lines.push('│' + ' '.repeat(W - 2) + '│');
    }

    lines.push('├' + '─'.repeat(W - 2) + '┤');

    // Summary line - use bcBalance (accumulated fees)
    const totalStr = `TOTAL: ${this.formatSOL(this.bcBalance)} SOL`;
    const feesStr = `FEES: ${this.feeCount}`;
    const pohStr = this.historyEnabled ? `PoH: ✓ ${this.pohEntries}` : 'PoH: -';
    const summaryLine = `  ${totalStr} │ ${feesStr} │ ${pohStr}`;
    lines.push('│' + summaryLine.padEnd(W - 2) + '│');

    lines.push('├' + '─'.repeat(W - 2) + '┤');

    // Last fee line
    let lastLine = '  (waiting for fees...)';
    if (this.lastFee) {
      const sign = '+';
      const amt = this.formatSOL(this.lastFee.amount);
      const time = new Date().toISOString().slice(11, 19);
      lastLine = `  LAST: ${sign}${amt} SOL → ${this.lastFee.symbol} @ ${time}`;
    }
    lines.push('│' + lastLine.padEnd(W - 2) + '│');

    lines.push('└' + '─'.repeat(W - 2) + '┘');

    // Footer
    lines.push('\n  Press Ctrl+C to stop');

    // Clear each line and print
    for (const line of lines) {
      process.stdout.write(line + '\x1b[K\n');
    }
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

  // Show header only in non-live mode
  if (!args.liveMode) {
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
  }

  // Load tokens if file provided
  let tokens: TokenConfig[] = [];
  if (args.tokensFile) {
    tokens = loadTokens(args.tokensFile);
    if (!args.liveMode) {
      console.log(`\n📦 Loaded ${tokens.length} token(s):`);
      for (const t of tokens) {
        console.log(`   • ${t.symbol} (${t.poolType})`);
      }
    }
  }

  // Create live dashboard if enabled
  let dashboard: LiveDashboard | null = null;
  if (args.liveMode) {
    dashboard = new LiveDashboard(
      creator.toBase58(),
      bcVault.toBase58(),
      ammVault.toBase58(),
      !!args.historyFile
    );
  }

  // Create daemon
  const daemon = new ValidatorDaemon({
    rpcUrl: args.rpcUrl,
    creatorAddress: args.creatorAddress,
    tokens: tokens.length > 0 ? tokens : undefined,
    pollInterval: args.pollInterval,
    verbose: args.verbose && !args.liveMode, // Disable verbose in live mode
    historyFile: args.historyFile || undefined,

    onFeeDetected: (record) => {
      if (dashboard) {
        dashboard.logFee(record);
      } else {
        const sol = Number(record.amount) / 1e9;
        const time = new Date().toISOString().slice(11, 19);
        console.log(`[${time}] 💰 ${record.symbol}: +${sol.toFixed(6)} SOL`);
      }
    },

    onHistoryEntry: args.historyFile ? (entry) => {
      if (dashboard) {
        dashboard.setPohEntries(entry.sequence);
      } else {
        const icon = entry.eventType === 'CLAIM' ? '📤' : '🔗';
        console.log(`         ${icon} Hash: ${entry.hash.slice(0, 16)}... (${entry.eventType} #${entry.sequence})`);
      }
    } : undefined,

    onStats: (stats) => {
      // In live mode, dashboard keeps its own state via logFee
      // Only show stats in non-live mode
      if (!dashboard) {
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
      }
    },
  });

  // Handle shutdown
  let shuttingDown = false;
  // Initialize shutdown handler (will be replaced in live mode)
  let shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop dashboard first
    if (dashboard) {
      dashboard.stop();
    }

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
  if (!args.liveMode) {
    console.log('\n▶ Starting daemon...\n');
  }
  await daemon.start();

  // Capture initial balances for live mode comparison
  let initialBc = 0n;
  let initialAmm = 0n;
  if (args.liveMode) {
    try {
      const { bc, amm } = await daemon.fetchCurrentBalances();
      initialBc = bc;
      initialAmm = amm;
    } catch (e) {
      // Ignore initial fetch error
    }
  }

  // Start dashboard after daemon is running
  if (dashboard) {
    dashboard.start();
  } else {
    console.log('✅ Daemon running. Press Ctrl+C to stop.\n');
  }

  // Update shutdown function to use initial balances
  const oldShutdown = process.listeners('SIGINT')[0] as () => void;
  if (oldShutdown) {
      process.removeListener('SIGINT', oldShutdown);
      process.removeListener('SIGTERM', oldShutdown);
  }

  // Redefine shutdown handler
  shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop dashboard first
    if (dashboard) {
      dashboard.stop();
    }

    console.log('\n\n🛑 Shutting down...');
    
    // Fetch final balances BEFORE stopping daemon (while RPC is hot)
    let finalBc = 0n;
    let finalAmm = 0n;
    if (args.liveMode) {
      try {
        const { bc, amm } = await daemon.fetchCurrentBalances();
        finalBc = bc;
        finalAmm = amm;
      } catch (e) {
        // Ignore final fetch error
      }
    }

    daemon.stop();

    const total = daemon.getTotalFees();
    const stats = daemon.getStats();
    const historyLog = daemon.getHistoryLog();
    const orphanFees = daemon.getOrphanFees();

    console.log('\n📊 FINAL STATS');
    console.log('═'.repeat(40));
    console.log(`Total fees tracked: ${(Number(total) / 1e9).toFixed(6)} SOL`);

    for (const s of stats) {
      if (s.totalFees > 0n) {
        console.log(`  ${s.symbol}: ${(Number(s.totalFees) / 1e9).toFixed(6)} SOL`);
      }
    }
    
    if (orphanFees > 0n) {
      console.log(`  [ORPHAN]: ${(Number(orphanFees) / 1e9).toFixed(6)} SOL`);
    }

    // Live Mode Comparison
    if (args.liveMode && initialBc > 0n) {
      const deltaBc = finalBc - initialBc;
      const deltaAmm = finalAmm - initialAmm;
      const totalDelta = deltaBc + deltaAmm;
      const diff = totalDelta - total;

      console.log('');
      console.log('⚖️  SESSION COMPARISON');
      console.log('─'.repeat(40));
      console.log(`Initial State: ${Number(initialBc)/1e9} SOL (BC) | ${Number(initialAmm)/1e9} SOL (AMM)`);
      console.log(`Final State:   ${Number(finalBc)/1e9} SOL (BC) | ${Number(finalAmm)/1e9} SOL (AMM)`);
      console.log('─'.repeat(40));
      console.log(`On-Chain Delta: ${(Number(totalDelta)/1e9).toFixed(6)} SOL`);
      console.log(`Tracker Fees:   ${(Number(total)/1e9).toFixed(6)} SOL`);
      console.log(`Difference:     ${(Number(diff)/1e9).toFixed(6)} SOL`);
      
      if (diff === 0n) {
        console.log('✅ PERFECT MATCH');
      } else if (diff < 0n) {
        console.log('⚠️  Difference detected (Likely withdrawals)');
      } else {
        console.log('⚠️  Difference detected (Missed fees?)');
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
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
