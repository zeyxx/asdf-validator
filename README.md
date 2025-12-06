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

1. Monitors your creator vault(s) for balance changes
2. Detects fee accumulation from trading activity
3. Detects creator claims (withdrawals)
4. Creates cryptographic proof for each event (Proof-of-History)
5. Reports stats every 60 seconds

```
🔥 ASDF VALIDATOR DAEMON
═══════════════════════════════════════════════════════
Creator:    5ABC...xyz
BC Vault:   7DEF...uvw
AMM Vault:  9GHI...rst
PoH:        history.json ✓
═══════════════════════════════════════════════════════

▶ Starting daemon...

✅ Daemon running. Press Ctrl+C to stop.

[12:34:56] 💰 BC: +0.001234 SOL
         🔗 Hash: c60d4ed93f68f412... (FEE #1)
[12:35:12] 💰 BC: +0.000567 SOL
         🔗 Hash: a164dd0b776b4f01... (FEE #2)
[12:36:00] BC: CLAIM -0.001500 SOL
         📤 Hash: 36cebdd9bd27d8c0... (CLAIM #3)

📊 STATS
────────────────────────────────────
Total: 0.001801 SOL
────────────────────────────────────
```

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

  onFeeDetected: (record) => {
    console.log(`${record.symbol}: +${record.amount} lamports`);
  },

  onHistoryEntry: (entry) => {
    console.log(`${entry.eventType} #${entry.sequence}: ${entry.hash}`);
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
| `pollInterval` | number | No | Poll interval ms (default: 5000) |
| `verbose` | boolean | No | Enable logging |
| `historyFile` | string | No | Path to save PoH file |
| `onFeeDetected` | function | No | Fee callback |
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
| `getTotalFees()` | Get total fees (bigint) |
| `getHistoryLog()` | Get the PoH log |
| `addToken(config)` | Add token to track |

### Utility Functions

```typescript
import {
  deriveBondingCurveVault,
  derivePumpSwapVault,
  loadHistoryLog,
  verifyHistoryChain,
  computeEntryHash,
  GENESIS_HASH,
} from 'asdf-validator';

// Get vault addresses for a creator
const bcVault = deriveBondingCurveVault(creatorPubkey);
const ammVault = derivePumpSwapVault(creatorPubkey);

// Load and verify a history file
const history = loadHistoryLog('history.json');
const result = verifyHistoryChain(history);
```

## Environment Variables

```bash
RPC_URL=https://my-rpc.com  # Default RPC URL
```

## License

MIT
