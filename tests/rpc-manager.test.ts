import { Connection, PublicKey, AccountInfo, ConfirmedSignatureInfo, VersionedTransactionResponse } from '@solana/web3.js';
import { RpcManager } from '../lib/rpc-manager';
import { CircuitBreaker, fetchWithRetry, DEFAULT_RETRY_CONFIG } from '../lib/utils';

// Mock @solana/web3.js
jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn(),
  };
});

// Mock CircuitBreaker and fetchWithRetry
jest.mock('../lib/utils', () => {
  const actual = jest.requireActual('../lib/utils');
  return {
    ...actual,
    CircuitBreaker: jest.fn().mockImplementation(() => ({
      canExecute: jest.fn().mockReturnValue(true),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getState: jest.fn().mockReturnValue('CLOSED'),
      reset: jest.fn(),
    })),
    fetchWithRetry: jest.fn().mockImplementation(async (fn) => fn()),
  };
});

const MockedConnection = Connection as jest.MockedClass<typeof Connection>;
const MockedCircuitBreaker = CircuitBreaker as jest.MockedClass<typeof CircuitBreaker>;
const mockedFetchWithRetry = fetchWithRetry as jest.MockedFunction<typeof fetchWithRetry>;

const TEST_RPC_URL = 'https://api.devnet.solana.com';
const TEST_PUBKEY = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

describe('RpcManager', () => {
  let mockConnection: jest.Mocked<Partial<Connection>>;
  let mockCircuitBreaker: {
    canExecute: jest.Mock;
    recordSuccess: jest.Mock;
    recordFailure: jest.Mock;
    getState: jest.Mock;
    reset: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockConnection = {
      getSlot: jest.fn().mockResolvedValue(12345678),
      getAccountInfo: jest.fn().mockResolvedValue({ lamports: 1000000, data: Buffer.from([]) } as unknown as AccountInfo<Buffer>),
      getBalance: jest.fn().mockResolvedValue(1000000),
      getTokenAccountBalance: jest.fn().mockResolvedValue({ value: { amount: '1000000000' } }),
      getSignaturesForAddress: jest.fn().mockResolvedValue([]),
      getTransaction: jest.fn().mockResolvedValue(null),
      getMultipleAccountsInfo: jest.fn().mockResolvedValue([]),
    };

    MockedConnection.mockImplementation(() => mockConnection as unknown as Connection);

    mockCircuitBreaker = {
      canExecute: jest.fn().mockReturnValue(true),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getState: jest.fn().mockReturnValue('CLOSED'),
      reset: jest.fn(),
    };

    MockedCircuitBreaker.mockImplementation(() => mockCircuitBreaker as unknown as CircuitBreaker);

    mockedFetchWithRetry.mockImplementation(async (fn) => fn());
  });

  describe('Constructor', () => {
    it('should create instance with RPC URL', () => {
      const manager = new RpcManager(TEST_RPC_URL);
      expect(MockedConnection).toHaveBeenCalledWith(TEST_RPC_URL, 'confirmed');
    });

    it('should create CircuitBreaker', () => {
      const manager = new RpcManager(TEST_RPC_URL);
      expect(MockedCircuitBreaker).toHaveBeenCalled();
    });

    it('should accept custom retry config', () => {
      const customConfig = { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 5000 };
      const manager = new RpcManager(TEST_RPC_URL, customConfig);
      expect(manager).toBeDefined();
    });

    it('should accept onRpcError callback', () => {
      const onError = jest.fn();
      const manager = new RpcManager(TEST_RPC_URL, undefined, onError);
      expect(manager).toBeDefined();
    });

    it('should use default retry config when not provided', () => {
      const manager = new RpcManager(TEST_RPC_URL);
      expect(manager).toBeInstanceOf(RpcManager);
    });
  });

  describe('getConnection', () => {
    it('should return the Connection instance', () => {
      const manager = new RpcManager(TEST_RPC_URL);
      const connection = manager.getConnection();
      expect(connection).toBeDefined();
    });
  });

  describe('getCircuitBreakerState', () => {
    it('should return circuit breaker state', () => {
      const manager = new RpcManager(TEST_RPC_URL);
      const state = manager.getCircuitBreakerState();

      expect(state).toHaveProperty('state');
      expect(state).toHaveProperty('canExecute');
      expect(state.state).toBe('CLOSED');
      expect(state.canExecute).toBe(true);
    });

    it('should return OPEN state when circuit is open', () => {
      mockCircuitBreaker.getState.mockReturnValue('OPEN');
      mockCircuitBreaker.canExecute.mockReturnValue(false);

      const manager = new RpcManager(TEST_RPC_URL);
      const state = manager.getCircuitBreakerState();

      expect(state.state).toBe('OPEN');
      expect(state.canExecute).toBe(false);
    });

    it('should return HALF_OPEN state during recovery', () => {
      mockCircuitBreaker.getState.mockReturnValue('HALF_OPEN');
      mockCircuitBreaker.canExecute.mockReturnValue(true);

      const manager = new RpcManager(TEST_RPC_URL);
      const state = manager.getCircuitBreakerState();

      expect(state.state).toBe('HALF_OPEN');
      expect(state.canExecute).toBe(true);
    });
  });

  describe('resetCircuitBreaker', () => {
    it('should call reset on circuit breaker', () => {
      const manager = new RpcManager(TEST_RPC_URL);
      manager.resetCircuitBreaker();

      expect(mockCircuitBreaker.reset).toHaveBeenCalled();
    });
  });

  describe('checkHealth', () => {
    it('should return healthy status on successful getSlot', async () => {
      const manager = new RpcManager(TEST_RPC_URL);
      const health = await manager.checkHealth();

      expect(health.healthy).toBe(true);
      expect(health.latencyMs).toBeDefined();
      expect(health.error).toBeUndefined();
    });

    it('should return unhealthy on timeout', async () => {
      mockConnection.getSlot = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10000))
      );

      const manager = new RpcManager(TEST_RPC_URL);
      const health = await manager.checkHealth(50); // 50ms timeout

      expect(health.healthy).toBe(false);
      expect(health.error).toBe('RPC timeout');
    });

    it('should return unhealthy on error', async () => {
      mockConnection.getSlot = jest.fn().mockRejectedValue(new Error('Connection failed'));

      const manager = new RpcManager(TEST_RPC_URL);
      const health = await manager.checkHealth();

      expect(health.healthy).toBe(false);
      expect(health.error).toBe('Connection failed');
    });

    it('should include latency in response', async () => {
      const manager = new RpcManager(TEST_RPC_URL);
      const health = await manager.checkHealth();

      expect(typeof health.latencyMs).toBe('number');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle non-Error objects', async () => {
      mockConnection.getSlot = jest.fn().mockRejectedValue('string error');

      const manager = new RpcManager(TEST_RPC_URL);
      const health = await manager.checkHealth();

      expect(health.healthy).toBe(false);
      expect(health.error).toBe('string error');
    });

    it('should use default timeout when not specified', async () => {
      const manager = new RpcManager(TEST_RPC_URL);
      const health = await manager.checkHealth();

      expect(health.healthy).toBe(true);
    });
  });

  describe('getAccountInfo', () => {
    it('should fetch account info', async () => {
      const mockAccountInfo = { lamports: 1000000, data: Buffer.from([1, 2, 3]) } as unknown as AccountInfo<Buffer>;
      mockConnection.getAccountInfo = jest.fn().mockResolvedValue(mockAccountInfo);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getAccountInfo(TEST_PUBKEY);

      expect(result).toBe(mockAccountInfo);
    });

    it('should return null for non-existent account', async () => {
      mockConnection.getAccountInfo = jest.fn().mockResolvedValue(null);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getAccountInfo(TEST_PUBKEY);

      expect(result).toBeNull();
    });

    it('should throw when circuit breaker is open', async () => {
      mockCircuitBreaker.canExecute.mockReturnValue(false);

      const manager = new RpcManager(TEST_RPC_URL);

      await expect(manager.getAccountInfo(TEST_PUBKEY)).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should record success on successful fetch', async () => {
      const manager = new RpcManager(TEST_RPC_URL);
      await manager.getAccountInfo(TEST_PUBKEY);

      expect(mockCircuitBreaker.recordSuccess).toHaveBeenCalled();
    });

    it('should record failure and throw on error', async () => {
      mockedFetchWithRetry.mockRejectedValue(new Error('RPC error'));

      const manager = new RpcManager(TEST_RPC_URL);

      await expect(manager.getAccountInfo(TEST_PUBKEY)).rejects.toThrow('RPC error');
      expect(mockCircuitBreaker.recordFailure).toHaveBeenCalled();
    });
  });

  describe('getBalance', () => {
    it('should fetch balance', async () => {
      mockConnection.getBalance = jest.fn().mockResolvedValue(5000000000);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getBalance(TEST_PUBKEY);

      expect(result).toBe(5000000000);
    });

    it('should throw when circuit breaker is open', async () => {
      mockCircuitBreaker.canExecute.mockReturnValue(false);

      const manager = new RpcManager(TEST_RPC_URL);

      await expect(manager.getBalance(TEST_PUBKEY)).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should record success on successful fetch', async () => {
      const manager = new RpcManager(TEST_RPC_URL);
      await manager.getBalance(TEST_PUBKEY);

      expect(mockCircuitBreaker.recordSuccess).toHaveBeenCalled();
    });
  });

  describe('getTokenAccountBalance', () => {
    it('should fetch token balance as bigint', async () => {
      mockConnection.getTokenAccountBalance = jest.fn().mockResolvedValue({
        value: { amount: '9876543210123456789' }
      });

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getTokenAccountBalance(TEST_PUBKEY);

      expect(result).toBe(9876543210123456789n);
    });

    it('should throw when circuit breaker is open', async () => {
      mockCircuitBreaker.canExecute.mockReturnValue(false);

      const manager = new RpcManager(TEST_RPC_URL);

      await expect(manager.getTokenAccountBalance(TEST_PUBKEY)).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should handle zero balance', async () => {
      mockConnection.getTokenAccountBalance = jest.fn().mockResolvedValue({
        value: { amount: '0' }
      });

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getTokenAccountBalance(TEST_PUBKEY);

      expect(result).toBe(0n);
    });
  });

  describe('getSignaturesForAddress', () => {
    it('should fetch signatures with default options', async () => {
      const mockSignatures: ConfirmedSignatureInfo[] = [
        { signature: 'sig1', slot: 1, err: null, memo: null, blockTime: 123 },
        { signature: 'sig2', slot: 2, err: null, memo: null, blockTime: 124 },
      ];
      mockConnection.getSignaturesForAddress = jest.fn().mockResolvedValue(mockSignatures);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getSignaturesForAddress(TEST_PUBKEY);

      expect(result).toEqual(mockSignatures);
      expect(mockConnection.getSignaturesForAddress).toHaveBeenCalledWith(
        TEST_PUBKEY,
        { limit: 10, before: undefined, until: undefined }
      );
    });

    it('should accept custom options', async () => {
      mockConnection.getSignaturesForAddress = jest.fn().mockResolvedValue([]);

      const manager = new RpcManager(TEST_RPC_URL);
      await manager.getSignaturesForAddress(TEST_PUBKEY, {
        limit: 50,
        before: 'beforeSig',
        until: 'untilSig'
      });

      expect(mockConnection.getSignaturesForAddress).toHaveBeenCalledWith(
        TEST_PUBKEY,
        { limit: 50, before: 'beforeSig', until: 'untilSig' }
      );
    });

    it('should throw when circuit breaker is open', async () => {
      mockCircuitBreaker.canExecute.mockReturnValue(false);

      const manager = new RpcManager(TEST_RPC_URL);

      await expect(manager.getSignaturesForAddress(TEST_PUBKEY)).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should handle empty response', async () => {
      mockConnection.getSignaturesForAddress = jest.fn().mockResolvedValue([]);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getSignaturesForAddress(TEST_PUBKEY);

      expect(result).toEqual([]);
    });
  });

  describe('getTransaction', () => {
    it('should fetch transaction', async () => {
      const mockTx = { slot: 123, transaction: {} } as unknown as VersionedTransactionResponse;
      mockConnection.getTransaction = jest.fn().mockResolvedValue(mockTx);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getTransaction('testSignature');

      expect(result).toBe(mockTx);
    });

    it('should return null for non-existent transaction', async () => {
      mockConnection.getTransaction = jest.fn().mockResolvedValue(null);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getTransaction('nonExistentSig');

      expect(result).toBeNull();
    });

    it('should throw when circuit breaker is open', async () => {
      mockCircuitBreaker.canExecute.mockReturnValue(false);

      const manager = new RpcManager(TEST_RPC_URL);

      await expect(manager.getTransaction('sig')).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should use maxSupportedTransactionVersion: 0', async () => {
      mockConnection.getTransaction = jest.fn().mockResolvedValue(null);

      const manager = new RpcManager(TEST_RPC_URL);
      await manager.getTransaction('sig123');

      expect(mockConnection.getTransaction).toHaveBeenCalledWith('sig123', {
        maxSupportedTransactionVersion: 0,
      });
    });
  });

  describe('getMultipleAccountsInfoBatch', () => {
    it('should return empty array for empty input', async () => {
      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getMultipleAccountsInfoBatch([]);

      expect(result).toEqual([]);
    });

    it('should throw when circuit breaker is open', async () => {
      mockCircuitBreaker.canExecute.mockReturnValue(false);

      const manager = new RpcManager(TEST_RPC_URL);

      await expect(manager.getMultipleAccountsInfoBatch([TEST_PUBKEY])).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should fetch single chunk of accounts', async () => {
      const mockAccounts = [
        { lamports: 1000000, data: Buffer.from([]) } as unknown as AccountInfo<Buffer>,
        { lamports: 2000000, data: Buffer.from([]) } as unknown as AccountInfo<Buffer>,
      ];
      mockConnection.getMultipleAccountsInfo = jest.fn().mockResolvedValue(mockAccounts);

      const pubkeys = [TEST_PUBKEY, new PublicKey('5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE')];

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getMultipleAccountsInfoBatch(pubkeys);

      expect(result.length).toBe(2);
    });

    it('should handle chunked requests for >100 accounts', async () => {
      // Create 150 pubkeys
      const pubkeys: PublicKey[] = [];
      for (let i = 0; i < 150; i++) {
        pubkeys.push(TEST_PUBKEY);
      }

      const mockResult = { lamports: 1000000, data: Buffer.from([]) } as unknown as AccountInfo<Buffer>;
      mockConnection.getMultipleAccountsInfo = jest.fn()
        .mockResolvedValueOnce(new Array(100).fill(mockResult))
        .mockResolvedValueOnce(new Array(50).fill(mockResult));

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getMultipleAccountsInfoBatch(pubkeys);

      // Should make 2 calls (100 + 50)
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
      expect(result.length).toBe(150);
    });

    it('should handle partial failures gracefully', async () => {
      mockConnection.getMultipleAccountsInfo = jest.fn()
        .mockResolvedValueOnce([{ lamports: 1000000, data: Buffer.from([]) }])
        .mockRejectedValueOnce(new Error('Chunk failed'));

      // Simulate fetchWithRetry failing
      mockedFetchWithRetry
        .mockImplementationOnce(async (fn) => fn())
        .mockRejectedValueOnce(new Error('Chunk failed'));

      const pubkeys: PublicKey[] = [];
      for (let i = 0; i < 150; i++) {
        pubkeys.push(TEST_PUBKEY);
      }

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getMultipleAccountsInfoBatch(pubkeys);

      // Should still return array with nulls for failed chunk
      expect(result.length).toBe(150);
    });

    it('should record success on each successful chunk', async () => {
      const pubkeys = [TEST_PUBKEY, TEST_PUBKEY];
      mockConnection.getMultipleAccountsInfo = jest.fn().mockResolvedValue([null, null]);

      const manager = new RpcManager(TEST_RPC_URL);
      await manager.getMultipleAccountsInfoBatch(pubkeys);

      expect(mockCircuitBreaker.recordSuccess).toHaveBeenCalled();
    });
  });

  describe('getAllSignaturesSince', () => {
    it('should fetch all signatures since a given signature', async () => {
      const mockSigs = [
        { signature: 'sig1', slot: 100 },
        { signature: 'sig2', slot: 99 },
      ] as ConfirmedSignatureInfo[];

      mockConnection.getSignaturesForAddress = jest.fn().mockResolvedValue(mockSigs);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getAllSignaturesSince(TEST_PUBKEY, 'untilSig', 100);

      expect(result).toContain('sig1');
      expect(result).toContain('sig2');
    });

    it('should stop when reaching untilSignature', async () => {
      const mockSigs = [
        { signature: 'sig1', slot: 100 },
        { signature: 'untilSig', slot: 99 },
        { signature: 'sig3', slot: 98 },
      ] as ConfirmedSignatureInfo[];

      mockConnection.getSignaturesForAddress = jest.fn().mockResolvedValue(mockSigs);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getAllSignaturesSince(TEST_PUBKEY, 'untilSig', 100);

      expect(result).toContain('sig1');
      expect(result).not.toContain('untilSig');
      expect(result).not.toContain('sig3');
    });

    it('should paginate through multiple pages', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        signature: `sig${i}`,
        slot: 1000 - i
      })) as ConfirmedSignatureInfo[];

      const page2 = [
        { signature: 'sig100', slot: 900 },
        { signature: 'sig101', slot: 899 },
      ] as ConfirmedSignatureInfo[];

      mockConnection.getSignaturesForAddress = jest.fn()
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getAllSignaturesSince(TEST_PUBKEY, '', 200);

      expect(result.length).toBeGreaterThan(100);
    });

    it('should use default limit of 1000', async () => {
      mockConnection.getSignaturesForAddress = jest.fn().mockResolvedValue([]);

      const manager = new RpcManager(TEST_RPC_URL);
      await manager.getAllSignaturesSince(TEST_PUBKEY, 'untilSig');

      // Method was called, default limit is used internally
      expect(mockConnection.getSignaturesForAddress).toHaveBeenCalled();
    });

    it('should handle empty response', async () => {
      mockConnection.getSignaturesForAddress = jest.fn().mockResolvedValue([]);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getAllSignaturesSince(TEST_PUBKEY, 'untilSig');

      expect(result).toEqual([]);
    });

    it('should handle errors gracefully and return partial results', async () => {
      // Need more than 100 signatures to trigger pagination
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        signature: `sig${i}`,
        slot: 1000 - i
      })) as ConfirmedSignatureInfo[];

      mockConnection.getSignaturesForAddress = jest.fn().mockResolvedValue(page1);

      // First fetchWithRetry succeeds, second throws
      let callCount = 0;
      mockedFetchWithRetry.mockImplementation(async (fn) => {
        callCount++;
        if (callCount > 1) {
          throw new Error('RPC error');
        }
        return fn();
      });

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getAllSignaturesSince(TEST_PUBKEY, '', 200);

      // Should return what was fetched before error
      expect(Array.isArray(result)).toBe(true);

      // Reset mock for next tests
      mockedFetchWithRetry.mockImplementation(async (fn) => fn());
    });

    it('should stop when fewer than 100 signatures returned', async () => {
      const mockSigs = Array.from({ length: 50 }, (_, i) => ({
        signature: `sig${i}`,
        slot: 1000 - i
      })) as ConfirmedSignatureInfo[];

      mockConnection.getSignaturesForAddress = jest.fn().mockResolvedValue(mockSigs);

      const manager = new RpcManager(TEST_RPC_URL);
      const result = await manager.getAllSignaturesSince(TEST_PUBKEY, '', 200);

      // Should only make one call since < 100 returned
      expect(mockConnection.getSignaturesForAddress).toHaveBeenCalledTimes(1);
      expect(result.length).toBe(50);
    });
  });

  describe('Error Callback', () => {
    beforeEach(() => {
      // Reset mock to default implementation for this test
      mockedFetchWithRetry.mockImplementation(async (fn) => fn());
    });

    it('should call onRpcError callback on retry', async () => {
      const onError = jest.fn();
      const manager = new RpcManager(TEST_RPC_URL, undefined, onError);

      // Simulate fetchWithRetry calling the error callback
      mockedFetchWithRetry.mockImplementationOnce(async (fn, config, errorCallback) => {
        if (errorCallback) {
          errorCallback(1, new Error('Test error'), 100);
        }
        return fn();
      });

      await manager.getAccountInfo(TEST_PUBKEY);

      expect(onError).toHaveBeenCalledWith(expect.any(Error), 1);
    });
  });

  describe('Circuit Breaker Integration', () => {
    it('should record success after successful operation', async () => {
      const manager = new RpcManager(TEST_RPC_URL);
      await manager.getBalance(TEST_PUBKEY);

      expect(mockCircuitBreaker.recordSuccess).toHaveBeenCalled();
    });

    it('should record failure after failed operation', async () => {
      mockedFetchWithRetry.mockRejectedValue(new Error('Failed'));

      const manager = new RpcManager(TEST_RPC_URL);

      try {
        await manager.getBalance(TEST_PUBKEY);
      } catch {
        // Expected
      }

      expect(mockCircuitBreaker.recordFailure).toHaveBeenCalled();
    });

    it('should block all operations when circuit is open', async () => {
      mockCircuitBreaker.canExecute.mockReturnValue(false);

      const manager = new RpcManager(TEST_RPC_URL);

      await expect(manager.getAccountInfo(TEST_PUBKEY)).rejects.toThrow('Circuit breaker is OPEN');
      await expect(manager.getBalance(TEST_PUBKEY)).rejects.toThrow('Circuit breaker is OPEN');
      await expect(manager.getTokenAccountBalance(TEST_PUBKEY)).rejects.toThrow('Circuit breaker is OPEN');
      await expect(manager.getSignaturesForAddress(TEST_PUBKEY)).rejects.toThrow('Circuit breaker is OPEN');
      await expect(manager.getTransaction('sig')).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should include operation name in circuit breaker error', async () => {
      mockCircuitBreaker.canExecute.mockReturnValue(false);

      const manager = new RpcManager(TEST_RPC_URL);

      await expect(manager.getAccountInfo(TEST_PUBKEY)).rejects.toThrow('getAccountInfo blocked');
    });
  });
});

describe('RpcManager with Real Connection (no mocks)', () => {
  beforeAll(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    jest.resetModules();
  });

  it('should create a real connection', () => {
    // This test uses the real Connection class
    // Just verify no errors on construction
    expect(() => {
      // Re-import to get unmocked version
      const { RpcManager: RealRpcManager } = jest.requireActual('../lib/rpc-manager');
      const manager = new RealRpcManager('https://api.devnet.solana.com');
      expect(manager).toBeDefined();
    }).not.toThrow();
  });
});
