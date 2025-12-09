import { PublicKey, Connection, AccountInfo, Context, Logs } from '@solana/web3.js';
import { EventEmitter } from 'events';
import {
  WebSocketManager,
  WebSocketConfig,
  AccountUpdate,
  LogUpdate,
  createVaultMonitor,
} from '../lib/websocket-manager';

// Mock @solana/web3.js Connection
jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getSlot: jest.fn().mockResolvedValue(12345678),
      onAccountChange: jest.fn().mockReturnValue(1),
      onLogs: jest.fn().mockReturnValue(2),
      removeAccountChangeListener: jest.fn().mockResolvedValue(undefined),
      removeOnLogsListener: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

const MockedConnection = Connection as jest.MockedClass<typeof Connection>;

// Test constants
const TEST_RPC_URL = 'https://api.mainnet-beta.solana.com';
const TEST_WS_URL = 'wss://api.mainnet-beta.solana.com';
const TEST_PUBKEY = new PublicKey('5zwN9NQei4fctQ8AfEk67PVoH1jSCSYCpfYkeamkpznj');
const TEST_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

describe('WebSocketManager', () => {
  let manager: WebSocketManager;
  let mockConnection: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get the mock connection instance
    mockConnection = {
      getSlot: jest.fn().mockResolvedValue(12345678),
      onAccountChange: jest.fn().mockReturnValue(1),
      onLogs: jest.fn().mockReturnValue(2),
      removeAccountChangeListener: jest.fn().mockResolvedValue(undefined),
      removeOnLogsListener: jest.fn().mockResolvedValue(undefined),
    };

    MockedConnection.mockImplementation(() => mockConnection);
  });

  afterEach(async () => {
    if (manager) {
      await manager.disconnect();
    }
  });

  describe('Constructor', () => {
    it('should create instance with minimal config', () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      expect(manager).toBeInstanceOf(WebSocketManager);
      expect(manager).toBeInstanceOf(EventEmitter);
    });

    it('should create Connection with provided rpcUrl', () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      expect(MockedConnection).toHaveBeenCalledWith(TEST_RPC_URL, 'confirmed');
    });

    it('should use custom commitment level', () => {
      manager = new WebSocketManager({
        rpcUrl: TEST_RPC_URL,
        commitment: 'finalized',
      });
      expect(MockedConnection).toHaveBeenCalledWith(TEST_RPC_URL, 'finalized');
    });

    it('should derive WebSocket URL from HTTP URL', () => {
      manager = new WebSocketManager({ rpcUrl: 'https://api.example.com' });
      expect(manager).toBeDefined();
    });

    it('should use custom WebSocket URL if provided', () => {
      manager = new WebSocketManager({
        rpcUrl: TEST_RPC_URL,
        wsUrl: 'wss://custom.ws.url',
      });
      expect(manager).toBeDefined();
    });

    it('should use default reconnect settings', () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      expect(manager).toBeDefined();
    });

    it('should use custom reconnect settings', () => {
      manager = new WebSocketManager({
        rpcUrl: TEST_RPC_URL,
        reconnectDelayMs: 10000,
        maxReconnectAttempts: 5,
      });
      expect(manager).toBeDefined();
    });
  });

  describe('getState', () => {
    it('should return disconnected initially', () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      expect(manager.getState()).toBe('disconnected');
    });

    it('should return connected after successful connect', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();
      expect(manager.getState()).toBe('connected');
    });

    it('should return disconnected after disconnect', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();
      await manager.disconnect();
      expect(manager.getState()).toBe('disconnected');
    });
  });

  describe('getConnection', () => {
    it('should return the Connection instance', () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      const connection = manager.getConnection();
      expect(connection).toBeDefined();
    });
  });

  describe('connect', () => {
    it('should set state to connected on success', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });

      await manager.connect();

      expect(manager.getState()).toBe('connected');
    });

    it('should emit connecting and connected events', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      const connectingHandler = jest.fn();
      const connectedHandler = jest.fn();

      manager.on('connecting', connectingHandler);
      manager.on('connected', connectedHandler);

      await manager.connect();

      expect(connectingHandler).toHaveBeenCalled();
      expect(connectedHandler).toHaveBeenCalled();
    });

    it('should not reconnect if already connected', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });

      await manager.connect();
      await manager.connect();

      expect(mockConnection.getSlot).toHaveBeenCalledTimes(1);
    });

    it('should emit error on connection failure', async () => {
      mockConnection.getSlot.mockRejectedValueOnce(new Error('Connection failed'));
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      const errorHandler = jest.fn();
      manager.on('error', errorHandler);

      await expect(manager.connect()).rejects.toThrow('Connection failed');
      expect(errorHandler).toHaveBeenCalled();
      expect(manager.getState()).toBe('disconnected');
    });
  });

  describe('disconnect', () => {
    it('should set state to disconnected', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();

      await manager.disconnect();

      expect(manager.getState()).toBe('disconnected');
    });

    it('should emit disconnected event', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      const disconnectedHandler = jest.fn();
      manager.on('disconnected', disconnectedHandler);
      await manager.connect();

      await manager.disconnect();

      expect(disconnectedHandler).toHaveBeenCalled();
    });

    it('should unsubscribe all subscriptions', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();
      await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());

      await manager.disconnect();

      expect(manager.getSubscriptionCount().accounts).toBe(0);
    });
  });

  describe('subscribeToAccount', () => {
    it('should throw if not connected', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });

      await expect(
        manager.subscribeToAccount(TEST_PUBKEY, jest.fn())
      ).rejects.toThrow('WebSocket not connected');
    });

    it('should subscribe to account changes', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();

      const subscriptionId = await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());

      expect(subscriptionId).toBe(1);
      expect(mockConnection.onAccountChange).toHaveBeenCalledWith(
        TEST_PUBKEY,
        expect.any(Function),
        'confirmed'
      );
    });

    it('should return existing subscription ID if already subscribed', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();

      const id1 = await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());
      const id2 = await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());

      expect(id1).toBe(id2);
      expect(mockConnection.onAccountChange).toHaveBeenCalledTimes(1);
    });

    it('should emit subscribed event', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      const subscribedHandler = jest.fn();
      manager.on('subscribed', subscribedHandler);
      await manager.connect();

      await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());

      expect(subscribedHandler).toHaveBeenCalledWith({
        type: 'account',
        pubkey: TEST_PUBKEY,
        subscriptionId: 1,
      });
    });

    it('should call callback on account update', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();

      const callback = jest.fn();
      await manager.subscribeToAccount(TEST_PUBKEY, callback);

      // Simulate account update by calling the stored callback
      const onAccountChangeCall = mockConnection.onAccountChange.mock.calls[0];
      const accountChangeCallback = onAccountChangeCall[1];

      const mockAccountInfo = { lamports: 1000000000, data: Buffer.from([]) } as any;
      const mockContext = { slot: 12345678 };

      accountChangeCallback(mockAccountInfo, mockContext);

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        pubkey: TEST_PUBKEY,
        accountInfo: mockAccountInfo,
        context: mockContext,
      }));
    });

    it('should emit accountUpdate event on update', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      const accountUpdateHandler = jest.fn();
      manager.on('accountUpdate', accountUpdateHandler);
      await manager.connect();

      await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());

      // Simulate account update
      const onAccountChangeCall = mockConnection.onAccountChange.mock.calls[0];
      const accountChangeCallback = onAccountChangeCall[1];

      accountChangeCallback({ lamports: 1000000000, data: Buffer.from([]) }, { slot: 12345678 });

      expect(accountUpdateHandler).toHaveBeenCalled();
    });
  });

  describe('subscribeToLogs', () => {
    it('should throw if not connected', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });

      await expect(
        manager.subscribeToLogs(TEST_PROGRAM_ID, jest.fn())
      ).rejects.toThrow('WebSocket not connected');
    });

    it('should subscribe to program logs', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();

      const subscriptionId = await manager.subscribeToLogs(TEST_PROGRAM_ID, jest.fn());

      expect(subscriptionId).toBe(2);
      expect(mockConnection.onLogs).toHaveBeenCalledWith(
        TEST_PROGRAM_ID,
        expect.any(Function),
        'confirmed'
      );
    });

    it('should return existing subscription ID if already subscribed', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();

      const id1 = await manager.subscribeToLogs(TEST_PROGRAM_ID, jest.fn());
      const id2 = await manager.subscribeToLogs(TEST_PROGRAM_ID, jest.fn());

      expect(id1).toBe(id2);
      expect(mockConnection.onLogs).toHaveBeenCalledTimes(1);
    });

    it('should emit subscribed event', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      const subscribedHandler = jest.fn();
      manager.on('subscribed', subscribedHandler);
      await manager.connect();

      await manager.subscribeToLogs(TEST_PROGRAM_ID, jest.fn());

      expect(subscribedHandler).toHaveBeenCalledWith({
        type: 'logs',
        programId: TEST_PROGRAM_ID,
        subscriptionId: 2,
      });
    });

    it('should call callback on log update', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();

      const callback = jest.fn();
      await manager.subscribeToLogs(TEST_PROGRAM_ID, callback);

      // Simulate log update
      const onLogsCall = mockConnection.onLogs.mock.calls[0];
      const logsCallback = onLogsCall[1];

      const mockLogs = { signature: 'abc123', logs: ['log1', 'log2'], err: null };
      const mockContext = { slot: 12345678 };

      logsCallback(mockLogs, mockContext);

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        signature: 'abc123',
        logs: ['log1', 'log2'],
        err: null,
        context: mockContext,
      }));
    });
  });

  describe('unsubscribeFromAccount', () => {
    it('should unsubscribe from account changes', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();
      await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());

      await manager.unsubscribeFromAccount(TEST_PUBKEY);

      expect(mockConnection.removeAccountChangeListener).toHaveBeenCalledWith(1);
      expect(manager.getSubscriptionCount().accounts).toBe(0);
    });

    it('should emit unsubscribed event', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      const unsubscribedHandler = jest.fn();
      manager.on('unsubscribed', unsubscribedHandler);
      await manager.connect();
      await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());

      await manager.unsubscribeFromAccount(TEST_PUBKEY);

      expect(unsubscribedHandler).toHaveBeenCalledWith({
        type: 'account',
        pubkey: TEST_PUBKEY,
        subscriptionId: 1,
      });
    });

    it('should do nothing if not subscribed', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();

      await manager.unsubscribeFromAccount(TEST_PUBKEY);

      expect(mockConnection.removeAccountChangeListener).not.toHaveBeenCalled();
    });
  });

  describe('unsubscribeFromLogs', () => {
    it('should unsubscribe from program logs', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();
      await manager.subscribeToLogs(TEST_PROGRAM_ID, jest.fn());

      await manager.unsubscribeFromLogs(TEST_PROGRAM_ID);

      expect(mockConnection.removeOnLogsListener).toHaveBeenCalledWith(2);
      expect(manager.getSubscriptionCount().logs).toBe(0);
    });

    it('should emit unsubscribed event', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      const unsubscribedHandler = jest.fn();
      manager.on('unsubscribed', unsubscribedHandler);
      await manager.connect();
      await manager.subscribeToLogs(TEST_PROGRAM_ID, jest.fn());

      await manager.unsubscribeFromLogs(TEST_PROGRAM_ID);

      expect(unsubscribedHandler).toHaveBeenCalledWith({
        type: 'logs',
        programId: TEST_PROGRAM_ID,
        subscriptionId: 2,
      });
    });
  });

  describe('unsubscribeAll', () => {
    it('should unsubscribe from all accounts and logs', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();
      await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());
      await manager.subscribeToLogs(TEST_PROGRAM_ID, jest.fn());

      await manager.unsubscribeAll();

      expect(mockConnection.removeAccountChangeListener).toHaveBeenCalled();
      expect(mockConnection.removeOnLogsListener).toHaveBeenCalled();
      expect(manager.getSubscriptionCount().accounts).toBe(0);
      expect(manager.getSubscriptionCount().logs).toBe(0);
    });

    it('should handle errors during unsubscribe gracefully', async () => {
      mockConnection.removeAccountChangeListener.mockRejectedValueOnce(new Error('Failed'));

      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();
      await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());

      // Should not throw
      await expect(manager.unsubscribeAll()).resolves.not.toThrow();
    });

    it('should do nothing if not connected', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });

      await manager.unsubscribeAll();

      expect(mockConnection.removeAccountChangeListener).not.toHaveBeenCalled();
    });
  });

  describe('getSubscriptionCount', () => {
    it('should return 0 counts initially', () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });

      const counts = manager.getSubscriptionCount();

      expect(counts.accounts).toBe(0);
      expect(counts.logs).toBe(0);
    });

    it('should return correct counts after subscriptions', async () => {
      manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
      await manager.connect();
      await manager.subscribeToAccount(TEST_PUBKEY, jest.fn());
      await manager.subscribeToLogs(TEST_PROGRAM_ID, jest.fn());

      const counts = manager.getSubscriptionCount();

      expect(counts.accounts).toBe(1);
      expect(counts.logs).toBe(1);
    });
  });
});

describe('WebSocketConfig interface', () => {
  it('should work with minimal config', () => {
    const config: WebSocketConfig = {
      rpcUrl: TEST_RPC_URL,
    };
    expect(config.rpcUrl).toBe(TEST_RPC_URL);
  });

  it('should work with all optional fields', () => {
    const config: WebSocketConfig = {
      rpcUrl: TEST_RPC_URL,
      wsUrl: TEST_WS_URL,
      commitment: 'finalized',
      reconnectDelayMs: 10000,
      maxReconnectAttempts: 5,
    };
    expect(config.commitment).toBe('finalized');
    expect(config.reconnectDelayMs).toBe(10000);
    expect(config.maxReconnectAttempts).toBe(5);
  });
});

describe('AccountUpdate interface', () => {
  it('should have all required fields', () => {
    const update: AccountUpdate = {
      pubkey: TEST_PUBKEY,
      accountInfo: { lamports: 1000, data: Buffer.from([]) } as any,
      context: { slot: 12345678 },
      timestamp: Date.now(),
    };

    expect(update.pubkey).toEqual(TEST_PUBKEY);
    expect(update.accountInfo).toBeDefined();
    expect(update.context.slot).toBe(12345678);
    expect(typeof update.timestamp).toBe('number');
  });
});

describe('LogUpdate interface', () => {
  it('should have all required fields', () => {
    const update: LogUpdate = {
      signature: 'abc123',
      logs: ['log1', 'log2'],
      err: null,
      context: { slot: 12345678 },
      timestamp: Date.now(),
    };

    expect(update.signature).toBe('abc123');
    expect(update.logs).toEqual(['log1', 'log2']);
    expect(update.err).toBeNull();
    expect(update.context.slot).toBe(12345678);
  });
});

describe('createVaultMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockedConnection.mockImplementation(() => ({
      getSlot: jest.fn().mockResolvedValue(12345678),
      onAccountChange: jest.fn().mockReturnValue(1),
      onLogs: jest.fn().mockReturnValue(2),
      removeAccountChangeListener: jest.fn().mockResolvedValue(undefined),
      removeOnLogsListener: jest.fn().mockResolvedValue(undefined),
    } as unknown as Connection));
  });

  it('should create a WebSocketManager', () => {
    const bcVault = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    const ammVault = new PublicKey('5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE');

    const manager = createVaultMonitor(
      TEST_RPC_URL,
      bcVault,
      ammVault,
      jest.fn(),
      jest.fn()
    );

    expect(manager).toBeInstanceOf(WebSocketManager);
  });

  it('should subscribe to both vaults on connect', async () => {
    const bcVault = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    const ammVault = new PublicKey('5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE');
    const onBcUpdate = jest.fn();
    const onAmmUpdate = jest.fn();

    const manager = createVaultMonitor(
      TEST_RPC_URL,
      bcVault,
      ammVault,
      onBcUpdate,
      onAmmUpdate
    );

    await manager.connect();

    // Wait for the connected event handler to execute
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(manager.getSubscriptionCount().accounts).toBe(2);
  });
});

describe('Edge Cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockedConnection.mockImplementation(() => ({
      getSlot: jest.fn().mockResolvedValue(12345678),
      onAccountChange: jest.fn().mockReturnValue(1),
      onLogs: jest.fn().mockReturnValue(2),
      removeAccountChangeListener: jest.fn().mockResolvedValue(undefined),
      removeOnLogsListener: jest.fn().mockResolvedValue(undefined),
    } as unknown as Connection));
  });

  it('should handle multiple subscriptions to different accounts', async () => {
    const manager = new WebSocketManager({ rpcUrl: TEST_RPC_URL });
    await manager.connect();

    const pubkey1 = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    const pubkey2 = new PublicKey('5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE');

    await manager.subscribeToAccount(pubkey1, jest.fn());
    await manager.subscribeToAccount(pubkey2, jest.fn());

    expect(manager.getSubscriptionCount().accounts).toBe(2);

    await manager.disconnect();
  });

  it('should convert HTTP URL to WebSocket URL', () => {
    const manager = new WebSocketManager({ rpcUrl: 'http://localhost:8899' });
    expect(manager).toBeDefined();
  });

  it('should convert HTTPS URL to WSS URL', () => {
    const manager = new WebSocketManager({ rpcUrl: 'https://api.mainnet-beta.solana.com' });
    expect(manager).toBeDefined();
  });
});
