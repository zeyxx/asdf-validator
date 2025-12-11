# ASDF Validator

Real-time fee tracking for Pump.fun token creators. Yes, another crypto tool. No, we're not sorry.

## What does it do?

It watches your Pump.fun fees in real-time. That's it. That's the whole thing.

- **Real-time tracking** - WebSocket magic, ~400ms latency (faster than your regrets)
- **Per-token attribution** - know exactly which token made you money (or didn't)
- **Auto-discovery** - finds all your tokens automatically because we're not savages
- **Proof-of-History** - SHA-256 chain, sounds fancy, works great
- **Web Dashboard** - pretty charts for pretty people
- **Dual vault monitoring** - Bonding Curve + AMM, because one vault is never enough

## Installation

```bash
npm install
npm run build
```

Congrats, you did it.

## Usage

### CLI Daemon

```bash
# Basic usage
npx ts-node cli.ts --creator YOUR_CREATOR_ADDRESS

# With Proof-of-History (for the paranoid)
npx ts-node cli.ts -c YOUR_ADDRESS -H history.json -v

# Verify a history file (trust but verify, right?)
npx ts-node cli.ts --verify history.json

# Custom RPC (if you're fancy like that)
npx ts-node cli.ts -c YOUR_ADDRESS -r https://my-rpc.com
```

### Web Dashboard

```bash
npx ts-node dashboard/server.ts YOUR_CREATOR_ADDRESS [RPC_URL] [PORT]

# Example
npx ts-node dashboard/server.ts 5zwN9NQei4fctQ8AfEk67PVoH1jSCSYCpfYkeamkpznj

# Open http://localhost:3000 and enjoy the vibes
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

It's boxes and arrows. It works. Don't overthink it.

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
│   └── public/            # Frontend stuff
├── tests/                 # We have tests. They pass. Mostly.
└── README.md              # You are here
```

## How It Works

### Fee Detection

1. WebSocket subscription to vault accounts
2. Balance changes? We see them. In real-time.
3. Fetch the transaction, find the token
4. Attribute the fee (or mark it as orphan, life is unfair)
5. Record it with PoH because blockchain means trust no one

### Token Attribution Flow

```
Vault balance change detected
         ↓
Fetch transaction at slot
         ↓
Parse token balances (before/after)
         ↓
Extract token mint (skip WSOL, obviously)
         ↓
Match to tracked token or discover new one
         ↓
Update stats, emit record, move on with life
```

### Proof-of-History

Each fee event is chained with SHA-256. Tamper with one record and the whole chain screams at you.

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
// It's running. Go touch grass.
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

Keep your secrets secret. We don't log API keys because we're not monsters.

## Testing

```bash
npm test           # Run tests
npm run test:coverage  # Run with coverage (for the completionists)
```

## License

MIT - Do whatever you want. This is fine.
