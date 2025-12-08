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

interface SubscriptionInfo {
  id: number;
  callback: (update: AccountUpdate) => void;
}

interface LogSubscriptionInfo {
  id: number;
  callback: (update: LogUpdate) => void;
}

export class WebSocketManager extends EventEmitter {
  private connection: Connection;
  private wsConnection: Connection | null = null;
  private subscriptions: Map<string, SubscriptionInfo> = new Map();
  private logSubscriptions: Map<string, LogSubscriptionInfo> = new Map();
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
      // Use the HTTP connection - it handles WebSocket internally for subscriptions
      this.wsConnection = this.connection;

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
      return this.subscriptions.get(key)!.id;
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

    // Store subscription with callback for reconnection
    this.subscriptions.set(key, { id: subscriptionId, callback });
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
      return this.logSubscriptions.get(key)!.id;
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

    // Store subscription with callback for reconnection
    this.logSubscriptions.set(key, { id: subscriptionId, callback });
    this.emit('subscribed', { type: 'logs', programId, subscriptionId });

    return subscriptionId;
  }

  /**
   * Unsubscribe from account changes
   */
  async unsubscribeFromAccount(pubkey: PublicKey): Promise<void> {
    const key = pubkey.toBase58();
    const subInfo = this.subscriptions.get(key);

    if (subInfo !== undefined && this.wsConnection) {
      await this.wsConnection.removeAccountChangeListener(subInfo.id);
      this.subscriptions.delete(key);
      this.emit('unsubscribed', { type: 'account', pubkey, subscriptionId: subInfo.id });
    }
  }

  /**
   * Unsubscribe from program logs
   */
  async unsubscribeFromLogs(programId: PublicKey): Promise<void> {
    const key = `logs:${programId.toBase58()}`;
    const subInfo = this.logSubscriptions.get(key);

    if (subInfo !== undefined && this.wsConnection) {
      await this.wsConnection.removeOnLogsListener(subInfo.id);
      this.logSubscriptions.delete(key);
      this.emit('unsubscribed', { type: 'logs', programId, subscriptionId: subInfo.id });
    }
  }

  /**
   * Unsubscribe from all (but keep callback info for resubscription)
   * @param clearCallbacks - If true, also clears stored callbacks (for full disconnect)
   */
  async unsubscribeAll(clearCallbacks: boolean = true): Promise<void> {
    if (!this.wsConnection) return;

    // Account subscriptions
    for (const [key, subInfo] of this.subscriptions) {
      try {
        await this.wsConnection.removeAccountChangeListener(subInfo.id);
      } catch (e) {
        // Ignore errors during cleanup
      }
    }

    // Log subscriptions
    for (const [key, subInfo] of this.logSubscriptions) {
      try {
        await this.wsConnection.removeOnLogsListener(subInfo.id);
      } catch (e) {
        // Ignore errors during cleanup
      }
    }

    if (clearCallbacks) {
      this.subscriptions.clear();
      this.logSubscriptions.clear();
    }
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
   * Uses stored callbacks to automatically restore subscriptions
   */
  private async resubscribeAll(): Promise<void> {
    if (!this.wsConnection) return;

    // Store old subscription info (with callbacks)
    const oldAccountSubs = new Map(this.subscriptions);
    const oldLogSubs = new Map(this.logSubscriptions);

    // Clear old subscription IDs (but callbacks are still in the old maps)
    this.subscriptions.clear();
    this.logSubscriptions.clear();

    let restoredAccounts = 0;
    let restoredLogs = 0;

    // Resubscribe to account changes
    for (const [key, subInfo] of oldAccountSubs) {
      try {
        const pubkey = new PublicKey(key);
        const newId = this.wsConnection.onAccountChange(
          pubkey,
          (accountInfo: AccountInfo<Buffer>, context: Context) => {
            const update: AccountUpdate = {
              pubkey,
              accountInfo,
              context,
              timestamp: Date.now(),
            };
            this.emit('accountUpdate', update);
            subInfo.callback(update);
          },
          this.config.commitment
        );
        this.subscriptions.set(key, { id: newId, callback: subInfo.callback });
        restoredAccounts++;
      } catch (error) {
        this.emit('resubscriptionError', { type: 'account', key, error });
      }
    }

    // Resubscribe to program logs
    for (const [key, subInfo] of oldLogSubs) {
      try {
        // Extract programId from key (format: "logs:<pubkey>")
        const programIdStr = key.replace('logs:', '');
        const programId = new PublicKey(programIdStr);
        const newId = this.wsConnection.onLogs(
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
            subInfo.callback(update);
          },
          this.config.commitment
        );
        this.logSubscriptions.set(key, { id: newId, callback: subInfo.callback });
        restoredLogs++;
      } catch (error) {
        this.emit('resubscriptionError', { type: 'logs', key, error });
      }
    }

    this.emit('resubscribed', {
      accounts: restoredAccounts,
      logs: restoredLogs,
      totalAccounts: oldAccountSubs.size,
      totalLogs: oldLogSubs.size,
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
