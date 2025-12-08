# asdf-validator

Track creator fees for your Pump.fun tokens with cryptographic Proof-of-History.

## Install

```bash
npm install -g asdf-validator
```

## Quick Start

```bash
# Run daemon for your creator address
asdf-validator --creator YOUR_CREATOR_WALLET_ADDRESS

# With Proof-of-History enabled (recommended)
asdf-validator -c YOUR_ADDRESS -H history.json -v

# Verify a history file
asdf-validator --verify history.json

# Custom RPC
asdf-validator -c YOUR_ADDRESS -r https://my-rpc.com
```

## What It Does

1. **Auto-discovers** all tokens created by your wallet
2. **Monitors** creator vault(s) for balance changes
3. **Attributes fees** to specific tokens via BC reserve tracking
4. **Detects migrations** from Bonding Curve to AMM
5. **Creates proof** with cryptographic Proof-of-History
6. **Reports stats** per token every 60 seconds

```
🔥 ASDF VALIDATOR DAEMON
═══════════════════════════════════════════════════════
Creator:    5ABC...xyz
BC Vault:   7DEF...uvw
AMM Vault:  9GHI...rst
PoH:        history.json ✓
═══════════════════════════════════════════════════════

▶ Discovering tokens...
Found token: TOKEN-1 (BC: 7K4s...abc, migrated: false)
Found token: TOKEN-2 (BC: 9F2x...def, migrated: true)
Tracking 2 token(s)

✅ Daemon running. Press Ctrl+C to stop.

[12:34:56] TOKEN-1: +0.001234 SOL (BC)
         🔗 Hash: c60d4ed93f68f412... (FEE #1)
[12:35:12] TOKEN-2: +0.000567 SOL (AMM)
         🔗 Hash: a164dd0b776b4f01... (FEE #2)

📊 STATS
────────────────────────────────────
TOKEN-1: 0.001234 SOL (1 fee)
TOKEN-2: 0.000567 SOL (1 fee)
Total: 0.001801 SOL
────────────────────────────────────
```

## Token Discovery

The daemon automatically discovers all tokens created by your wallet:

1. **Scans bonding curves** via `getProgramAccounts` filter on creator
2. **Deserializes BC data** to get reserves and migration status
3. **Tracks each token** separately with its own stats
4. **Detects migrations** when `complete` flag becomes true

### How Fee Attribution Works

Pump.fun creator fees go to shared vaults (one per creator), not per token. The daemon correlates vault changes with BC reserve changes:

1. Poll each token's BC `realSolReserves`
2. When vault balance increases, attribute proportionally to tokens with reserve changes
3. Record attribution in history with `mint` and `symbol` fields

This provides **100% fee attribution** when BC activity is detectable.

## Proof-of-History

Enable cryptographic proof for all fee events with `--history`:

```bash
asdf-validator -c YOUR_ADDRESS -H history.json
```

Each event is recorded with:
- **SHA-256 hash** of event data
- **Chain linking** (each entry references previous hash)
- **Solana slot number** for on-chain verification
- **Timestamps** and balance snapshots

### Verify a History File

Anyone can verify the integrity of a history file:

```bash
asdf-validator --verify history.json
```

Output:
```
🔍 PROOF-OF-HISTORY VERIFICATION
═══════════════════════════════════════════════════════
File: history.json

📋 METADATA
────────────────────────────────────────
Version:     1.0.0
Creator:     7E9jfxCczubz4FXkkVKzUMHXGwzJxyppC4m7y3ew8ATg
Total Fees:  0.085192345 SOL
Entries:     33

🔗 CHAIN VERIFICATION
────────────────────────────────────────
✅ All hashes valid
✅ Chain linkage verified
✅ Sequence numbers correct

═══════════════════════════════════════════════════════
✅ PROOF-OF-HISTORY VERIFIED SUCCESSFULLY
═══════════════════════════════════════════════════════
```

### History File Format

```json
{
  "version": "1.0.0",
  "creator": "YOUR_CREATOR_ADDRESS",
  "bcVault": "BC_VAULT_ADDRESS",
  "ammVault": "AMM_VAULT_ADDRESS",
  "startedAt": "2025-12-06T19:31:12.147Z",
  "lastUpdated": "2025-12-06T19:49:07.626Z",
  "totalFees": "85192345",
  "entryCount": 33,
  "latestHash": "dbdb2c2320f9bddf...",
  "entries": [
    {
      "sequence": 1,
      "prevHash": "a1b2c3d4...",
      "eventType": "FEE",
      "vaultType": "BC",
      "vault": "VAULT_ADDRESS",
      "amount": "100000",
      "balanceBefore": "1640880",
      "balanceAfter": "1740880",
      "slot": 384931057,
      "timestamp": 1765049527355,
      "date": "2025-12-06T19:32:07.355Z",
      "hash": "c60d4ed93f68f412..."
    }
  ]
}
```

### Event Types

| Type | Description |
|------|-------------|
| `FEE` | Fee received (positive balance change) |
| `CLAIM` | Creator withdrawal (negative balance change) |

Claims are recorded in the history but NOT counted in `totalFees`.

## Options

```
--creator, -c <ADDRESS>   Creator wallet address (required)
--rpc, -r <URL>           RPC URL (default: mainnet)
--tokens, -t <FILE>       JSON file with token configs
--interval, -i <SECONDS>  Poll interval (default: 5)
--history, -H <FILE>      Enable Proof-of-History, save to FILE
--verify, -V <FILE>       Verify a Proof-of-History file
--verbose, -v             Verbose logging
--help, -h                Show help
```

## Token Config File

Track specific tokens with a JSON file:

```json
[
  {
    "mint": "TokenMintAddress...",
    "symbol": "MYTOKEN",
    "bondingCurve": "BCAddress...",
    "poolType": "bonding_curve"
  }
]
```

```bash
asdf-validator -c YOUR_ADDRESS -t tokens.json
```

## Programmatic Usage

```typescript
import { ValidatorDaemon } from 'asdf-validator';

const daemon = new ValidatorDaemon({
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  creatorAddress: 'YOUR_CREATOR_ADDRESS',
  historyFile: 'history.json',
  verbose: true,
  autoDiscover: true, // Enable auto token discovery (default: true)

  onTokenDiscovered: (token) => {
    console.log(`Discovered: ${token.bondingCurve.toBase58()}`);
    console.log(`  Migrated: ${token.migrated}`);
    console.log(`  Reserves: ${Number(token.realSolReserves) / 1e9} SOL`);
  },

  onFeeDetected: (record) => {
    console.log(`${record.symbol}: +${Number(record.amount) / 1e9} SOL`);
    console.log(`  Token: ${record.mint}`);
  },

  onHistoryEntry: (entry) => {
    console.log(`${entry.eventType} #${entry.sequence}: ${entry.hash}`);
    if (entry.mint) console.log(`  Token: ${entry.symbol}`);
  },

  onStats: (stats) => {
    const total = stats.reduce((sum, s) => sum + Number(s.totalFees), 0);
    console.log(`Total: ${total / 1e9} SOL`);
  },
});

await daemon.start();

// Later...
daemon.stop();
console.log(`Final total: ${daemon.getTotalFees()}`);

// Get the history log
const history = daemon.getHistoryLog();
console.log(`Recorded ${history.entryCount} events`);
```

### Verify History Programmatically

```typescript
import { loadHistoryLog, verifyHistoryChain } from 'asdf-validator';

const history = loadHistoryLog('history.json');
const result = verifyHistoryChain(history);

if (result.valid) {
  console.log('History verified!');
} else {
  console.log(`Failed at entry ${result.entryIndex}: ${result.error}`);
}
```

## API

### `ValidatorDaemon`

```typescript
new ValidatorDaemon(config: DaemonConfig)
```

#### Config

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `rpcUrl` | string | Yes | Solana RPC URL |
| `creatorAddress` | string | Yes | Creator wallet |
| `tokens` | TokenConfig[] | No | Tokens to track |
| `autoDiscover` | boolean | No | Auto-discover tokens (default: true) |
| `pollInterval` | number | No | Poll interval ms (default: 5000) |
| `verbose` | boolean | No | Enable logging |
| `historyFile` | string | No | Path to save PoH file |
| `onFeeDetected` | function | No | Fee callback |
| `onTokenDiscovered` | function | No | Token discovery callback |
| `onHistoryEntry` | function | No | PoH entry callback |
| `onStats` | function | No | Stats callback |
| `statsInterval` | number | No | Stats interval ms (default: 60000) |

#### Methods

| Method | Description |
|--------|-------------|
| `start()` | Start the daemon |
| `stop()` | Stop the daemon |
| `isRunning()` | Check if running |
| `getStats()` | Get current stats |
| `getTrackedTokens()` | Get all tracked tokens |
| `getTotalFees()` | Get total fees (bigint) |
| `getHistoryLog()` | Get the PoH log |
| `addToken(config)` | Add token to track |

### Utility Functions

```typescript
import {
  deriveBondingCurveVault,
  derivePumpSwapVault,
  deriveBondingCurve,
  deserializeBondingCurve,
  discoverCreatorTokens,
  loadHistoryLog,
  verifyHistoryChain,
  computeEntryHash,
  GENESIS_HASH,
} from 'asdf-validator';

// Get vault addresses for a creator
const bcVault = deriveBondingCurveVault(creatorPubkey);
const ammVault = derivePumpSwapVault(creatorPubkey);

// Derive bonding curve from mint
const bc = deriveBondingCurve(mintPubkey);

// Deserialize bonding curve data
const accountInfo = await connection.getAccountInfo(bc);
const bcData = deserializeBondingCurve(accountInfo.data);
console.log(`Creator: ${bcData.creator.toBase58()}`);
console.log(`Migrated: ${bcData.complete}`);
console.log(`Reserves: ${bcData.realSolReserves}`);

// Discover all tokens for a creator
const tokens = await discoverCreatorTokens(connection, creatorPubkey);
console.log(`Found ${tokens.length} tokens`);

// Load and verify a history file
const history = loadHistoryLog('history.json');
const result = verifyHistoryChain(history);
```

## Environment Variables

```bash
RPC_URL=https://my-rpc.com  # Default RPC URL
```

## Advanced Features

### Network Resilience

The daemon includes built-in network resilience features:

#### Retry with Exponential Backoff
RPC calls automatically retry on failure with exponential backoff:
- Default: 3 retries
- Base delay: 1 second (doubles each retry)
- Max delay: 10 seconds

```typescript
const daemon = new ValidatorDaemon({
  // ... other config
  retryConfig: {
    maxRetries: 5,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
  },
  onRpcError: (error, attempt) => {
    console.log(`RPC error on attempt ${attempt}: ${error.message}`);
  },
});
```

#### Circuit Breaker
Protects against cascade failures:
- Opens after 5 consecutive failures
- Auto-recovers after 60 seconds
- Prevents hammering a failing RPC

```typescript
// Check circuit state
const state = daemon.getCircuitState(); // 'CLOSED' | 'OPEN' | 'HALF_OPEN'

// Reset manually if needed
daemon.resetCircuitBreaker();
```

#### Health Check
RPC health is verified on startup (can be disabled):

```typescript
const daemon = new ValidatorDaemon({
  // ... other config
  enableHealthCheck: true, // default: true
});

// Manual health check
const health = await daemon.checkHealth(5000); // 5s timeout
if (!health.healthy) {
  console.error(`RPC unhealthy: ${health.error}`);
}
```

### Input Validation

All inputs are validated before use:

```typescript
import {
  validateRpcUrl,
  validateSolanaAddress,
  validateTokenConfig,
  validatePollInterval,
} from 'asdf-validator';

// Validate RPC URL
const urlResult = validateRpcUrl('https://api.mainnet-beta.solana.com');
if (!urlResult.valid) console.error(urlResult.error);

// Validate Solana address
const addrResult = validateSolanaAddress('11111111111111111111111111111111');
if (!addrResult.valid) console.error(addrResult.error);
```

### Performance Utilities

```typescript
import { LRUCache, RateLimiter, getMemoryUsage } from 'asdf-validator';

// LRU Cache with TTL
const cache = new LRUCache<string, number>(100, 5000); // 100 items, 5s TTL
cache.set('key', 123);
const value = cache.get('key'); // 123 or undefined if expired

// Rate limiter (token bucket)
const limiter = new RateLimiter(10, 2); // 10 tokens max, 2/sec refill
if (limiter.tryAcquire()) {
  // Make request
}

// Memory usage (MB)
const { heapUsed, heapTotal, rss } = getMemoryUsage();
```

## Troubleshooting

### Common Issues

#### "RPC health check failed"
The daemon couldn't connect to the RPC endpoint.

**Solutions:**
1. Check your internet connection
2. Verify the RPC URL is correct
3. Try a different RPC endpoint
4. Disable health check: `--no-health-check` or `enableHealthCheck: false`

#### "Invalid creator address"
The provided address is not a valid Solana address.

**Solutions:**
1. Verify the address is 32-44 characters long
2. Ensure it only contains base58 characters (no 0, O, I, l)
3. Copy the address directly from a wallet or explorer

#### "Circuit breaker is OPEN"
Too many RPC failures occurred.

**Solutions:**
1. Wait 60 seconds for auto-recovery
2. Reset manually: `daemon.resetCircuitBreaker()`
3. Check if the RPC endpoint is down
4. Switch to a backup RPC

#### High memory usage
The daemon accumulates data over long runs.

**Solutions:**
1. Enable periodic restarts (e.g., daily via cron)
2. Limit history entries in memory
3. Monitor with `getMemoryUsage()`

### Debugging

Enable verbose mode for detailed logs:

```bash
asdf-validator -c ADDRESS -v
```

Check internal state:
```typescript
console.log('Running:', daemon.isRunning());
console.log('Circuit:', daemon.getCircuitState());
console.log('Stats:', daemon.getStats());
console.log('Memory:', getMemoryUsage());
```

## Known Limitations

1. **Single creator per daemon** - Each daemon instance tracks one creator address. Run multiple instances for multiple creators.

2. **Polling-based** - Uses RPC polling (not WebSockets). Minimum resolution is the poll interval (default 5s).

3. **No historical backfill** - Only tracks events from daemon start. Past transactions are not retroactively fetched.

4. **Memory accumulation** - History entries accumulate in memory. For very long runs, consider periodic restarts.

5. **RPC dependency** - Requires reliable RPC access. Use quality RPC providers for production.

6. **No multi-sig support** - Designed for single-owner creator wallets.

7. **Solana only** - No support for other blockchains.

## FAQ

**Q: How accurate is fee tracking?**
A: The daemon detects balance changes at poll intervals. Very fast consecutive transactions may be aggregated into a single event.

**Q: Can I verify a history file offline?**
A: Yes! The `--verify` command only reads the JSON file and performs cryptographic verification locally.

**Q: What happens if the daemon crashes?**
A: Resume by restarting with the same `--history` file. The chain will continue from the last entry.

**Q: Is my RPC API key exposed?**
A: No, the API key stays local. History files only contain public blockchain data.

**Q: Can someone fake a history file?**
A: They cannot forge valid hashes. Each entry's hash depends on all previous entries, making tampering detectable.

**Q: How much disk space does history use?**
A: Approximately 500 bytes per entry. 1000 events ≈ 500KB.

**Q: Does this work with PumpSwap AMM?**
A: Yes! The daemon monitors both Bonding Curve and AMM creator vaults.

## Contributing

Issues and pull requests welcome at [GitHub](https://github.com/zeyxx/asdf-validator).

## License

MIT
