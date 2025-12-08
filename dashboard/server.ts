#!/usr/bin/env node
/**
 * ASDF Validator Dashboard Server
 *
 * Real-time fee tracking dashboard with WebSocket updates.
 *
 * Usage:
 *   npx ts-node dashboard/server.ts <CREATOR_ADDRESS> [RPC_URL] [PORT]
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import {
  RealtimeTracker,
  deriveBondingCurveVault,
  derivePumpSwapVault,
  FeeRecord,
  TokenManager,
  RpcManager,
} from '../daemon';

const LAMPORTS_PER_SOL = 1_000_000_000;

interface TokenStatsDisplay {
  mint: string;
  symbol: string;
  name?: string;
  totalFees: string;
  feeCount: number;
  lastFeeTimestamp: number;
  migrated: boolean;
}

interface HourlyFee {
  hour: string; // Format: "HH:00"
  timestamp: number; // Hour start timestamp
  amount: number; // SOL
}

interface DashboardState {
  creator: string;
  bcVault: string;
  ammVault: string;
  bcBalance: string;
  ammBalance: string;
  totalFees: string;
  feeCount: number;
  orphanFees: string;
  orphanFeeCount: number;
  lastUpdate: number;
  recentFees: Array<{
    amount: string;
    vault: string;
    timestamp: number;
    slot: number;
    mint?: string;
    symbol?: string;
  }>;
  tokens: TokenStatsDisplay[];
  feesPerHour: HourlyFee[];
  connected: boolean;
}

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log('Usage: npx ts-node dashboard/server.ts <CREATOR_ADDRESS> [RPC_URL] [PORT]');
  console.log('');
  console.log('Example:');
  console.log('  npx ts-node dashboard/server.ts 5zwN9NQei4fctQ8AfEk67PVoH1jSCSYCpfYkeamkpznj');
  process.exit(1);
}

const creatorAddress = args[0];
const rpcUrl = args[1] || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const port = parseInt(args[2] || '3000', 10);

// Validate creator address
let creator: PublicKey;
try {
  creator = new PublicKey(creatorAddress);
} catch (e) {
  console.error('Invalid creator address:', creatorAddress);
  process.exit(1);
}

const bcVault = deriveBondingCurveVault(creator);
const ammVault = derivePumpSwapVault(creator);

// Dashboard state
const state: DashboardState = {
  creator: creator.toBase58(),
  bcVault: bcVault.toBase58(),
  ammVault: ammVault.toBase58(),
  bcBalance: '0',
  ammBalance: '0',
  totalFees: '0',
  feeCount: 0,
  orphanFees: '0',
  orphanFeeCount: 0,
  lastUpdate: Date.now(),
  recentFees: [],
  tokens: [],
  feesPerHour: initializeHourlyBuckets(),
  connected: false,
};

// Initialize 24 hourly buckets
function initializeHourlyBuckets(): HourlyFee[] {
  const buckets: HourlyFee[] = [];
  const now = Date.now();
  for (let i = 23; i >= 0; i--) {
    const hourStart = new Date(now - i * 60 * 60 * 1000);
    hourStart.setMinutes(0, 0, 0);
    buckets.push({
      hour: hourStart.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      timestamp: hourStart.getTime(),
      amount: 0,
    });
  }
  return buckets;
}

// Get hour key for bucketing
function getHourKey(timestamp: number): string {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Update hourly buckets with new fee
function updateHourlyBuckets(feeTimestamp: number, amount: number): void {
  const now = Date.now();
  const hourKey = getHourKey(feeTimestamp);
  const hourStart = new Date(feeTimestamp);
  hourStart.setMinutes(0, 0, 0);

  // Find or create bucket
  let bucket = state.feesPerHour.find(b => b.hour === hourKey);
  if (bucket) {
    bucket.amount += amount;
  } else {
    // Add new bucket
    state.feesPerHour.push({
      hour: hourKey,
      timestamp: hourStart.getTime(),
      amount,
    });
  }

  // Prune old buckets (keep last 24 hours)
  const cutoff = now - 24 * 60 * 60 * 1000;
  state.feesPerHour = state.feesPerHour
    .filter(b => b.timestamp >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);

  // Ensure we always have 24 buckets (fill gaps)
  const newBuckets = initializeHourlyBuckets();
  for (const existingBucket of state.feesPerHour) {
    const match = newBuckets.find(b => b.hour === existingBucket.hour);
    if (match) {
      match.amount = existingBucket.amount;
    }
  }
  state.feesPerHour = newBuckets;
}

// RPC Manager (initialized in start())
let rpcManager: RpcManager | null = null;

// Helper to update token stats
function updateTokenStats() {
  state.tokens = tracker.getStats().map(s => ({
    mint: s.mint,
    symbol: s.symbol,
    name: s.name,
    totalFees: formatSol(s.totalFees),
    feeCount: s.feeCount,
    lastFeeTimestamp: s.lastFeeTimestamp,
    migrated: s.migrated || false,
  })).sort((a, b) => parseFloat(b.totalFees) - parseFloat(a.totalFees));
}

// Helper to calculate orphan fees from recent fees
function calculateOrphanStats(): { total: number; count: number } {
  let total = 0;
  let count = 0;
  for (const fee of state.recentFees) {
    if (fee.symbol === 'ORPHAN' || fee.mint === 'orphan') {
      total += parseFloat(fee.amount);
      count++;
    }
  }
  return { total, count };
}

// Create Express app
const app = express();
const server = createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server });
const clients: Set<WebSocket> = new Set();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.get('/api/state', (req, res) => {
  res.json(state);
});

app.get('/api/config', (req, res) => {
  res.json({
    creator: state.creator,
    bcVault: state.bcVault,
    ammVault: state.ammVault,
    // RPC URL is not exposed for security reasons
  });
});

// Health check endpoint
const startTime = Date.now();
app.get('/health', async (req, res) => {
  const uptimeMs = Date.now() - startTime;
  const memUsage = process.memoryUsage();

  // Get circuit breaker state
  const circuitBreakerState = rpcManager
    ? rpcManager.getCircuitBreakerState()
    : { state: 'UNKNOWN', canExecute: false };

  // Get RPC health (async)
  let rpcHealth = { healthy: false, latencyMs: 0, error: 'Not initialized' };
  if (rpcManager) {
    try {
      rpcHealth = await rpcManager.checkHealth(5000);
    } catch (e) {
      rpcHealth = { healthy: false, latencyMs: 0, error: String(e) };
    }
  }

  const healthData = {
    status: state.connected ? 'healthy' : 'degraded',
    uptime: {
      ms: uptimeMs,
      formatted: formatUptime(uptimeMs),
    },
    websocket: {
      connected: state.connected,
      clients: clients.size,
    },
    tracker: {
      running: tracker.isRunning(),
      updateCount: tracker.getUpdateCount(),
      feeCount: state.feeCount,
    },
    circuitBreaker: {
      state: circuitBreakerState.state,
      canExecute: circuitBreakerState.canExecute,
      description: getCircuitBreakerDescription(circuitBreakerState.state),
    },
    rpc: {
      healthy: rpcHealth.healthy,
      latencyMs: rpcHealth.latencyMs,
      error: rpcHealth.error,
    },
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024),
      unit: 'MB',
    },
    timestamp: new Date().toISOString(),
  };

  // Return 200 for healthy/degraded, 503 for down
  const statusCode = state.connected ? 200 : 503;
  res.status(statusCode).json(healthData);
});

function getCircuitBreakerDescription(state: string): string {
  switch (state) {
    case 'CLOSED':
      return 'RPC connection healthy';
    case 'OPEN':
      return 'RPC failures detected, blocking requests';
    case 'HALF_OPEN':
      return 'Testing RPC recovery';
    default:
      return 'Unknown state';
  }
}

// Export endpoints
app.get('/api/export/fees', (req, res) => {
  const format = (req.query.format as string) || 'json';
  const fees = state.recentFees;

  if (format === 'csv') {
    const headers = ['timestamp', 'date', 'amount', 'vault', 'slot', 'mint', 'symbol'];
    const csvRows = [headers.join(',')];
    for (const fee of fees) {
      csvRows.push([
        fee.timestamp,
        new Date(fee.timestamp).toISOString(),
        fee.amount,
        fee.vault,
        fee.slot,
        fee.mint || '',
        fee.symbol || '',
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="fees-${Date.now()}.csv"`);
    res.send(csvRows.join('\n'));
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="fees-${Date.now()}.json"`);
    res.json({
      exported: new Date().toISOString(),
      creator: state.creator,
      totalFees: state.totalFees,
      feeCount: state.feeCount,
      fees,
    });
  }
});

app.get('/api/export/tokens', (req, res) => {
  const format = (req.query.format as string) || 'json';
  const tokens = state.tokens;

  if (format === 'csv') {
    const headers = ['mint', 'symbol', 'name', 'totalFees', 'feeCount', 'lastFeeTimestamp', 'migrated'];
    const csvRows = [headers.join(',')];
    for (const token of tokens) {
      csvRows.push([
        token.mint,
        token.symbol,
        token.name || '',
        token.totalFees,
        token.feeCount,
        token.lastFeeTimestamp,
        token.migrated,
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tokens-${Date.now()}.csv"`);
    res.send(csvRows.join('\n'));
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="tokens-${Date.now()}.json"`);
    res.json({
      exported: new Date().toISOString(),
      creator: state.creator,
      tokenCount: tokens.length,
      tokens,
    });
  }
});

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// WebSocket handling
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Client connected (${clients.size} total)`);

  // Send current state
  ws.send(JSON.stringify({ type: 'state', data: state }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} total)`);
  });
});

function broadcast(message: object) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Format for display
function formatSol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
}

// Create tracker
const tracker = new RealtimeTracker({
  creator,
  bcVault,
  ammVault,
  rpcUrl,
  verbose: false,
  onFeeDetected: (record: FeeRecord) => {
    state.feeCount++;
    state.totalFees = formatSol(tracker.getTotalFees());
    state.lastUpdate = Date.now();

    // Track orphan fees
    const isOrphan = record.symbol === 'ORPHAN' || record.mint === 'orphan';
    if (isOrphan) {
      state.orphanFeeCount++;
      state.orphanFees = (parseFloat(state.orphanFees) + Number(record.amount) / LAMPORTS_PER_SOL).toFixed(6);
    }

    // Update hourly buckets
    const feeAmountSol = Number(record.amount) / LAMPORTS_PER_SOL;
    updateHourlyBuckets(record.timestamp, feeAmountSol);

    // Update token stats
    updateTokenStats();

    // Add to recent fees (keep last 50)
    state.recentFees.unshift({
      amount: formatSol(record.amount),
      vault: record.symbol,
      timestamp: record.timestamp,
      slot: record.slot,
      mint: record.mint,
      symbol: record.symbol,
    });
    if (state.recentFees.length > 50) {
      state.recentFees.pop();
    }

    broadcast({
      type: 'fee',
      data: {
        amount: formatSol(record.amount),
        vault: record.symbol,
        timestamp: record.timestamp,
        slot: record.slot,
        mint: record.mint,
        symbol: record.symbol,
        totalFees: state.totalFees,
        feeCount: state.feeCount,
        orphanFees: state.orphanFees,
        orphanFeeCount: state.orphanFeeCount,
        isOrphan,
        tokens: state.tokens,
        feesPerHour: state.feesPerHour,
      },
    });
  },
  onBalanceChange: (vault, oldBalance, newBalance) => {
    if (vault === 'BC') {
      state.bcBalance = formatSol(newBalance);
    } else {
      state.ammBalance = formatSol(newBalance);
    }
    state.lastUpdate = Date.now();

    broadcast({
      type: 'balance',
      data: {
        vault,
        balance: vault === 'BC' ? state.bcBalance : state.ammBalance,
        bcBalance: state.bcBalance,
        ammBalance: state.ammBalance,
      },
    });
  },
});

// Tracker events
tracker.on('connected', () => {
  state.connected = true;
  console.log('RealtimeTracker connected');
  broadcast({ type: 'status', data: { connected: true } });
});

tracker.on('disconnected', () => {
  state.connected = false;
  console.log('RealtimeTracker disconnected');
  broadcast({ type: 'status', data: { connected: false } });
});

tracker.on('error', (error) => {
  console.error('RealtimeTracker error:', error);
});

// Start server
async function start() {
  console.log('');
  console.log('='.repeat(60));
  console.log('   ASDF Validator Dashboard');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Creator:   ${creator.toBase58()}`);
  console.log(`BC Vault:  ${bcVault.toBase58()}`);
  console.log(`AMM Vault: ${ammVault.toBase58()}`);
  console.log('');

  // Discover tokens created by this creator
  console.log('Discovering tokens...');
  rpcManager = new RpcManager(rpcUrl);
  const tokenManager = new TokenManager(rpcManager);

  try {
    const discoveredTokens = await tokenManager.discoverTokens(creator);
    console.log(`Found ${discoveredTokens.length} tokens`);

    for (const token of discoveredTokens) {
      if (!token.mint) continue; // Skip tokens without mint
      const mintStr = token.mint.toBase58();
      const bcStr = token.bondingCurve.toBase58();
      const symbol = mintStr.substring(0, 6);

      tracker.addToken({
        mint: mintStr,
        symbol: symbol,
        bondingCurve: bcStr,
        ammPool: '',
        migrated: token.migrated,
        lastSolReserves: token.realSolReserves || 0n,
        lastAmmReserves: 0n,
        totalFees: 0n,
        feeCount: 0,
        recentAmmFees: 0n,
        recentAmmFeesTimestamp: 0,
        recentBcFees: 0n,
        recentBcFeesTimestamp: 0,
        isMayhemMode: token.isMayhemMode || false,
        tokenProgram: 'TOKEN',
      });
      console.log(`  - ${symbol} (${token.migrated ? 'AMM' : 'BC'})`);
    }

    // Update state with discovered tokens
    updateTokenStats();
  } catch (error) {
    console.log('Token discovery failed:', error);
  }

  // Start tracker
  await tracker.start();

  // Get initial balances
  const balances = tracker.getBalances();
  state.bcBalance = formatSol(balances.bc);
  state.ammBalance = formatSol(balances.amm);

  // Start HTTP server
  server.listen(port, () => {
    console.log('');
    console.log(`Dashboard running at http://localhost:${port}`);
    console.log('');
    console.log('Press Ctrl+C to stop');
    console.log('');
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await tracker.stop();
  server.close();
  process.exit(0);
});

start().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
