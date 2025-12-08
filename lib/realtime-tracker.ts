import { PublicKey, AccountInfo } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { WebSocketManager, AccountUpdate } from './websocket-manager';
import { RpcManager } from './rpc-manager';
import { TokenManager } from './token-manager';
import { HistoryManager } from './history-manager';
import {
  TrackedToken,
  TokenStats,
  FeeRecord,
  WSOL_MINT,
} from './utils';
import { getAssociatedTokenAddress } from '@solana/spl-token';

export interface RealtimeTrackerConfig {
  creator: PublicKey;
  bcVault: PublicKey;
  ammVault: PublicKey;
  rpcUrl: string;
  wsUrl?: string;
  onFeeDetected?: (record: FeeRecord) => void;
  onTokenDiscovered?: (token: TrackedToken) => void;
  onStats?: (stats: TokenStats[]) => void;
  onBalanceChange?: (vault: 'BC' | 'AMM', oldBalance: bigint, newBalance: bigint) => void;
  verbose?: boolean;
}

export interface BalanceSnapshot {
  bc: bigint;
  amm: bigint;
  timestamp: number;
  slot: number;
}

/**
 * Real-time fee tracker using WebSocket subscriptions
 * instead of polling
 */
export class RealtimeTracker extends EventEmitter {
  private wsManager: WebSocketManager;
  private rpcManager: RpcManager;
  private tokenManager: TokenManager;
  private historyManager?: HistoryManager;
  private ammVaultATA!: PublicKey;

  // State
  private running = false;
  private lastBcBalance: bigint = 0n;
  private lastAmmBalance: bigint = 0n;
  private totalBcFees: bigint = 0n;
  private totalAmmFees: bigint = 0n;
  private updateCount = 0;

  private trackedTokens: Map<string, TrackedToken> = new Map();
  private tokenStats: Map<string, TokenStats> = new Map();

  constructor(
    private config: RealtimeTrackerConfig,
    historyManager?: HistoryManager
  ) {
    super();
    this.historyManager = historyManager;

    // Create managers
    this.wsManager = new WebSocketManager({
      rpcUrl: config.rpcUrl,
      wsUrl: config.wsUrl,
    });

    this.rpcManager = new RpcManager(config.rpcUrl);
    this.tokenManager = new TokenManager(this.rpcManager);

    // Setup WebSocket event handlers
    this.setupWebSocketHandlers();
  }

  private setupWebSocketHandlers() {
    this.wsManager.on('connected', () => {
      this.log('WebSocket connected');
      this.emit('connected');
    });

    this.wsManager.on('disconnected', () => {
      this.log('WebSocket disconnected');
      this.emit('disconnected');
    });

    this.wsManager.on('error', (error) => {
      this.log(`WebSocket error: ${error}`);
      this.emit('error', error);
    });

    this.wsManager.on('reconnecting', ({ attempt, delayMs }) => {
      this.log(`Reconnecting (attempt ${attempt}) in ${delayMs}ms`);
      this.emit('reconnecting', { attempt, delayMs });
    });
  }

  private log(message: string) {
    if (this.config.verbose) {
      console.log(`[RealtimeTracker] ${message}`);
    }
  }

  addToken(token: TrackedToken) {
    this.trackedTokens.set(token.bondingCurve, token);
    if (!this.tokenStats.has(token.mint)) {
      this.tokenStats.set(token.mint, {
        mint: token.mint,
        symbol: token.symbol,
        totalFees: 0n,
        feeCount: 0,
        lastFeeTimestamp: 0,
        migrated: token.migrated,
      });
    }
  }

  getTrackedTokens(): TrackedToken[] {
    return Array.from(this.trackedTokens.values());
  }

  getStats(): TokenStats[] {
    return Array.from(this.tokenStats.values());
  }

  getTotalFees(): bigint {
    return this.totalBcFees + this.totalAmmFees;
  }

  getBalances(): BalanceSnapshot {
    return {
      bc: this.lastBcBalance,
      amm: this.lastAmmBalance,
      timestamp: Date.now(),
      slot: 0, // Will be updated from WebSocket context
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Derive AMM vault ATA
    this.ammVaultATA = await getAssociatedTokenAddress(
      WSOL_MINT,
      this.config.ammVault,
      true
    );

    // Get initial balances
    try {
      this.lastBcBalance = BigInt(
        await this.rpcManager.getBalance(this.config.bcVault)
      );
      this.lastAmmBalance = await this.rpcManager.getTokenAccountBalance(
        this.ammVaultATA
      );
      this.log(`Initial BC balance: ${this.lastBcBalance}`);
      this.log(`Initial AMM balance: ${this.lastAmmBalance}`);
    } catch (error) {
      this.log(`Failed to get initial balances: ${error}`);
    }

    // Connect WebSocket
    await this.wsManager.connect();

    // Subscribe to vault account changes
    await this.wsManager.subscribeToAccount(
      this.config.bcVault,
      (update) => this.handleBcUpdate(update)
    );

    await this.wsManager.subscribeToAccount(
      this.ammVaultATA,
      (update) => this.handleAmmUpdate(update)
    );

    this.running = true;
    this.log('RealtimeTracker started');
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    await this.wsManager.disconnect();
    this.log('RealtimeTracker stopped');
    this.emit('stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle BC vault account update
   */
  private handleBcUpdate(update: AccountUpdate) {
    this.updateCount++;
    const newBalance = BigInt(update.accountInfo.lamports);
    const delta = newBalance - this.lastBcBalance;

    this.log(`BC update #${this.updateCount}: ${this.lastBcBalance} -> ${newBalance} (delta: ${delta})`);

    if (delta > 0n) {
      // Fee received
      this.totalBcFees += delta;

      const record: FeeRecord = {
        mint: 'unknown', // Will be attributed later
        symbol: 'BC',
        amount: delta,
        timestamp: update.timestamp,
        slot: update.context.slot,
      };

      // Record in history
      if (this.historyManager) {
        this.historyManager.addEntry(
          'FEE',
          'BC',
          this.config.bcVault.toBase58(),
          delta,
          this.lastBcBalance,
          newBalance,
          update.context.slot,
          update.timestamp
        );
      }

      this.config.onFeeDetected?.(record);
      this.emit('feeDetected', record);
    } else if (delta < 0n) {
      // Claim/withdrawal
      this.log(`BC withdrawal detected: ${-delta} lamports`);

      if (this.historyManager) {
        this.historyManager.addEntry(
          'CLAIM',
          'BC',
          this.config.bcVault.toBase58(),
          delta,
          this.lastBcBalance,
          newBalance,
          update.context.slot,
          update.timestamp
        );
      }

      this.emit('claim', { vault: 'BC', amount: -delta, slot: update.context.slot });
    }

    this.config.onBalanceChange?.('BC', this.lastBcBalance, newBalance);
    this.lastBcBalance = newBalance;

    // Emit stats update
    if (this.config.onStats) {
      this.config.onStats(this.getStats());
    }
  }

  /**
   * Handle AMM vault account update (WSOL token account)
   */
  private handleAmmUpdate(update: AccountUpdate) {
    this.updateCount++;

    // Parse token account data to get balance
    // Token account data layout: mint (32) + owner (32) + amount (8) + ...
    const data = update.accountInfo.data;
    if (data.length < 72) {
      this.log('Invalid AMM account data');
      return;
    }

    const newBalance = data.readBigUInt64LE(64); // amount at offset 64
    const delta = newBalance - this.lastAmmBalance;

    this.log(`AMM update #${this.updateCount}: ${this.lastAmmBalance} -> ${newBalance} (delta: ${delta})`);

    if (delta > 0n) {
      // Fee received
      this.totalAmmFees += delta;

      const record: FeeRecord = {
        mint: 'unknown',
        symbol: 'AMM',
        amount: delta,
        timestamp: update.timestamp,
        slot: update.context.slot,
      };

      if (this.historyManager) {
        this.historyManager.addEntry(
          'FEE',
          'AMM',
          this.ammVaultATA.toBase58(),
          delta,
          this.lastAmmBalance,
          newBalance,
          update.context.slot,
          update.timestamp
        );
      }

      this.config.onFeeDetected?.(record);
      this.emit('feeDetected', record);
    } else if (delta < 0n) {
      // Claim/withdrawal
      this.log(`AMM withdrawal detected: ${-delta} lamports`);

      if (this.historyManager) {
        this.historyManager.addEntry(
          'CLAIM',
          'AMM',
          this.ammVaultATA.toBase58(),
          delta,
          this.lastAmmBalance,
          newBalance,
          update.context.slot,
          update.timestamp
        );
      }

      this.emit('claim', { vault: 'AMM', amount: -delta, slot: update.context.slot });
    }

    this.config.onBalanceChange?.('AMM', this.lastAmmBalance, newBalance);
    this.lastAmmBalance = newBalance;

    if (this.config.onStats) {
      this.config.onStats(this.getStats());
    }
  }

  /**
   * Get WebSocket manager for advanced usage
   */
  getWebSocketManager(): WebSocketManager {
    return this.wsManager;
  }

  /**
   * Get update count (for monitoring)
   */
  getUpdateCount(): number {
    return this.updateCount;
  }
}
