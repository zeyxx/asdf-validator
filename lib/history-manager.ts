import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export type HistoryEventType = 'FEE' | 'CLAIM';

export interface HistoryEntry {
  sequence: number;
  prevHash: string;
  hash: string;
  eventType: HistoryEventType;
  vaultType: 'BC' | 'AMM';
  vault: string;
  mint?: string;
  symbol?: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  slot: number;
  timestamp: number;
  date: string;
}

export interface HistoryMetadata {
  version: string;
  creator: string;
  bcVault: string;
  ammVault: string;
  startedAt: string;
  lastUpdated: string;
  totalFees: string;
  entryCount: number;
  latestHash: string;
}

export interface HistoryLog extends HistoryMetadata {
  entries: HistoryEntry[];
}

/** Genesis block hash - SHA256("ASDF_VALIDATOR_GENESIS") */
export const GENESIS_HASH = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

export function computeEntryHash(entry: Omit<HistoryEntry, 'hash'>): string {
  const data = [
    entry.sequence.toString(),
    entry.prevHash,
    entry.eventType,
    entry.vaultType,
    entry.vault,
    entry.mint || '',
    entry.symbol || '',
    entry.amount,
    entry.balanceBefore,
    entry.balanceAfter,
    entry.slot.toString(),
    entry.timestamp.toString(),
  ].join('|');

  return createHash('sha256').update(data).digest('hex');
}

export interface ChainValidationResult {
  valid: boolean;
  entriesChecked: number;
  error?: string;
  corruptedAtSequence?: number;
}

export class HistoryManager {
  private filePath: string;
  private metadata: HistoryMetadata;
  private writeStream: fs.WriteStream | null = null;
  private chainValidation: ChainValidationResult = { valid: true, entriesChecked: 0 };

  constructor(
    filePath: string,
    creator: string,
    bcVault: string,
    ammVault: string
  ) {
    this.filePath = filePath;
    this.metadata = {
      version: '1.0.0',
      creator,
      bcVault,
      ammVault,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      totalFees: '0',
      entryCount: 0,
      latestHash: GENESIS_HASH,
    };
  }

  /**
   * Initialize the history manager.
   * If file exists, read metadata and last entry to restore state.
   */
  async init(): Promise<void> {
    if (fs.existsSync(this.filePath)) {
      await this.restoreState();
    } else {
      // Create new file with metadata
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Write metadata as first line
      fs.writeFileSync(this.filePath, JSON.stringify({ type: 'metadata', data: this.metadata }) + '\n');
    }

    // Open append stream with error handling
    this.writeStream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this.writeStream.on('error', (err) => {
      console.error('[HistoryManager] WriteStream error:', err.message);
    });
  }

  private async restoreState(): Promise<void> {
    // Read file line by line and validate the PoH chain integrity
    const fileStream = fs.createReadStream(this.filePath);
    const rl = require('readline').createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let expectedPrevHash = GENESIS_HASH;
    let entriesChecked = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === 'metadata') {
          // Base metadata
          this.metadata = { ...this.metadata, ...record.data };
        } else if (record.type === 'entry') {
          const entry = record.data as HistoryEntry;
          entriesChecked++;

          // PoH Validation 1: Verify prevHash links to previous entry
          if (entry.prevHash !== expectedPrevHash) {
            this.chainValidation = {
              valid: false,
              entriesChecked,
              error: `Chain broken at sequence ${entry.sequence}: prevHash mismatch`,
              corruptedAtSequence: entry.sequence,
            };
            console.error(`[HistoryManager] PoH chain broken at sequence ${entry.sequence}`);
            // Continue loading but mark as invalid
          }

          // PoH Validation 2: Verify entry hash is correct
          const computedHash = computeEntryHash(entry);
          if (computedHash !== entry.hash) {
            this.chainValidation = {
              valid: false,
              entriesChecked,
              error: `Invalid hash at sequence ${entry.sequence}: expected ${computedHash}, got ${entry.hash}`,
              corruptedAtSequence: entry.sequence,
            };
            console.error(`[HistoryManager] Invalid hash at sequence ${entry.sequence}`);
          }

          // Update expected prevHash for next entry
          expectedPrevHash = entry.hash;

          // Update metadata from entry
          this.metadata.latestHash = entry.hash;
          this.metadata.entryCount = entry.sequence;
          this.metadata.lastUpdated = entry.date;
          if (entry.eventType === 'FEE') {
            const amount = BigInt(entry.amount);
            const currentTotal = BigInt(this.metadata.totalFees);
            this.metadata.totalFees = (currentTotal + (amount > 0n ? amount : -amount)).toString();
          }
        }
      } catch (e) {
        // Malformed line - log but don't break
        console.warn(`[HistoryManager] Malformed line in history file: ${e}`);
      }
    }

    // Update validation result if no errors were found
    if (this.chainValidation.valid) {
      this.chainValidation.entriesChecked = entriesChecked;
    }
  }

  addEntry(
    eventType: HistoryEventType,
    vaultType: 'BC' | 'AMM',
    vault: string,
    amount: bigint,
    balanceBefore: bigint,
    balanceAfter: bigint,
    slot: number,
    timestamp: number,
    mint?: string,
    symbol?: string
  ): HistoryEntry {
    const prevHash = this.metadata.latestHash;
    const sequence = this.metadata.entryCount + 1;

    const entryData: Omit<HistoryEntry, 'hash'> = {
      sequence,
      prevHash,
      eventType,
      vaultType,
      vault,
      mint,
      symbol,
      amount: amount.toString(),
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      slot,
      timestamp,
      date: new Date(timestamp).toISOString(),
    };

    const hash = computeEntryHash(entryData);
    const entry: HistoryEntry = { ...entryData, hash };

    // Update state
    this.metadata.entryCount = sequence;
    this.metadata.latestHash = hash;
    this.metadata.lastUpdated = entry.date;
    if (eventType === 'FEE') {
      const absAmount = amount < 0n ? -amount : amount;
      this.metadata.totalFees = (BigInt(this.metadata.totalFees) + absAmount).toString();
    }

    // Write to stream
    const line = JSON.stringify({ type: 'entry', data: entry }) + '\n';
    if (this.writeStream) {
      this.writeStream.write(line);
    }

    return entry;
  }

  getMetadata(): HistoryMetadata {
    return { ...this.metadata };
  }

  /**
   * Get the chain validation result from init().
   * Returns { valid: true, entriesChecked: N } if chain is valid,
   * or { valid: false, error: "...", corruptedAtSequence: N } if corrupted.
   */
  getChainValidation(): ChainValidationResult {
    return { ...this.chainValidation };
  }

  /**
   * Check if the history chain is valid (shorthand for getChainValidation().valid)
   */
  isChainValid(): boolean {
    return this.chainValidation.valid;
  }

  close(): void {
    if (this.writeStream) {
      this.writeStream.end();
    }
  }
}
