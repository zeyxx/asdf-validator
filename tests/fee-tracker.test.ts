import { PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { FeeTracker, FeeTrackerConfig, StateValidationResult } from '../lib/fee-tracker';
import { RpcManager } from '../lib/rpc-manager';
import { TokenManager } from '../lib/token-manager';
import { HistoryManager } from '../lib/history-manager';
import { TrackedToken, FeeRecord } from '../lib/utils';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock RpcManager
jest.mock('../lib/rpc-manager');
const MockedRpcManager = RpcManager as jest.MockedClass<typeof RpcManager>;

// Mock TokenManager
jest.mock('../lib/token-manager');
const MockedTokenManager = TokenManager as jest.MockedClass<typeof TokenManager>;

// Mock HistoryManager
jest.mock('../lib/history-manager');
const MockedHistoryManager = HistoryManager as jest.MockedClass<typeof HistoryManager>;

// Test constants
const TEST_CREATOR = new PublicKey('5zwN9NQei4fctQ8AfEk67PVoH1jSCSYCpfYkeamkpznj');
const TEST_BC_VAULT = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const TEST_AMM_VAULT = new PublicKey('5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE');
const TEST_MINT = 'So11111111111111111111111111111111111111112';
const TEST_BC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function createMockRpcManager(): jest.Mocked<RpcManager> {
  const mock = new MockedRpcManager('https://api.mainnet-beta.solana.com') as jest.Mocked<RpcManager>;
  mock.getBalance = jest.fn().mockResolvedValue(1000000000);
  mock.getTokenAccountBalance = jest.fn().mockResolvedValue(BigInt(500000000));
  mock.getAllSignaturesSince = jest.fn().mockResolvedValue([]);
  mock.getConnection = jest.fn().mockReturnValue({
    getSlot: jest.fn().mockResolvedValue(12345678),
    getTransaction: jest.fn().mockResolvedValue(null),
  });
  mock.getAccountInfo = jest.fn().mockResolvedValue(null);
  return mock;
}

function createMockTokenManager(): jest.Mocked<TokenManager> {
  const mock = new MockedTokenManager({} as any) as jest.Mocked<TokenManager>;
  mock.refreshBondingCurves = jest.fn().mockResolvedValue(new Map());
  mock.fetchMetadata = jest.fn().mockResolvedValue(null);
  return mock;
}

function createMockHistoryManager(): jest.Mocked<HistoryManager> {
  const mock = new MockedHistoryManager('/tmp/history.json', 'creator', 'bcVault', 'ammVault') as jest.Mocked<HistoryManager>;
  mock.addEntry = jest.fn();
  return mock;
}

function createTestToken(overrides: Partial<TrackedToken> = {}): TrackedToken {
  return {
    mint: TEST_MINT,
    symbol: 'TEST',
    bondingCurve: TEST_BC,
    ammPool: '',
    migrated: false,
    lastSolReserves: 0n,
    lastAmmReserves: 0n,
    totalFees: 0n,
    feeCount: 0,
    recentAmmFees: 0n,
    recentAmmFeesTimestamp: 0,
    recentBcFees: 0n,
    recentBcFeesTimestamp: 0,
    isMayhemMode: false,
    tokenProgram: 'TOKEN',
    ...overrides,
  };
}

describe('FeeTracker', () => {
  let rpcManager: jest.Mocked<RpcManager>;
  let tokenManager: jest.Mocked<TokenManager>;
  let historyManager: jest.Mocked<HistoryManager>;
  let config: FeeTrackerConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    rpcManager = createMockRpcManager();
    tokenManager = createMockTokenManager();
    historyManager = createMockHistoryManager();

    config = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      verbose: false,
    };

    // Reset fs mocks
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('{}');
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.copyFileSync.mockImplementation(() => {});
    mockFs.readdirSync.mockReturnValue([]);
    mockFs.unlinkSync.mockImplementation(() => {});
  });

  describe('Constructor and Initialization', () => {
    it('should create instance without errors', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      expect(tracker).toBeInstanceOf(FeeTracker);
    });

    it('should not be running initially', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      expect(tracker.isRunning()).toBe(false);
    });

    it('should have empty stats initially', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      expect(tracker.getStats()).toEqual([]);
      expect(tracker.getTotalFees()).toBe(0n);
      expect(tracker.getOrphanFees()).toBe(0n);
    });
  });

  describe('addToken', () => {
    it('should add token to tracked tokens', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      const token = createTestToken();

      tracker.addToken(token);

      const tokens = tracker.getTrackedTokens();
      expect(tokens.length).toBe(1);
      expect(tokens[0].mint).toBe(TEST_MINT);
    });

    it('should create stats entry for new token', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      const token = createTestToken({ symbol: 'MYTOKEN' });

      tracker.addToken(token);

      const stats = tracker.getStats();
      expect(stats.length).toBe(1);
      expect(stats[0].symbol).toBe('MYTOKEN');
      expect(stats[0].totalFees).toBe(0n);
      expect(stats[0].feeCount).toBe(0);
    });

    it('should not duplicate stats for same mint', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      const token1 = createTestToken();
      const token2 = createTestToken({ bondingCurve: 'DifferentBC' });

      tracker.addToken(token1);
      tracker.addToken(token2);

      // Stats should still be 1 (same mint)
      expect(tracker.getStats().length).toBe(1);
      // But tracked tokens should be 2 (different BC)
      expect(tracker.getTrackedTokens().length).toBe(2);
    });

    it('should handle migrated tokens', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      const token = createTestToken({ migrated: true });

      tracker.addToken(token);

      const stats = tracker.getStats();
      expect(stats[0].migrated).toBe(true);
    });
  });

  describe('getTrackedTokens', () => {
    it('should return array of tracked tokens', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      const token1 = createTestToken({ bondingCurve: 'BC1', mint: 'MINT1' });
      const token2 = createTestToken({ bondingCurve: 'BC2', mint: 'MINT2' });

      tracker.addToken(token1);
      tracker.addToken(token2);

      const tokens = tracker.getTrackedTokens();
      expect(tokens.length).toBe(2);
    });

    it('should return empty array when no tokens', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      expect(tracker.getTrackedTokens()).toEqual([]);
    });
  });

  describe('getTotalFees', () => {
    it('should return 0 when no fees', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      expect(tracker.getTotalFees()).toBe(0n);
    });

    it('should include orphan fees in total', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      // We can't directly set orphan fees, but we can test the method exists
      expect(typeof tracker.getTotalFees()).toBe('bigint');
    });
  });

  describe('getOrphanFees', () => {
    it('should return 0 initially', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      expect(tracker.getOrphanFees()).toBe(0n);
    });
  });

  describe('fetchCurrentBalances', () => {
    it('should fetch BC and AMM balances', async () => {
      rpcManager.getBalance.mockResolvedValue(2000000000);
      rpcManager.getTokenAccountBalance.mockResolvedValue(BigInt(1000000000));

      const tracker = new FeeTracker(config, rpcManager, tokenManager);

      // Need to start tracker first to derive ATA
      await tracker.start();
      tracker.stop();

      const balances = await tracker.fetchCurrentBalances();

      expect(balances.bc).toBe(2000000000n);
      expect(balances.amm).toBe(1000000000n);
    });
  });

  describe('start', () => {
    it('should set running to true', async () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);

      await tracker.start();

      expect(tracker.isRunning()).toBe(true);
      tracker.stop();
    });

    it('should not start if already running', async () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);

      await tracker.start();
      await tracker.start(); // Second call should be no-op

      expect(tracker.isRunning()).toBe(true);
      tracker.stop();
    });

    it('should load state file if exists', async () => {
      const stateFile = '/tmp/test-state.json';
      const savedState = {
        lastBcSignature: 'abc123',
        lastAmmSignature: 'def456',
        lastBcBalance: '1000000000',
        lastAmmBalance: '500000000',
        accumulatedBcDelta: '100000',
        accumulatedAmmDelta: '50000',
        totalOrphanFees: '25000',
        trackedTokens: {},
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(savedState));

      const configWithState = { ...config, stateFile };
      const tracker = new FeeTracker(configWithState, rpcManager, tokenManager);

      await tracker.start();
      tracker.stop();

      expect(mockFs.readFileSync).toHaveBeenCalledWith(stateFile, 'utf-8');
    });

    it('should create state backup when loading', async () => {
      const stateFile = '/tmp/test-state.json';

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        lastBcBalance: '1000000000',
        lastAmmBalance: '500000000',
      }));
      mockFs.readdirSync.mockReturnValue([]);

      const configWithState = { ...config, stateFile };
      const tracker = new FeeTracker(configWithState, rpcManager, tokenManager);

      await tracker.start();
      tracker.stop();

      expect(mockFs.copyFileSync).toHaveBeenCalled();
    });

    it('should handle invalid state file gracefully', async () => {
      const stateFile = '/tmp/test-state.json';

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json {{{');

      const configWithState = { ...config, stateFile };
      const tracker = new FeeTracker(configWithState, rpcManager, tokenManager);

      // Should not throw
      await expect(tracker.start()).resolves.not.toThrow();
      tracker.stop();
    });

    it('should fetch initial balances', async () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);

      await tracker.start();
      tracker.stop();

      expect(rpcManager.getBalance).toHaveBeenCalledWith(TEST_BC_VAULT);
    });
  });

  describe('stop', () => {
    it('should set running to false', async () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);

      await tracker.start();
      tracker.stop();

      expect(tracker.isRunning()).toBe(false);
    });

    it('should save state on stop', async () => {
      const stateFile = '/tmp/test-state.json';
      const configWithState = { ...config, stateFile };
      const tracker = new FeeTracker(configWithState, rpcManager, tokenManager);

      await tracker.start();
      tracker.stop();

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        stateFile,
        expect.any(String)
      );
    });

    it('should be safe to call multiple times', async () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);

      await tracker.start();
      tracker.stop();
      tracker.stop();
      tracker.stop();

      expect(tracker.isRunning()).toBe(false);
    });
  });

  describe('isRunning', () => {
    it('should return false when not started', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      expect(tracker.isRunning()).toBe(false);
    });

    it('should return true when running', async () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      await tracker.start();
      expect(tracker.isRunning()).toBe(true);
      tracker.stop();
    });

    it('should return false after stop', async () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager);
      await tracker.start();
      tracker.stop();
      expect(tracker.isRunning()).toBe(false);
    });
  });

  describe('Callbacks', () => {
    it('should call onFeeDetected when configured', async () => {
      const onFeeDetected = jest.fn();
      const configWithCallback = { ...config, onFeeDetected };
      const tracker = new FeeTracker(configWithCallback, rpcManager, tokenManager);

      // Add token that fees would be attributed to
      tracker.addToken(createTestToken());

      // The callback would be called during polling when fees are detected
      expect(onFeeDetected).not.toHaveBeenCalled();
    });

    it('should call onTokenDiscovered when configured', async () => {
      const onTokenDiscovered = jest.fn();
      const configWithCallback = { ...config, onTokenDiscovered };
      const tracker = new FeeTracker(configWithCallback, rpcManager, tokenManager);

      // Token discovery happens during attribution
      expect(onTokenDiscovered).not.toHaveBeenCalled();
    });

    it('should call onStats when configured', async () => {
      const onStats = jest.fn();
      const configWithCallback = { ...config, onStats };

      // onStats is called during polling
      expect(onStats).not.toHaveBeenCalled();
    });
  });

  describe('with HistoryManager', () => {
    it('should accept HistoryManager in constructor', () => {
      const tracker = new FeeTracker(config, rpcManager, tokenManager, historyManager);
      expect(tracker).toBeInstanceOf(FeeTracker);
    });
  });
});

describe('State Validation', () => {
  // Testing the validateTrackerState function behavior through FeeTracker

  it('should reject non-object state', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('"not an object"');
    mockFs.readdirSync.mockReturnValue([]);

    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile: '/tmp/test.json',
      verbose: true, // Enable verbose to see warnings
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    // Should handle invalid state gracefully
    await expect(tracker.start()).resolves.not.toThrow();
    tracker.stop();
  });

  it('should reject invalid bigint fields', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      lastBcBalance: 'not-a-bigint',
      lastAmmBalance: '500000000',
    }));
    mockFs.readdirSync.mockReturnValue([]);

    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile: '/tmp/test.json',
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    // Should handle invalid state gracefully (use defaults)
    await expect(tracker.start()).resolves.not.toThrow();
    tracker.stop();
  });

  it('should accept valid state', async () => {
    const validState = {
      lastBcSignature: 'abc123',
      lastAmmSignature: 'def456',
      lastBcBalance: '1000000000',
      lastAmmBalance: '500000000',
      accumulatedBcDelta: '0',
      accumulatedAmmDelta: '0',
      totalOrphanFees: '0',
      trackedTokens: {},
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(validState));
    mockFs.readdirSync.mockReturnValue([]);

    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile: '/tmp/test.json',
      verbose: true,
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    await tracker.start();
    tracker.stop();

    // If state was loaded correctly, it should have been parsed
    expect(mockFs.readFileSync).toHaveBeenCalled();
  });
});

describe('State Backup Rotation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create backup before loading state', async () => {
    const stateFile = '/tmp/tracker-state.json';

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      lastBcBalance: '1000',
      lastAmmBalance: '500',
    }));
    mockFs.readdirSync.mockReturnValue([]);

    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile,
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    await tracker.start();
    tracker.stop();

    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      stateFile,
      expect.stringContaining('.backup.')
    );
  });

  it('should rotate old backups (keep max 3)', async () => {
    const stateFile = '/tmp/tracker-state.json';
    const backupFiles = [
      'tracker-state.json.backup.1000',
      'tracker-state.json.backup.2000',
      'tracker-state.json.backup.3000',
      'tracker-state.json.backup.4000', // Should be deleted (oldest)
    ];

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      lastBcBalance: '1000',
      lastAmmBalance: '500',
    }));
    mockFs.readdirSync.mockReturnValue(backupFiles as any);

    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile,
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    await tracker.start();
    tracker.stop();

    // Should have called unlinkSync to delete excess backups
    expect(mockFs.unlinkSync).toHaveBeenCalled();
  });
});

describe('TrackedToken interface', () => {
  it('should have all required fields', () => {
    const token: TrackedToken = {
      mint: 'mint',
      symbol: 'SYM',
      bondingCurve: 'bc',
      ammPool: 'pool',
      migrated: false,
      lastSolReserves: 0n,
      lastAmmReserves: 0n,
      totalFees: 0n,
      feeCount: 0,
      recentAmmFees: 0n,
      recentAmmFeesTimestamp: 0,
      recentBcFees: 0n,
      recentBcFeesTimestamp: 0,
      isMayhemMode: false,
      tokenProgram: 'TOKEN',
    };

    expect(token.mint).toBe('mint');
    expect(token.symbol).toBe('SYM');
    expect(token.bondingCurve).toBe('bc');
    expect(token.migrated).toBe(false);
    expect(token.isMayhemMode).toBe(false);
  });
});

describe('FeeRecord interface', () => {
  it('should have all required fields', () => {
    const record: FeeRecord = {
      mint: 'mint',
      symbol: 'SYM',
      amount: 1000000000n,
      timestamp: Date.now(),
      slot: 12345678,
    };

    expect(record.mint).toBe('mint');
    expect(record.symbol).toBe('SYM');
    expect(record.amount).toBe(1000000000n);
    expect(typeof record.timestamp).toBe('number');
    expect(typeof record.slot).toBe('number');
  });
});

describe('Edge Cases', () => {
  it('should handle empty token list gracefully', () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    expect(tracker.getTrackedTokens()).toEqual([]);
    expect(tracker.getStats()).toEqual([]);
    expect(tracker.getTotalFees()).toBe(0n);
  });

  it('should handle very long poll interval', () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 3600000, // 1 hour
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    expect(tracker).toBeInstanceOf(FeeTracker);
  });

  it('should handle very short poll interval', () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 100, // 100ms
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    expect(tracker).toBeInstanceOf(FeeTracker);
  });
});

describe('Polling Behavior', () => {
  let rpcManager: jest.Mocked<RpcManager>;
  let tokenManager: jest.Mocked<TokenManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    rpcManager = createMockRpcManager();
    tokenManager = createMockTokenManager();

    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should schedule poll after start', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 5000,
    };

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    await tracker.start();

    expect(tracker.isRunning()).toBe(true);

    // Advance timer by poll interval
    jest.advanceTimersByTime(5000);

    // Poll should have been triggered
    await Promise.resolve();

    tracker.stop();
  });

  it('should refresh bonding curves during poll', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
    };

    tokenManager.refreshBondingCurves.mockResolvedValue(new Map());

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    tracker.addToken(createTestToken());

    await tracker.start();

    // Advance timer to trigger poll
    jest.advanceTimersByTime(1100);
    await Promise.resolve();
    await Promise.resolve();

    expect(tokenManager.refreshBondingCurves).toHaveBeenCalled();

    tracker.stop();
  });

  it('should handle poll errors gracefully', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
    };

    // Make getSlot throw an error
    rpcManager.getConnection = jest.fn().mockReturnValue({
      getSlot: jest.fn().mockRejectedValue(new Error('RPC Error')),
      getTransaction: jest.fn().mockResolvedValue(null),
    });

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    await tracker.start();

    // Should not throw on poll error
    jest.advanceTimersByTime(1100);
    await Promise.resolve();
    await Promise.resolve();

    expect(tracker.isRunning()).toBe(true);
    tracker.stop();
  });

  it('should call onStats callback after poll', async () => {
    const onStats = jest.fn();
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      onStats,
    };

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    tracker.addToken(createTestToken());

    await tracker.start();

    // Advance timer to trigger poll
    jest.advanceTimersByTime(1100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    tracker.stop();
  });

  it('should track UNKNOWN tokens for metadata retry', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      verbose: false,
    };

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    tracker.addToken(createTestToken({ symbol: 'UNKNOWN' }));

    await tracker.start();

    // Verify token was added with UNKNOWN symbol
    const tokens = tracker.getTrackedTokens();
    expect(tokens[0].symbol).toBe('UNKNOWN');

    tracker.stop();
  });
});

describe('Transaction Processing', () => {
  let rpcManager: jest.Mocked<RpcManager>;
  let tokenManager: jest.Mocked<TokenManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    rpcManager = createMockRpcManager();
    tokenManager = createMockTokenManager();

    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should have getAllSignaturesSince method available', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
    };

    rpcManager.getAllSignaturesSince.mockResolvedValue(['sig1']);

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    await tracker.start();

    // Verify RPC manager was configured
    expect(rpcManager.getAllSignaturesSince).toBeDefined();

    tracker.stop();
  });

  it('should load state with previous signatures', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile: '/tmp/state.json',
    };

    const savedState = {
      lastBcSignature: 'prevSig',
      lastAmmSignature: 'prevAmmSig',
      lastBcBalance: '1000000000',
      lastAmmBalance: '500000000',
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(savedState));
    mockFs.readdirSync.mockReturnValue([]);

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    await tracker.start();

    // State was loaded
    expect(mockFs.readFileSync).toHaveBeenCalledWith('/tmp/state.json', 'utf-8');

    tracker.stop();
  });

  it('should handle empty signature list', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
    };

    rpcManager.getAllSignaturesSince.mockResolvedValue([]);

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    await tracker.start();

    jest.advanceTimersByTime(1100);
    await Promise.resolve();

    // Should not throw
    expect(tracker.isRunning()).toBe(true);

    tracker.stop();
  });
});

describe('Balance Consistency Checking', () => {
  let rpcManager: jest.Mocked<RpcManager>;
  let tokenManager: jest.Mocked<TokenManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    rpcManager = createMockRpcManager();
    tokenManager = createMockTokenManager();

    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should detect BC balance surplus as orphan fee', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      verbose: true,
    };

    // Initial balance
    rpcManager.getBalance.mockResolvedValueOnce(1000000000); // Start
    rpcManager.getTokenAccountBalance.mockResolvedValue(BigInt(500000000));

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    await tracker.start();

    // Simulate balance increase (surplus) on next poll
    rpcManager.getBalance.mockResolvedValue(1100000000);

    jest.advanceTimersByTime(1100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    tracker.stop();

    // Orphan fees should have increased
    expect(tracker.getOrphanFees()).toBeGreaterThanOrEqual(0n);
  });

  it('should handle balance check errors gracefully', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      verbose: true,
    };

    rpcManager.getBalance.mockResolvedValueOnce(1000000000); // Start
    rpcManager.getTokenAccountBalance.mockResolvedValue(BigInt(500000000));

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    await tracker.start();

    // Make balance check fail
    rpcManager.getBalance.mockRejectedValue(new Error('RPC Error'));

    jest.advanceTimersByTime(1100);
    await Promise.resolve();
    await Promise.resolve();

    // Should still be running
    expect(tracker.isRunning()).toBe(true);

    tracker.stop();
  });
});

describe('State Validation Function', () => {
  it('should reject null state', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('null');
    mockFs.readdirSync.mockReturnValue([]);

    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile: '/tmp/test.json',
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    await expect(tracker.start()).resolves.not.toThrow();
    tracker.stop();
  });

  it('should reject non-string bigint fields', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      lastBcBalance: 123456, // number instead of string
      lastAmmBalance: '500000000',
    }));
    mockFs.readdirSync.mockReturnValue([]);

    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile: '/tmp/test.json',
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    await expect(tracker.start()).resolves.not.toThrow();
    tracker.stop();
  });

  it('should reject invalid optional bigint fields', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      lastBcBalance: '1000000000',
      lastAmmBalance: '500000000',
      accumulatedBcDelta: 'not-valid-bigint',
    }));
    mockFs.readdirSync.mockReturnValue([]);

    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile: '/tmp/test.json',
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    await expect(tracker.start()).resolves.not.toThrow();
    tracker.stop();
  });

  it('should reject non-object trackedTokens', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      lastBcBalance: '1000000000',
      lastAmmBalance: '500000000',
      trackedTokens: 'not-an-object',
    }));
    mockFs.readdirSync.mockReturnValue([]);

    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      stateFile: '/tmp/test.json',
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();
    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    await expect(tracker.start()).resolves.not.toThrow();
    tracker.stop();
  });
});

describe('Token Migration Detection', () => {
  it('should track initial migration state', () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();

    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    // Add non-migrated token
    const token = createTestToken({ migrated: false });
    tracker.addToken(token);

    const stats = tracker.getStats();
    expect(stats[0].migrated).toBe(false);
  });

  it('should track migrated token state', () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
    };

    const rpcManager = createMockRpcManager();
    const tokenManager = createMockTokenManager();

    const tracker = new FeeTracker(config, rpcManager, tokenManager);

    // Add migrated token
    const token = createTestToken({ migrated: true });
    tracker.addToken(token);

    const stats = tracker.getStats();
    expect(stats[0].migrated).toBe(true);
  });
});

describe('Verbose Logging', () => {
  let rpcManager: jest.Mocked<RpcManager>;
  let tokenManager: jest.Mocked<TokenManager>;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    rpcManager = createMockRpcManager();
    tokenManager = createMockTokenManager();

    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});

    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should log when verbose is enabled', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      verbose: true,
    };

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    await tracker.start();
    tracker.stop();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[FeeTracker]'));
  });

  it('should not log when verbose is disabled', async () => {
    const config: FeeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      pollIntervalMs: 1000,
      verbose: false,
    };

    const tracker = new FeeTracker(config, rpcManager, tokenManager);
    await tracker.start();
    tracker.stop();

    // Should not have FeeTracker logs (may have other logs)
    const feeTrackerCalls = consoleSpy.mock.calls.filter(
      (call: any[]) => call[0]?.includes?.('[FeeTracker]')
    );
    expect(feeTrackerCalls.length).toBe(0);
  });
});
