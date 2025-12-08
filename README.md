# ASDF Validator

Real-time fee tracking for Pump.fun token creators with cryptographic Proof-of-History.

## Features

- **Real-time tracking** via WebSocket (~400ms latency)
- **Per-token attribution** - know which token generated each fee
- **Auto-discovery** of all tokens from a creator wallet
- **Proof-of-History** - SHA-256 chain for verifiable fee records
- **Web Dashboard** - real-time visualization of fees
- **Dual vault monitoring** - Bonding Curve + AMM (PumpSwap)

## Installation

```bash
npm install
npm run build
```

## Quick Start

### CLI Daemon

```bash
# Run daemon for your creator address
npx ts-node cli.ts --creator YOUR_CREATOR_ADDRESS

# With Proof-of-History enabled
npx ts-node cli.ts -c YOUR_ADDRESS -H history.json -v

# Verify a history file
npx ts-node cli.ts --verify history.json

# Custom RPC
npx ts-node cli.ts -c YOUR_ADDRESS -r https://my-rpc.com
```

### Web Dashboard

```bash
# Start the dashboard
npx ts-node dashboard/server.ts YOUR_CREATOR_ADDRESS [RPC_URL] [PORT]

# Example
npx ts-node dashboard/server.ts 5zwN9NQei4fctQ8AfEk67PVoH1jSCSYCpfYkeamkpznj

# Open http://localhost:3000
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Web Dashboard                         │
│         Real-time stats, charts, per-token fees         │
└────────────────────────┬────────────────────────────────┘
                         │ WebSocket
┌────────────────────────▼────────────────────────────────┐
│                  Dashboard Server                        │
│              (Express + WebSocket Server)               │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                  RealtimeTracker                         │
│    WebSocket subscriptions + Transaction attribution    │
└────────────────────────┬────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   ┌──────────┐   ┌───────────┐   ┌─────────────┐
   │ RpcManager│   │TokenManager│   │HistoryManager│
   │ (Solana)  │   │ (Metaplex) │   │   (PoH)     │
   └──────────┘   └───────────┘   └─────────────┘
```

## Project Structure

```
asdf-validator/
├── cli.ts                 # CLI entry point
├── daemon.ts              # ValidatorDaemon exports
├── index.ts               # SDK for programmatic use
├── lib/
│   ├── fee-tracker.ts     # Polling-based fee tracker
│   ├── realtime-tracker.ts # WebSocket-based tracker
│   ├── history-manager.ts # Proof-of-History chain
│   ├── token-manager.ts   # Token discovery & metadata
│   ├── rpc-manager.ts     # RPC with retry & circuit breaker
│   ├── websocket-manager.ts # WebSocket subscriptions
│   └── utils.ts           # Types, constants, utilities
├── dashboard/
│   ├── server.ts          # Dashboard Express server
│   └── public/
│       ├── index.html     # Dashboard UI
│       ├── app.js         # Frontend logic
│       └── style.css      # Styles
├── tests/                 # Jest test suite
├── package.json
├── tsconfig.json
└── README.md
```

## How It Works

### Fee Detection

1. **WebSocket subscription** to creator vault accounts (BC + AMM)
2. **Balance change** detected in real-time
3. **Transaction fetch** to find the token mint
4. **Attribution** to specific token or marked as "orphan"
5. **PoH record** with SHA-256 chain linking

### Token Attribution Flow

```
Vault balance change detected
         ↓
Fetch recent transaction at slot
         ↓
Parse preTokenBalances / postTokenBalances
         ↓
Extract token mint (not WSOL)
         ↓
Match to tracked token or discover new
         ↓
Update per-token stats
         ↓
Emit FeeRecord with mint & symbol
```

### Proof-of-History

Each fee event is recorded with:
- SHA-256 hash of entry data
- Link to previous entry hash
- Sequence number for ordering
- Timestamp and slot for verification

```json
{
  "sequence": 42,
  "hash": "a1b2c3...",
  "prevHash": "x9y8z7...",
  "eventType": "FEE",
  "vault": "BC",
  "amount": "1000000",
  "mint": "TokenMint123...",
  "symbol": "DOGE"
}
```

## API Reference

### ValidatorDaemon

```typescript
import { ValidatorDaemon } from './daemon';

const daemon = new ValidatorDaemon({
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  creatorAddress: 'YOUR_CREATOR_ADDRESS',
  autoDiscover: true,
  historyFile: 'history.json',
  onFeeDetected: (record) => {
    console.log(`Fee: ${record.amount} from ${record.symbol}`);
  },
});

await daemon.start();
```

### RealtimeTracker

```typescript
import { RealtimeTracker } from './lib/realtime-tracker';

const tracker = new RealtimeTracker({
  creator: creatorPubkey,
  bcVault: bcVaultPubkey,
  ammVault: ammVaultPubkey,
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  onFeeDetected: (record) => console.log(record),
  onBalanceChange: (vault, old, new_) => console.log(vault, old, new_),
});

await tracker.start();
```

## Environment Variables

```bash
# .env
RPC_URL=https://api.mainnet-beta.solana.com
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage
```

## License

MIT
