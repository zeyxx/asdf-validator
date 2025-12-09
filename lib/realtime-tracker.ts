import { PublicKey, AccountInfo, VersionedTransactionResponse } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { WebSocketManager, AccountUpdate } from './websocket-manager';
import { RpcManager } from './rpc-manager';
import { TokenManager, deriveBondingCurve, deriveAMMPool } from './token-manager';
import { HistoryManager } from './history-manager';
import {
  TrackedToken,
  TokenStats,
  FeeRecord,
  WSOL_MINT,
  deserializeBondingCurve,
  getAssociatedTokenAddress,
} from './utils';

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
  private ammVaultATA: PublicKey | null = null;

  // State
  private running = false;
  private lastBcBalance: bigint = 0n;
  private lastAmmBalance: bigint = 0n;
  private totalBcFees: bigint = 0n;
  private totalAmmFees: bigint = 0n;
  private updateCount = 0;

  private trackedTokens: Map<string, TrackedToken> = new Map();
  private tokenStats: Map<string, TokenStats> = new Map();

  // Limits to prevent unbounded growth
  private static readonly MAX_TRACKED_TOKENS = 500;
  private static readonly MAX_TOKEN_STATS = 1000;

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
    // Evict oldest entry if at capacity (LRU based on insertion order)
    if (this.trackedTokens.size >= RealtimeTracker.MAX_TRACKED_TOKENS && !this.trackedTokens.has(token.bondingCurve)) {
      const oldestKey = this.trackedTokens.keys().next().value;
      if (oldestKey) this.trackedTokens.delete(oldestKey);
    }

    this.trackedTokens.set(token.bondingCurve, token);

    if (!this.tokenStats.has(token.mint)) {
      // Evict oldest stats entry if at capacity
      if (this.tokenStats.size >= RealtimeTracker.MAX_TOKEN_STATS) {
        const oldestKey = this.tokenStats.keys().next().value;
        if (oldestKey) this.tokenStats.delete(oldestKey);
      }

      this.tokenStats.set(token.mint, {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        totalFees: 0n,
        feeCount: 0,
        lastFeeTimestamp: 0,
        migrated: token.migrated,
      });
    }
  }

  /**
   * Update token stats with LRU refresh (moves entry to end of Map)
   */
  private updateTokenStats(mint: string, update: (stats: TokenStats) => void): void {
    const stats = this.tokenStats.get(mint);
    if (stats) {
      update(stats);
      // Refresh LRU order: delete and re-insert to move to end
      this.tokenStats.delete(mint);
      this.tokenStats.set(mint, stats);
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

    // Cleanup: Remove all EventEmitter listeners to prevent memory leaks
    // Must be after emit('stopped') so listeners can handle it
    this.removeAllListeners();
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Attribute a fee to a specific token by fetching and parsing the transaction
   * Improved: higher signature limit, wider slot tolerance, retry mechanism
   */
  private async attributeFee(
    vaultType: 'BC' | 'AMM',
    slot: number,
    amount: bigint,
    retryCount: number = 0
  ): Promise<{ mint: string; symbol: string }> {
    const MAX_RETRIES = 2;
    const SIGNATURE_LIMIT = 20; // Increased from 5
    const SLOT_TOLERANCE = 5;   // Increased from 2

    try {
      const vault = vaultType === 'BC' ? this.config.bcVault : this.ammVaultATA!;

      // Fetch recent signatures for the vault
      const signatures = await this.rpcManager.getSignaturesForAddress(vault, { limit: SIGNATURE_LIMIT });

      if (signatures.length === 0) {
        // Retry after delay if no signatures found
        if (retryCount < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500));
          return this.attributeFee(vaultType, slot, amount, retryCount + 1);
        }
        return { mint: 'orphan', symbol: 'ORPHAN' };
      }

      // Find transaction at or near this slot (wider tolerance)
      for (const sig of signatures) {
        if (Math.abs(sig.slot - slot) <= SLOT_TOLERANCE) {
          const tx = await this.rpcManager.getTransaction(sig.signature);
          if (!tx) continue;

          // Extract mints from token balances
          const balances = [
            ...(tx.meta?.preTokenBalances || []),
            ...(tx.meta?.postTokenBalances || [])
          ];

          for (const b of balances) {
            if (b.mint && b.mint !== WSOL_MINT.toBase58()) {
              // Check if we're already tracking this token
              const stats = this.tokenStats.get(b.mint);
              if (stats) {
                return { mint: b.mint, symbol: stats.symbol };
              }

              // Try to discover and add this token
              const newToken = await this.discoverToken(b.mint);
              if (newToken) {
                return { mint: b.mint, symbol: newToken.symbol };
              }
            }
          }
        }
      }

      // No match found - retry after delay
      if (retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 300));
        return this.attributeFee(vaultType, slot, amount, retryCount + 1);
      }
    } catch (error) {
      this.log(`Attribution error: ${error}`);
      // Retry on error
      if (retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500));
        return this.attributeFee(vaultType, slot, amount, retryCount + 1);
      }
    }

    return { mint: 'orphan', symbol: 'ORPHAN' };
  }

  /**
   * Try to discover and add a token from its mint
   */
  private async discoverToken(mintStr: string): Promise<TrackedToken | null> {
    try {
      const mint = new PublicKey(mintStr);
      const bondingCurve = deriveBondingCurve(mint);

      // Check if this bonding curve belongs to our creator
      const bcInfo = await this.rpcManager.getAccountInfo(bondingCurve);
      if (!bcInfo || bcInfo.data.length < 100) {
        return null;
      }

      // Deserialize bonding curve data
      const bcData = deserializeBondingCurve(bcInfo.data);
      if (!bcData || !bcData.creator.equals(this.config.creator)) {
        return null; // Not our creator's token
      }

      // Fetch token metadata (name, symbol) from Metaplex
      const metadata = await this.tokenManager.fetchMetadata(mint);
      const symbol = metadata?.symbol || mintStr.substring(0, 6);
      const name = metadata?.name || symbol;

      const ammPool = deriveAMMPool(mint);

      const token: TrackedToken = {
        mint: mintStr,
        symbol,
        name,
        bondingCurve: bondingCurve.toBase58(),
        ammPool: ammPool.toBase58(),
        migrated: bcData.complete,
        lastSolReserves: bcData.realSolReserves,
        lastAmmReserves: 0n,
        totalFees: 0n,
        feeCount: 0,
        recentAmmFees: 0n,
        recentAmmFeesTimestamp: Date.now(),
        recentBcFees: 0n,
        recentBcFeesTimestamp: Date.now(),
        isMayhemMode: false,
        tokenProgram: 'TOKEN',
      };

      this.addToken(token);
      this.log(`Discovered new token: ${symbol} - ${name} (${mintStr})`);
      try {
        this.config.onTokenDiscovered?.(token);
      } catch (err) {
        this.log(`onTokenDiscovered callback error: ${err}`);
      }

      return token;
    } catch (error) {
      this.log(`Token discovery failed for ${mintStr}: ${error}`);
      return null;
    }
  }

  /**
   * Handle BC vault account update
   */
  private async handleBcUpdate(update: AccountUpdate) {
    this.updateCount++;
    const newBalance = BigInt(update.accountInfo.lamports);
    const delta = newBalance - this.lastBcBalance;

    this.log(`BC update #${this.updateCount}: ${this.lastBcBalance} -> ${newBalance} (delta: ${delta})`);

    if (delta > 0n) {
      // Fee received - attribute to token
      this.totalBcFees += delta;

      const { mint, symbol } = await this.attributeFee('BC', update.context.slot, delta);

      // Update token stats with LRU refresh
      if (mint !== 'orphan') {
        this.updateTokenStats(mint, (stats) => {
          stats.totalFees += delta;
          stats.feeCount++;
          stats.lastFeeTimestamp = update.timestamp;
        });
      }

      const record: FeeRecord = {
        mint,
        symbol,
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
          update.timestamp,
          mint !== 'orphan' ? mint : undefined,
          mint !== 'orphan' ? symbol : undefined
        );
      }

      try {
        this.config.onFeeDetected?.(record);
      } catch (err) {
        this.log(`onFeeDetected callback error: ${err}`);
      }
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

    try {
      this.config.onBalanceChange?.('BC', this.lastBcBalance, newBalance);
    } catch (err) {
      this.log(`onBalanceChange callback error: ${err}`);
    }
    this.lastBcBalance = newBalance;

    // Emit stats update
    if (this.config.onStats) {
      try {
        this.config.onStats(this.getStats());
      } catch (err) {
        this.log(`onStats callback error: ${err}`);
      }
    }
  }

  /**
   * Handle AMM vault account update (WSOL token account)
   */
  private async handleAmmUpdate(update: AccountUpdate) {
    this.updateCount++;

    // Parse token account data to get balance
    // Token account data layout: mint (32) + owner (32) + amount (8) + ...
    const data = update.accountInfo.data;
    if (!Buffer.isBuffer(data) || data.length < 72) {
      this.log(`Invalid AMM account data: expected >= 72 bytes, got ${data?.length || 0}`);
      return;
    }

    let newBalance: bigint;
    try {
      newBalance = data.readBigUInt64LE(64); // amount at offset 64
    } catch (err) {
      this.log(`Failed to parse AMM balance: ${err}`);
      return;
    }
    const delta = newBalance - this.lastAmmBalance;

    this.log(`AMM update #${this.updateCount}: ${this.lastAmmBalance} -> ${newBalance} (delta: ${delta})`);

    if (delta > 0n) {
      // Fee received - attribute to token
      this.totalAmmFees += delta;

      const { mint, symbol } = await this.attributeFee('AMM', update.context.slot, delta);

      // Update token stats with LRU refresh
      if (mint !== 'orphan') {
        this.updateTokenStats(mint, (stats) => {
          stats.totalFees += delta;
          stats.feeCount++;
          stats.lastFeeTimestamp = update.timestamp;
        });
      }

      const record: FeeRecord = {
        mint,
        symbol,
        amount: delta,
        timestamp: update.timestamp,
        slot: update.context.slot,
      };

      if (this.historyManager) {
        this.historyManager.addEntry(
          'FEE',
          'AMM',
          this.ammVaultATA!.toBase58(),
          delta,
          this.lastAmmBalance,
          newBalance,
          update.context.slot,
          update.timestamp,
          mint !== 'orphan' ? mint : undefined,
          mint !== 'orphan' ? symbol : undefined
        );
      }

      try {
        this.config.onFeeDetected?.(record);
      } catch (err) {
        this.log(`onFeeDetected callback error: ${err}`);
      }
      this.emit('feeDetected', record);
    } else if (delta < 0n) {
      // Claim/withdrawal
      this.log(`AMM withdrawal detected: ${-delta} lamports`);

      if (this.historyManager) {
        this.historyManager.addEntry(
          'CLAIM',
          'AMM',
          this.ammVaultATA!.toBase58(),
          delta,
          this.lastAmmBalance,
          newBalance,
          update.context.slot,
          update.timestamp
        );
      }

      this.emit('claim', { vault: 'AMM', amount: -delta, slot: update.context.slot });
    }

    try {
      this.config.onBalanceChange?.('AMM', this.lastAmmBalance, newBalance);
    } catch (err) {
      this.log(`onBalanceChange callback error: ${err}`);
    }
    this.lastAmmBalance = newBalance;

    if (this.config.onStats) {
      try {
        this.config.onStats(this.getStats());
      } catch (err) {
        this.log(`onStats callback error: ${err}`);
      }
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
