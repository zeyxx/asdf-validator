import { PublicKey, Connection } from '@solana/web3.js';
import { createHash } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export type PoolType = 'bonding_curve' | 'pumpswap_amm';

export interface TokenConfig {
  mint: string;
  symbol: string;
  bondingCurve: string;
  poolType: PoolType;
  ammPool?: string;
  name?: string; // Legacy support
  pool?: string; // Legacy support
}

export interface FeeRecord {
  mint: string;
  symbol: string;
  amount: bigint;
  timestamp: number;
  slot: number;
}

export interface TokenStats {
  mint: string;
  symbol: string;
  name?: string;
  totalFees: bigint;
  feeCount: number;
  lastFeeTimestamp: number;
  migrated?: boolean;
  lastActivity?: number;
}

export interface BondingCurveData {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
}

export interface TrackedToken {
  mint: string;
  symbol: string;
  name?: string;
  bondingCurve: string;
  ammPool: string;
  migrated: boolean;
  lastSolReserves: bigint;
  lastAmmReserves: bigint;
  totalFees: bigint;
  feeCount: number;
  recentAmmFees: bigint;
  recentAmmFeesTimestamp: number;
  recentBcFees: bigint;
  recentBcFeesTimestamp: number;
  isMayhemMode: boolean;
  tokenProgram: 'TOKEN' | 'TOKEN_2022';
}

// ============================================================================
// Network Resilience
// ============================================================================

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
): Promise<T> {
  let lastError: Error = new Error('No attempts made');

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < config.maxRetries) {
        const delay = Math.min(
          config.baseDelayMs * Math.pow(2, attempt) + Math.random() * 100,
          config.maxDelayMs
        );

        if (onRetry) {
          onRetry(attempt + 1, lastError, delay);
        }

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures: number = 0;
  private lastFailure: number = 0;
  private successCount: number = 0;

  constructor(
    private readonly threshold: number = 5,
    private readonly resetTimeoutMs: number = 60000,
    private readonly halfOpenSuccessThreshold: number = 2
  ) {}

  getState(): CircuitState {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      }
    }
    return this.state;
  }

  canExecute(): boolean {
    const state = this.getState();
    return state !== 'OPEN';
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.halfOpenSuccessThreshold) {
        this.state = 'CLOSED';
        this.failures = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successCount = 0;
    this.lastFailure = 0;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new Error(`Circuit breaker is OPEN. Retry after ${Math.ceil((this.resetTimeoutMs - (Date.now() - this.lastFailure)) / 1000)}s`);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
}

// ============================================================================
// Performance Optimization
// ============================================================================

export class LRUCache<K, V> {
  private cache: Map<K, { value: V; expiry: number }>;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number = 100, ttlMs: number = 5000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      value,
      expiry: Date.now() + (ttlMs ?? this.ttlMs),
    });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiry) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private lastRefill: number;

  constructor(maxTokens: number = 10, refillRate: number = 2) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const tokensNeeded = 1 - this.tokens;
    const waitTimeMs = (tokensNeeded / this.refillRate) * 1000;
    await new Promise(resolve => setTimeout(resolve, waitTimeMs));
    this.tokens = 0;
  }

  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateSolanaAddress(address: string): ValidationResult {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Address is required' };
  }
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  if (!base58Regex.test(address)) {
    return { valid: false, error: 'Address contains invalid characters (must be base58)' };
  }
  if (address.length < 32 || address.length > 44) {
    return { valid: false, error: 'Address must be 32-44 characters long' };
  }
  try {
    new PublicKey(address);
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid Solana address checksum' };
  }
}

// Trusted RPC domains for strict validation (prevents SSRF)
export const TRUSTED_RPC_DOMAINS = [
  'api.mainnet-beta.solana.com',
  'api.devnet.solana.com',
  'api.testnet.solana.com',
  'mainnet.helius-rpc.com',
  'rpc.helius.xyz',
  'solana-mainnet.g.alchemy.com',
  'solana-devnet.g.alchemy.com',
  'mainnet.rpcpool.com',
  'devnet.rpcpool.com',
  'api.quicknode.com',
  'rpc.ankr.com',
  'solana.public-rpc.com',
];

export interface RpcValidationOptions {
  /** If true, only allow URLs from TRUSTED_RPC_DOMAINS */
  strict?: boolean;
  /** Additional domains to allow (only used when strict=true) */
  additionalDomains?: string[];
}

export function validateRpcUrl(url: string, options: RpcValidationOptions = {}): ValidationResult {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'RPC URL is required' };
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'RPC URL must use http or https protocol' };
    }
    if (!parsed.host) {
      return { valid: false, error: 'RPC URL must have a valid host' };
    }

    // Strict mode: check against whitelist
    if (options.strict) {
      const allowedDomains = [...TRUSTED_RPC_DOMAINS, ...(options.additionalDomains || [])];
      const hostname = parsed.hostname.toLowerCase();

      const isTrusted = allowedDomains.some(domain => {
        const domainLower = domain.toLowerCase();
        // Match exact domain or subdomain
        return hostname === domainLower || hostname.endsWith('.' + domainLower);
      });

      if (!isTrusted) {
        return {
          valid: false,
          error: `RPC URL domain not in trusted list. Use a known provider or disable strict mode.`
        };
      }
    }

    // Block obvious dangerous patterns
    const dangerousPatterns = [
      /^localhost$/i,
      /^127\.\d+\.\d+\.\d+$/,
      /^10\.\d+\.\d+\.\d+$/,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+$/,
      /^192\.168\.\d+\.\d+$/,
      /^0\.0\.0\.0$/,
      /^\[::1\]$/,
      /^169\.254\.\d+\.\d+$/, // Link-local
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(parsed.hostname)) {
        return { valid: false, error: 'RPC URL cannot point to internal/private network addresses' };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid RPC URL format' };
  }
}

export function validateTokenConfig(config: unknown): ValidationResult {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Token config must be an object' };
  }
  const token = config as Record<string, unknown>;
  
  // Mint required
  if (!token.mint || typeof token.mint !== 'string') {
    return { valid: false, error: 'Token config requires "mint" field' };
  }
  const mintValidation = validateSolanaAddress(token.mint);
  if (!mintValidation.valid) {
    return { valid: false, error: `Invalid mint address: ${mintValidation.error}` };
  }

  // Symbol or Name required
  if (!token.symbol && !token.name) {
    return { valid: false, error: 'Token config requires "symbol" or "name" field' };
  }

  // BondingCurve or Pool required
  if (!token.bondingCurve && !token.pool) {
    return { valid: false, error: 'Token config requires "bondingCurve" or "pool" field' };
  }

  // Pool Type optional but must be valid
  if (token.poolType && !['bonding_curve', 'pumpswap_amm'].includes(token.poolType as string)) {
    return { valid: false, error: 'poolType must be "bonding_curve" or "pumpswap_amm"' };
  }

  return { valid: true };
}

export function validateTokenConfigStrict(config: unknown): ValidationResult {
  return validateTokenConfig(config);
}

export function validatePollInterval(intervalMs: number): ValidationResult {
  if (typeof intervalMs !== 'number' || isNaN(intervalMs)) {
    return { valid: false, error: 'Poll interval must be a number' };
  }
  if (intervalMs < 1000) {
    return { valid: false, error: 'Poll interval must be at least 1000ms (1 second)' };
  }
  if (intervalMs > 300000) {
    return { valid: false, error: 'Poll interval must not exceed 300000ms (5 minutes)' };
  }
  return { valid: true };
}

// ============================================================================
// Constants & Parsers
// ============================================================================

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Get the Associated Token Account address for a given mint and owner.
 * This is a local implementation to avoid the vulnerable @solana/spl-token dependency.
 */
export async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  programId = SPL_TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID
): Promise<PublicKey> {
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    associatedTokenProgramId
  );
  return address;
}

export function deserializeMetadata(data: Buffer): { name: string; symbol: string } | null {
  try {
    // Metadata Account Data Layout (approximate for V1/V2)
    // Key: 1 byte
    // Update Authority: 32 bytes
    // Mint: 32 bytes
    // Data:
    //   Name: 4 bytes len + string (padded)
    //   Symbol: 4 bytes len + string (padded)
    
    let offset = 1 + 32 + 32; // Skip Key, UpdateAuth, Mint
    
    if (offset + 4 > data.length) return null;
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    
    if (offset + nameLen > data.length) return null;
    const name = data.subarray(offset, offset + nameLen).toString('utf8').replace(/\u0000/g, '').trim();
    offset += nameLen; // In some versions this might be fixed 32, but usually it's len + bytes.
    // Wait, Metaplex strings are often fixed size on older accounts. 
    // It's safest to assume standard Borsh but handle the nulls which implies padding.
    // Actually, simply reading the length and then the bytes works for both if we strip nulls.
    
    if (offset + 4 > data.length) return null;
    const symbolLen = data.readUInt32LE(offset);
    offset += 4;
    
    if (offset + symbolLen > data.length) return null;
    const symbol = data.subarray(offset, offset + symbolLen).toString('utf8').replace(/\u0000/g, '').trim();
    
    return { name, symbol };
  } catch {
    return null;
  }
}

export function deserializeToken2022Metadata(data: Buffer): { name: string; symbol: string } | null {
  try {
    // Check for Token-2022 Account Type/Extensions
    // Standard Mint size is 82.
    if (data.length <= 82) return null;

    // The logic to find extensions is:
    // 1. Read AccountType at offset 165 (usually) for Accounts, but for Mints it's after the mint data?
    // Actually, Token-2022 mints have a variable length.
    // The extensions start after the standard mint data (82 bytes).
    // There is usually a "Account Type" byte and then the TLV data.
    
    // Simplification: Scan for the Metadata Extension (Type 19)
    // TLV: Type (2 bytes), Length (2 bytes), Value
    
    let offset = 82; // End of standard mint
    
    // Scan for TLV start
    // In Token-2022, there is padding, then the AccountType (1 byte), then TLV.
    // However, finding the start of TLV can be tricky without the full layout.
    // But usually, the extensions are at the end of the buffer?
    // No, they are appended.
    
    // Let's try a heuristic search for the Metadata Extension Type (19) if we can't properly traverse.
    // Type 19 = 0x13 0x00 (little endian)
    
    // Proper traversal:
    // The Mint has a `tlv_address` if initialized?
    // Actually, just looping through the buffer from offset 82 looking for valid TLVs might be risky.
    
    // Let's assume standard packing:
    // offset 82: potentially padding zeros.
    // The TLV area starts where the first non-zero byte (AccountType) is?
    // No.
    
    // Alternative: If the user wants Token-2022 support, we should check if the account is actually a Mint with extensions.
    // For now, let's look for the specific pattern of the Metadata extension which starts with update_authority (32), mint (32), name(4+len).
    
    // Let's iterate through the buffer searching for the type 19 tag.
    // Structure: [19, 0, LEN, LEN_HI]
    
    for (let i = 82; i < data.length - 4; i++) {
        // Check for Type 19 (0x13, 0x00)
        if (data[i] === 0x13 && data[i+1] === 0x00) {
            const len = data.readUInt16LE(i + 2);
            // Check if length is reasonable and fits in buffer
            if (i + 4 + len <= data.length) {
                // Potential Metadata Extension found at i + 4
                // Layout:
                // UpdateAuth (32)
                // Mint (32)
                // Name (4 + len)
                // Symbol (4 + len)
                
                let metaOffset = i + 4;
                metaOffset += 32; // Skip UpdateAuth
                metaOffset += 32; // Skip Mint
                
                if (metaOffset + 4 > data.length) continue;
                const nameLen = data.readUInt32LE(metaOffset);
                metaOffset += 4;
                
                if (metaOffset + nameLen > data.length) continue;
                const name = data.subarray(metaOffset, metaOffset + nameLen).toString('utf8').replace(/\u0000/g, '').trim();
                metaOffset += nameLen;
                
                if (metaOffset + 4 > data.length) continue;
                const symbolLen = data.readUInt32LE(metaOffset);
                metaOffset += 4;
                
                if (metaOffset + symbolLen > data.length) continue;
                const symbol = data.subarray(metaOffset, metaOffset + symbolLen).toString('utf8').replace(/\u0000/g, '').trim();
                
                // Heuristic validation: name and symbol should be printable
                if (name.length > 0) {
                     return { name, symbol };
                }
            }
        }
    }
    
    return null;
  } catch {
    return null;
  }
}

export function deserializeBondingCurve(data: Buffer): BondingCurveData | null {
  if (data.length < 81) return null;

  try {
    let offset = 8;
    const virtualTokenReserves = data.readBigUInt64LE(offset); offset += 8;
    const virtualSolReserves = data.readBigUInt64LE(offset); offset += 8;
    const realTokenReserves = data.readBigUInt64LE(offset); offset += 8;
    const realSolReserves = data.readBigUInt64LE(offset); offset += 8;
    const tokenTotalSupply = data.readBigUInt64LE(offset); offset += 8;
    const complete = data[offset] === 1; offset += 1;
    const creator = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const isMayhemMode = data.length >= 82 ? data[offset] === 1 : false;

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      creator,
      isMayhemMode,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Utils
// ============================================================================

export function getMemoryUsage(): { heapUsed: number; heapTotal: number; rss: number } {
  const usage = process.memoryUsage();
  return {
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
    rss: Math.round(usage.rss / 1024 / 1024),
  };
}

export function validateHistoryLog(log: unknown): ValidationResult {
  if (!log || typeof log !== 'object') {
    return { valid: false, error: 'History log must be an object' };
  }

  const history = log as Record<string, unknown>;

  const requiredFields = [
    'version',
    'creator',
    'bcVault',
    'ammVault',
    'startedAt',
    'lastUpdated',
    'totalFees',
    'entryCount',
    'latestHash',
    'entries',
  ];

  for (const field of requiredFields) {
    if (!(field in history)) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  if (!Array.isArray(history.entries)) {
    return { valid: false, error: 'entries must be an array' };
  }

  if (typeof history.entryCount !== 'number') {
    return { valid: false, error: 'entryCount must be a number' };
  }

  const creatorValidation = validateSolanaAddress(history.creator as string);
  if (!creatorValidation.valid) {
    return { valid: false, error: `Invalid creator address: ${creatorValidation.error}` };
  }

  return { valid: true };
}
