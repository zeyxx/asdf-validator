import * as fs from 'fs';
import * as path from 'path';
import {
  HistoryManager,
  computeEntryHash,
  GENESIS_HASH,
  HistoryEntry,
} from '../lib/history-manager';

describe('History Manager', () => {
  const testDir = path.join(__dirname, 'test-history');
  const testFile = path.join(testDir, 'history.jsonl');
  const creator = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const bcVault = 'BcVault111111111111111111111111111111111111';
  const ammVault = 'AmmVault11111111111111111111111111111111111';

  beforeEach(async () => {
    // Clean up test directory
    await cleanupTestDir();
  });

  afterEach(async () => {
    // Give time for streams to close
    await new Promise(resolve => setTimeout(resolve, 100));
    await cleanupTestDir();
  });

  function cleanupTestDir() {
    if (fs.existsSync(testDir)) {
      // Use recursive delete
      const deleteFolderRecursive = (dirPath: string) => {
        if (fs.existsSync(dirPath)) {
          fs.readdirSync(dirPath).forEach((file) => {
            const curPath = path.join(dirPath, file);
            if (fs.lstatSync(curPath).isDirectory()) {
              deleteFolderRecursive(curPath);
            } else {
              fs.unlinkSync(curPath);
            }
          });
          fs.rmdirSync(dirPath);
        }
      };
      deleteFolderRecursive(testDir);
    }
  }

  describe('computeEntryHash', () => {
    it('should compute consistent hash for same entry', () => {
      const entry = {
        sequence: 1,
        prevHash: GENESIS_HASH,
        eventType: 'FEE' as const,
        vaultType: 'BC' as const,
        vault: bcVault,
        mint: 'Mint11111111111111111111111111111111111111',
        symbol: 'TEST',
        amount: '1000000',
        balanceBefore: '0',
        balanceAfter: '1000000',
        slot: 12345,
        timestamp: 1700000000000,
        date: new Date(1700000000000).toISOString(),
      };

      const hash1 = computeEntryHash(entry);
      const hash2 = computeEntryHash(entry);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce different hashes for different amounts', () => {
      const entry1 = {
        sequence: 1,
        prevHash: GENESIS_HASH,
        eventType: 'FEE' as const,
        vaultType: 'BC' as const,
        vault: bcVault,
        amount: '1000000',
        balanceBefore: '0',
        balanceAfter: '1000000',
        slot: 12345,
        timestamp: 1700000000000,
        date: new Date(1700000000000).toISOString(),
      };

      const entry2 = { ...entry1, amount: '2000000' };

      const hash1 = computeEntryHash(entry1);
      const hash2 = computeEntryHash(entry2);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different sequences', () => {
      const entry1 = {
        sequence: 1,
        prevHash: GENESIS_HASH,
        eventType: 'FEE' as const,
        vaultType: 'BC' as const,
        vault: bcVault,
        amount: '1000000',
        balanceBefore: '0',
        balanceAfter: '1000000',
        slot: 12345,
        timestamp: 1700000000000,
        date: new Date(1700000000000).toISOString(),
      };

      const entry2 = { ...entry1, sequence: 2 };

      const hash1 = computeEntryHash(entry1);
      const hash2 = computeEntryHash(entry2);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different prevHash', () => {
      const entry1 = {
        sequence: 1,
        prevHash: GENESIS_HASH,
        eventType: 'FEE' as const,
        vaultType: 'BC' as const,
        vault: bcVault,
        amount: '1000000',
        balanceBefore: '0',
        balanceAfter: '1000000',
        slot: 12345,
        timestamp: 1700000000000,
        date: new Date(1700000000000).toISOString(),
      };

      const entry2 = { ...entry1, prevHash: 'different_hash_value_here_123456789012345678901234' };

      const hash1 = computeEntryHash(entry1);
      const hash2 = computeEntryHash(entry2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle missing optional fields', () => {
      const entry = {
        sequence: 1,
        prevHash: GENESIS_HASH,
        eventType: 'FEE' as const,
        vaultType: 'BC' as const,
        vault: bcVault,
        amount: '1000000',
        balanceBefore: '0',
        balanceAfter: '1000000',
        slot: 12345,
        timestamp: 1700000000000,
        date: new Date(1700000000000).toISOString(),
        // No mint or symbol
      };

      const hash = computeEntryHash(entry);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should differentiate FEE vs CLAIM event types', () => {
      const baseEntry = {
        sequence: 1,
        prevHash: GENESIS_HASH,
        vaultType: 'BC' as const,
        vault: bcVault,
        amount: '1000000',
        balanceBefore: '1000000',
        balanceAfter: '0',
        slot: 12345,
        timestamp: 1700000000000,
        date: new Date(1700000000000).toISOString(),
      };

      const feeEntry = { ...baseEntry, eventType: 'FEE' as const };
      const claimEntry = { ...baseEntry, eventType: 'CLAIM' as const };

      expect(computeEntryHash(feeEntry)).not.toBe(computeEntryHash(claimEntry));
    });

    it('should differentiate BC vs AMM vault types', () => {
      const baseEntry = {
        sequence: 1,
        prevHash: GENESIS_HASH,
        eventType: 'FEE' as const,
        vault: bcVault,
        amount: '1000000',
        balanceBefore: '0',
        balanceAfter: '1000000',
        slot: 12345,
        timestamp: 1700000000000,
        date: new Date(1700000000000).toISOString(),
      };

      const bcEntry = { ...baseEntry, vaultType: 'BC' as const };
      const ammEntry = { ...baseEntry, vaultType: 'AMM' as const };

      expect(computeEntryHash(bcEntry)).not.toBe(computeEntryHash(ammEntry));
    });
  });

  describe('GENESIS_HASH', () => {
    it('should be a valid 64-character hex string', () => {
      expect(GENESIS_HASH).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should be the expected value', () => {
      expect(GENESIS_HASH).toBe('a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456');
    });
  });

  describe('HistoryManager', () => {
    describe('constructor', () => {
      it('should create instance with initial metadata', () => {
        const manager = new HistoryManager(testFile, creator, bcVault, ammVault);
        const metadata = manager.getMetadata();

        expect(metadata.version).toBe('1.0.0');
        expect(metadata.creator).toBe(creator);
        expect(metadata.bcVault).toBe(bcVault);
        expect(metadata.ammVault).toBe(ammVault);
        expect(metadata.entryCount).toBe(0);
        expect(metadata.latestHash).toBe(GENESIS_HASH);
        expect(metadata.totalFees).toBe('0');
      });
    });

    describe('init', () => {
      it('should create new file when not exists', async () => {
        const manager = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager.init();

        expect(fs.existsSync(testFile)).toBe(true);

        // Read and verify metadata line
        const content = fs.readFileSync(testFile, 'utf-8');
        const firstLine = content.split('\n')[0];
        const record = JSON.parse(firstLine);

        expect(record.type).toBe('metadata');
        expect(record.data.creator).toBe(creator);

        manager.close();
      });

      it('should create directory if not exists', async () => {
        const nestedPath = path.join(testDir, 'nested', 'deep', 'history.jsonl');
        const manager = new HistoryManager(nestedPath, creator, bcVault, ammVault);
        await manager.init();

        expect(fs.existsSync(nestedPath)).toBe(true);

        manager.close();
      });

      it('should restore state from existing file', async () => {
        // Create initial manager and add entries
        const manager1 = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager1.init();

        manager1.addEntry('FEE', 'BC', bcVault, 1000000n, 0n, 1000000n, 100, Date.now());
        manager1.addEntry('FEE', 'BC', bcVault, 500000n, 1000000n, 1500000n, 101, Date.now());
        manager1.close();

        // Create new manager and restore
        const manager2 = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager2.init();

        const metadata = manager2.getMetadata();
        expect(metadata.entryCount).toBe(2);
        expect(metadata.latestHash).not.toBe(GENESIS_HASH);
        expect(BigInt(metadata.totalFees)).toBe(1500000n);

        manager2.close();
      });
    });

    describe('addEntry', () => {
      it('should add FEE entry and update metadata', async () => {
        const manager = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager.init();

        const entry = manager.addEntry(
          'FEE',
          'BC',
          bcVault,
          1000000n,
          0n,
          1000000n,
          12345,
          Date.now(),
          'Mint111',
          'TEST'
        );

        expect(entry.sequence).toBe(1);
        expect(entry.prevHash).toBe(GENESIS_HASH);
        expect(entry.eventType).toBe('FEE');
        expect(entry.vaultType).toBe('BC');
        expect(entry.amount).toBe('1000000');
        expect(entry.mint).toBe('Mint111');
        expect(entry.symbol).toBe('TEST');

        const metadata = manager.getMetadata();
        expect(metadata.entryCount).toBe(1);
        expect(metadata.totalFees).toBe('1000000');
        expect(metadata.latestHash).toBe(entry.hash);

        manager.close();
      });

      it('should chain entries correctly', async () => {
        const manager = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager.init();

        const entry1 = manager.addEntry('FEE', 'BC', bcVault, 1000000n, 0n, 1000000n, 100, Date.now());
        const entry2 = manager.addEntry('FEE', 'BC', bcVault, 500000n, 1000000n, 1500000n, 101, Date.now());
        const entry3 = manager.addEntry('FEE', 'AMM', ammVault, 250000n, 0n, 250000n, 102, Date.now());

        expect(entry1.prevHash).toBe(GENESIS_HASH);
        expect(entry2.prevHash).toBe(entry1.hash);
        expect(entry3.prevHash).toBe(entry2.hash);

        expect(entry1.sequence).toBe(1);
        expect(entry2.sequence).toBe(2);
        expect(entry3.sequence).toBe(3);

        manager.close();
      });

      it('should handle CLAIM events without adding to totalFees', async () => {
        const manager = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager.init();

        manager.addEntry('FEE', 'BC', bcVault, 1000000n, 0n, 1000000n, 100, Date.now());
        manager.addEntry('CLAIM', 'BC', bcVault, 500000n, 1000000n, 500000n, 101, Date.now());

        const metadata = manager.getMetadata();
        // Only FEE events count towards totalFees
        expect(metadata.totalFees).toBe('1000000');
        expect(metadata.entryCount).toBe(2);

        manager.close();
      });

      it('should handle negative amounts (absolute value for totalFees)', async () => {
        const manager = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager.init();

        manager.addEntry('FEE', 'BC', bcVault, -500000n, 1000000n, 500000n, 100, Date.now());

        const metadata = manager.getMetadata();
        expect(metadata.totalFees).toBe('500000');

        manager.close();
      });

      it('should write entry to file', async () => {
        const manager = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager.init();

        manager.addEntry('FEE', 'BC', bcVault, 1000000n, 0n, 1000000n, 12345, Date.now());
        manager.close();

        // Wait for file write
        await new Promise(resolve => setTimeout(resolve, 100));

        const content = fs.readFileSync(testFile, 'utf-8');
        const lines = content.trim().split('\n');

        expect(lines.length).toBe(2); // metadata + 1 entry

        const entryRecord = JSON.parse(lines[1]);
        expect(entryRecord.type).toBe('entry');
        expect(entryRecord.data.sequence).toBe(1);
        expect(entryRecord.data.amount).toBe('1000000');
      });
    });

    describe('getMetadata', () => {
      it('should return copy of metadata', async () => {
        const manager = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager.init();

        const metadata1 = manager.getMetadata();
        const metadata2 = manager.getMetadata();

        expect(metadata1).not.toBe(metadata2);
        expect(metadata1).toEqual(metadata2);

        manager.close();
      });
    });

    describe('close', () => {
      it('should close write stream', async () => {
        const manager = new HistoryManager(testFile, creator, bcVault, ammVault);
        await manager.init();

        manager.close();

        // Should not throw when called multiple times
        manager.close();
      });
    });
  });
});
