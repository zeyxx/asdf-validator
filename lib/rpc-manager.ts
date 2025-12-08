import { Connection, PublicKey, AccountInfo, ParsedAccountData } from '@solana/web3.js';
import { CircuitBreaker, fetchWithRetry, RetryConfig, DEFAULT_RETRY_CONFIG } from './utils';

export class RpcManager {
  private connection: Connection;
  private circuitBreaker: CircuitBreaker;
  private retryConfig: RetryConfig;
  private onRpcError?: (error: Error, attempt: number) => void;

  constructor(
    rpcUrl: string,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
    onRpcError?: (error: Error, attempt: number) => void
  ) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.circuitBreaker = new CircuitBreaker();
    this.retryConfig = retryConfig;
    this.onRpcError = onRpcError;
  }

  getConnection(): Connection {
    return this.connection;
  }

  async checkHealth(timeoutMs: number = 5000): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
    const startTime = Date.now();
    try {
      const result = await Promise.race([
        this.connection.getSlot().then(() => ({ success: true as const })),
        new Promise<{ success: false; error: string }>((resolve) =>
          setTimeout(() => resolve({ success: false, error: 'RPC timeout' }), timeoutMs)
        ),
      ]);

      const latencyMs = Date.now() - startTime;
      if (result.success) {
        return { healthy: true, latencyMs };
      } else {
        return { healthy: false, latencyMs, error: result.error };
      }
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Fetch multiple accounts using batched RPC calls (chunked by 100)
   */
  async getMultipleAccountsInfoBatch(
    publicKeys: PublicKey[]
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    if (publicKeys.length === 0) return [];

    if (!this.circuitBreaker.canExecute()) {
      throw new Error('Circuit breaker is OPEN');
    }

    const CHUNK_SIZE = 100;
    const results: (AccountInfo<Buffer> | null)[] = new Array(publicKeys.length).fill(null);
    const chunks: PublicKey[][] = [];

    for (let i = 0; i < publicKeys.length; i += CHUNK_SIZE) {
      chunks.push(publicKeys.slice(i, i + CHUNK_SIZE));
    }

    await Promise.all(
      chunks.map(async (chunk, chunkIndex) => {
        try {
          const chunkResults = await fetchWithRetry(
            async () => {
              const res = await this.connection.getMultipleAccountsInfo(chunk);
              this.circuitBreaker.recordSuccess();
              return res;
            },
            this.retryConfig,
            (attempt, error) => this.onRpcError?.(error, attempt)
          );

          // Place results in correct position
          const startIndex = chunkIndex * CHUNK_SIZE;
          for (let i = 0; i < chunkResults.length; i++) {
            results[startIndex + i] = chunkResults[i];
          }
        } catch (error) {
          this.circuitBreaker.recordFailure();
          console.error(`Failed to fetch chunk ${chunkIndex}:`, error);
          // Allow partial failure? For now, we just log and leave nulls.
          // Caller must handle nulls.
        }
      })
    );

    return results;
  }

  /**
   * Fetch all signatures since a given signature (pagination)
   */
  async getAllSignaturesSince(
    address: PublicKey,
    untilSignature: string,
    limit: number = 1000
  ): Promise<string[]> {
    const allSignatures: string[] = [];
    let before: string | undefined;
    let reachedEnd = false;

    while (!reachedEnd && allSignatures.length < limit) {
      try {
        const signatures = await fetchWithRetry(
          async () => {
            const options: any = {
              limit: 100, // Max limit per call
              before,
            };
            if (untilSignature) {
              options.until = untilSignature;
            }

            const res = await this.connection.getSignaturesForAddress(address, options);
            this.circuitBreaker.recordSuccess();
            return res;
          },
          this.retryConfig
        );

        if (signatures.length === 0) {
          reachedEnd = true;
          break;
        }

        // Add to list
        for (const sig of signatures) {
          if (sig.signature === untilSignature) {
            reachedEnd = true;
            break;
          }
          allSignatures.push(sig.signature);
        }

        // Pagination
        before = signatures[signatures.length - 1].signature;

        // Optimization: if we got less than requested, we're likely done
        if (signatures.length < 100) {
          reachedEnd = true;
        }
      } catch (error) {
        console.warn(`Error fetching signatures for ${address.toBase58()}:`, error);
        break; // Stop on error
      }
    }

    return allSignatures;
  }

  /**
   * Fetch a single account with retry
   */
  async getAccountInfo(publicKey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    if (!this.circuitBreaker.canExecute()) {
      return null;
    }

    return fetchWithRetry(
      async () => {
        const res = await this.connection.getAccountInfo(publicKey);
        this.circuitBreaker.recordSuccess();
        return res;
      },
      this.retryConfig,
      (attempt, error) => this.onRpcError?.(error, attempt)
    );
  }

  /**
   * Fetch balance with retry
   */
  async getBalance(publicKey: PublicKey): Promise<number> {
    if (!this.circuitBreaker.canExecute()) {
      throw new Error('Circuit breaker is OPEN');
    }

    return fetchWithRetry(
      async () => {
        const res = await this.connection.getBalance(publicKey);
        this.circuitBreaker.recordSuccess();
        return res;
      },
      this.retryConfig,
      (attempt, error) => this.onRpcError?.(error, attempt)
    );
  }

  /**
   * Fetch token account balance with retry
   */
  async getTokenAccountBalance(publicKey: PublicKey): Promise<bigint> {
    if (!this.circuitBreaker.canExecute()) {
      throw new Error('Circuit breaker is OPEN');
    }

    return fetchWithRetry(
      async () => {
        const res = await this.connection.getTokenAccountBalance(publicKey);
        this.circuitBreaker.recordSuccess();
        return BigInt(res.value.amount);
      },
      this.retryConfig,
      (attempt, error) => this.onRpcError?.(error, attempt)
    );
  }
}
