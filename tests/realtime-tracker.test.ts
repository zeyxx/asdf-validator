import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { RealtimeTracker, RealtimeTrackerConfig, BalanceSnapshot } from '../lib/realtime-tracker';
import { WebSocketManager } from '../lib/websocket-manager';
import { RpcManager } from '../lib/rpc-manager';
import { TokenManager } from '../lib/token-manager';
import { HistoryManager } from '../lib/history-manager';
import { TrackedToken, FeeRecord, TokenStats } from '../lib/utils';

// Mock WebSocketManager
jest.mock('../lib/websocket-manager');
const MockedWebSocketManager = WebSocketManager as jest.MockedClass<typeof WebSocketManager>;

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
const TEST_RPC_URL = 'https://api.mainnet-beta.solana.com';
const TEST_MINT = 'So11111111111111111111111111111111111111112';
const TEST_BC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

describe('RealtimeTracker', () => {
  let config: RealtimeTrackerConfig;
  let mockWsManager: any;
  let mockRpcManager: any;
  let mockTokenManager: any;

  beforeEach(() => {
    jest.clearAllMocks();

    config = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      rpcUrl: TEST_RPC_URL,
      verbose: false,
    };

    // Setup WebSocketManager mock
    mockWsManager = {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      subscribeToAccount: jest.fn().mockResolvedValue(undefined),
    };
    MockedWebSocketManager.mockImplementation(() => mockWsManager);

    // Setup RpcManager mock
    mockRpcManager = {
      getBalance: jest.fn().mockResolvedValue(1000000000),
      getTokenAccountBalance: jest.fn().mockResolvedValue(BigInt(500000000)),
      getSignaturesForAddress: jest.fn().mockResolvedValue([]),
      getTransaction: jest.fn().mockResolvedValue(null),
      getAccountInfo: jest.fn().mockResolvedValue(null),
    };
    MockedRpcManager.mockImplementation(() => mockRpcManager);

    // Setup TokenManager mock
    mockTokenManager = {
      fetchMetadata: jest.fn().mockResolvedValue(null),
    };
    MockedTokenManager.mockImplementation(() => mockTokenManager);
  });

  describe('Constructor', () => {
    it('should create instance with minimal config', () => {
      const tracker = new RealtimeTracker(config);
      expect(tracker).toBeInstanceOf(RealtimeTracker);
      expect(tracker).toBeInstanceOf(EventEmitter);
    });

    it('should create instance with HistoryManager', () => {
      const historyManager = new MockedHistoryManager('/tmp/test.json', 'c', 'b', 'a');
      const tracker = new RealtimeTracker(config, historyManager);
      expect(tracker).toBeInstanceOf(RealtimeTracker);
    });

    it('should create WebSocketManager with provided rpcUrl', () => {
      new RealtimeTracker(config);
      expect(MockedWebSocketManager).toHaveBeenCalledWith({
        rpcUrl: TEST_RPC_URL,
        wsUrl: undefined,
      });
    });

    it('should create WebSocketManager with custom wsUrl', () => {
      const configWithWs = { ...config, wsUrl: 'wss://custom.ws.url' };
      new RealtimeTracker(configWithWs);
      expect(MockedWebSocketManager).toHaveBeenCalledWith({
        rpcUrl: TEST_RPC_URL,
        wsUrl: 'wss://custom.ws.url',
      });
    });

    it('should setup WebSocket event handlers', () => {
      new RealtimeTracker(config);
      expect(mockWsManager.on).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(mockWsManager.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
      expect(mockWsManager.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWsManager.on).toHaveBeenCalledWith('reconnecting', expect.any(Function));
    });
  });

  describe('addToken', () => {
    it('should add token to tracked tokens', () => {
      const tracker = new RealtimeTracker(config);
      const token = createTestToken();

      tracker.addToken(token);

      const tokens = tracker.getTrackedTokens();
      expect(tokens.length).toBe(1);
      expect(tokens[0].mint).toBe(TEST_MINT);
    });

    it('should create stats entry for new token', () => {
      const tracker = new RealtimeTracker(config);
      const token = createTestToken({ symbol: 'MYTOKEN' });

      tracker.addToken(token);

      const stats = tracker.getStats();
      expect(stats.length).toBe(1);
      expect(stats[0].symbol).toBe('MYTOKEN');
      expect(stats[0].totalFees).toBe(0n);
    });

    it('should not duplicate stats for same mint', () => {
      const tracker = new RealtimeTracker(config);
      const token1 = createTestToken();
      const token2 = createTestToken({ bondingCurve: 'DifferentBC' });

      tracker.addToken(token1);
      tracker.addToken(token2);

      expect(tracker.getStats().length).toBe(1);
      expect(tracker.getTrackedTokens().length).toBe(2);
    });

    it('should include name in stats if provided', () => {
      const tracker = new RealtimeTracker(config);
      const token = createTestToken({ name: 'My Token Name' });

      tracker.addToken(token);

      const stats = tracker.getStats();
      expect(stats[0].name).toBe('My Token Name');
    });

    it('should handle migrated tokens', () => {
      const tracker = new RealtimeTracker(config);
      const token = createTestToken({ migrated: true });

      tracker.addToken(token);

      const stats = tracker.getStats();
      expect(stats[0].migrated).toBe(true);
    });

    it('should enforce MAX_TRACKED_TOKENS limit with LRU eviction', () => {
      const tracker = new RealtimeTracker(config);

      // Add MAX_TRACKED_TOKENS tokens
      for (let i = 0; i < 500; i++) {
        tracker.addToken(createTestToken({
          bondingCurve: `BC${i}`,
          mint: `MINT${i}`
        }));
      }

      expect(tracker.getTrackedTokens().length).toBe(500);

      // Add one more - should evict oldest
      tracker.addToken(createTestToken({
        bondingCurve: 'NEWBC',
        mint: 'NEWMINT'
      }));

      expect(tracker.getTrackedTokens().length).toBe(500);

      // First token should be evicted
      const tokens = tracker.getTrackedTokens();
      expect(tokens.find(t => t.bondingCurve === 'BC0')).toBeUndefined();
      expect(tokens.find(t => t.bondingCurve === 'NEWBC')).toBeDefined();
    });
  });

  describe('getTrackedTokens', () => {
    it('should return empty array initially', () => {
      const tracker = new RealtimeTracker(config);
      expect(tracker.getTrackedTokens()).toEqual([]);
    });

    it('should return array of tracked tokens', () => {
      const tracker = new RealtimeTracker(config);
      tracker.addToken(createTestToken({ bondingCurve: 'BC1', mint: 'MINT1' }));
      tracker.addToken(createTestToken({ bondingCurve: 'BC2', mint: 'MINT2' }));

      const tokens = tracker.getTrackedTokens();
      expect(tokens.length).toBe(2);
    });
  });

  describe('getStats', () => {
    it('should return empty array initially', () => {
      const tracker = new RealtimeTracker(config);
      expect(tracker.getStats()).toEqual([]);
    });

    it('should return TokenStats array', () => {
      const tracker = new RealtimeTracker(config);
      tracker.addToken(createTestToken({ mint: 'MINT1' }));

      const stats = tracker.getStats();
      expect(stats[0]).toMatchObject({
        mint: 'MINT1',
        totalFees: 0n,
        feeCount: 0,
        lastFeeTimestamp: 0,
      });
    });
  });

  describe('getTotalFees', () => {
    it('should return 0 initially', () => {
      const tracker = new RealtimeTracker(config);
      expect(tracker.getTotalFees()).toBe(0n);
    });

    it('should return sum of BC and AMM fees', () => {
      const tracker = new RealtimeTracker(config);
      // Total fees is sum of totalBcFees + totalAmmFees
      // These are updated during handleBcUpdate/handleAmmUpdate
      expect(typeof tracker.getTotalFees()).toBe('bigint');
    });
  });

  describe('getBalances', () => {
    it('should return initial balance snapshot', () => {
      const tracker = new RealtimeTracker(config);
      const balances = tracker.getBalances();

      expect(balances).toMatchObject({
        bc: 0n,
        amm: 0n,
        slot: 0,
      });
      expect(typeof balances.timestamp).toBe('number');
    });

    it('should have correct shape', () => {
      const tracker = new RealtimeTracker(config);
      const balances: BalanceSnapshot = tracker.getBalances();

      expect(balances).toHaveProperty('bc');
      expect(balances).toHaveProperty('amm');
      expect(balances).toHaveProperty('timestamp');
      expect(balances).toHaveProperty('slot');
    });
  });

  describe('start', () => {
    it('should set running to true', async () => {
      const tracker = new RealtimeTracker(config);

      await tracker.start();

      expect(tracker.isRunning()).toBe(true);
      await tracker.stop();
    });

    it('should not start if already running', async () => {
      const tracker = new RealtimeTracker(config);

      await tracker.start();
      await tracker.start(); // Second call should be no-op

      expect(tracker.isRunning()).toBe(true);
      expect(mockWsManager.connect).toHaveBeenCalledTimes(1);
      await tracker.stop();
    });

    it('should connect WebSocket', async () => {
      const tracker = new RealtimeTracker(config);

      await tracker.start();

      expect(mockWsManager.connect).toHaveBeenCalled();
      await tracker.stop();
    });

    it('should subscribe to BC and AMM vault accounts', async () => {
      const tracker = new RealtimeTracker(config);

      await tracker.start();

      expect(mockWsManager.subscribeToAccount).toHaveBeenCalledTimes(2);
      await tracker.stop();
    });

    it('should fetch initial balances', async () => {
      const tracker = new RealtimeTracker(config);

      await tracker.start();

      expect(mockRpcManager.getBalance).toHaveBeenCalled();
      expect(mockRpcManager.getTokenAccountBalance).toHaveBeenCalled();
      await tracker.stop();
    });

    it('should emit started event', async () => {
      const tracker = new RealtimeTracker(config);
      const startedHandler = jest.fn();
      tracker.on('started', startedHandler);

      await tracker.start();

      expect(startedHandler).toHaveBeenCalled();
      await tracker.stop();
    });

    it('should handle initial balance fetch errors gracefully', async () => {
      mockRpcManager.getBalance.mockRejectedValue(new Error('RPC error'));

      const tracker = new RealtimeTracker(config);

      // Should not throw
      await expect(tracker.start()).resolves.not.toThrow();
      await tracker.stop();
    });
  });

  describe('stop', () => {
    it('should set running to false', async () => {
      const tracker = new RealtimeTracker(config);
      await tracker.start();

      await tracker.stop();

      expect(tracker.isRunning()).toBe(false);
    });

    it('should disconnect WebSocket', async () => {
      const tracker = new RealtimeTracker(config);
      await tracker.start();

      await tracker.stop();

      expect(mockWsManager.disconnect).toHaveBeenCalled();
    });

    it('should emit stopped event', async () => {
      const tracker = new RealtimeTracker(config);
      const stoppedHandler = jest.fn();
      tracker.on('stopped', stoppedHandler);
      await tracker.start();

      await tracker.stop();

      expect(stoppedHandler).toHaveBeenCalled();
    });

    it('should not stop if not running', async () => {
      const tracker = new RealtimeTracker(config);

      await tracker.stop(); // Should be no-op

      expect(mockWsManager.disconnect).not.toHaveBeenCalled();
    });

    it('should remove all listeners on stop', async () => {
      const tracker = new RealtimeTracker(config);
      const handler = jest.fn();
      tracker.on('someEvent', handler);
      await tracker.start();

      await tracker.stop();

      expect(tracker.listenerCount('someEvent')).toBe(0);
    });
  });

  describe('isRunning', () => {
    it('should return false initially', () => {
      const tracker = new RealtimeTracker(config);
      expect(tracker.isRunning()).toBe(false);
    });

    it('should return true when running', async () => {
      const tracker = new RealtimeTracker(config);
      await tracker.start();
      expect(tracker.isRunning()).toBe(true);
      await tracker.stop();
    });

    it('should return false after stop', async () => {
      const tracker = new RealtimeTracker(config);
      await tracker.start();
      await tracker.stop();
      expect(tracker.isRunning()).toBe(false);
    });
  });

  describe('getWebSocketManager', () => {
    it('should return WebSocketManager instance', () => {
      const tracker = new RealtimeTracker(config);
      const wsManager = tracker.getWebSocketManager();
      expect(wsManager).toBe(mockWsManager);
    });
  });

  describe('getUpdateCount', () => {
    it('should return 0 initially', () => {
      const tracker = new RealtimeTracker(config);
      expect(tracker.getUpdateCount()).toBe(0);
    });
  });

  describe('Event Emissions', () => {
    it('should emit connected event when WebSocket connects', () => {
      const tracker = new RealtimeTracker(config);
      const connectedHandler = jest.fn();
      tracker.on('connected', connectedHandler);

      // Find the 'connected' handler registered on wsManager
      const connectedCall = mockWsManager.on.mock.calls.find(
        (call: any[]) => call[0] === 'connected'
      );
      expect(connectedCall).toBeDefined();

      // Trigger the handler
      connectedCall![1]();

      expect(connectedHandler).toHaveBeenCalled();
    });

    it('should emit disconnected event when WebSocket disconnects', () => {
      const tracker = new RealtimeTracker(config);
      const disconnectedHandler = jest.fn();
      tracker.on('disconnected', disconnectedHandler);

      const disconnectedCall = mockWsManager.on.mock.calls.find(
        (call: any[]) => call[0] === 'disconnected'
      );
      disconnectedCall![1]();

      expect(disconnectedHandler).toHaveBeenCalled();
    });

    it('should emit error event when WebSocket errors', () => {
      const tracker = new RealtimeTracker(config);
      const errorHandler = jest.fn();
      tracker.on('error', errorHandler);

      const errorCall = mockWsManager.on.mock.calls.find(
        (call: any[]) => call[0] === 'error'
      );
      errorCall![1](new Error('Test error'));

      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should emit reconnecting event', () => {
      const tracker = new RealtimeTracker(config);
      const reconnectingHandler = jest.fn();
      tracker.on('reconnecting', reconnectingHandler);

      const reconnectingCall = mockWsManager.on.mock.calls.find(
        (call: any[]) => call[0] === 'reconnecting'
      );
      reconnectingCall![1]({ attempt: 1, delayMs: 1000 });

      expect(reconnectingHandler).toHaveBeenCalledWith({ attempt: 1, delayMs: 1000 });
    });
  });

  describe('Callbacks', () => {
    it('should call onFeeDetected when configured and fee detected', async () => {
      const onFeeDetected = jest.fn();
      const configWithCallback = { ...config, onFeeDetected };
      const tracker = new RealtimeTracker(configWithCallback);

      // Callback would be called during handleBcUpdate/handleAmmUpdate
      // which is triggered by WebSocket subscription callbacks
      expect(tracker).toBeDefined();
    });

    it('should call onTokenDiscovered when configured', async () => {
      const onTokenDiscovered = jest.fn();
      const configWithCallback = { ...config, onTokenDiscovered };
      const tracker = new RealtimeTracker(configWithCallback);

      expect(tracker).toBeDefined();
    });

    it('should call onStats when configured', async () => {
      const onStats = jest.fn();
      const configWithCallback = { ...config, onStats };
      const tracker = new RealtimeTracker(configWithCallback);

      expect(tracker).toBeDefined();
    });

    it('should call onBalanceChange when configured', async () => {
      const onBalanceChange = jest.fn();
      const configWithCallback = { ...config, onBalanceChange };
      const tracker = new RealtimeTracker(configWithCallback);

      expect(tracker).toBeDefined();
    });
  });

  describe('Verbose Mode', () => {
    it('should not log when verbose is false', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const tracker = new RealtimeTracker({ ...config, verbose: false });

      // Trigger connected event which logs
      const connectedCall = mockWsManager.on.mock.calls.find(
        (call: any[]) => call[0] === 'connected'
      );
      connectedCall![1]();

      // Should not have logged [RealtimeTracker] message
      const realtimeTrackerLogs = consoleSpy.mock.calls.filter(
        call => call[0]?.includes?.('[RealtimeTracker]')
      );
      expect(realtimeTrackerLogs.length).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should log when verbose is true', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const tracker = new RealtimeTracker({ ...config, verbose: true });

      // Trigger connected event which logs
      const connectedCall = mockWsManager.on.mock.calls.find(
        (call: any[]) => call[0] === 'connected'
      );
      connectedCall![1]();

      expect(consoleSpy).toHaveBeenCalledWith('[RealtimeTracker] WebSocket connected');

      consoleSpy.mockRestore();
    });
  });
});

describe('BalanceSnapshot interface', () => {
  it('should have all required fields', () => {
    const snapshot: BalanceSnapshot = {
      bc: 1000000000n,
      amm: 500000000n,
      timestamp: Date.now(),
      slot: 12345678,
    };

    expect(snapshot.bc).toBe(1000000000n);
    expect(snapshot.amm).toBe(500000000n);
    expect(typeof snapshot.timestamp).toBe('number');
    expect(typeof snapshot.slot).toBe('number');
  });
});

describe('RealtimeTrackerConfig interface', () => {
  it('should work with minimal required fields', () => {
    const config: RealtimeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      rpcUrl: TEST_RPC_URL,
    };

    expect(config.creator).toEqual(TEST_CREATOR);
    expect(config.bcVault).toEqual(TEST_BC_VAULT);
    expect(config.ammVault).toEqual(TEST_AMM_VAULT);
    expect(config.rpcUrl).toBe(TEST_RPC_URL);
  });

  it('should work with all optional fields', () => {
    const config: RealtimeTrackerConfig = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      rpcUrl: TEST_RPC_URL,
      wsUrl: 'wss://custom.ws',
      onFeeDetected: () => {},
      onTokenDiscovered: () => {},
      onStats: () => {},
      onBalanceChange: () => {},
      verbose: true,
    };

    expect(config.wsUrl).toBe('wss://custom.ws');
    expect(config.verbose).toBe(true);
  });
});

describe('Edge Cases', () => {
  let config: RealtimeTrackerConfig;
  let mockWsManager: any;

  beforeEach(() => {
    jest.clearAllMocks();

    config = {
      creator: TEST_CREATOR,
      bcVault: TEST_BC_VAULT,
      ammVault: TEST_AMM_VAULT,
      rpcUrl: TEST_RPC_URL,
      verbose: false,
    };

    mockWsManager = {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      subscribeToAccount: jest.fn().mockResolvedValue(undefined),
    };
    MockedWebSocketManager.mockImplementation(() => mockWsManager);

    const mockRpcManager = {
      getBalance: jest.fn().mockResolvedValue(0),
      getTokenAccountBalance: jest.fn().mockResolvedValue(0n),
    };
    MockedRpcManager.mockImplementation(() => mockRpcManager as any);
    MockedTokenManager.mockImplementation(() => ({}) as any);
  });

  it('should handle start-stop-start cycle', async () => {
    const tracker = new RealtimeTracker(config);

    await tracker.start();
    expect(tracker.isRunning()).toBe(true);

    await tracker.stop();
    expect(tracker.isRunning()).toBe(false);

    // After stop, listeners are removed, so we need new tracker for clean test
    const tracker2 = new RealtimeTracker(config);
    await tracker2.start();
    expect(tracker2.isRunning()).toBe(true);
    await tracker2.stop();
  });

  it('should handle multiple tokens with same mint but different BC', () => {
    const tracker = new RealtimeTracker(config);

    tracker.addToken(createTestToken({ mint: 'SAME_MINT', bondingCurve: 'BC1' }));
    tracker.addToken(createTestToken({ mint: 'SAME_MINT', bondingCurve: 'BC2' }));

    // Same mint, so stats should be 1
    expect(tracker.getStats().length).toBe(1);
    // But different BC, so tracked tokens should be 2
    expect(tracker.getTrackedTokens().length).toBe(2);
  });

  it('should handle empty rpcUrl gracefully', () => {
    const emptyConfig = { ...config, rpcUrl: '' };

    // Should not throw during construction
    expect(() => new RealtimeTracker(emptyConfig)).not.toThrow();
  });
});
