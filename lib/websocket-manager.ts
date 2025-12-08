import { Connection, PublicKey, AccountInfo, Context, Logs } from '@solana/web3.js';
import { EventEmitter } from 'events';

export interface WebSocketConfig {
  rpcUrl: string;
  wsUrl?: string; // Optional WebSocket URL (derived from rpcUrl if not provided)
  commitment?: 'processed' | 'confirmed' | 'finalized';
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

export interface AccountUpdate {
  pubkey: PublicKey;
  accountInfo: AccountInfo<Buffer>;
  context: Context;
  timestamp: number;
}

export interface LogUpdate {
  signature: string;
  logs: string[];
  err: any;
  context: Context;
  timestamp: number;
}

type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class WebSocketManager extends EventEmitter {
  private connection: Connection;
  private wsConnection: Connection | null = null;
  private subscriptions: Map<string, number> = new Map();
  private logSubscriptions: Map<string, number> = new Map();
  private state: WebSocketState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private config: Required<WebSocketConfig>;

  constructor(config: WebSocketConfig) {
    super();
    this.config = {
      rpcUrl: config.rpcUrl,
      wsUrl: config.wsUrl || this.deriveWsUrl(config.rpcUrl),
      commitment: config.commitment || 'confirmed',
      reconnectDelayMs: config.reconnectDelayMs || 5000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
    };

    // HTTP connection for RPC calls
    this.connection = new Connection(this.config.rpcUrl, this.config.commitment);
  }

  /**
   * Derive WebSocket URL from HTTP URL
   */
  private deriveWsUrl(httpUrl: string): string {
    const url = new URL(httpUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  /**
   * Get the current connection state
   */
  getState(): WebSocketState {
    return this.state;
  }

  /**
   * Get the HTTP connection for RPC calls
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Connect to WebSocket
   */
  async connect(): Promise<void> {
    if (this.state === 'connected') return;

    this.state = 'connecting';
    this.emit('connecting');

    try {
      // Create WebSocket connection
      this.wsConnection = new Connection(this.config.wsUrl, {
        commitment: this.config.commitment,
        wsEndpoint: this.config.wsUrl,
      });

      // Test connection with a slot query
      await this.wsConnection.getSlot();

      this.state = 'connected';
      this.reconnectAttempts = 0;
      this.emit('connected');
    } catch (error) {
      this.state = 'disconnected';
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Disconnect from WebSocket
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Unsubscribe all
    await this.unsubscribeAll();

    this.state = 'disconnected';
    this.wsConnection = null;
    this.emit('disconnected');
  }

  /**
   * Subscribe to account changes
   */
  async subscribeToAccount(
    pubkey: PublicKey,
    callback: (update: AccountUpdate) => void
  ): Promise<number> {
    if (!this.wsConnection) {
      throw new Error('WebSocket not connected');
    }

    const key = pubkey.toBase58();
    if (this.subscriptions.has(key)) {
      return this.subscriptions.get(key)!;
    }

    const subscriptionId = this.wsConnection.onAccountChange(
      pubkey,
      (accountInfo: AccountInfo<Buffer>, context: Context) => {
        const update: AccountUpdate = {
          pubkey,
          accountInfo,
          context,
          timestamp: Date.now(),
        };
        this.emit('accountUpdate', update);
        callback(update);
      },
      this.config.commitment
    );

    this.subscriptions.set(key, subscriptionId);
    this.emit('subscribed', { type: 'account', pubkey, subscriptionId });

    return subscriptionId;
  }

  /**
   * Subscribe to program logs (for detecting transactions)
   */
  async subscribeToLogs(
    programId: PublicKey,
    callback: (update: LogUpdate) => void
  ): Promise<number> {
    if (!this.wsConnection) {
      throw new Error('WebSocket not connected');
    }

    const key = `logs:${programId.toBase58()}`;
    if (this.logSubscriptions.has(key)) {
      return this.logSubscriptions.get(key)!;
    }

    const subscriptionId = this.wsConnection.onLogs(
      programId,
      (logs: Logs, context: Context) => {
        const update: LogUpdate = {
          signature: logs.signature,
          logs: logs.logs,
          err: logs.err,
          context,
          timestamp: Date.now(),
        };
        this.emit('logUpdate', update);
        callback(update);
      },
      this.config.commitment
    );

    this.logSubscriptions.set(key, subscriptionId);
    this.emit('subscribed', { type: 'logs', programId, subscriptionId });

    return subscriptionId;
  }

  /**
   * Unsubscribe from account changes
   */
  async unsubscribeFromAccount(pubkey: PublicKey): Promise<void> {
    const key = pubkey.toBase58();
    const subscriptionId = this.subscriptions.get(key);

    if (subscriptionId !== undefined && this.wsConnection) {
      await this.wsConnection.removeAccountChangeListener(subscriptionId);
      this.subscriptions.delete(key);
      this.emit('unsubscribed', { type: 'account', pubkey, subscriptionId });
    }
  }

  /**
   * Unsubscribe from program logs
   */
  async unsubscribeFromLogs(programId: PublicKey): Promise<void> {
    const key = `logs:${programId.toBase58()}`;
    const subscriptionId = this.logSubscriptions.get(key);

    if (subscriptionId !== undefined && this.wsConnection) {
      await this.wsConnection.removeOnLogsListener(subscriptionId);
      this.logSubscriptions.delete(key);
      this.emit('unsubscribed', { type: 'logs', programId, subscriptionId });
    }
  }

  /**
   * Unsubscribe from all
   */
  async unsubscribeAll(): Promise<void> {
    if (!this.wsConnection) return;

    // Account subscriptions
    for (const [key, subscriptionId] of this.subscriptions) {
      try {
        await this.wsConnection.removeAccountChangeListener(subscriptionId);
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
    this.subscriptions.clear();

    // Log subscriptions
    for (const [key, subscriptionId] of this.logSubscriptions) {
      try {
        await this.wsConnection.removeOnLogsListener(subscriptionId);
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
    this.logSubscriptions.clear();
  }

  /**
   * Handle reconnection
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.state = 'reconnecting';
    this.reconnectAttempts++;

    const delay = this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        // Resubscribe to all accounts
        await this.resubscribeAll();
      } catch (error) {
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Resubscribe to all accounts after reconnection
   */
  private async resubscribeAll(): Promise<void> {
    const oldSubscriptions = new Map(this.subscriptions);
    this.subscriptions.clear();

    for (const key of oldSubscriptions.keys()) {
      const pubkey = new PublicKey(key);
      // Note: We can't restore the original callback here
      // The caller should resubscribe with their callbacks
    }

    this.emit('resubscriptionRequired', {
      accounts: Array.from(oldSubscriptions.keys()),
      logs: Array.from(this.logSubscriptions.keys()),
    });
  }

  /**
   * Get subscription count
   */
  getSubscriptionCount(): { accounts: number; logs: number } {
    return {
      accounts: this.subscriptions.size,
      logs: this.logSubscriptions.size,
    };
  }
}

/**
 * Helper function to create a WebSocket manager with vault monitoring
 */
export function createVaultMonitor(
  rpcUrl: string,
  bcVault: PublicKey,
  ammVault: PublicKey,
  onBcUpdate: (update: AccountUpdate) => void,
  onAmmUpdate: (update: AccountUpdate) => void
): WebSocketManager {
  const manager = new WebSocketManager({ rpcUrl });

  manager.on('connected', async () => {
    await manager.subscribeToAccount(bcVault, onBcUpdate);
    await manager.subscribeToAccount(ammVault, onAmmUpdate);
  });

  return manager;
}
