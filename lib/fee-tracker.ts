import { PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { RpcManager } from './rpc-manager';
import { TokenManager, deriveBondingCurve, deriveAMMPool } from './token-manager';
import { HistoryManager } from './history-manager';
import {
  TrackedToken,
  TokenStats,
  FeeRecord,
  WSOL_MINT,
  deserializeBondingCurve,
  getMemoryUsage,
  fetchWithRetry
} from './utils';
import { getAssociatedTokenAddress } from '@solana/spl-token';

export interface FeeTrackerConfig {
  creator: PublicKey;
  bcVault: PublicKey;
  ammVault: PublicKey;
  pollIntervalMs: number;
  stateFile?: string;
  onFeeDetected?: (record: FeeRecord) => void;
  onTokenDiscovered?: (token: TrackedToken) => void;
  onStats?: (stats: TokenStats[]) => void;
  verbose?: boolean;
}

interface TrackerState {
  lastBcSignature: string | null;
  lastAmmSignature: string | null;
  lastBcBalance: string; // BigInt as string
  lastAmmBalance: string; // BigInt as string
  accumulatedBcDelta: string; // BigInt as string
  accumulatedAmmDelta: string; // BigInt as string
  totalOrphanFees: string; // BigInt as string
  trackedTokens: Record<string, any>; // Simplified serialization
}

export interface StateValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate TrackerState schema
 */
function validateTrackerState(data: unknown): StateValidationResult {
  if (typeof data !== 'object' || data === null) {
    return { valid: false, error: 'State must be an object' };
  }

  const state = data as Record<string, unknown>;

  // Validate bigint string fields
  const bigintFields = ['lastBcBalance', 'lastAmmBalance'];
  for (const field of bigintFields) {
    if (state[field] !== undefined) {
      const val = state[field];
      if (typeof val !== 'string') {
        return { valid: false, error: `${field} must be a string` };
      }
      try {
        BigInt(val);
      } catch {
        return { valid: false, error: `${field} must be a valid bigint string` };
      }
    }
  }

  // Optional bigint fields (added later, backwards compatible)
  const optionalBigintFields = ['accumulatedBcDelta', 'accumulatedAmmDelta', 'totalOrphanFees'];
  for (const field of optionalBigintFields) {
    if (state[field] !== undefined) {
      const val = state[field];
      if (typeof val !== 'string') {
        return { valid: false, error: `${field} must be a string` };
      }
      try {
        BigInt(val);
      } catch {
        return { valid: false, error: `${field} must be a valid bigint string` };
      }
    }
  }

  // trackedTokens must be an object if present
  if (state.trackedTokens !== undefined && typeof state.trackedTokens !== 'object') {
    return { valid: false, error: 'trackedTokens must be an object' };
  }

  return { valid: true };
}

/**
 * Create backup of state file with rotation
 */
function createStateBackup(stateFile: string, maxBackups: number = 3): void {
  if (!fs.existsSync(stateFile)) return;

  const dir = path.dirname(stateFile);
  const base = path.basename(stateFile);
  const backupPath = path.join(dir, `${base}.backup.${Date.now()}`);

  // Create new backup
  fs.copyFileSync(stateFile, backupPath);

  // Rotate old backups
  const backupFiles = fs.readdirSync(dir)
    .filter(f => f.startsWith(`${base}.backup.`))
    .sort()
    .reverse();

  // Remove excess backups
  for (let i = maxBackups; i < backupFiles.length; i++) {
    fs.unlinkSync(path.join(dir, backupFiles[i]));
  }
}

export class FeeTracker {
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private ammVaultATA!: PublicKey;

  // State
  private lastBcSignature: string | null = null;
  private lastAmmSignature: string | null = null;
  private lastBcBalance: bigint = 0n;
  private lastAmmBalance: bigint = 0n;
  private accumulatedBcDelta: bigint = 0n;
  private accumulatedAmmDelta: bigint = 0n;
  private totalOrphanFees: bigint = 0n;
  private pollCount: number = 0;

  // Idempotency protection - track processed signatures
  private processedSignatures: Set<string> = new Set();
  private static readonly MAX_PROCESSED_SIGNATURES = 10000;

  private trackedTokens: Map<string, TrackedToken> = new Map();
  private tokenStats: Map<string, TokenStats> = new Map();

  constructor(
    private config: FeeTrackerConfig,
    private rpcManager: RpcManager,
    private tokenManager: TokenManager,
    private historyManager?: HistoryManager
  ) {}

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
    let total = 0n;
    for (const s of this.tokenStats.values()) {
      total += s.totalFees;
    }
    return total + this.totalOrphanFees;
  }

  getOrphanFees(): bigint {
    return this.totalOrphanFees;
  }

  async fetchCurrentBalances(): Promise<{ bc: bigint; amm: bigint }> {
    const bc = BigInt(await this.rpcManager.getBalance(this.config.bcVault));
    const amm = await this.rpcManager.getTokenAccountBalance(this.ammVaultATA);
    return { bc, amm };
  }

  async start() {
    if (this.running) return;
    
    // Derive ATA
    this.ammVaultATA = await getAssociatedTokenAddress(
      WSOL_MINT,
      this.config.ammVault,
      true
    );

    // Load state if exists
    if (this.config.stateFile && fs.existsSync(this.config.stateFile)) {
      try {
        // Create backup before loading (rotation: keep last 3)
        createStateBackup(this.config.stateFile, 3);
        this.log('State backup created');

        const rawData = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf-8'));

        // Validate state schema
        const validation = validateTrackerState(rawData);
        if (!validation.valid) {
          console.warn(`State validation failed: ${validation.error}. Using default state.`);
          // Don't restore invalid state - use defaults
        } else {
          const data = rawData as TrackerState;
          this.lastBcSignature = data.lastBcSignature;
          this.lastAmmSignature = data.lastAmmSignature;
          this.lastBcBalance = BigInt(data.lastBcBalance);
          this.lastAmmBalance = BigInt(data.lastAmmBalance);
          // Restore accumulated deltas and orphan fees (new fields, backwards compatible)
          this.accumulatedBcDelta = data.accumulatedBcDelta ? BigInt(data.accumulatedBcDelta) : 0n;
          this.accumulatedAmmDelta = data.accumulatedAmmDelta ? BigInt(data.accumulatedAmmDelta) : 0n;
          this.totalOrphanFees = data.totalOrphanFees ? BigInt(data.totalOrphanFees) : 0n;
          this.log(`State restored: BC=${this.lastBcBalance}, AMM=${this.lastAmmBalance}, orphan=${this.totalOrphanFees}`);
        }
      } catch (e) {
        console.warn('Failed to load state file:', e);
      }
    }

    // Initial balance fetch
    try {
      this.lastBcBalance = BigInt(await this.rpcManager.getBalance(this.config.bcVault));
      this.lastAmmBalance = await this.rpcManager.getTokenAccountBalance(this.ammVaultATA);
    } catch {
      // Ignore initial errors
    }

    this.running = true;
    this.log('FeeTracker started');
    this.schedulePoll();
  }

  stop() {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.saveState();
  }

  isRunning(): boolean {
    return this.running;
  }

  private schedulePoll() {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.poll();
      } catch (e) {
        console.error('Poll error:', e);
      } finally {
        this.schedulePoll();
      }
    }, this.config.pollIntervalMs);
  }

  private async poll() {
    const slot = await this.rpcManager.getConnection().getSlot().catch(() => 0);
    const timestamp = Date.now();
    this.pollCount++;

    // 0. Retry Metadata for UNKNOWN tokens (every 60 polls)
    if (this.pollCount % 60 === 0) {
      for (const token of this.trackedTokens.values()) {
        if (token.symbol === 'UNKNOWN') {
          this.tokenManager.fetchMetadata(new PublicKey(token.mint)).then(metadata => {
            if (metadata) {
              token.symbol = metadata.symbol;
              const stats = this.tokenStats.get(token.mint);
              if (stats) stats.symbol = metadata.symbol;
              this.log(`Fetched metadata for ${token.mint}: ${metadata.symbol}`);
            }
          }).catch((err) => {
            this.log(`Failed to fetch metadata for ${token.mint}: ${err.message || err}`);
          });
        }
      }
    }

    // 1. Refresh BC reserves (Batch)
    const updates = await this.tokenManager.refreshBondingCurves(
      Array.from(this.trackedTokens.values()).map(t => ({
        bondingCurve: t.bondingCurve,
        migrated: t.migrated
      }))
    );

    const tokenDeltas = new Map<string, bigint>();

    for (const [bc, update] of updates) {
      const token = this.trackedTokens.get(bc);
      if (token) {
        // Check migration
        if (update.migrated && !token.migrated) {
          token.migrated = true;
          this.tokenStats.get(token.mint)!.migrated = true;
          this.log(`Token ${token.symbol} migrated to AMM`);
        }

        // Calculate delta
        const delta = update.reserves - token.lastSolReserves;
        if (delta !== 0n) {
          tokenDeltas.set(bc, delta > 0n ? delta : -delta);
        }
        token.lastSolReserves = update.reserves;
      }
    }

    // 2. Poll Transactions
    const bcResult = await this.pollTransactions('BC', this.config.bcVault, this.lastBcSignature);
    this.lastBcSignature = bcResult.latestSignature || this.lastBcSignature;
    this.accumulatedBcDelta += bcResult.netDelta;

    const ammResult = await this.pollTransactions('AMM', this.ammVaultATA, this.lastAmmSignature);
    this.lastAmmSignature = ammResult.latestSignature || this.lastAmmSignature;
    this.accumulatedAmmDelta += ammResult.netDelta;

    // 3. Attribute Fees
    await this.processVault('BC', this.config.bcVault, bcResult, tokenDeltas, slot, timestamp);
    await this.processVault('AMM', this.ammVaultATA, ammResult, tokenDeltas, slot, timestamp); // AMM logic differs slightly (WSOL)

    // 3.5 Check Balance Consistency
    await this.checkBalanceConsistency(slot, timestamp, tokenDeltas);

    // 4. Save state
    this.saveState();

    if (this.config.onStats) {
      this.config.onStats(this.getStats());
    }
  }

  private async pollTransactions(
    type: 'BC' | 'AMM',
    address: PublicKey,
    lastSignature: string | null
  ): Promise<{ 
    attributed: Map<string, bigint>; 
    unattributed: bigint; 
    latestSignature: string | null;
    netDelta: bigint;
  }> {
    const attributed = new Map<string, bigint>();
    let unattributed = 0n;
    let netDelta = 0n;

    // Fetch all signatures since last one
    let signatures: string[] = [];
    if (lastSignature) {
      signatures = await this.rpcManager.getAllSignaturesSince(address, lastSignature, 100000);
    } else {
      // First run: just get latest
      const latest = await this.rpcManager.getAllSignaturesSince(address, '', 1);
      if (latest.length > 0) {
        return { attributed, unattributed, latestSignature: latest[0], netDelta: 0n };
      }
      return { attributed, unattributed, latestSignature: null, netDelta: 0n };
    }

    if (signatures.length === 0) {
      return { attributed, unattributed, latestSignature: lastSignature, netDelta: 0n };
    }

    const latestSignature = signatures[0];
    const connection = this.rpcManager.getConnection();

    // Process transactions in chronological order (reverse)
    for (const sig of signatures.reverse()) {
      // Idempotency check - skip already processed signatures
      if (this.processedSignatures.has(sig)) {
        if (this.config.verbose) console.log(`Skipping already processed signature: ${sig}`);
        continue;
      }

      try {
        const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        if (!tx || !tx.meta) continue;

        // Mark as processed (before any processing to prevent race conditions)
        this.processedSignatures.add(sig);

        // FIFO eviction if Set is too large
        if (this.processedSignatures.size > FeeTracker.MAX_PROCESSED_SIGNATURES) {
          const iterator = this.processedSignatures.values();
          const oldest = iterator.next().value;
          if (oldest) this.processedSignatures.delete(oldest);
        }

        const feeAmount = this.calculateFeeAmount(type, address, tx);
        netDelta += feeAmount;

        if (feeAmount <= 0n) continue;

        // Attribute
        const attribution = await this.attributeTransaction(type, tx, feeAmount);
        if (attribution.attributedTo) {
          const current = attributed.get(attribution.attributedTo) || 0n;
          attributed.set(attribution.attributedTo, current + feeAmount);
        } else {
          unattributed += feeAmount;
        }

      } catch (e) {
        // Log error but continue
        if (this.config.verbose) console.warn(`Error processing tx ${sig}:`, e);
      }
    }

    return { attributed, unattributed, latestSignature, netDelta };
  }

  private calculateFeeAmount(
    type: 'BC' | 'AMM',
    vaultAddress: PublicKey,
    tx: VersionedTransactionResponse
  ): bigint {
    const vaultStr = vaultAddress.toBase58();
    const accountKeys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58());
    // Add loaded keys
    if (tx.meta?.loadedAddresses) {
      accountKeys.push(...tx.meta.loadedAddresses.writable.map(k => k.toBase58()));
      accountKeys.push(...tx.meta.loadedAddresses.readonly.map(k => k.toBase58()));
    }

    if (type === 'BC') {
      // Native SOL balance change
      const index = accountKeys.indexOf(vaultStr);
      if (index === -1) return 0n;
      const pre = BigInt(tx.meta!.preBalances[index]);
      const post = BigInt(tx.meta!.postBalances[index]);
      return post - pre;
    } else {
      // Token balance change (WSOL)
      const preList = tx.meta!.preTokenBalances || [];
      const postList = tx.meta!.postTokenBalances || [];
      
      const pre = preList.find(b => accountKeys[b.accountIndex] === vaultStr);
      const post = postList.find(b => accountKeys[b.accountIndex] === vaultStr);

      const preAmount = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
      const postAmount = post ? BigInt(post.uiTokenAmount.amount) : 0n;
      return postAmount - preAmount;
    }
  }

  private async attributeTransaction(
    type: 'BC' | 'AMM',
    tx: VersionedTransactionResponse,
    amount: bigint
  ): Promise<{ attributedTo?: string }> {
    const accountKeys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58());
    if (tx.meta?.loadedAddresses) {
      accountKeys.push(...tx.meta.loadedAddresses.writable.map(k => k.toBase58()));
      accountKeys.push(...tx.meta.loadedAddresses.readonly.map(k => k.toBase58()));
    }

    const txMints = new Set<string>();
    const balances = [...(tx.meta?.preTokenBalances || []), ...(tx.meta?.postTokenBalances || [])];
    for (const b of balances) {
      if (b.mint && b.mint !== WSOL_MINT.toBase58()) txMints.add(b.mint);
    }

    // Check tracked tokens
    for (const token of this.trackedTokens.values()) {
      // Key match
      if (accountKeys.includes(token.bondingCurve) || accountKeys.includes(token.mint) || 
          (token.ammPool && accountKeys.includes(token.ammPool))) {
        return { attributedTo: token.bondingCurve };
      }
      // Mint match in balances
      if (txMints.has(token.mint)) {
        return { attributedTo: token.bondingCurve };
      }
    }

    // Dynamic discovery
    for (const mintStr of txMints) {
      try {
        const mint = new PublicKey(mintStr);
        const bc = deriveBondingCurve(mint);
        const bcStr = bc.toBase58();
        
        // Check if we can verify this is our creator's token
        // This is where we need to fetch BC data
        // We use rpcManager.getAccountInfo
        const account = await this.rpcManager.getAccountInfo(bc);
        if (account) {
          const data = deserializeBondingCurve(account.data);
          if (data && data.creator.equals(this.config.creator)) {
             // New token found!
             const pool = deriveAMMPool(mint);
             const token: TrackedToken = {
               mint: mintStr,
               symbol: 'UNKNOWN',
               bondingCurve: bcStr,
               ammPool: pool.toBase58(),
               migrated: data.complete,
               lastSolReserves: data.realSolReserves,
               lastAmmReserves: 0n,
               totalFees: 0n,
               feeCount: 0,
               recentAmmFees: 0n,
               recentAmmFeesTimestamp: Date.now(),
               recentBcFees: 0n,
               recentBcFeesTimestamp: Date.now(),
               isMayhemMode: data.isMayhemMode,
               tokenProgram: 'TOKEN'
             };
             
             // Try to fetch metadata immediately
             this.tokenManager.fetchMetadata(mint).then(metadata => {
               if (metadata) {
                 token.symbol = metadata.symbol;
                 const stats = this.tokenStats.get(token.mint);
                 if (stats) stats.symbol = metadata.symbol;
               }
             }).catch((err) => {
               this.log(`Failed to fetch metadata for new token ${mintStr}: ${err.message || err}`);
             });

             this.addToken(token);
             if (this.config.onTokenDiscovered) {
               this.config.onTokenDiscovered(token);
             }
             this.log(`Dynamically discovered ${token.mint}`);
             return { attributedTo: bcStr };
          }
        }
      } catch {}
    }

    return {};
  }

  private async processVault(
    type: 'BC' | 'AMM',
    vault: PublicKey,
    txResult: { attributed: Map<string, bigint>; unattributed: bigint },
    tokenDeltas: Map<string, bigint>,
    slot: number,
    timestamp: number
  ) {
    // Process attributed
    for (const [bc, amount] of txResult.attributed) {
      this.recordFee(bc, amount, slot, timestamp, type, vault);
    }

    // Process unattributed (proportional)
    if (txResult.unattributed > 0n) {
       // logic for proportional distribution using tokenDeltas or recent fees
       // Simplified: Distribute to tokens that had activity in this poll (tokenDeltas)
       // If no activity, distribute to all (fallback)
       // Or better: Use recent activity window logic from original daemon
       this.distributeProportional(txResult.unattributed, type, tokenDeltas, slot, timestamp, vault);
    }

    // Check balance for non-tx fees (claims or missed txs)
    // Handled in checkBalanceConsistency
  }

  private async checkBalanceConsistency(
    slot: number, 
    timestamp: number, 
    tokenDeltas: Map<string, bigint>
  ) {
    // 1. Check BC Vault
    try {
      const currentBc = BigInt(await this.rpcManager.getBalance(this.config.bcVault));
      const expectedBc = this.lastBcBalance + this.accumulatedBcDelta;
      const diffBc = currentBc - expectedBc;
      
      if (diffBc !== 0n) {
        if (diffBc > 0n) {
           this.log(`[BalanceCheck] BC Surplus: ${Number(diffBc)/1e9} SOL. Recorded as Orphan Fee.`);
           this.totalOrphanFees += diffBc;
        } else {
           // Deficit: Likely we found the transaction for a previous orphan
           const reduceBy = -diffBc;
           if (this.totalOrphanFees > 0n) {
             if (this.totalOrphanFees >= reduceBy) {
               this.totalOrphanFees -= reduceBy;
               this.log(`[BalanceCheck] BC Deficit resolved (tx found). Reduced Orphan Fees by ${Number(reduceBy)/1e9} SOL.`);
             } else {
               this.totalOrphanFees = 0n;
             }
           }
        }
        this.accumulatedBcDelta += diffBc;
      }
    } catch (e) {
      if (this.config.verbose) console.warn('BC Balance check failed', e);
    }

    // 2. Check AMM Vault (WSOL)
    try {
      const currentAmm = await this.rpcManager.getTokenAccountBalance(this.ammVaultATA);
      const expectedAmm = this.lastAmmBalance + this.accumulatedAmmDelta;
      const diffAmm = currentAmm - expectedAmm;
      
      if (diffAmm !== 0n) {
        if (diffAmm > 0n) {
           this.log(`[BalanceCheck] AMM Surplus: ${Number(diffAmm)/1e9} SOL. Recorded as Orphan Fee.`);
           this.totalOrphanFees += diffAmm;
        } else {
           // Deficit: Likely we found the transaction for a previous orphan
           const reduceBy = -diffAmm;
           if (this.totalOrphanFees > 0n) {
             if (this.totalOrphanFees >= reduceBy) {
               this.totalOrphanFees -= reduceBy;
               this.log(`[BalanceCheck] AMM Deficit resolved (tx found). Reduced Orphan Fees by ${Number(reduceBy)/1e9} SOL.`);
             } else {
               this.totalOrphanFees = 0n;
             }
           }
        }
        this.accumulatedAmmDelta += diffAmm;
      }
    } catch (e) {
      if (this.config.verbose) console.warn('AMM Balance check failed', e);
    }
  }

  private recordFee(
    bc: string,
    amount: bigint,
    slot: number,
    timestamp: number,
    vaultType: 'BC' | 'AMM',
    vault: PublicKey
  ) {
    const token = this.trackedTokens.get(bc);
    if (!token) return;

    token.totalFees += amount;
    token.feeCount++;
    const stats = this.tokenStats.get(token.mint);
    if (stats) {
      stats.totalFees += amount;
      stats.feeCount++;
      stats.lastFeeTimestamp = timestamp;
    }

    if (this.historyManager) {
      this.historyManager.addEntry(
        'FEE',
        vaultType,
        vault.toBase58(),
        amount,
        0n, // We don't track exact balance before/after per entry easily without checking vault balance each time
        0n,
        slot,
        timestamp,
        token.mint,
        token.symbol
      );
    }

    if (this.config.onFeeDetected) {
      this.config.onFeeDetected({
        mint: token.mint,
        symbol: token.symbol,
        amount,
        timestamp,
        slot
      });
    }
  }

  private distributeProportional(
    amount: bigint,
    type: 'BC' | 'AMM',
    deltas: Map<string, bigint>,
    slot: number,
    timestamp: number,
    vault: PublicKey
  ) {
    // Filter active tokens
    const active = Array.from(deltas.keys())
        .map(bc => ({ bc, delta: deltas.get(bc)! }))
        .filter(x => {
          const t = this.trackedTokens.get(x.bc);
          return t && (type === 'BC' ? !t.migrated : t.migrated);
        });
    
    const totalDelta = active.reduce((sum, x) => sum + x.delta, 0n);

    if (totalDelta > 0n) {
      let remaining = amount;
      active.forEach((x, i) => {
         let share = (amount * x.delta) / totalDelta;
         if (i === active.length - 1) share = remaining;
         else remaining -= share;
         
         if (share > 0n) this.recordFee(x.bc, share, slot, timestamp, type, vault);
      });
    } else {
       // Fallback to all applicable tokens
       const applicable = Array.from(this.trackedTokens.values())
         .filter(t => type === 'BC' ? !t.migrated : t.migrated);
       
       if (applicable.length > 0) {
         const share = amount / BigInt(applicable.length);
         applicable.forEach(t => {
           if (share > 0n) this.recordFee(t.bondingCurve, share, slot, timestamp, type, vault);
         });
       }
    }
  }

  private saveState() {
    if (!this.config.stateFile) return;
    const state: TrackerState = {
      lastBcSignature: this.lastBcSignature,
      lastAmmSignature: this.lastAmmSignature,
      lastBcBalance: this.lastBcBalance.toString(),
      lastAmmBalance: this.lastAmmBalance.toString(),
      accumulatedBcDelta: this.accumulatedBcDelta.toString(),
      accumulatedAmmDelta: this.accumulatedAmmDelta.toString(),
      totalOrphanFees: this.totalOrphanFees.toString(),
      trackedTokens: {} // We rely on discovery to re-populate full objects, but we could save stats here
    };
    fs.writeFileSync(this.config.stateFile, JSON.stringify(state));
  }

  private log(msg: string) {
    if (this.config.verbose) {
      console.log(`[FeeTracker] ${msg}`);
    }
  }
}
