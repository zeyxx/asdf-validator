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

export class HistoryManager {
  private filePath: string;
  private metadata: HistoryMetadata;
  private writeStream: fs.WriteStream | null = null;

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

    // Open append stream
    this.writeStream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  private async restoreState(): Promise<void> {
    // Read file line by line to find metadata and last entry
    // efficient for large files: we only need the first line (metadata) and verify the last line
    // But to be 100% correct we should scan the whole file? For "restore", maybe just the header is enough if we trust the append only nature.
    // However, we need 'latestHash' and 'entryCount' from the metadata which should be updated.
    // Wait, in JSONL, the metadata is at the top. It doesn't get updated unless we rewrite the file.
    // Solution: The metadata line at the top is the *initial* metadata. We need to scan the file to calculate current state.
    // Or, we can append a "checkpoint" or "summary" line periodically?
    // Let's scan the file. It's safe and robust.

    const fileStream = fs.createReadStream(this.filePath);
    const rl = require('readline').createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === 'metadata') {
          // Base metadata
          this.metadata = { ...this.metadata, ...record.data };
        } else if (record.type === 'entry') {
          const entry = record.data as HistoryEntry;
          this.metadata.latestHash = entry.hash;
          this.metadata.entryCount = entry.sequence;
          this.metadata.lastUpdated = entry.date;
          if (entry.eventType === 'FEE') {
             // Re-calculate total fees to be safe, or trust the sequence
             // BigInt parsing needed
             const amount = BigInt(entry.amount);
             const currentTotal = BigInt(this.metadata.totalFees);
             this.metadata.totalFees = (currentTotal + (amount > 0n ? amount : -amount)).toString();
          }
        }
      } catch (e) {
        // Ignore malformed lines
      }
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

  close(): void {
    if (this.writeStream) {
      this.writeStream.end();
    }
  }
}
