/**
 * ASDF Validator Daemon
 *
 * Standalone daemon to track fees for tokens sharing a creator vault.
 * Anyone can run this to monitor their own creator address.
 *
 * @example
 * ```typescript
 * import { ValidatorDaemon } from '@asdf/validator-sdk';
 *
 * const daemon = new ValidatorDaemon({
 *   rpcUrl: 'https://api.mainnet-beta.solana.com',
 *   creatorAddress: 'YOUR_CREATOR_WALLET',
 *   onFeeDetected: (mint, amount) => {
 *     console.log(`${mint}: +${amount / 1e9} SOL`);
 *   }
 * });
 *
 * await daemon.start();
 * ```
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Constants
// ============================================================================

/** PumpFun Program ID */
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** PumpSwap AMM Program ID */
export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

/** Wrapped SOL Mint */
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** Token Program ID (SPL Token) */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** Token-2022 Program ID (used by Mayhem Mode tokens) */
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** Associated Token Program ID */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// ============================================================================
// Types
// ============================================================================

export type PoolType = 'bonding_curve' | 'pumpswap_amm';

export interface TokenConfig {
  mint: string;
  symbol: string;
  bondingCurve: string;
  poolType: PoolType;
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
  totalFees: bigint;
  feeCount: number;
  lastFeeTimestamp: number;
  migrated?: boolean;
  lastActivity?: number;
}

// ============================================================================
// Bonding Curve Types & Deserialization
// ============================================================================

/**
 * Pump.fun Bonding Curve Account Layout:
 *
 * discriminator:         8 bytes (anchor discriminator)
 * virtual_token_reserves: u64 (8 bytes)
 * virtual_sol_reserves:   u64 (8 bytes)
 * real_token_reserves:    u64 (8 bytes)
 * real_sol_reserves:      u64 (8 bytes)
 * token_total_supply:     u64 (8 bytes)
 * complete:               bool (1 byte)
 * creator:                Pubkey (32 bytes)
 * is_mayhem_mode:         bool (1 byte) - optional, only present in 82-byte accounts
 *
 * Total: 81 bytes (classic) or 82 bytes (mayhem mode / Token-2022)
 */
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

/**
 * Deserialize a Pump.fun bonding curve account
 * @param data Raw account data buffer
 * @returns Parsed bonding curve data or null if invalid
 */
export function deserializeBondingCurve(data: Buffer): BondingCurveData | null {
  // Structure: 8 (discriminator) + 40 (5 u64s) + 1 (bool) + 32 (pubkey) = 81 bytes minimum
  // Mayhem mode adds 1 byte (is_mayhem_mode) = 82 bytes
  if (data.length < 81) return null;

  try {
    // Skip 8-byte discriminator
    let offset = 8;

    const virtualTokenReserves = data.readBigUInt64LE(offset); offset += 8;
    const virtualSolReserves = data.readBigUInt64LE(offset); offset += 8;
    const realTokenReserves = data.readBigUInt64LE(offset); offset += 8;
    const realSolReserves = data.readBigUInt64LE(offset); offset += 8;
    const tokenTotalSupply = data.readBigUInt64LE(offset); offset += 8;
    const complete = data[offset] === 1; offset += 1;
    const creator = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;

    // Mayhem mode flag (Token-2022) - only present in 82-byte accounts
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

/**
 * Token discovered from on-chain bonding curve scan
 */
export interface DiscoveredToken {
  bondingCurve: PublicKey;
  mint?: PublicKey;
  creator: PublicKey;
  migrated: boolean;
  realSolReserves: bigint;
  isMayhemMode: boolean;
}

/**
 * Token being actively tracked
 */
export interface TrackedToken {
  mint: string;
  symbol: string;
  bondingCurve: string;
  ammPool: string;
  migrated: boolean;
  lastSolReserves: bigint;  // BC reserves for non-migrated
  lastAmmReserves: bigint;  // AMM pool WSOL reserves for migrated
  totalFees: bigint;
  feeCount: number;
  recentAmmFees: bigint;    // AMM fees in recent window (for proportional distribution)
  recentAmmFeesTimestamp: number;  // When recentAmmFees started accumulating
  recentBcFees: bigint;     // BC fees in recent window (for proportional distribution)
  recentBcFeesTimestamp: number;   // When recentBcFees started accumulating
  isMayhemMode: boolean;    // Token-2022 mayhem mode token
  tokenProgram: 'TOKEN' | 'TOKEN_2022';  // Which token program this mint uses
}

/**
 * Derive bonding curve PDA from mint address
 * Seeds: ["bonding-curve", mint]
 */
export function deriveBondingCurve(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

/**
 * Discover all tokens created by a specific creator address
 * Uses getProgramAccounts to scan for bonding curves
 * Supports both classic (81 bytes) and mayhem mode (82 bytes) accounts
 *
 * @param connection Solana RPC connection
 * @param creator Creator wallet address
 * @returns Array of discovered tokens with their bonding curve data
 */
export async function discoverCreatorTokens(
  connection: Connection,
  creator: PublicKey
): Promise<DiscoveredToken[]> {
  // BC account layout: creator pubkey is at offset 49 (8 disc + 40 reserves + 1 complete)
  const creatorOffset = 49;

  // Query both classic (81 bytes) and mayhem mode (82 bytes) accounts
  const [classicAccounts, mayhemAccounts] = await Promise.all([
    connection.getProgramAccounts(PUMP_PROGRAM_ID, {
      filters: [
        { dataSize: 81 }, // Classic BC account size
        { memcmp: { offset: creatorOffset, bytes: creator.toBase58() } },
      ],
    }),
    connection.getProgramAccounts(PUMP_PROGRAM_ID, {
      filters: [
        { dataSize: 82 }, // Mayhem mode BC account size (Token-2022)
        { memcmp: { offset: creatorOffset, bytes: creator.toBase58() } },
      ],
    }),
  ]);

  const tokens: DiscoveredToken[] = [];

  // Process classic accounts
  for (const { pubkey, account } of classicAccounts) {
    const data = deserializeBondingCurve(account.data);
    if (data) {
      tokens.push({
        bondingCurve: pubkey,
        creator: data.creator,
        migrated: data.complete,
        realSolReserves: data.realSolReserves,
        isMayhemMode: false,
      });
    }
  }

  // Process mayhem mode accounts (Token-2022)
  for (const { pubkey, account } of mayhemAccounts) {
    const data = deserializeBondingCurve(account.data);
    if (data) {
      tokens.push({
        bondingCurve: pubkey,
        creator: data.creator,
        migrated: data.complete,
        realSolReserves: data.realSolReserves,
        isMayhemMode: data.isMayhemMode,
      });
    }
  }

  return tokens;
}

/**
 * Detect which token program a mint uses (SPL Token or Token-2022)
 * @param connection Solana RPC connection
 * @param mint Mint address to check
 * @returns 'TOKEN' or 'TOKEN_2022'
 */
export async function getTokenProgramForMint(
  connection: Connection,
  mint: PublicKey
): Promise<'TOKEN' | 'TOKEN_2022'> {
  try {
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) return 'TOKEN';

    // The owner of the mint account indicates which token program is used
    if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return 'TOKEN_2022';
    }
    return 'TOKEN';
  } catch {
    return 'TOKEN';
  }
}

/**
 * Get the mint address from a bonding curve by examining its token accounts
 * Supports both SPL Token and Token-2022 (mayhem mode) accounts
 */
export async function getMintFromBondingCurve(
  connection: Connection,
  bondingCurve: PublicKey
): Promise<{ mint: PublicKey; tokenProgram: 'TOKEN' | 'TOKEN_2022' } | null> {
  try {
    // Try SPL Token program first (classic tokens)
    let tokenAccounts = await connection.getTokenAccountsByOwner(bondingCurve, {
      programId: SPL_TOKEN_PROGRAM_ID,
    });

    let tokenProgram: 'TOKEN' | 'TOKEN_2022' = 'TOKEN';

    // If not found, try Token-2022 program (mayhem mode)
    if (tokenAccounts.value.length === 0) {
      tokenAccounts = await connection.getTokenAccountsByOwner(bondingCurve, {
        programId: TOKEN_2022_PROGRAM_ID,
      });
      tokenProgram = 'TOKEN_2022';
    }

    if (tokenAccounts.value.length === 0) {
      return null;
    }

    // Parse the first token account to get the mint
    // Token account layout: mint is at offset 0 (32 bytes)
    const data = tokenAccounts.value[0].account.data;
    const mint = new PublicKey(data.slice(0, 32));
    return { mint, tokenProgram };
  } catch {
    return null;
  }
}

// Global fetch is available in Node.js 18+
declare function fetch(url: string, init?: RequestInit): Promise<Response>;
interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
interface Response {
  json(): Promise<any>;
}

/**
 * Fetch token metadata from Helius DAS API
 */
export async function fetchTokenMetadata(
  rpcUrl: string,
  mint: PublicKey
): Promise<{ symbol: string; name: string } | null> {
  try {
    // Use Helius DAS API getAsset method
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'asdf-validator',
        method: 'getAsset',
        params: { id: mint.toBase58() },
      }),
    });

    const json = await response.json() as any;
    if (json.result?.content?.metadata) {
      const meta = json.result.content.metadata;
      return {
        symbol: meta.symbol || 'UNKNOWN',
        name: meta.name || 'Unknown Token',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Enriched token with metadata
 */
export interface EnrichedToken {
  mint: PublicKey;
  symbol: string;
  name: string;
  bondingCurve: PublicKey;
  migrated: boolean;
}

/**
 * Extract Helius API key from RPC URL
 */
function extractHeliusApiKey(rpcUrl: string): string | null {
  const match = rpcUrl.match(/api-key=([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

/**
 * Discover tokens via Helius enhanced transactions API
 * This is much more efficient than getProgramAccounts
 */
export async function discoverTokensViaHelius(
  connection: Connection,
  creator: PublicKey,
  rpcUrl: string
): Promise<EnrichedToken[]> {
  const apiKey = extractHeliusApiKey(rpcUrl);
  if (!apiKey) {
    throw new Error('Helius API key required for token discovery');
  }

  const tokens: EnrichedToken[] = [];
  const seenMints = new Set<string>();

  // Paginate through transactions (no type filter - Pump.fun uses custom types)
  let before: string | undefined;
  let hasMore = true;
  let pageCount = 0;
  const MAX_PAGES = 10; // Limit pages to avoid excessive API calls

  while (hasMore && pageCount < MAX_PAGES) {
    pageCount++;

    // Don't use type=CREATE - Pump.fun transactions have different types
    const txUrl = `https://api.helius.xyz/v0/addresses/${creator.toBase58()}/transactions?api-key=${apiKey}&limit=100${before ? `&before=${before}` : ''}`;

    try {
      const txResponse = await fetch(txUrl);
      const txsRaw = await txResponse.json();

      // Handle API errors or non-array responses
      if (!Array.isArray(txsRaw)) {
        console.warn('Helius API returned non-array response:', typeof txsRaw);
        hasMore = false;
        break;
      }
      const txs = txsRaw as any[];

      if (txs.length === 0) {
        hasMore = false;
        break;
      }

      for (const tx of txs) {
        // Look for Pump.fun program in accountData or instructions
        const isPumpFunTx = tx.source === 'PUMP_FUN' ||
                           tx.instructions?.some((ix: any) => ix.programId === PUMP_PROGRAM_ID.toBase58());

        if (!isPumpFunTx) continue;

        // Get mint from tokenTransfers or nativeTransfers
        let mintAddress: string | null = null;

        if (tx.tokenTransfers?.length) {
          // Look for a non-SOL mint
          for (const transfer of tx.tokenTransfers) {
            if (transfer.mint && transfer.mint !== WSOL_MINT.toBase58()) {
              mintAddress = transfer.mint;
              break;
            }
          }
        }

        if (!mintAddress) continue;
        if (seenMints.has(mintAddress)) continue;

        seenMints.add(mintAddress);
        const mint = new PublicKey(mintAddress);

        // Derive bonding curve from mint
        const bondingCurve = deriveBondingCurve(mint);

        // Verify this BC belongs to our creator
        let migrated = false;
        let isOurToken = false;
        try {
          const bcAccount = await connection.getAccountInfo(bondingCurve);
          if (bcAccount?.data) {
            const bcData = deserializeBondingCurve(bcAccount.data);
            if (bcData && bcData.creator.equals(creator)) {
              isOurToken = true;
              migrated = bcData.complete;
            }
          }
        } catch {
          // Skip if we can't verify
          continue;
        }

        if (!isOurToken) continue;

        // Fetch metadata via DAS
        const metadata = await fetchTokenMetadata(rpcUrl, mint);

        tokens.push({
          mint,
          symbol: metadata?.symbol || 'UNKNOWN',
          name: metadata?.name || 'Unknown Token',
          bondingCurve,
          migrated,
        });
      }

      // Get signature of last tx for pagination
      if (txs.length > 0) {
        before = txs[txs.length - 1].signature;
      }

      // Stop if we got less than expected (last page)
      if (txs.length < 100) {
        hasMore = false;
      }
    } catch (error) {
      console.warn('Helius API fetch error:', error);
      hasMore = false;
    }
  }

  return tokens;
}

/**
 * Discover tokens with full metadata using Helius DAS API
 * @deprecated Use discoverTokensViaHelius instead
 */
export async function discoverCreatorTokensWithMetadata(
  connection: Connection,
  creator: PublicKey,
  rpcUrl: string
): Promise<(DiscoveredToken & { mint: PublicKey; symbol: string; name: string })[]> {
  // Try Helius API first
  if (rpcUrl.includes('helius')) {
    const tokens = await discoverTokensViaHelius(connection, creator, rpcUrl);
    return tokens.map(t => ({
      bondingCurve: t.bondingCurve,
      creator,
      migrated: t.migrated,
      realSolReserves: 0n,
      isMayhemMode: false, // Helius API doesn't provide this, default to classic
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
    }));
  }

  // Fallback to getProgramAccounts (may fail with large programs)
  const basicTokens = await discoverCreatorTokens(connection, creator);
  const enrichedTokens: (DiscoveredToken & { mint: PublicKey; symbol: string; name: string; tokenProgram: 'TOKEN' | 'TOKEN_2022' })[] = [];

  for (const token of basicTokens) {
    const mintResult = await getMintFromBondingCurve(connection, token.bondingCurve);
    if (!mintResult) continue;

    const { mint, tokenProgram } = mintResult;
    const metadata = await fetchTokenMetadata(rpcUrl, mint);

    enrichedTokens.push({
      ...token,
      mint,
      tokenProgram,
      symbol: metadata?.symbol || `TOKEN-${enrichedTokens.length + 1}`,
      name: metadata?.name || 'Unknown Token',
    });
  }

  return enrichedTokens;
}

// ============================================================================
// Proof-of-History Types
// ============================================================================

/** Genesis block hash - SHA256("ASDF_VALIDATOR_GENESIS") */
export const GENESIS_HASH = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

// ============================================================================
// Performance Optimization
// ============================================================================

/**
 * Simple LRU Cache implementation
 */
export class LRUCache<K, V> {
  private cache: Map<K, { value: V; expiry: number }>;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number = 100, ttlMs: number = 5000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Get a value from cache
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check if expired
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  /**
   * Set a value in cache
   */
  set(key: K, value: V, ttlMs?: number): void {
    // Remove if exists (to update position)
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + (ttlMs ?? this.ttlMs),
    });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a key from cache
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clean up expired entries
   */
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

/**
 * Rate limiter using token bucket algorithm
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private lastRefill: number;

  constructor(maxTokens: number = 10, refillRate: number = 2) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /**
   * Try to acquire a token
   * @returns true if token acquired, false if rate limited
   */
  tryAcquire(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Wait until a token is available
   * @returns Promise that resolves when token is acquired
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate wait time for next token
    const tokensNeeded = 1 - this.tokens;
    const waitTimeMs = (tokensNeeded / this.refillRate) * 1000;

    await new Promise(resolve => setTimeout(resolve, waitTimeMs));
    this.tokens = 0; // We used the token we waited for
  }

  /**
   * Get available tokens
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Reset rate limiter
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}

/**
 * Memory usage monitor
 */
export function getMemoryUsage(): { heapUsed: number; heapTotal: number; rss: number } {
  const usage = process.memoryUsage();
  return {
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
    rss: Math.round(usage.rss / 1024 / 1024), // MB
  };
}

// ============================================================================
// Input Validation
// ============================================================================

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate RPC URL format
 */
export function validateRpcUrl(url: string): ValidationResult {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'RPC URL is required' };
  }

  try {
    const parsed = new URL(url);

    // Must be http or https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'RPC URL must use http or https protocol' };
    }

    // Must have a host
    if (!parsed.host) {
      return { valid: false, error: 'RPC URL must have a valid host' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid RPC URL format' };
  }
}

/**
 * Validate Solana address format (base58, 32-44 chars)
 */
export function validateSolanaAddress(address: string): ValidationResult {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Address is required' };
  }

  // Base58 character set
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;

  if (!base58Regex.test(address)) {
    return { valid: false, error: 'Address contains invalid characters (must be base58)' };
  }

  if (address.length < 32 || address.length > 44) {
    return { valid: false, error: 'Address must be 32-44 characters long' };
  }

  // Try to create PublicKey to validate checksum
  try {
    new PublicKey(address);
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid Solana address checksum' };
  }
}

/**
 * Validate token configuration
 */
export function validateTokenConfig(config: unknown): ValidationResult {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Token config must be an object' };
  }

  const token = config as Record<string, unknown>;

  // Required: mint
  if (!token.mint || typeof token.mint !== 'string') {
    return { valid: false, error: 'Token config requires "mint" field' };
  }

  const mintValidation = validateSolanaAddress(token.mint);
  if (!mintValidation.valid) {
    return { valid: false, error: `Invalid mint address: ${mintValidation.error}` };
  }

  // Required: symbol (or name as fallback)
  if (!token.symbol && !token.name) {
    return { valid: false, error: 'Token config requires "symbol" or "name" field' };
  }

  // Required: bondingCurve (or pool as fallback)
  if (!token.bondingCurve && !token.pool) {
    return { valid: false, error: 'Token config requires "bondingCurve" or "pool" field' };
  }

  const bcAddress = (token.bondingCurve || token.pool) as string;
  const bcValidation = validateSolanaAddress(bcAddress);
  if (!bcValidation.valid) {
    return { valid: false, error: `Invalid bondingCurve address: ${bcValidation.error}` };
  }

  // Optional: poolType
  if (token.poolType) {
    if (!['bonding_curve', 'pumpswap_amm'].includes(token.poolType as string)) {
      return { valid: false, error: 'poolType must be "bonding_curve" or "pumpswap_amm"' };
    }
  }

  return { valid: true };
}

/**
 * Validate history log structure
 */
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

  // Validate creator address
  const creatorValidation = validateSolanaAddress(history.creator as string);
  if (!creatorValidation.valid) {
    return { valid: false, error: `Invalid creator address: ${creatorValidation.error}` };
  }

  return { valid: true };
}

/**
 * Validate poll interval
 */
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
// Network Resilience
// ============================================================================

/**
 * Configuration for retry logic
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

/**
 * Execute a function with exponential backoff retry
 */
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
        // Exponential backoff with jitter
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

/**
 * Circuit breaker states
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Circuit breaker for RPC failure protection
 */
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

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    if (this.state === 'OPEN') {
      // Check if reset timeout has passed
      if (Date.now() - this.lastFailure >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      }
    }
    return this.state;
  }

  /**
   * Check if circuit allows execution
   */
  canExecute(): boolean {
    const state = this.getState();
    return state !== 'OPEN';
  }

  /**
   * Record a successful execution
   */
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

  /**
   * Record a failed execution
   */
  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
    }
  }

  /**
   * Reset the circuit breaker
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successCount = 0;
    this.lastFailure = 0;
  }

  /**
   * Execute a function with circuit breaker protection
   */
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

/**
 * Check if RPC endpoint is healthy
 */
export async function checkRpcHealth(
  connection: Connection,
  timeoutMs: number = 5000
): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
  const startTime = Date.now();

  try {
    // Race between getSlot and timeout
    const result = await Promise.race([
      connection.getSlot().then(() => ({ success: true as const })),
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
 * Event type for history entries
 */
export type HistoryEventType = 'FEE' | 'CLAIM';

/**
 * Proof-of-History entry for verifiable fee tracking
 * Each entry is chained to the previous via prevHash
 */
export interface HistoryEntry {
  /** Sequence number (0 = genesis) */
  sequence: number;
  /** Hash of previous entry (genesis for first) */
  prevHash: string;
  /** SHA-256 hash of this entry's data */
  hash: string;
  /** Event type: FEE (incoming) or CLAIM (withdrawal) */
  eventType: HistoryEventType;
  /** Vault type: BC or AMM */
  vaultType: 'BC' | 'AMM';
  /** Vault address */
  vault: string;
  /** Token mint address (if attribution available) */
  mint?: string;
  /** Token symbol (if attribution available) */
  symbol?: string;
  /** Amount in lamports (positive for FEE, negative for CLAIM) */
  amount: string;
  /** Balance before this event */
  balanceBefore: string;
  /** Balance after this event */
  balanceAfter: string;
  /** Solana slot number */
  slot: number;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** ISO date string for readability */
  date: string;
}

/**
 * Full proof-of-history log with metadata
 */
export interface HistoryLog {
  /** Version of the proof-of-history format */
  version: string;
  /** Creator address being tracked */
  creator: string;
  /** BC vault address */
  bcVault: string;
  /** AMM vault address */
  ammVault: string;
  /** When tracking started */
  startedAt: string;
  /** Last update time */
  lastUpdated: string;
  /** Total fees tracked (lamports) */
  totalFees: string;
  /** Number of fee events */
  entryCount: number;
  /** Hash of latest entry */
  latestHash: string;
  /** All history entries */
  entries: HistoryEntry[];
}

export interface DaemonConfig {
  /** Solana RPC URL */
  rpcUrl: string;

  /** Creator wallet address (owner of the vault) */
  creatorAddress: string;

  /** Tokens to track (optional - auto-detect if not provided) */
  tokens?: TokenConfig[];

  /** Enable automatic token discovery via BC scan (default: true) */
  autoDiscover?: boolean;

  /** Poll interval in milliseconds (default: 5000) */
  pollInterval?: number;

  /** Callback when fees detected */
  onFeeDetected?: (record: FeeRecord) => void;

  /** Callback for periodic stats */
  onStats?: (stats: TokenStats[]) => void;

  /** Callback when a new token is discovered */
  onTokenDiscovered?: (token: DiscoveredToken) => void;

  /** Stats interval in milliseconds (default: 60000) */
  statsInterval?: number;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Path to proof-of-history JSON file (enables PoH tracking) */
  historyFile?: string;

  /** Callback when history entry is added */
  onHistoryEntry?: (entry: HistoryEntry) => void;

  /** Retry configuration for RPC calls */
  retryConfig?: RetryConfig;

  /** Enable health check on startup (default: true) */
  enableHealthCheck?: boolean;

  /** Callback when RPC errors occur */
  onRpcError?: (error: Error, attempt: number) => void;
}

// ============================================================================
// Proof-of-History Functions
// ============================================================================

/**
 * Compute SHA-256 hash of entry data (excluding the hash field itself)
 */
export function computeEntryHash(entry: Omit<HistoryEntry, 'hash'>): string {
  const data = [
    entry.sequence.toString(),
    entry.prevHash,
    entry.eventType,
    entry.vaultType,
    entry.vault,
    entry.mint || '',
    entry.symbol || '',
    entry.amount,
    entry.balanceBefore,
    entry.balanceAfter,
    entry.slot.toString(),
    entry.timestamp.toString(),
  ].join('|');

  return createHash('sha256').update(data).digest('hex');
}

/**
 * Verify a single history entry's hash
 */
export function verifyEntryHash(entry: HistoryEntry): boolean {
  const computed = computeEntryHash(entry);
  return computed === entry.hash;
}

/**
 * Verify the entire proof-of-history chain
 * Returns { valid: true } or { valid: false, error: string, entryIndex: number }
 */
export function verifyHistoryChain(log: HistoryLog): { valid: boolean; error?: string; entryIndex?: number } {
  if (log.entries.length === 0) {
    return { valid: true };
  }

  // Verify first entry links to genesis
  if (log.entries[0].prevHash !== GENESIS_HASH) {
    return { valid: false, error: 'First entry does not link to genesis hash', entryIndex: 0 };
  }

  // Verify each entry
  for (let i = 0; i < log.entries.length; i++) {
    const entry = log.entries[i];

    // Verify sequence number
    if (entry.sequence !== i + 1) {
      return { valid: false, error: `Invalid sequence number: expected ${i + 1}, got ${entry.sequence}`, entryIndex: i };
    }

    // Verify hash
    if (!verifyEntryHash(entry)) {
      return { valid: false, error: `Invalid hash at entry ${i + 1}`, entryIndex: i };
    }

    // Verify chain linkage (except first entry)
    if (i > 0 && entry.prevHash !== log.entries[i - 1].hash) {
      return { valid: false, error: `Broken chain at entry ${i + 1}: prevHash does not match previous entry`, entryIndex: i };
    }
  }

  // Verify latest hash matches
  const lastEntry = log.entries[log.entries.length - 1];
  if (log.latestHash !== lastEntry.hash) {
    return { valid: false, error: 'latestHash does not match last entry hash', entryIndex: log.entries.length - 1 };
  }

  return { valid: true };
}

/**
 * Load existing history log or create new one
 */
export function loadHistoryLog(filePath: string, creator: string, bcVault: string, ammVault: string): HistoryLog {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as HistoryLog;
    }
  } catch (error) {
    console.error(`Warning: Could not load history file, creating new: ${error}`);
  }

  // Create new history log
  return {
    version: '1.0.0',
    creator,
    bcVault,
    ammVault,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    totalFees: '0',
    entryCount: 0,
    latestHash: GENESIS_HASH,
    entries: [],
  };
}

/**
 * Save history log to file
 */
export function saveHistoryLog(filePath: string, log: HistoryLog): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
}

// ============================================================================
// Vault Address Derivation
// ============================================================================

/**
 * Derive creator vault for PumpFun Bonding Curve
 * Seeds: ["creator-vault", creator] (hyphen)
 */
export function deriveBondingCurveVault(creator: PublicKey): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return vault;
}

/**
 * Derive creator vault for PumpSwap AMM
 * Seeds: ["creator_vault", creator] (underscore)
 */
export function derivePumpSwapVault(creator: PublicKey): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), creator.toBuffer()],
    PUMPSWAP_PROGRAM_ID
  );
  return vault;
}

/**
 * Derive AMM Pool address from mint
 * Seeds: ["pool", mint, WSOL_MINT, index(u16)]
 */
export function deriveAMMPool(mint: PublicKey, index: number = 0): PublicKey {
  const indexBuffer = Buffer.alloc(2);
  indexBuffer.writeUInt16LE(index);
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), mint.toBuffer(), WSOL_MINT.toBuffer(), indexBuffer],
    PUMPSWAP_PROGRAM_ID
  );
  return pool;
}

/**
 * Derive AMM Creator Vault ATA (WSOL token account for creator fees)
 * Uses getAssociatedTokenAddress with allowOwnerOffCurve = true
 */
export async function deriveAMMCreatorVaultATA(creator: PublicKey): Promise<PublicKey> {
  const creatorVault = derivePumpSwapVault(creator);
  return getAssociatedTokenAddress(WSOL_MINT, creatorVault, true);
}

// ============================================================================
// Validator Daemon
// ============================================================================

/**
 * Standalone validator daemon for tracking creator fees
 */
export class ValidatorDaemon {
  private connection: Connection;
  private rpcUrl: string;
  private creator: PublicKey;
  private tokens: Map<string, TokenConfig>;
  private tokenStats: Map<string, TokenStats>;

  // Token discovery and tracking
  private trackedTokens: Map<string, TrackedToken>;
  private autoDiscover: boolean;
  private onTokenDiscovered?: (token: DiscoveredToken) => void;

  private bcVault: PublicKey;
  private ammVault: PublicKey;
  private ammVaultATA!: PublicKey; // WSOL token account for AMM fees (initialized in start())
  private lastBcBalance: bigint = 0n;
  private lastAmmBalance: bigint = 0n; // WSOL balance in ATA

  // AMM transaction tracking for per-token attribution
  private lastAMMSignature: string | null = null;
  private processedAMMTxs: Set<string> = new Set();

  // BC transaction tracking for per-token attribution
  private lastBCSignature: string | null = null;
  private processedBCTxs: Set<string> = new Set();

  private pollInterval: number;
  private statsInterval: number;
  private verbose: boolean;

  private onFeeDetected?: (record: FeeRecord) => void;
  private onStats?: (stats: TokenStats[]) => void;
  private onHistoryEntry?: (entry: HistoryEntry) => void;
  private onRpcError?: (error: Error, attempt: number) => void;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Proof-of-History
  private historyFile?: string;
  private historyLog?: HistoryLog;

  // Network resilience
  private circuitBreaker: CircuitBreaker;
  private retryConfig: RetryConfig;
  private enableHealthCheck: boolean;

  constructor(config: DaemonConfig) {
    this.rpcUrl = config.rpcUrl;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this.creator = new PublicKey(config.creatorAddress);
    this.tokens = new Map();
    this.tokenStats = new Map();
    this.trackedTokens = new Map();

    // Token discovery config
    this.autoDiscover = config.autoDiscover !== false; // default: true
    this.onTokenDiscovered = config.onTokenDiscovered;

    // Derive vault addresses (ammVaultATA is async, initialized in start())
    this.bcVault = deriveBondingCurveVault(this.creator);
    this.ammVault = derivePumpSwapVault(this.creator);

    // Load tokens if provided
    if (config.tokens) {
      for (const token of config.tokens) {
        this.tokens.set(token.mint, token);
        this.tokenStats.set(token.mint, {
          mint: token.mint,
          symbol: token.symbol,
          totalFees: 0n,
          feeCount: 0,
          lastFeeTimestamp: 0,
        });
        // Derive AMM pool from mint
        const mintPubkey = new PublicKey(token.mint);
        const ammPool = deriveAMMPool(mintPubkey);
        // Also add to tracked tokens
        this.trackedTokens.set(token.bondingCurve, {
          mint: token.mint,
          symbol: token.symbol,
          bondingCurve: token.bondingCurve,
          ammPool: ammPool.toBase58(),
          migrated: token.poolType === 'pumpswap_amm',
          lastSolReserves: 0n,
          lastAmmReserves: 0n,
          totalFees: 0n,
          feeCount: 0,
          recentAmmFees: 0n,
          recentAmmFeesTimestamp: Date.now(),
          recentBcFees: 0n,
          recentBcFeesTimestamp: Date.now(),
          isMayhemMode: false, // User-configured tokens default to classic
          tokenProgram: 'TOKEN', // Default to SPL Token, will be detected on first use
        });
      }
    }

    this.pollInterval = config.pollInterval || 5000;
    this.statsInterval = config.statsInterval || 60000;
    this.verbose = config.verbose || false;
    this.onFeeDetected = config.onFeeDetected;
    this.onStats = config.onStats;
    this.onHistoryEntry = config.onHistoryEntry;
    this.onRpcError = config.onRpcError;

    // Network resilience
    this.circuitBreaker = new CircuitBreaker();
    this.retryConfig = config.retryConfig || DEFAULT_RETRY_CONFIG;
    this.enableHealthCheck = config.enableHealthCheck !== false;

    // Initialize Proof-of-History if file path provided
    this.historyFile = config.historyFile;
    if (this.historyFile) {
      this.historyLog = loadHistoryLog(
        this.historyFile,
        this.creator.toBase58(),
        this.bcVault.toBase58(),
        this.ammVault.toBase58()
      );
    }
  }

  /**
   * Add a token to track
   */
  addToken(config: TokenConfig): void {
    this.tokens.set(config.mint, config);
    if (!this.tokenStats.has(config.mint)) {
      this.tokenStats.set(config.mint, {
        mint: config.mint,
        symbol: config.symbol,
        totalFees: 0n,
        feeCount: 0,
        lastFeeTimestamp: 0,
      });
    }
  }

  /**
   * Get current stats for all tokens
   */
  getStats(): TokenStats[] {
    return Array.from(this.tokenStats.values());
  }

  /**
   * Get all tracked tokens
   */
  getTrackedTokens(): TrackedToken[] {
    return Array.from(this.trackedTokens.values());
  }

  /**
   * Get total fees across all tokens
   */
  getTotalFees(): bigint {
    let total = 0n;
    for (const stats of this.tokenStats.values()) {
      total += stats.totalFees;
    }
    return total;
  }

  /**
   * Get the proof-of-history log (if enabled)
   */
  getHistoryLog(): HistoryLog | undefined {
    return this.historyLog;
  }

  /**
   * Verify the proof-of-history chain integrity
   */
  verifyHistory(): { valid: boolean; error?: string; entryIndex?: number } {
    if (!this.historyLog) {
      return { valid: false, error: 'Proof-of-History not enabled' };
    }
    return verifyHistoryChain(this.historyLog);
  }

  /**
   * Get history file path
   */
  getHistoryFilePath(): string | undefined {
    return this.historyFile;
  }

  /**
   * Get circuit breaker state
   */
  getCircuitState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  /**
   * Check RPC health
   */
  async checkHealth(timeoutMs: number = 5000): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
    return checkRpcHealth(this.connection, timeoutMs);
  }

  /**
   * Reset circuit breaker manually
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  /**
   * Start the daemon
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log('Daemon already running');
      return;
    }

    this.log('Starting validator daemon...');
    this.log(`Creator: ${this.creator.toBase58()}`);
    this.log(`BC Vault: ${this.bcVault.toBase58()}`);
    this.log(`AMM Vault: ${this.ammVault.toBase58()}`);

    // Derive AMM vault ATA (async)
    this.ammVaultATA = await deriveAMMCreatorVaultATA(this.creator);
    this.log(`AMM Vault ATA: ${this.ammVaultATA.toBase58()}`);
    this.log(`Poll interval: ${this.pollInterval}ms`);

    // Health check on startup
    if (this.enableHealthCheck) {
      this.log('Checking RPC health...');
      const health = await this.checkHealth();
      if (!health.healthy) {
        throw new Error(`RPC health check failed: ${health.error}`);
      }
      this.log(`RPC healthy (latency: ${health.latencyMs}ms)`);
    }

    // Auto-discover tokens if enabled
    if (this.autoDiscover) {
      this.log('Discovering tokens...');
      await this.discoverTokens();
      this.log(`Discovered ${this.trackedTokens.size} token(s) from API`);

      // Also discover from recent transactions (catches tokens missed by API)
      this.log('Scanning vault transactions for additional tokens...');
      await this.discoverTokensFromTransactions();
      this.log(`Total: ${this.trackedTokens.size} token(s)`);
    }

    // Log token breakdown
    const bcTokens = Array.from(this.trackedTokens.values()).filter(t => !t.migrated);
    const ammTokens = Array.from(this.trackedTokens.values()).filter(t => t.migrated);
    this.log(`Tracking ${this.trackedTokens.size} token(s): ${bcTokens.length} BC, ${ammTokens.length} AMM`);

    for (const token of this.trackedTokens.values()) {
      this.log(`  - ${token.symbol}: ${token.migrated ? 'AMM' : 'BC'} (mint: ${token.mint.slice(0, 8)}...)`);
    }

    this.running = true;

    // Get initial balances
    await this.initializeBalances();

    // Initialize BC reserves for tracked tokens
    await this.initializeBondingCurves();

    // Initialize AMM pools for migrated tokens
    await this.initializeAMMPools();

    // Start polling
    this.pollTimer = setInterval(() => this.poll(), this.pollInterval);

    // Start stats reporting
    if (this.onStats) {
      this.statsTimer = setInterval(() => {
        this.onStats!(this.getStats());
      }, this.statsInterval);
    }

    this.log('Daemon started');
  }

  /**
   * Discover tokens from vault transactions
   * Analyzes recent transactions on BC and AMM vaults to find tokens
   */
  private async discoverTokensFromTransactions(): Promise<void> {
    const discoveredMints = new Set<string>();

    // 1. Analyze BC vault transactions
    try {
      const bcSignatures = await this.connection.getSignaturesForAddress(this.bcVault, { limit: 100 });

      for (const sig of bcSignatures) {
        try {
          const tx = await this.connection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });
          if (!tx || !tx.meta) continue;

          // Get all account keys
          const accountKeys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58());
          if (tx.meta.loadedAddresses) {
            accountKeys.push(...tx.meta.loadedAddresses.writable.map(k => k.toBase58()));
            accountKeys.push(...tx.meta.loadedAddresses.readonly.map(k => k.toBase58()));
          }

          // Look for token mints in the transaction
          // Check preTokenBalances and postTokenBalances for mints
          const tokenBalances = [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])];
          for (const bal of tokenBalances) {
            if (bal.mint && bal.mint !== WSOL_MINT.toBase58()) {
              discoveredMints.add(bal.mint);
            }
          }
        } catch {
          // Skip failed tx fetches
        }
      }
    } catch (error) {
      this.log(`Error scanning BC vault transactions: ${error}`);
    }

    // 2. Analyze AMM vault transactions
    try {
      const ammSignatures = await this.connection.getSignaturesForAddress(this.ammVaultATA, { limit: 100 });

      for (const sig of ammSignatures) {
        try {
          const tx = await this.connection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });
          if (!tx || !tx.meta) continue;

          // Get all account keys
          const accountKeys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58());
          if (tx.meta.loadedAddresses) {
            accountKeys.push(...tx.meta.loadedAddresses.writable.map(k => k.toBase58()));
            accountKeys.push(...tx.meta.loadedAddresses.readonly.map(k => k.toBase58()));
          }

          // Look for token mints in the transaction
          const tokenBalances = [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])];
          for (const bal of tokenBalances) {
            if (bal.mint && bal.mint !== WSOL_MINT.toBase58()) {
              discoveredMints.add(bal.mint);
            }
          }
        } catch {
          // Skip failed tx fetches
        }
      }
    } catch (error) {
      this.log(`Error scanning AMM vault transactions: ${error}`);
    }

    this.log(`Found ${discoveredMints.size} potential mint(s) from transactions`);

    // 3. Verify each mint and add to tracked tokens
    for (const mintStr of discoveredMints) {
      try {
        const mint = new PublicKey(mintStr);
        const bondingCurve = deriveBondingCurve(mint);
        const bcAddress = bondingCurve.toBase58();

        // Skip if already tracked
        if (this.trackedTokens.has(bcAddress)) continue;

        // Verify this BC belongs to our creator
        const bcAccount = await this.connection.getAccountInfo(bondingCurve);
        if (!bcAccount?.data) continue;

        const bcData = deserializeBondingCurve(bcAccount.data);
        if (!bcData || !bcData.creator.equals(this.creator)) continue;

        // Detect token program (SPL Token or Token-2022)
        const tokenProgram = await getTokenProgramForMint(this.connection, mint);

        // Fetch metadata if using Helius
        let symbol = `TOKEN-${this.trackedTokens.size + 1}`;
        if (this.rpcUrl.includes('helius')) {
          const metadata = await fetchTokenMetadata(this.rpcUrl, mint);
          if (metadata?.symbol) symbol = metadata.symbol;
        }

        const ammPool = deriveAMMPool(mint);
        const tracked: TrackedToken = {
          mint: mintStr,
          symbol,
          bondingCurve: bcAddress,
          ammPool: ammPool.toBase58(),
          migrated: bcData.complete,
          lastSolReserves: bcData.realSolReserves,
          lastAmmReserves: 0n,
          totalFees: 0n,
          feeCount: 0,
          recentAmmFees: 0n,
          recentAmmFeesTimestamp: Date.now(),
          recentBcFees: 0n,
          recentBcFeesTimestamp: Date.now(),
          isMayhemMode: bcData.isMayhemMode,
          tokenProgram,
        };

        this.trackedTokens.set(bcAddress, tracked);
        const tokenTypeLabel = tokenProgram === 'TOKEN_2022' ? 'Token-2022' : 'SPL Token';
        this.log(`Discovered AMM token: ${symbol} (${tokenTypeLabel})`);
        this.tokenStats.set(bcAddress, {
          mint: mintStr,
          symbol,
          totalFees: 0n,
          feeCount: 0,
          lastFeeTimestamp: 0,
          migrated: bcData.complete,
        });

        this.log(`Discovered from tx: ${symbol} (mint: ${mintStr.slice(0, 8)}..., ${bcData.complete ? 'AMM' : 'BC'})`);
      } catch {
        // Skip invalid mints
      }
    }
  }

  /**
   * Discover all tokens created by this creator
   */
  private async discoverTokens(): Promise<void> {
    try {
      const isHeliusRpc = this.rpcUrl.includes('helius');

      // ALWAYS use getProgramAccounts first - it returns ALL bonding curves for a creator
      // This is more reliable than transaction history which has pagination limits
      this.log(`Discovering tokens via getProgramAccounts...`);
      const discovered = await discoverCreatorTokens(this.connection, this.creator);
      this.log(`Found ${discovered.length} bonding curve(s) for creator`);

      let processed = 0;
      for (const token of discovered) {
        const bcAddress = token.bondingCurve.toBase58();

        // Skip if already tracked
        if (this.trackedTokens.has(bcAddress)) {
          continue;
        }

        // Get the mint from the bonding curve's token accounts
        const mintResult = await getMintFromBondingCurve(this.connection, token.bondingCurve);
        if (!mintResult) {
          // Skip if we can't resolve the mint
          continue;
        }

        const { mint, tokenProgram } = mintResult;
        const mintAddress = mint.toBase58();
        const ammPool = deriveAMMPool(mint);
        const ammPoolAddress = ammPool.toBase58();

        // Get metadata (symbol) via Helius DAS API if available
        let symbol = `TOKEN-${this.trackedTokens.size + 1}`;
        if (isHeliusRpc) {
          try {
            const metadata = await fetchTokenMetadata(this.rpcUrl, mint);
            if (metadata?.symbol) {
              symbol = metadata.symbol;
            }
          } catch {
            // Ignore metadata errors, use default symbol
          }
        }

        // Create tracked token entry
        const tracked: TrackedToken = {
          mint: mintAddress,
          symbol,
          bondingCurve: bcAddress,
          ammPool: ammPoolAddress,
          migrated: token.migrated,
          lastSolReserves: token.realSolReserves,
          lastAmmReserves: 0n,
          totalFees: 0n,
          feeCount: 0,
          recentAmmFees: 0n,
          recentAmmFeesTimestamp: Date.now(),
          recentBcFees: 0n,
          recentBcFeesTimestamp: Date.now(),
          isMayhemMode: token.isMayhemMode,
          tokenProgram,
        };

        this.trackedTokens.set(bcAddress, tracked);

        // Also add to tokenStats
        this.tokenStats.set(bcAddress, {
          mint: mintAddress,
          symbol: tracked.symbol,
          totalFees: 0n,
          feeCount: 0,
          lastFeeTimestamp: 0,
          migrated: token.migrated,
        });

        // Notify callback
        if (this.onTokenDiscovered) {
          this.onTokenDiscovered(token);
        }

        const tokenTypeLabel = tokenProgram === 'TOKEN_2022' ? 'Token-2022' : 'SPL Token';
        this.log(`Found token: ${tracked.symbol} (mint: ${mintAddress.slice(0, 8)}..., ${tokenTypeLabel}, migrated: ${token.migrated})`);

        processed++;
        // Log progress every 50 tokens
        if (processed % 50 === 0) {
          this.log(`Processed ${processed}/${discovered.length} tokens...`);
        }
      }

      this.log(`Discovered ${this.trackedTokens.size} token(s) total`);
    } catch (error) {
      this.log(`Token discovery error: ${error}`);
    }
  }

  /**
   * Initialize bonding curve reserves for tracked tokens
   */
  private async initializeBondingCurves(): Promise<void> {
    for (const [bcAddress, token] of this.trackedTokens) {
      try {
        const bcPubkey = new PublicKey(bcAddress);
        const accountInfo = await this.connection.getAccountInfo(bcPubkey);

        if (accountInfo) {
          const bcData = deserializeBondingCurve(accountInfo.data);
          if (bcData) {
            token.lastSolReserves = bcData.realSolReserves;
            token.migrated = bcData.complete;
            this.log(`BC ${bcAddress.slice(0, 8)}...: reserves=${Number(bcData.realSolReserves) / 1e9} SOL, migrated=${bcData.complete}`);
          }
        }
      } catch (error) {
        this.log(`Failed to init BC ${bcAddress.slice(0, 8)}...: ${error}`);
      }
    }
  }

  /**
   * Initialize AMM pools for migrated tokens
   * Derives pool addresses and initializes WSOL reserve tracking
   */
  private async initializeAMMPools(): Promise<void> {
    const migratedTokens = Array.from(this.trackedTokens.values()).filter(t => t.migrated);
    if (migratedTokens.length === 0) return;

    this.log(`Found ${migratedTokens.length} migrated token(s)`);

    for (const [, token] of this.trackedTokens) {
      if (!token.migrated) continue;
      if (!token.mint || token.mint === token.bondingCurve) continue;

      // Derive pool address if not set
      if (!token.ammPool) {
        const mintPubkey = new PublicKey(token.mint);
        const poolPubkey = deriveAMMPool(mintPubkey);
        token.ammPool = poolPubkey.toBase58();
      }

      // Initialize pool WSOL reserves
      try {
        const poolPubkey = new PublicKey(token.ammPool);
        const poolWsolAta = await getAssociatedTokenAddress(WSOL_MINT, poolPubkey, true);
        const vaultBalance = await this.connection.getTokenAccountBalance(poolWsolAta);
        token.lastAmmReserves = BigInt(vaultBalance.value.amount);
        this.log(`AMM ${token.symbol}: pool=${token.ammPool.slice(0, 8)}..., reserves=${Number(token.lastAmmReserves) / 1e9} SOL`);
      } catch {
        this.log(`AMM ${token.symbol}: pool=${token.ammPool.slice(0, 8)}... (no reserves yet)`);
      }
    }
  }

  /**
   * Stop the daemon
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    this.log('Daemon stopped');
  }

  /**
   * Check if daemon is running
   */
  isRunning(): boolean {
    return this.running;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async initializeBalances(): Promise<void> {
    // BC Vault: native SOL balance
    try {
      this.lastBcBalance = BigInt(await this.connection.getBalance(this.bcVault));
      this.log(`BC vault initial: ${Number(this.lastBcBalance) / 1e9} SOL`);
    } catch {
      this.lastBcBalance = 0n;
    }

    // AMM Vault: WSOL token balance in ATA
    try {
      const ataInfo = await this.connection.getTokenAccountBalance(this.ammVaultATA);
      this.lastAmmBalance = BigInt(ataInfo.value.amount);
      this.log(`AMM vault ATA initial: ${Number(this.lastAmmBalance) / 1e9} WSOL`);
    } catch {
      // ATA may not exist yet (no AMM fees received)
      this.lastAmmBalance = 0n;
      this.log(`AMM vault ATA: not found (no fees yet)`);
    }
  }

  private async poll(): Promise<void> {
    const slot = await this.connection.getSlot();
    const timestamp = Date.now();

    // Cleanup old recent fees (24h window)
    this.cleanupRecentFees(timestamp);

    // Step 1: Poll BC reserves for migration detection
    await this.pollBondingCurves();

    // Step 2: Poll BC vault transactions for fee attribution to non-migrated tokens
    const bcResult = await this.pollBCVaultTransactions();

    // Step 3: Poll AMM pools for migrated tokens
    const ammResult = await this.pollAMMPools();

    // Step 4: Process and attribute fees
    // BC vault: native SOL balance
    await this.pollBCVault(slot, timestamp, bcResult);
    // AMM vault: WSOL token balance in ATA
    await this.pollAMMVaultATA(slot, timestamp, ammResult);
  }

  /**
   * Cleanup recent fees tracking - reset if older than 24h
   */
  private cleanupRecentFees(now: number): void {
    const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

    for (const [, token] of this.trackedTokens) {
      // Cleanup AMM fees
      if (now - token.recentAmmFeesTimestamp > WINDOW_MS) {
        if (this.verbose && token.recentAmmFees > 0n) {
          this.log(`Resetting recent AMM fees for ${token.symbol} (24h window expired)`);
        }
        token.recentAmmFees = 0n;
        token.recentAmmFeesTimestamp = now;
      }
      // Cleanup BC fees
      if (now - token.recentBcFeesTimestamp > WINDOW_MS) {
        if (this.verbose && token.recentBcFees > 0n) {
          this.log(`Resetting recent BC fees for ${token.symbol} (24h window expired)`);
        }
        token.recentBcFees = 0n;
        token.recentBcFeesTimestamp = now;
      }
    }
  }

  /**
   * Poll bonding curve reserves for all tracked tokens
   * Returns a map of BC address -> absolute reserve change (any trading activity)
   * Both buys and sells generate creator fees!
   */
  private async pollBondingCurves(): Promise<Map<string, bigint>> {
    const deltas = new Map<string, bigint>();

    for (const [bcAddress, token] of this.trackedTokens) {
      // Skip migrated tokens (no BC activity)
      if (token.migrated) continue;

      try {
        const bcPubkey = new PublicKey(bcAddress);
        const accountInfo = await this.connection.getAccountInfo(bcPubkey);

        if (accountInfo) {
          const bcData = deserializeBondingCurve(accountInfo.data);
          if (bcData) {
            // Check for migration
            if (bcData.complete && !token.migrated) {
              token.migrated = true;
              this.log(`Token ${token.symbol} has migrated to AMM`);

              // Update tokenStats
              const stats = this.tokenStats.get(bcAddress);
              if (stats) {
                stats.migrated = true;
              }
            }

            // Calculate ABSOLUTE reserve change - both buys and sells generate fees!
            // Buy = reserves increase (positive delta)
            // Sell = reserves decrease (negative delta)
            // Both generate creator fees!
            const reserveDelta = bcData.realSolReserves - token.lastSolReserves;
            if (reserveDelta !== 0n) {
              // Use absolute value for fee attribution
              const absDelta = reserveDelta > 0n ? reserveDelta : -reserveDelta;
              deltas.set(bcAddress, absDelta);
            }

            token.lastSolReserves = bcData.realSolReserves;
          }
        }
      } catch {
        // Ignore individual BC fetch errors
      }
    }

    return deltas;
  }

  /**
   * Poll BC vault transactions to attribute fees to specific tokens
   * Analyzes transactions to see which bonding curve/mint is involved
   * Returns { attributed: map of bcAddress -> fee amount, unattributed: total unattributed fees }
   */
  private async pollBCVaultTransactions(): Promise<{ attributed: Map<string, bigint>; unattributed: bigint }> {
    const deltas = new Map<string, bigint>();
    let unattributedTotal = 0n;

    // Get non-migrated tokens (BC phase)
    const bcTokens = Array.from(this.trackedTokens.entries())
      .filter(([, t]) => !t.migrated);

    // Debug: log tracked BC tokens
    if (this.verbose && bcTokens.length > 0) {
      this.log(`BC: ${bcTokens.length} non-migrated token(s) tracked: ${bcTokens.map(([, t]) => `${t.symbol}(${t.mint.slice(0, 8)})`).join(', ')}`);
    }

    try {
      // Get recent signatures for BC vault (native SOL)
      const signatures = await this.connection.getSignaturesForAddress(this.bcVault, {
        limit: 50,
      });

      if (signatures.length === 0) return { attributed: deltas, unattributed: 0n };

      // On first poll, just record the latest signature
      if (!this.lastBCSignature) {
        this.lastBCSignature = signatures[0].signature;
        this.log(`BC: Initialized at signature ${signatures[0].signature.slice(0, 8)}...`);
        return { attributed: deltas, unattributed: 0n };
      }

      // Find new transactions
      const newSigs: typeof signatures = [];
      for (const sig of signatures) {
        if (sig.signature === this.lastBCSignature) break;
        if (!this.processedBCTxs.has(sig.signature)) {
          newSigs.push(sig);
        }
      }

      if (newSigs.length === 0) return { attributed: deltas, unattributed: 0n };

      this.log(`BC: Processing ${newSigs.length} new transaction(s)`);

      // Process each new transaction to find which token it belongs to
      for (const sig of newSigs.reverse()) {
        try {
          const tx = await this.connection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (!tx || !tx.meta) continue;

          // Get all account keys from the transaction
          const accountKeys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58());
          const loadedAddresses = tx.meta.loadedAddresses;
          if (loadedAddresses) {
            accountKeys.push(...loadedAddresses.writable.map(k => k.toBase58()));
            accountKeys.push(...loadedAddresses.readonly.map(k => k.toBase58()));
          }

          // Calculate fee amount from native SOL balances (not token balances)
          const vaultAddress = this.bcVault.toBase58();
          const vaultIndex = accountKeys.indexOf(vaultAddress);

          if (vaultIndex === -1) {
            this.processedBCTxs.add(sig.signature);
            continue;
          }

          const preBalances = tx.meta.preBalances;
          const postBalances = tx.meta.postBalances;

          const preBalance = BigInt(preBalances[vaultIndex]);
          const postBalance = BigInt(postBalances[vaultIndex]);

          const feeAmount = postBalance - preBalance;
          if (feeAmount <= 0n) {
            this.processedBCTxs.add(sig.signature);
            continue; // Not a fee (could be claim)
          }

          // Find which non-migrated token this transaction belongs to
          let attributed = false;

          // Also collect mints from token balances (to find the traded token)
          const txMints = new Set<string>();
          const allTokenBalances = [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])];
          for (const bal of allTokenBalances) {
            if (bal.mint && bal.mint !== WSOL_MINT.toBase58()) {
              txMints.add(bal.mint);
            }
          }

          // Debug: log transaction details
          if (this.verbose) {
            if (txMints.size > 0) {
              this.log(`  TX ${sig.signature.slice(0, 8)}: mints=${Array.from(txMints).map(m => m.slice(0, 8)).join(',')}, fee=${Number(feeAmount) / 1e9} SOL`);
            } else {
              this.log(`  TX ${sig.signature.slice(0, 8)}: NO mints, fee=${Number(feeAmount) / 1e9} SOL, accounts=${accountKeys.length}`);
            }
          }

          // Method 1: Check if bonding curve or mint is in account keys
          for (const [bcAddress, token] of bcTokens) {
            const bcInKeys = accountKeys.includes(bcAddress);
            const mintInKeys = accountKeys.includes(token.mint);
            const inTokenBalances = txMints.has(token.mint);

            if (bcInKeys || mintInKeys || inTokenBalances) {
              // This transaction involves this token
              const currentDelta = deltas.get(bcAddress) || 0n;
              deltas.set(bcAddress, currentDelta + feeAmount);
              const matchReason = bcInKeys ? 'bc-key' : (mintInKeys ? 'mint-key' : 'mint');
              this.log(`BC tx for ${token.symbol}: +${Number(feeAmount) / 1e9} SOL (${sig.signature.slice(0, 8)}... via ${matchReason})`);
              attributed = true;
              break;
            }
          }

          // Method 2: Try to discover token from mint in token balances
          if (!attributed && feeAmount > 0n && txMints.size > 0) {
            this.log(`BC: Attempting dynamic discovery for ${txMints.size} mint(s)...`);
            for (const mintStr of txMints) {
              try {
                const mint = new PublicKey(mintStr);
                const bondingCurve = deriveBondingCurve(mint);
                const bcAddress = bondingCurve.toBase58();

                // Check if already tracked
                const existingToken = this.trackedTokens.get(bcAddress);
                if (existingToken && !existingToken.migrated) {
                  // Attribute the fee to this token
                  const currentDelta = deltas.get(bcAddress) || 0n;
                  deltas.set(bcAddress, currentDelta + feeAmount);
                  this.log(`BC tx for ${existingToken.symbol}: +${Number(feeAmount) / 1e9} SOL (${sig.signature.slice(0, 8)}... via derived-bc)`);
                  attributed = true;
                  break;
                }

                // Not tracked - try to discover dynamically
                // Verify this BC belongs to our creator
                this.log(`BC: Checking mint ${mintStr.slice(0, 8)}... (BC: ${bcAddress.slice(0, 8)}...)`);
                const bcAccount = await this.connection.getAccountInfo(bondingCurve);
                if (!bcAccount?.data) {
                  this.log(`BC: No account data for BC ${bcAddress.slice(0, 8)}...`);
                  continue;
                }

                const bcData = deserializeBondingCurve(bcAccount.data);
                if (!bcData) {
                  this.log(`BC: Failed to deserialize BC ${bcAddress.slice(0, 8)}...`);
                  continue;
                }
                if (!bcData.creator.equals(this.creator)) {
                  if (this.verbose) {
                    this.log(`BC: Creator mismatch for ${mintStr.slice(0, 8)}... (got ${bcData.creator.toBase58().slice(0, 8)}..., expected ${this.creator.toBase58().slice(0, 8)}...)`);
                  }
                  continue;
                }

                // Detect token program (SPL Token or Token-2022)
                const tokenProgram = await getTokenProgramForMint(this.connection, mint);

                // Found a new token! Add it
                let symbol = `TOKEN-${this.trackedTokens.size + 1}`;
                if (this.rpcUrl.includes('helius')) {
                  try {
                    const metadata = await fetchTokenMetadata(this.rpcUrl, mint);
                    if (metadata?.symbol) symbol = metadata.symbol;
                  } catch {
                    // Ignore metadata errors
                  }
                }

                const ammPool = deriveAMMPool(mint);
                const tracked: TrackedToken = {
                  mint: mintStr,
                  symbol,
                  bondingCurve: bcAddress,
                  ammPool: ammPool.toBase58(),
                  migrated: bcData.complete,
                  lastSolReserves: bcData.realSolReserves,
                  lastAmmReserves: 0n,
                  totalFees: 0n,
                  feeCount: 0,
                  recentAmmFees: 0n,
                  recentAmmFeesTimestamp: Date.now(),
                  recentBcFees: 0n,
                  recentBcFeesTimestamp: Date.now(),
                  isMayhemMode: bcData.isMayhemMode,
                  tokenProgram,
                };

                this.trackedTokens.set(bcAddress, tracked);
                this.tokenStats.set(bcAddress, {
                  mint: mintStr,
                  symbol,
                  totalFees: 0n,
                  feeCount: 0,
                  lastFeeTimestamp: 0,
                  migrated: bcData.complete,
                });

                const tokenTypeLabel = tokenProgram === 'TOKEN_2022' ? 'Token-2022' : 'SPL Token';
                this.log(`Discovered new BC token: ${symbol} (mint: ${mintStr.slice(0, 8)}..., ${tokenTypeLabel})`);

                // Attribute the fee to this newly discovered token
                const currentDelta = deltas.get(bcAddress) || 0n;
                deltas.set(bcAddress, currentDelta + feeAmount);
                this.log(`BC tx for ${symbol}: +${Number(feeAmount) / 1e9} SOL (${sig.signature.slice(0, 8)}...)`);
                attributed = true;
                break;
              } catch {
                // Ignore invalid mints
              }
            }
          }

          // If still not attributed, add to unattributed total
          if (!attributed && feeAmount > 0n) {
            unattributedTotal += feeAmount;
            // Always log unattributed fees to help debug discovery issues
            this.log(`BC tx unattributed: +${Number(feeAmount) / 1e9} SOL (${sig.signature.slice(0, 8)}...) mints: ${txMints.size > 0 ? Array.from(txMints).map(m => m.slice(0, 8)).join(',') : 'NONE'}`);
          }

          this.processedBCTxs.add(sig.signature);
        } catch (txError) {
          if (this.verbose) {
            console.warn(`Error processing BC tx ${sig.signature.slice(0, 8)}:`, txError);
          }
          this.processedBCTxs.add(sig.signature);
        }
      }

      // Update last signature
      this.lastBCSignature = signatures[0].signature;

      // Cleanup old processed txs
      if (this.processedBCTxs.size > 1000) {
        const arr = Array.from(this.processedBCTxs);
        this.processedBCTxs = new Set(arr.slice(-500));
      }
    } catch (error) {
      if (this.verbose) {
        console.error('Error polling BC vault transactions:', error);
      }
    }

    return { attributed: deltas, unattributed: unattributedTotal };
  }

  /**
   * Poll AMM vault transactions to attribute fees to specific tokens
   * Analyzes transactions to see which pool/mint is involved
   * Returns { attributed: map of bcAddress -> fee amount, unattributed: total unattributed fees }
   */
  private async pollAMMPools(): Promise<{ attributed: Map<string, bigint>; unattributed: bigint }> {
    const deltas = new Map<string, bigint>();
    let unattributedTotal = 0n;

    // Get migrated tokens (for matching)
    const migratedTokens = Array.from(this.trackedTokens.entries())
      .filter(([, t]) => t.migrated && t.ammPool);

    // Debug: log tracked migrated tokens
    if (this.verbose && migratedTokens.length > 0) {
      this.log(`AMM: ${migratedTokens.length} migrated token(s) tracked: ${migratedTokens.map(([, t]) => `${t.symbol}(${t.mint.slice(0, 8)})`).join(', ')}`);
    }

    // Don't return early - allow dynamic discovery even if no tokens tracked yet

    try {
      // Get recent signatures for AMM vault ATA
      const signatures = await this.connection.getSignaturesForAddress(this.ammVaultATA, {
        limit: 50,
      });

      if (signatures.length === 0) return { attributed: deltas, unattributed: 0n };

      // On first poll, just record the latest signature
      if (!this.lastAMMSignature) {
        this.lastAMMSignature = signatures[0].signature;
        this.log(`AMM: Initialized at signature ${signatures[0].signature.slice(0, 8)}...`);
        return { attributed: deltas, unattributed: 0n };
      }

      // Find new transactions
      const newSigs: typeof signatures = [];
      for (const sig of signatures) {
        if (sig.signature === this.lastAMMSignature) break;
        if (!this.processedAMMTxs.has(sig.signature)) {
          newSigs.push(sig);
        }
      }

      if (newSigs.length === 0) return { attributed: deltas, unattributed: 0n };

      this.log(`AMM: Processing ${newSigs.length} new transaction(s)`);

      // Process each new transaction to find which token it belongs to
      for (const sig of newSigs.reverse()) {
        try {
          const tx = await this.connection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (!tx || !tx.meta) continue;

          // Get all account keys from the transaction
          const accountKeys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58());
          const loadedAddresses = tx.meta.loadedAddresses;
          if (loadedAddresses) {
            accountKeys.push(...loadedAddresses.writable.map(k => k.toBase58()));
            accountKeys.push(...loadedAddresses.readonly.map(k => k.toBase58()));
          }

          // Calculate fee amount from token balances
          const vaultAddress = this.ammVaultATA.toBase58();
          const preTokenBalances = tx.meta.preTokenBalances || [];
          const postTokenBalances = tx.meta.postTokenBalances || [];

          let preBalance = 0n;
          let postBalance = 0n;

          for (const bal of preTokenBalances) {
            if (accountKeys[bal.accountIndex] === vaultAddress) {
              preBalance = BigInt(bal.uiTokenAmount.amount);
              break;
            }
          }

          for (const bal of postTokenBalances) {
            if (accountKeys[bal.accountIndex] === vaultAddress) {
              postBalance = BigInt(bal.uiTokenAmount.amount);
              break;
            }
          }

          const feeAmount = postBalance - preBalance;
          if (feeAmount <= 0n) {
            this.processedAMMTxs.add(sig.signature);
            continue; // Not a fee (could be claim)
          }

          // Find which migrated token this transaction belongs to
          // Method 1: Check if mint or pool is in account keys
          // Method 2: Check if mint appears in token balances
          let attributed = false;

          // Collect all mints from token balances (excluding WSOL)
          const txMints = new Set<string>();
          const allTokenBalances = [...preTokenBalances, ...postTokenBalances];
          for (const bal of allTokenBalances) {
            if (bal.mint && bal.mint !== WSOL_MINT.toBase58()) {
              txMints.add(bal.mint);
            }
          }

          // Debug: log mints found or when no mints
          if (this.verbose) {
            if (txMints.size > 0) {
              this.log(`  TX ${sig.signature.slice(0, 8)}: mints=${Array.from(txMints).map(m => m.slice(0, 8)).join(',')}, fee=${Number(feeAmount) / 1e9}`);
            } else {
              this.log(`  TX ${sig.signature.slice(0, 8)}: NO mints in token balances, fee=${Number(feeAmount) / 1e9}`);
            }
          }

          for (const [bcAddress, token] of migratedTokens) {
            // Check account keys for mint or pool
            const mintInKeys = accountKeys.includes(token.mint);
            const poolInKeys = accountKeys.includes(token.ammPool!);
            const inAccountKeys = mintInKeys || poolInKeys;

            // Check token balances for mint
            const inTokenBalances = txMints.has(token.mint);

            if (inAccountKeys || inTokenBalances) {
              // This transaction involves this token
              const currentDelta = deltas.get(bcAddress) || 0n;
              deltas.set(bcAddress, currentDelta + feeAmount);
              const matchReason = inTokenBalances ? 'mint' : (mintInKeys ? 'mint-key' : 'pool-key');
              this.log(`AMM tx for ${token.symbol}: +${Number(feeAmount) / 1e9} SOL (${sig.signature.slice(0, 8)}... via ${matchReason})`);
              attributed = true;
              break;
            }
          }

          // If we couldn't attribute, try to discover the token dynamically
          if (!attributed && feeAmount > 0n && txMints.size > 0) {
            this.log(`AMM: Attempting dynamic discovery for ${txMints.size} mint(s)...`);
            for (const mintStr of txMints) {
              try {
                const mint = new PublicKey(mintStr);
                const bondingCurve = deriveBondingCurve(mint);
                const bcAddress = bondingCurve.toBase58();

                // Check if already tracked but not in migratedTokens (needs migration update)
                const existingToken = this.trackedTokens.get(bcAddress);
                if (existingToken) {
                  // Token exists but wasn't in migratedTokens - update its migration status
                  if (!existingToken.migrated) {
                    existingToken.migrated = true;
                    this.log(`Token ${existingToken.symbol} now marked as migrated (from AMM tx)`);
                    const stats = this.tokenStats.get(bcAddress);
                    if (stats) stats.migrated = true;
                  }
                  // Attribute the fee to this token
                  const currentDelta = deltas.get(bcAddress) || 0n;
                  deltas.set(bcAddress, currentDelta + feeAmount);
                  this.log(`AMM tx for ${existingToken.symbol}: +${Number(feeAmount) / 1e9} SOL (${sig.signature.slice(0, 8)}...)`);
                  attributed = true;
                  break;
                }

                // Verify this BC belongs to our creator
                this.log(`AMM: Checking mint ${mintStr.slice(0, 8)}... (BC: ${bcAddress.slice(0, 8)}...)`);
                const bcAccount = await this.connection.getAccountInfo(bondingCurve);
                if (!bcAccount?.data) {
                  this.log(`AMM: No BC account for mint ${mintStr.slice(0, 8)}...`);
                  continue;
                }

                const bcData = deserializeBondingCurve(bcAccount.data);
                if (!bcData) {
                  this.log(`AMM: Failed to deserialize BC for mint ${mintStr.slice(0, 8)}...`);
                  continue;
                }
                if (!bcData.creator.equals(this.creator)) {
                  if (this.verbose) {
                    this.log(`AMM: Creator mismatch for ${mintStr.slice(0, 8)}... (got ${bcData.creator.toBase58().slice(0, 8)}..., expected ${this.creator.toBase58().slice(0, 8)}...)`);
                  }
                  continue;
                }

                // Detect token program (SPL Token or Token-2022)
                const tokenProgram = await getTokenProgramForMint(this.connection, mint);

                // Found a new token! Add it
                let symbol = `TOKEN-${this.trackedTokens.size + 1}`;
                if (this.rpcUrl.includes('helius')) {
                  const metadata = await fetchTokenMetadata(this.rpcUrl, mint);
                  if (metadata?.symbol) symbol = metadata.symbol;
                }

                const ammPool = deriveAMMPool(mint);
                const tracked: TrackedToken = {
                  mint: mintStr,
                  symbol,
                  bondingCurve: bcAddress,
                  ammPool: ammPool.toBase58(),
                  migrated: bcData.complete,
                  lastSolReserves: bcData.realSolReserves,
                  lastAmmReserves: 0n,
                  totalFees: 0n,
                  feeCount: 0,
                  recentAmmFees: 0n,
                  recentAmmFeesTimestamp: Date.now(),
                  recentBcFees: 0n,
                  recentBcFeesTimestamp: Date.now(),
                  isMayhemMode: bcData.isMayhemMode,
                  tokenProgram,
                };

                this.trackedTokens.set(bcAddress, tracked);
                this.tokenStats.set(bcAddress, {
                  mint: mintStr,
                  symbol,
                  totalFees: 0n,
                  feeCount: 0,
                  lastFeeTimestamp: 0,
                  migrated: bcData.complete,
                });

                const tokenTypeLabel = tokenProgram === 'TOKEN_2022' ? 'Token-2022' : 'SPL Token';
                this.log(`Discovered new AMM token: ${symbol} (mint: ${mintStr.slice(0, 8)}..., ${tokenTypeLabel})`);

                // Attribute the fee to this newly discovered token
                const currentDelta = deltas.get(bcAddress) || 0n;
                deltas.set(bcAddress, currentDelta + feeAmount);
                this.log(`AMM tx for ${symbol}: +${Number(feeAmount) / 1e9} SOL (${sig.signature.slice(0, 8)}...)`);
                attributed = true;
                break;
              } catch {
                // Skip invalid mints
              }
            }
          }

          // Last resort: scan all tracked tokens' pools against accountKeys
          if (!attributed && feeAmount > 0n) {
            for (const [bcAddress, token] of this.trackedTokens) {
              if (!token.ammPool) continue;
              if (accountKeys.includes(token.ammPool)) {
                // Found pool in transaction - mark as migrated if needed
                if (!token.migrated) {
                  token.migrated = true;
                  this.log(`Token ${token.symbol} marked as migrated (pool found in tx)`);
                  const stats = this.tokenStats.get(bcAddress);
                  if (stats) stats.migrated = true;
                }
                const currentDelta = deltas.get(bcAddress) || 0n;
                deltas.set(bcAddress, currentDelta + feeAmount);
                this.log(`AMM tx for ${token.symbol}: +${Number(feeAmount) / 1e9} SOL (${sig.signature.slice(0, 8)}... via pool-scan)`);
                attributed = true;
                break;
              }
            }
          }

          // Still couldn't attribute - track as unattributed
          if (!attributed && feeAmount > 0n) {
            unattributedTotal += feeAmount;
            const mintList = txMints.size > 0 ? Array.from(txMints).map(m => m.slice(0, 8)).join(', ') : 'none';
            this.log(`AMM tx unattributed: +${Number(feeAmount) / 1e9} SOL (mints: ${mintList})`);
          }

          this.processedAMMTxs.add(sig.signature);
        } catch {
          // Skip failed tx fetches
        }
      }

      // Update last signature
      this.lastAMMSignature = signatures[0].signature;

      // Cleanup old processed txs (keep last 1000)
      if (this.processedAMMTxs.size > 1000) {
        const arr = Array.from(this.processedAMMTxs);
        this.processedAMMTxs = new Set(arr.slice(-500));
      }

    } catch (error) {
      this.log(`Error polling AMM transactions: ${error}`);
    }

    return { attributed: deltas, unattributed: unattributedTotal };
  }

  /**
   * Poll AMM vault ATA for WSOL balance (creator fees from AMM trades)
   * ammResult contains attributed fees per token and unattributed fees
   */
  private async pollAMMVaultATA(
    slot: number,
    timestamp: number,
    ammResult: { attributed: Map<string, bigint>; unattributed: bigint }
  ): Promise<void> {
    const { attributed: tokenDeltas, unattributed } = ammResult;

    // Process attributed fees
    if (tokenDeltas.size > 0) {
      for (const [bcAddress, feeAmount] of tokenDeltas) {
        const token = this.trackedTokens.get(bcAddress);
        if (!token) continue;

        // Update tracked token stats
        token.totalFees += feeAmount;
        token.feeCount++;
        token.recentAmmFees += feeAmount;  // Track for proportional distribution

        // Update tokenStats
        const stats = this.tokenStats.get(bcAddress);
        if (stats) {
          stats.totalFees += feeAmount;
          stats.feeCount++;
          stats.lastFeeTimestamp = timestamp;
          stats.lastActivity = timestamp;
        }

        // Callback
        if (this.onFeeDetected) {
          this.onFeeDetected({
            mint: token.mint,
            symbol: token.symbol,
            amount: feeAmount,
            timestamp,
            slot,
          });
        }
      }
    }

    // Distribute unattributed fees proportionally to migrated tokens
    if (unattributed > 0n) {
      this.distributeAmmFeeProportionally(unattributed, slot, timestamp);
    }

    // Update vault balance tracking if we processed any transactions
    if (tokenDeltas.size > 0 || unattributed > 0n) {
      try {
        const ataInfo = await this.connection.getTokenAccountBalance(this.ammVaultATA);
        this.lastAmmBalance = BigInt(ataInfo.value.amount);
      } catch {
        // Ignore balance update errors
      }
      return;
    }

    // Fallback: poll vault balance if no transaction data
    if (!this.circuitBreaker.canExecute()) {
      if (this.verbose) {
        console.warn('Circuit breaker OPEN, skipping AMM poll');
      }
      return;
    }

    try {
      const currentBalance = await fetchWithRetry(
        async () => {
          try {
            const ataInfo = await this.connection.getTokenAccountBalance(this.ammVaultATA);
            this.circuitBreaker.recordSuccess();
            return BigInt(ataInfo.value.amount);
          } catch {
            this.circuitBreaker.recordSuccess();
            return 0n;
          }
        },
        this.retryConfig,
        (attempt, error, delayMs) => {
          if (this.onRpcError) {
            this.onRpcError(error, attempt);
          }
          if (this.verbose) {
            console.warn(`RPC retry ${attempt}/${this.retryConfig.maxRetries} for AMM ATA: ${error.message} (waiting ${delayMs}ms)`);
          }
        }
      );

      const lastBalance = this.lastAmmBalance;
      const delta = currentBalance - lastBalance;

      if (delta > 0n) {
        // Fee detected via balance polling - distribute proportionally
        this.distributeAmmFeeProportionally(delta, slot, timestamp);
      } else if (delta < 0n) {
        this.handleBalanceChange('CLAIM', 'AMM', this.ammVaultATA, delta, lastBalance, currentBalance, slot, timestamp);
      }

      this.lastAmmBalance = currentBalance;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      if (this.verbose) {
        console.error(`Poll error (AMM ATA) after ${this.retryConfig.maxRetries} retries:`, error);
      }
      if (this.onRpcError) {
        this.onRpcError(error instanceof Error ? error : new Error(String(error)), this.retryConfig.maxRetries);
      }
    }
  }

  /**
   * Poll BC vault for native SOL balance (creator fees from BC trades)
   * bcResult contains attributed fees per token and unattributed fees
   */
  private async pollBCVault(
    slot: number,
    timestamp: number,
    bcResult: { attributed: Map<string, bigint>; unattributed: bigint }
  ): Promise<void> {
    const { attributed: tokenDeltas, unattributed } = bcResult;

    // Process attributed fees
    if (tokenDeltas.size > 0) {
      for (const [bcAddress, feeAmount] of tokenDeltas) {
        const token = this.trackedTokens.get(bcAddress);
        if (!token) continue;

        // Update tracked token stats
        token.totalFees += feeAmount;
        token.feeCount++;
        token.recentBcFees += feeAmount;  // Track for proportional distribution

        // Update tokenStats
        const stats = this.tokenStats.get(bcAddress);
        if (stats) {
          stats.totalFees += feeAmount;
          stats.feeCount++;
          stats.lastFeeTimestamp = timestamp;
          stats.lastActivity = timestamp;
        }

        // Callback
        if (this.onFeeDetected) {
          this.onFeeDetected({
            mint: token.mint,
            symbol: token.symbol,
            amount: feeAmount,
            timestamp,
            slot,
          });
        }
      }
    }

    // Distribute unattributed fees proportionally to non-migrated tokens
    if (unattributed > 0n) {
      this.distributeBcFeeProportionally(unattributed, slot, timestamp);
    }

    // Update vault balance tracking if we processed any transactions
    if (tokenDeltas.size > 0 || unattributed > 0n) {
      try {
        const balance = await this.connection.getBalance(this.bcVault);
        this.lastBcBalance = BigInt(balance);
      } catch {
        // Ignore balance update errors
      }
      return;
    }

    // Fallback: poll vault balance if no transaction data
    if (!this.circuitBreaker.canExecute()) {
      if (this.verbose) {
        console.warn('Circuit breaker OPEN, skipping BC poll');
      }
      return;
    }

    try {
      const currentBalance = await fetchWithRetry(
        async () => {
          const balance = await this.connection.getBalance(this.bcVault);
          this.circuitBreaker.recordSuccess();
          return BigInt(balance);
        },
        this.retryConfig,
        (attempt, error, delayMs) => {
          if (this.onRpcError) {
            this.onRpcError(error, attempt);
          }
          if (this.verbose) {
            console.warn(`RPC retry ${attempt}/${this.retryConfig.maxRetries} for BC vault: ${error.message} (waiting ${delayMs}ms)`);
          }
        }
      );

      const lastBalance = this.lastBcBalance;
      const delta = currentBalance - lastBalance;

      if (delta > 0n) {
        // Fee detected via balance polling - distribute proportionally
        this.distributeBcFeeProportionally(delta, slot, timestamp);
      } else if (delta < 0n) {
        this.handleBalanceChange('CLAIM', 'BC', this.bcVault, delta, lastBalance, currentBalance, slot, timestamp);
      }

      this.lastBcBalance = currentBalance;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      if (this.verbose) {
        console.error(`Poll error (BC vault) after ${this.retryConfig.maxRetries} retries:`, error);
      }
      if (this.onRpcError) {
        this.onRpcError(error instanceof Error ? error : new Error(String(error)), this.retryConfig.maxRetries);
      }
    }
  }

  /**
   * Distribute AMM fees proportionally to migrated tokens
   * Used when fees can't be attributed to specific tokens via transaction analysis
   */
  private distributeAmmFeeProportionally(amount: bigint, slot: number, timestamp: number): void {
    const migratedTokens = Array.from(this.trackedTokens.entries())
      .filter(([, t]) => t.migrated && t.ammPool);

    if (migratedTokens.length === 0) {
      // No migrated tokens - fall back to generic AMM
      this.handleBalanceChange('FEE', 'AMM', this.ammVaultATA, amount, 0n, amount, slot, timestamp);
      return;
    }

    // Calculate total recent AMM fees across all migrated tokens
    const totalRecentFees = migratedTokens.reduce((sum, [, t]) => sum + t.recentAmmFees, 0n);

    if (totalRecentFees > 0n) {
      // Distribute proportionally based on recent activity
      for (const [bcAddress, token] of migratedTokens) {
        const share = (amount * token.recentAmmFees) / totalRecentFees;
        if (share > 0n) {
          token.totalFees += share;
          token.feeCount++;
          token.recentAmmFees += share;

          const stats = this.tokenStats.get(bcAddress);
          if (stats) {
            stats.totalFees += share;
            stats.feeCount++;
            stats.lastFeeTimestamp = timestamp;
          }

          if (this.verbose) {
            this.log(`Distributed ${Number(share) / 1e9} SOL to ${token.symbol} (proportional)`);
          }

          if (this.onFeeDetected) {
            this.onFeeDetected({
              mint: token.mint,
              symbol: token.symbol,
              amount: share,
              timestamp,
              slot,
            });
          }
        }
      }
    } else {
      // No recent activity - distribute equally
      const share = amount / BigInt(migratedTokens.length);
      for (const [bcAddress, token] of migratedTokens) {
        token.totalFees += share;
        token.feeCount++;
        token.recentAmmFees += share;

        const stats = this.tokenStats.get(bcAddress);
        if (stats) {
          stats.totalFees += share;
          stats.feeCount++;
          stats.lastFeeTimestamp = timestamp;
        }

        if (this.verbose) {
          this.log(`Distributed ${Number(share) / 1e9} SOL to ${token.symbol} (equal)`);
        }

        if (this.onFeeDetected) {
          this.onFeeDetected({
            mint: token.mint,
            symbol: token.symbol,
            amount: share,
            timestamp,
            slot,
          });
        }
      }
    }
  }

  /**
   * Distribute BC fees proportionally to non-migrated tokens
   * Used when fees can't be attributed to specific tokens via transaction analysis
   */
  private distributeBcFeeProportionally(amount: bigint, slot: number, timestamp: number): void {
    const bcTokens = Array.from(this.trackedTokens.entries())
      .filter(([, t]) => !t.migrated);

    if (bcTokens.length === 0) {
      // No BC tokens - fall back to generic BC
      this.handleBalanceChange('FEE', 'BC', this.bcVault, amount, 0n, amount, slot, timestamp);
      return;
    }

    // Calculate total recent BC fees across all non-migrated tokens
    const totalRecentFees = bcTokens.reduce((sum, [, t]) => sum + t.recentBcFees, 0n);

    if (totalRecentFees > 0n) {
      // Distribute proportionally based on recent activity
      for (const [bcAddress, token] of bcTokens) {
        const share = (amount * token.recentBcFees) / totalRecentFees;
        if (share > 0n) {
          token.totalFees += share;
          token.feeCount++;
          token.recentBcFees += share;

          const stats = this.tokenStats.get(bcAddress);
          if (stats) {
            stats.totalFees += share;
            stats.feeCount++;
            stats.lastFeeTimestamp = timestamp;
          }

          if (this.verbose) {
            this.log(`Distributed ${Number(share) / 1e9} SOL to ${token.symbol} (BC proportional)`);
          }

          if (this.onFeeDetected) {
            this.onFeeDetected({
              mint: token.mint,
              symbol: token.symbol,
              amount: share,
              timestamp,
              slot,
            });
          }
        }
      }
    } else {
      // No recent activity - distribute equally
      const share = amount / BigInt(bcTokens.length);
      for (const [bcAddress, token] of bcTokens) {
        token.totalFees += share;
        token.feeCount++;
        token.recentBcFees += share;

        const stats = this.tokenStats.get(bcAddress);
        if (stats) {
          stats.totalFees += share;
          stats.feeCount++;
          stats.lastFeeTimestamp = timestamp;
        }

        if (this.verbose) {
          this.log(`Distributed ${Number(share) / 1e9} SOL to ${token.symbol} (BC equal)`);
        }

        if (this.onFeeDetected) {
          this.onFeeDetected({
            mint: token.mint,
            symbol: token.symbol,
            amount: share,
            timestamp,
            slot,
          });
        }
      }
    }
  }

  /**
   * Poll vault balance and attribute fees to active tokens
   */
  private async pollVaultWithAttribution(
    vaultType: 'BC' | 'AMM',
    vault: PublicKey,
    slot: number,
    timestamp: number,
    balanceKey: 'lastBcBalance' | 'lastAmmBalance',
    tokenDeltas: Map<string, bigint>
  ): Promise<void> {
    // Check circuit breaker before making RPC call
    if (!this.circuitBreaker.canExecute()) {
      if (this.verbose) {
        console.warn(`Circuit breaker OPEN, skipping ${vaultType} poll`);
      }
      return;
    }

    try {
      const currentBalance = await fetchWithRetry(
        async () => {
          const balance = await this.connection.getBalance(vault);
          this.circuitBreaker.recordSuccess();
          return BigInt(balance);
        },
        this.retryConfig,
        (attempt, error, delayMs) => {
          if (this.onRpcError) {
            this.onRpcError(error, attempt);
          }
          if (this.verbose) {
            console.warn(`RPC retry ${attempt}/${this.retryConfig.maxRetries} for ${vaultType}: ${error.message} (waiting ${delayMs}ms)`);
          }
        }
      );

      const lastBalance = this[balanceKey];
      const delta = currentBalance - lastBalance;

      if (delta > 0n) {
        // Fee incoming - attribute to active tokens
        this.handleFeeWithAttribution(vaultType, vault, delta, lastBalance, currentBalance, slot, timestamp, tokenDeltas);
      } else if (delta < 0n) {
        // Claim detected (withdrawal)
        this.handleBalanceChange('CLAIM', vaultType, vault, delta, lastBalance, currentBalance, slot, timestamp);
      }

      this[balanceKey] = currentBalance;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      if (this.verbose) {
        console.error(`Poll error (${vaultType}) after ${this.retryConfig.maxRetries} retries:`, error);
      }
      if (this.onRpcError) {
        this.onRpcError(error instanceof Error ? error : new Error(String(error)), this.retryConfig.maxRetries);
      }
    }
  }

  /**
   * Handle fee with proportional attribution to active tokens
   */
  private handleFeeWithAttribution(
    vaultType: 'BC' | 'AMM',
    vault: PublicKey,
    totalFee: bigint,
    balanceBefore: bigint,
    balanceAfter: bigint,
    slot: number,
    timestamp: number,
    tokenDeltas: Map<string, bigint>
  ): void {
    // Calculate total reserve change across all active tokens
    const totalReserveChange = Array.from(tokenDeltas.values()).reduce((sum, d) => sum + d, 0n);

    if (totalReserveChange > 0n && tokenDeltas.size > 0) {
      // Attribute fees proportionally to active tokens
      let remainingFee = totalFee;
      const entries = Array.from(tokenDeltas.entries());

      for (let i = 0; i < entries.length; i++) {
        const [bcAddress, reserveDelta] = entries[i];
        const token = this.trackedTokens.get(bcAddress);
        if (!token) continue;

        // Calculate proportional fee (last token gets remaining to avoid rounding issues)
        let attributedFee: bigint;
        if (i === entries.length - 1) {
          attributedFee = remainingFee;
        } else {
          const proportion = Number(reserveDelta) / Number(totalReserveChange);
          attributedFee = BigInt(Math.floor(Number(totalFee) * proportion));
          remainingFee -= attributedFee;
        }

        // Update tracked token stats
        token.totalFees += attributedFee;
        token.feeCount++;

        // Update tokenStats
        const stats = this.tokenStats.get(bcAddress);
        if (stats) {
          stats.totalFees += attributedFee;
          stats.feeCount++;
          stats.lastFeeTimestamp = timestamp;
          stats.lastActivity = timestamp;
        }

        // Create history entry with token attribution
        this.createHistoryEntryWithToken(
          'FEE',
          vaultType,
          vault,
          attributedFee,
          balanceBefore,
          balanceAfter,
          slot,
          timestamp,
          token.mint,
          token.symbol
        );

        // Log the attributed fee
        this.log(`${token.symbol}: +${Number(attributedFee) / 1e9} SOL (${vaultType})`);

        // Callback
        if (this.onFeeDetected) {
          this.onFeeDetected({
            mint: token.mint,
            symbol: token.symbol,
            amount: attributedFee,
            timestamp,
            slot,
          });
        }
      }
    } else {
      // No BC activity detected - fall back to vault-level tracking
      this.handleBalanceChange('FEE', vaultType, vault, totalFee, balanceBefore, balanceAfter, slot, timestamp);
    }
  }

  /**
   * Create history entry with token attribution
   */
  private createHistoryEntryWithToken(
    eventType: HistoryEventType,
    vaultType: 'BC' | 'AMM',
    vault: PublicKey,
    amount: bigint,
    balanceBefore: bigint,
    balanceAfter: bigint,
    slot: number,
    timestamp: number,
    mint: string,
    symbol: string
  ): void {
    if (!this.historyLog || !this.historyFile) return;

    const prevHash = this.historyLog.latestHash;
    const sequence = this.historyLog.entryCount + 1;

    const entryData: Omit<HistoryEntry, 'hash'> = {
      sequence,
      prevHash,
      eventType,
      vaultType,
      vault: vault.toBase58(),
      mint,
      symbol,
      amount: amount.toString(),
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      slot,
      timestamp,
      date: new Date(timestamp).toISOString(),
    };

    const hash = computeEntryHash(entryData);
    const entry: HistoryEntry = { ...entryData, hash };

    // Update history log
    this.historyLog.entries.push(entry);
    this.historyLog.entryCount = sequence;
    this.historyLog.latestHash = hash;
    this.historyLog.lastUpdated = new Date().toISOString();
    this.historyLog.totalFees = (BigInt(this.historyLog.totalFees) + amount).toString();

    // Save to file
    saveHistoryLog(this.historyFile, this.historyLog);

    // Callback
    if (this.onHistoryEntry) {
      this.onHistoryEntry(entry);
    }
  }

  private async pollVault(
    vaultType: 'BC' | 'AMM',
    vault: PublicKey,
    slot: number,
    timestamp: number,
    balanceKey: 'lastBcBalance' | 'lastAmmBalance'
  ): Promise<void> {
    // Check circuit breaker before making RPC call
    if (!this.circuitBreaker.canExecute()) {
      if (this.verbose) {
        console.warn(`Circuit breaker OPEN, skipping ${vaultType} poll`);
      }
      return;
    }

    try {
      const currentBalance = await fetchWithRetry(
        async () => {
          const balance = await this.connection.getBalance(vault);
          this.circuitBreaker.recordSuccess();
          return BigInt(balance);
        },
        this.retryConfig,
        (attempt, error, delayMs) => {
          if (this.onRpcError) {
            this.onRpcError(error, attempt);
          }
          if (this.verbose) {
            console.warn(`RPC retry ${attempt}/${this.retryConfig.maxRetries} for ${vaultType}: ${error.message} (waiting ${delayMs}ms)`);
          }
        }
      );

      const lastBalance = this[balanceKey];
      const delta = currentBalance - lastBalance;

      if (delta > 0n) {
        // Fee incoming
        this.handleBalanceChange('FEE', vaultType, vault, delta, lastBalance, currentBalance, slot, timestamp);
      } else if (delta < 0n) {
        // Claim detected (withdrawal)
        this.handleBalanceChange('CLAIM', vaultType, vault, delta, lastBalance, currentBalance, slot, timestamp);
      }

      this[balanceKey] = currentBalance;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      if (this.verbose) {
        console.error(`Poll error (${vaultType}) after ${this.retryConfig.maxRetries} retries:`, error);
      }
      if (this.onRpcError) {
        this.onRpcError(error instanceof Error ? error : new Error(String(error)), this.retryConfig.maxRetries);
      }
    }
  }

  private handleBalanceChange(
    eventType: HistoryEventType,
    vaultType: 'BC' | 'AMM',
    vault: PublicKey,
    amount: bigint,
    balanceBefore: bigint,
    balanceAfter: bigint,
    slot: number,
    timestamp: number
  ): void {
    const absAmount = amount < 0n ? -amount : amount;

    // Only update stats for FEE events (not claims)
    if (eventType === 'FEE') {
      let stats = this.tokenStats.get(vaultType);
      if (!stats) {
        stats = {
          mint: vaultType,
          symbol: vaultType,
          totalFees: 0n,
          feeCount: 0,
          lastFeeTimestamp: 0,
        };
        this.tokenStats.set(vaultType, stats);
      }
      stats.totalFees += absAmount;
      stats.feeCount++;
      stats.lastFeeTimestamp = timestamp;
    }

    // Create Proof-of-History entry if enabled (for both FEE and CLAIM)
    if (this.historyLog && this.historyFile) {
      const prevHash = this.historyLog.latestHash;
      const sequence = this.historyLog.entryCount + 1;

      const entryData: Omit<HistoryEntry, 'hash'> = {
        sequence,
        prevHash,
        eventType,
        vaultType,
        vault: vault.toBase58(),
        amount: amount.toString(),
        balanceBefore: balanceBefore.toString(),
        balanceAfter: balanceAfter.toString(),
        slot,
        timestamp,
        date: new Date(timestamp).toISOString(),
      };

      const hash = computeEntryHash(entryData);
      const entry: HistoryEntry = { ...entryData, hash };

      // Update history log
      this.historyLog.entries.push(entry);
      this.historyLog.entryCount = sequence;
      this.historyLog.latestHash = hash;
      this.historyLog.lastUpdated = new Date().toISOString();

      // Only add to totalFees for FEE events
      if (eventType === 'FEE') {
        this.historyLog.totalFees = (BigInt(this.historyLog.totalFees) + absAmount).toString();
      }

      // Save to file
      saveHistoryLog(this.historyFile, this.historyLog);

      // Callback
      if (this.onHistoryEntry) {
        this.onHistoryEntry(entry);
      }
    }

    // Log the event
    if (eventType === 'FEE') {
      this.log(`${vaultType}: +${Number(absAmount) / 1e9} SOL`);
    } else {
      this.log(`${vaultType}: CLAIM -${Number(absAmount) / 1e9} SOL`);
    }

    // Only call onFeeDetected for FEE events
    if (eventType === 'FEE' && this.onFeeDetected) {
      const record: FeeRecord = {
        mint: 'unknown',
        symbol: vaultType,
        amount: absAmount,
        timestamp,
        slot,
      };
      this.onFeeDetected(record);
    }
  }

  private attributeFee(
    token: TokenConfig,
    amount: bigint,
    slot: number,
    timestamp: number
  ): void {
    // Update stats
    const stats = this.tokenStats.get(token.mint);
    if (stats) {
      stats.totalFees += amount;
      stats.feeCount++;
      stats.lastFeeTimestamp = timestamp;
    }

    // Create record
    const record: FeeRecord = {
      mint: token.mint,
      symbol: token.symbol,
      amount,
      timestamp,
      slot,
    };

    this.log(`${token.symbol}: +${Number(amount) / 1e9} SOL`);

    // Callback
    if (this.onFeeDetected) {
      this.onFeeDetected(record);
    }
  }

  private log(message: string): void {
    if (this.verbose) {
      const time = new Date().toISOString().slice(11, 19);
      console.log(`[${time}] ${message}`);
    }
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

/**
 * Run daemon from command line
 */
export async function runDaemonCLI(args: string[]): Promise<void> {
  // Parse args
  const creatorIdx = args.findIndex(a => a === '--creator' || a === '-c');
  const rpcIdx = args.findIndex(a => a === '--rpc' || a === '-r');
  const verboseFlag = args.includes('--verbose') || args.includes('-v');

  if (creatorIdx === -1 || !args[creatorIdx + 1]) {
    console.log(`
ASDF Validator Daemon

Usage:
  npx @asdf/validator-sdk daemon --creator <ADDRESS> [options]

Options:
  --creator, -c <ADDRESS>  Creator wallet address (required)
  --rpc, -r <URL>          RPC URL (default: mainnet)
  --verbose, -v            Enable verbose logging
  --help, -h               Show help

Example:
  npx @asdf/validator-sdk daemon -c 5ABC...xyz -v
`);
    process.exit(1);
  }

  const creatorAddress = args[creatorIdx + 1];
  const rpcUrl = rpcIdx !== -1 && args[rpcIdx + 1]
    ? args[rpcIdx + 1]
    : 'https://api.mainnet-beta.solana.com';

  console.log('\n🔥 ASDF VALIDATOR DAEMON');
  console.log('='.repeat(50));
  console.log(`Creator: ${creatorAddress}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log('='.repeat(50) + '\n');

  const daemon = new ValidatorDaemon({
    rpcUrl,
    creatorAddress,
    verbose: verboseFlag,
    onFeeDetected: (record) => {
      console.log(`💰 ${record.symbol}: +${Number(record.amount) / 1e9} SOL`);
    },
    onStats: (stats) => {
      const total = stats.reduce((sum, s) => sum + Number(s.totalFees), 0);
      console.log(`\n📊 Total fees: ${total / 1e9} SOL`);
      for (const s of stats) {
        if (s.totalFees > 0n) {
          console.log(`   ${s.symbol}: ${Number(s.totalFees) / 1e9} SOL`);
        }
      }
      console.log('');
    },
  });

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    daemon.stop();
    const total = daemon.getTotalFees();
    console.log(`Total fees tracked: ${Number(total) / 1e9} SOL`);
    process.exit(0);
  });

  await daemon.start();
  console.log('Press Ctrl+C to stop\n');
}

export default ValidatorDaemon;
