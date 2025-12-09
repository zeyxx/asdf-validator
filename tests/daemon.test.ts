/**
 * ValidatorDaemon Tests
 *
 * Tests for daemon functionality including vault derivation and token stats.
 */

import { PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  ValidatorDaemon,
  deriveBondingCurveVault,
  derivePumpSwapVault,
  PUMP_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  TokenConfig,
  TokenStats,
  loadHistoryLog,
  saveHistoryLog,
  verifyHistoryChain,
  verifyEntryHash,
  GENESIS_HASH,
  computeEntryHash,
  HistoryLog,
  HistoryEntry,
} from '../daemon';

// Mock RpcManager to avoid real RPC calls
jest.mock('../lib/rpc-manager', () => {
  return {
    RpcManager: jest.fn().mockImplementation(() => ({
      checkHealth: jest.fn().mockResolvedValue({ healthy: true }),
      getConnection: jest.fn().mockReturnValue({
        getBalance: jest.fn().mockResolvedValue(1000000000),
      }),
    })),
  };
});

// Mock TokenManager
jest.mock('../lib/token-manager', () => {
  const actual = jest.requireActual('../lib/token-manager');
  return {
    ...actual,
    TokenManager: jest.fn().mockImplementation(() => ({
      discoverTokens: jest.fn().mockResolvedValue([]),
      resolveMint: jest.fn().mockResolvedValue(null),
    })),
  };
});

// Mock FeeTracker with token tracking
const mockTokens: any[] = [];
jest.mock('../lib/fee-tracker', () => {
  return {
    FeeTracker: jest.fn().mockImplementation(() => {
      const tokens: any[] = [];
      return {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
        isRunning: jest.fn().mockReturnValue(false),
        getStats: jest.fn().mockImplementation(() => tokens.map(t => ({
          mint: t.mint,
          symbol: t.symbol,
          bondingCurve: t.bondingCurve,
          ammPool: t.ammPool,
          totalFees: 0n,
          feeCount: 0,
        }))),
        getTotalFees: jest.fn().mockReturnValue(0n),
        getOrphanFees: jest.fn().mockReturnValue(0n),
        fetchCurrentBalances: jest.fn().mockResolvedValue({ bc: 1000n, amm: 2000n }),
        addToken: jest.fn().mockImplementation((token: any) => tokens.push(token)),
      };
    }),
  };
});

// Mock HistoryManager
jest.mock('../lib/history-manager', () => {
  const actual = jest.requireActual('../lib/history-manager');
  return {
    ...actual,
    HistoryManager: jest.fn().mockImplementation(() => ({
      init: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
      getMetadata: jest.fn().mockReturnValue({
        version: '1.0.0',
        creator: '11111111111111111111111111111111',
        bcVault: 'bcVault123',
        ammVault: 'ammVault456',
        startedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        totalFees: '0',
        entryCount: 0,
        latestHash: actual.GENESIS_HASH,
      }),
    })),
  };
});

describe('Vault Derivation', () => {
  describe('deriveBondingCurveVault', () => {
    it('should derive consistent vault for same creator', () => {
      const creator = new PublicKey('11111111111111111111111111111111');

      const vault1 = deriveBondingCurveVault(creator);
      const vault2 = deriveBondingCurveVault(creator);

      expect(vault1.equals(vault2)).toBe(true);
    });

    it('should derive different vaults for different creators', () => {
      const creator1 = new PublicKey('11111111111111111111111111111111');
      const creator2 = new PublicKey('So11111111111111111111111111111111111111112');

      const vault1 = deriveBondingCurveVault(creator1);
      const vault2 = deriveBondingCurveVault(creator2);

      expect(vault1.equals(vault2)).toBe(false);
    });

    it('should return valid PublicKey', () => {
      const creator = new PublicKey('11111111111111111111111111111111');
      const vault = deriveBondingCurveVault(creator);

      expect(vault).toBeInstanceOf(PublicKey);
      expect(vault.toBase58()).toHaveLength(44); // Base58 pubkey length
    });
  });

  describe('derivePumpSwapVault', () => {
    it('should derive consistent vault for same creator', () => {
      const creator = new PublicKey('11111111111111111111111111111111');

      const vault1 = derivePumpSwapVault(creator);
      const vault2 = derivePumpSwapVault(creator);

      expect(vault1.equals(vault2)).toBe(true);
    });

    it('should derive different vaults for different creators', () => {
      const creator1 = new PublicKey('11111111111111111111111111111111');
      const creator2 = new PublicKey('So11111111111111111111111111111111111111112');

      const vault1 = derivePumpSwapVault(creator1);
      const vault2 = derivePumpSwapVault(creator2);

      expect(vault1.equals(vault2)).toBe(false);
    });

    it('should derive different vault than BC for same creator', () => {
      const creator = new PublicKey('11111111111111111111111111111111');

      const bcVault = deriveBondingCurveVault(creator);
      const ammVault = derivePumpSwapVault(creator);

      // Different programs and seeds = different vaults
      expect(bcVault.equals(ammVault)).toBe(false);
    });
  });
});

describe('ValidatorDaemon', () => {
  // Note: Full daemon tests require mocking RPC calls
  // These tests focus on configuration and state management

  describe('Configuration', () => {
    it('should accept minimal configuration', () => {
      const config = {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      };

      // Should not throw
      const daemon = new ValidatorDaemon(config);
      expect(daemon.isRunning()).toBe(false);
    });

    it('should accept full configuration', () => {
      const tokens: TokenConfig[] = [
        {
          mint: 'So11111111111111111111111111111111111111112',
          symbol: 'TEST',
          bondingCurve: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          poolType: 'bonding_curve',
        },
      ];

      const onFeeDetected = jest.fn();
      const onStats = jest.fn();
      const onHistoryEntry = jest.fn();

      const config = {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        tokens,
        pollInterval: 3000,
        statsInterval: 30000,
        verbose: true,
        historyFile: '/tmp/test-history.json',
        onFeeDetected,
        onStats,
        onHistoryEntry,
      };

      const daemon = new ValidatorDaemon(config);
      expect(daemon.isRunning()).toBe(false);
    });

    it('should throw for invalid creator address', () => {
      const config = {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: 'invalid-address',
      };

      expect(() => new ValidatorDaemon(config)).toThrow();
    });
  });

  describe('Token Management', () => {
    it('should start with empty stats when no tokens configured', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      const stats = daemon.getStats();
      expect(stats).toHaveLength(0);
    });

    it('should initialize stats for configured tokens', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        tokens: [
          {
            mint: 'So11111111111111111111111111111111111111112',
            symbol: 'TOKEN1',
            bondingCurve: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            poolType: 'bonding_curve',
          },
          {
            mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            symbol: 'TOKEN2',
            bondingCurve: 'So11111111111111111111111111111111111111112',
            poolType: 'pumpswap_amm',
          },
        ],
      });

      const stats = daemon.getStats();
      expect(stats).toHaveLength(2);
      expect(stats[0].symbol).toBe('TOKEN1');
      expect(stats[1].symbol).toBe('TOKEN2');
      expect(stats[0].totalFees).toBe(0n);
      expect(stats[0].feeCount).toBe(0);
    });

    it('should allow adding tokens after creation', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      daemon.addToken({
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'ADDED',
        bondingCurve: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        poolType: 'bonding_curve',
      });

      const stats = daemon.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].symbol).toBe('ADDED');
    });
  });

  describe('Total Fees', () => {
    it('should return 0n when no fees tracked', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      expect(daemon.getTotalFees()).toBe(0n);
    });
  });

  describe('History Management', () => {
    it('should return undefined history when not enabled', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      expect(daemon.getHistoryLog()).toBeUndefined();
      expect(daemon.getHistoryFilePath()).toBeUndefined();
    });

    it('should initialize history when file path provided', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        historyFile: '/tmp/test-history-daemon.json',
      });

      const history = daemon.getHistoryLog();
      expect(history).toBeDefined();
      expect(history?.version).toBe('1.0.0');
      expect(history?.entries).toHaveLength(0);
      expect(daemon.getHistoryFilePath()).toBe('/tmp/test-history-daemon.json');
    });

    it('should fail verification when history not enabled', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      const result = daemon.verifyHistory();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not enabled');
    });

    it('should pass verification for empty history', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        historyFile: '/tmp/test-history-verify.json',
      });

      const result = daemon.verifyHistory();
      expect(result.valid).toBe(true);
    });
  });

  describe('Lifecycle', () => {
    it('should not be running initially', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      expect(daemon.isRunning()).toBe(false);
    });

    it('should stop gracefully when not running', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      // Should not throw
      daemon.stop();
      expect(daemon.isRunning()).toBe(false);
    });
  });
});

describe('Program IDs', () => {
  it('should export PUMP_PROGRAM_ID', () => {
    expect(PUMP_PROGRAM_ID).toBeInstanceOf(PublicKey);
    expect(PUMP_PROGRAM_ID.toBase58()).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  });

  it('should export PUMPSWAP_PROGRAM_ID', () => {
    expect(PUMPSWAP_PROGRAM_ID).toBeInstanceOf(PublicKey);
    expect(PUMPSWAP_PROGRAM_ID.toBase58()).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  });
});

describe('loadHistoryLog', () => {
  const testDir = '/tmp/daemon-test-history';

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test files
    try {
      const files = fs.readdirSync(testDir);
      for (const file of files) {
        fs.unlinkSync(path.join(testDir, file));
      }
    } catch {}
  });

  it('should load valid JSON history log', () => {
    const testFile = path.join(testDir, 'valid.json');
    const testLog: HistoryLog = {
      version: '1.0.0',
      creator: 'test-creator',
      bcVault: 'test-bc',
      ammVault: 'test-amm',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-01-01T00:00:00.000Z',
      totalFees: '1000000',
      entryCount: 0,
      latestHash: GENESIS_HASH,
      entries: [],
    };
    fs.writeFileSync(testFile, JSON.stringify(testLog));

    const loaded = loadHistoryLog(testFile);
    expect(loaded.version).toBe('1.0.0');
    expect(loaded.creator).toBe('test-creator');
    expect(loaded.totalFees).toBe('1000000');
  });

  it('should load JSONL format when JSON parse fails', () => {
    const testFile = path.join(testDir, 'jsonl.log');
    const metadata = {
      type: 'metadata',
      data: {
        version: '1.0.0',
        creator: 'jsonl-creator',
        bcVault: 'jsonl-bc',
        ammVault: 'jsonl-amm',
        startedAt: '2024-01-01T00:00:00.000Z',
        lastUpdated: '2024-01-01T00:00:00.000Z',
        totalFees: '500000',
        entryCount: 1,
        latestHash: 'hash123',
      },
    };
    const entry = {
      type: 'entry',
      data: {
        sequence: 1,
        timestamp: '2024-01-01T00:00:00.000Z',
        eventType: 'FEE',
        amount: '100000',
        vault: 'BC',
        prevHash: GENESIS_HASH,
        hash: 'entry-hash',
      },
    };
    fs.writeFileSync(testFile, JSON.stringify(metadata) + '\n' + JSON.stringify(entry) + '\n');

    const loaded = loadHistoryLog(testFile, 'creator', 'bc', 'amm');
    expect(loaded.version).toBe('1.0.0');
    expect(loaded.creator).toBe('jsonl-creator');
    expect(loaded.entries).toHaveLength(1);
  });

  it('should return fallback log when file does not exist but args provided', () => {
    const testFile = path.join(testDir, 'nonexistent.json');

    const loaded = loadHistoryLog(testFile, 'fallback-creator', 'fallback-bc', 'fallback-amm');
    expect(loaded.version).toBe('1.0.0');
    expect(loaded.creator).toBe('fallback-creator');
    expect(loaded.bcVault).toBe('fallback-bc');
    expect(loaded.ammVault).toBe('fallback-amm');
    expect(loaded.entries).toHaveLength(0);
  });

  it('should throw error when file does not exist and no args provided', () => {
    const testFile = path.join(testDir, 'nonexistent-no-args.json');

    expect(() => loadHistoryLog(testFile)).toThrow('Failed to load history log');
  });

  it('should handle JSONL with empty lines', () => {
    const testFile = path.join(testDir, 'jsonl-empty-lines.log');
    const metadata = {
      type: 'metadata',
      data: {
        version: '1.0.0',
        creator: 'test',
        bcVault: 'bc',
        ammVault: 'amm',
        startedAt: '2024-01-01T00:00:00.000Z',
        lastUpdated: '2024-01-01T00:00:00.000Z',
        totalFees: '0',
        entryCount: 0,
        latestHash: GENESIS_HASH,
      },
    };
    // Need two JSON objects to make it invalid for JSON.parse (which tolerates whitespace)
    const entry = { type: 'entry', data: { sequence: 1 } };
    fs.writeFileSync(testFile, '\n\n' + JSON.stringify(metadata) + '\n\n' + JSON.stringify(entry) + '\n');

    const loaded = loadHistoryLog(testFile, 'c', 'b', 'a');
    expect(loaded.version).toBe('1.0.0');
  });

  it('should skip invalid JSON lines in JSONL format', () => {
    const testFile = path.join(testDir, 'jsonl-invalid.log');
    const metadata = {
      type: 'metadata',
      data: {
        version: '1.0.0',
        creator: 'test',
        bcVault: 'bc',
        ammVault: 'amm',
        startedAt: '2024-01-01T00:00:00.000Z',
        lastUpdated: '2024-01-01T00:00:00.000Z',
        totalFees: '0',
        entryCount: 0,
        latestHash: GENESIS_HASH,
      },
    };
    fs.writeFileSync(testFile, 'not valid json\n' + JSON.stringify(metadata) + '\n{broken');

    const loaded = loadHistoryLog(testFile, 'c', 'b', 'a');
    expect(loaded.version).toBe('1.0.0');
  });
});

describe('saveHistoryLog', () => {
  const testDir = '/tmp/daemon-test-save';

  afterEach(() => {
    try {
      const files = fs.readdirSync(testDir);
      for (const file of files) {
        fs.unlinkSync(path.join(testDir, file));
      }
      fs.rmdirSync(testDir);
    } catch {}
  });

  it('should save history log to file', () => {
    const testFile = path.join(testDir, 'saved.json');
    const testLog: HistoryLog = {
      version: '1.0.0',
      creator: 'saved-creator',
      bcVault: 'saved-bc',
      ammVault: 'saved-amm',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-01-01T00:00:00.000Z',
      totalFees: '2000000',
      entryCount: 0,
      latestHash: GENESIS_HASH,
      entries: [],
    };

    saveHistoryLog(testFile, testLog);

    expect(fs.existsSync(testFile)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
    expect(loaded.creator).toBe('saved-creator');
    expect(loaded.totalFees).toBe('2000000');
  });

  it('should create directory if it does not exist', () => {
    const nestedDir = path.join(testDir, 'nested', 'deep');
    const testFile = path.join(nestedDir, 'saved.json');
    const testLog: HistoryLog = {
      version: '1.0.0',
      creator: 'nested-creator',
      bcVault: 'bc',
      ammVault: 'amm',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-01-01T00:00:00.000Z',
      totalFees: '0',
      entryCount: 0,
      latestHash: GENESIS_HASH,
      entries: [],
    };

    saveHistoryLog(testFile, testLog);

    expect(fs.existsSync(testFile)).toBe(true);

    // Clean up nested dirs
    fs.unlinkSync(testFile);
    fs.rmdirSync(nestedDir);
    fs.rmdirSync(path.join(testDir, 'nested'));
  });
});

describe('verifyHistoryChain', () => {
  it('should return valid for empty entries', () => {
    const log: HistoryLog = {
      version: '1.0.0',
      creator: 'test',
      bcVault: 'bc',
      ammVault: 'amm',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-01-01T00:00:00.000Z',
      totalFees: '0',
      entryCount: 0,
      latestHash: GENESIS_HASH,
      entries: [],
    };

    const result = verifyHistoryChain(log);
    expect(result.valid).toBe(true);
  });

  it('should fail when first entry does not link to genesis hash', () => {
    const now = Date.now();
    const entry: HistoryEntry = {
      sequence: 1,
      timestamp: now,
      eventType: 'FEE',
      vaultType: 'BC',
      vault: 'vault-address',
      amount: '100000',
      balanceBefore: '0',
      balanceAfter: '100000',
      slot: 12345,
      date: new Date(now).toISOString(),
      prevHash: 'wrong-hash',
      hash: 'entry-hash',
    };
    const log: HistoryLog = {
      version: '1.0.0',
      creator: 'test',
      bcVault: 'bc',
      ammVault: 'amm',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-01-01T00:00:00.000Z',
      totalFees: '100000',
      entryCount: 1,
      latestHash: 'entry-hash',
      entries: [entry],
    };

    const result = verifyHistoryChain(log);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('genesis hash');
    expect(result.entryIndex).toBe(0);
  });

  it('should fail when sequence is invalid', () => {
    const now = Date.now();
    const entry: HistoryEntry = {
      sequence: 5, // Wrong sequence, should be 1
      timestamp: now,
      eventType: 'FEE',
      vaultType: 'BC',
      vault: 'vault-address',
      amount: '100000',
      balanceBefore: '0',
      balanceAfter: '100000',
      slot: 12345,
      date: new Date(now).toISOString(),
      prevHash: GENESIS_HASH,
      hash: 'entry-hash',
    };
    const log: HistoryLog = {
      version: '1.0.0',
      creator: 'test',
      bcVault: 'bc',
      ammVault: 'amm',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-01-01T00:00:00.000Z',
      totalFees: '100000',
      entryCount: 1,
      latestHash: 'entry-hash',
      entries: [entry],
    };

    const result = verifyHistoryChain(log);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid sequence');
    expect(result.entryIndex).toBe(0);
  });

  it('should fail when hash is invalid', () => {
    const now = Date.now();
    const entry: HistoryEntry = {
      sequence: 1,
      timestamp: now,
      eventType: 'FEE',
      vaultType: 'BC',
      vault: 'vault-address',
      amount: '100000',
      balanceBefore: '0',
      balanceAfter: '100000',
      slot: 12345,
      date: new Date(now).toISOString(),
      prevHash: GENESIS_HASH,
      hash: 'wrong-hash',
    };
    const log: HistoryLog = {
      version: '1.0.0',
      creator: 'test',
      bcVault: 'bc',
      ammVault: 'amm',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-01-01T00:00:00.000Z',
      totalFees: '100000',
      entryCount: 1,
      latestHash: 'wrong-hash',
      entries: [entry],
    };

    const result = verifyHistoryChain(log);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid hash');
  });

  it('should fail when chain is broken between entries', () => {
    // Create valid first entry
    const now = Date.now();
    const entry1: HistoryEntry = {
      sequence: 1,
      timestamp: now,
      eventType: 'FEE',
      vaultType: 'BC',
      vault: 'vault-address',
      amount: '100000',
      balanceBefore: '0',
      balanceAfter: '100000',
      slot: 12345,
      date: new Date(now).toISOString(),
      prevHash: GENESIS_HASH,
      hash: '', // Will be computed
    };
    entry1.hash = computeEntryHash(entry1);

    // Create second entry with wrong prevHash
    const entry2: HistoryEntry = {
      sequence: 2,
      timestamp: now + 60000,
      eventType: 'FEE',
      vaultType: 'AMM',
      vault: 'vault-address-2',
      amount: '200000',
      balanceBefore: '100000',
      balanceAfter: '300000',
      slot: 12346,
      date: new Date(now + 60000).toISOString(),
      prevHash: 'wrong-prev-hash', // Should be entry1.hash
      hash: '',
    };
    entry2.hash = computeEntryHash(entry2);

    const log: HistoryLog = {
      version: '1.0.0',
      creator: 'test',
      bcVault: 'bc',
      ammVault: 'amm',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-01-01T00:01:00.000Z',
      totalFees: '300000',
      entryCount: 2,
      latestHash: entry2.hash,
      entries: [entry1, entry2],
    };

    const result = verifyHistoryChain(log);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Broken chain');
    expect(result.entryIndex).toBe(1);
  });

  it('should pass for valid chain', () => {
    const now = Date.now();
    const entry1: HistoryEntry = {
      sequence: 1,
      timestamp: now,
      eventType: 'FEE',
      vaultType: 'BC',
      vault: 'vault-address',
      amount: '100000',
      balanceBefore: '0',
      balanceAfter: '100000',
      slot: 12345,
      date: new Date(now).toISOString(),
      prevHash: GENESIS_HASH,
      hash: '',
    };
    entry1.hash = computeEntryHash(entry1);

    const entry2: HistoryEntry = {
      sequence: 2,
      timestamp: now + 60000,
      eventType: 'FEE',
      vaultType: 'AMM',
      vault: 'vault-address-2',
      amount: '200000',
      balanceBefore: '100000',
      balanceAfter: '300000',
      slot: 12346,
      date: new Date(now + 60000).toISOString(),
      prevHash: entry1.hash,
      hash: '',
    };
    entry2.hash = computeEntryHash(entry2);

    const log: HistoryLog = {
      version: '1.0.0',
      creator: 'test',
      bcVault: 'bc',
      ammVault: 'amm',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-01-01T00:01:00.000Z',
      totalFees: '300000',
      entryCount: 2,
      latestHash: entry2.hash,
      entries: [entry1, entry2],
    };

    const result = verifyHistoryChain(log);
    expect(result.valid).toBe(true);
  });
});

describe('verifyEntryHash', () => {
  it('should return true for valid entry hash', () => {
    const now = Date.now();
    const entry: HistoryEntry = {
      sequence: 1,
      timestamp: now,
      eventType: 'FEE',
      vaultType: 'BC',
      vault: 'vault-address',
      amount: '100000',
      balanceBefore: '0',
      balanceAfter: '100000',
      slot: 12345,
      date: new Date(now).toISOString(),
      prevHash: GENESIS_HASH,
      hash: '',
    };
    entry.hash = computeEntryHash(entry);

    expect(verifyEntryHash(entry)).toBe(true);
  });

  it('should return false for invalid entry hash', () => {
    const now = Date.now();
    const entry: HistoryEntry = {
      sequence: 1,
      timestamp: now,
      eventType: 'FEE',
      vaultType: 'BC',
      vault: 'vault-address',
      amount: '100000',
      balanceBefore: '0',
      balanceAfter: '100000',
      slot: 12345,
      date: new Date(now).toISOString(),
      prevHash: GENESIS_HASH,
      hash: 'invalid-hash',
    };

    expect(verifyEntryHash(entry)).toBe(false);
  });
});

describe('ValidatorDaemon Extended', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('start()', () => {
    it('should start successfully with healthy RPC', async () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      await expect(daemon.start()).resolves.not.toThrow();
    });

    it('should start with autoDiscover disabled', async () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        autoDiscover: false,
      });

      await expect(daemon.start()).resolves.not.toThrow();
    });

    it('should start with health check disabled', async () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        enableHealthCheck: false,
      });

      await expect(daemon.start()).resolves.not.toThrow();
    });

    it('should start with historyFile and init history manager', async () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        historyFile: '/tmp/test-daemon-start-history.json',
      });

      await expect(daemon.start()).resolves.not.toThrow();
    });

    it('should throw when RPC health check fails', async () => {
      const { RpcManager } = require('../lib/rpc-manager');
      RpcManager.mockImplementationOnce(() => ({
        checkHealth: jest.fn().mockResolvedValue({ healthy: false, error: 'RPC unreachable' }),
        getConnection: jest.fn(),
      }));

      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      await expect(daemon.start()).rejects.toThrow('RPC health check failed');
    });
  });

  describe('stop()', () => {
    it('should stop with historyManager and close it', () => {
      const { HistoryManager } = require('../lib/history-manager');
      const mockClose = jest.fn();
      HistoryManager.mockImplementationOnce(() => ({
        init: jest.fn().mockResolvedValue(undefined),
        close: mockClose,
        getMetadata: jest.fn().mockReturnValue({
          version: '1.0.0',
          creator: 'test',
          bcVault: 'bc',
          ammVault: 'amm',
          startedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          totalFees: '0',
          entryCount: 0,
          latestHash: GENESIS_HASH,
        }),
      }));

      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        historyFile: '/tmp/test-stop.json',
      });

      daemon.stop();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('getOrphanFees()', () => {
    it('should return orphan fees from fee tracker', () => {
      const { FeeTracker } = require('../lib/fee-tracker');
      FeeTracker.mockImplementationOnce(() => ({
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
        isRunning: jest.fn().mockReturnValue(false),
        getStats: jest.fn().mockReturnValue([]),
        getTotalFees: jest.fn().mockReturnValue(0n),
        getOrphanFees: jest.fn().mockReturnValue(500000n),
        fetchCurrentBalances: jest.fn().mockResolvedValue({ bc: 1000n, amm: 2000n }),
        addToken: jest.fn(),
      }));

      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      expect(daemon.getOrphanFees()).toBe(500000n);
    });
  });

  describe('fetchCurrentBalances()', () => {
    it('should fetch current balances from fee tracker', async () => {
      const { FeeTracker } = require('../lib/fee-tracker');
      FeeTracker.mockImplementationOnce(() => ({
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
        isRunning: jest.fn().mockReturnValue(false),
        getStats: jest.fn().mockReturnValue([]),
        getTotalFees: jest.fn().mockReturnValue(0n),
        getOrphanFees: jest.fn().mockReturnValue(0n),
        fetchCurrentBalances: jest.fn().mockResolvedValue({ bc: 5000000n, amm: 3000000n }),
        addToken: jest.fn(),
      }));

      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      const balances = await daemon.fetchCurrentBalances();
      expect(balances.bc).toBe(5000000n);
      expect(balances.amm).toBe(3000000n);
    });
  });
});
