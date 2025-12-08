import { PublicKey } from '@solana/web3.js';
import { RpcManager } from './rpc-manager';
import {
  deserializeBondingCurve,
  deserializeMetadata,
  deserializeToken2022Metadata,
  PUMP_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
} from './utils';

export interface DiscoveredToken {
  bondingCurve: PublicKey;
  mint?: PublicKey;
  creator: PublicKey;
  migrated: boolean;
  realSolReserves: bigint;
  isMayhemMode: boolean;
}

export interface EnrichedToken extends DiscoveredToken {
  mint: PublicKey;
  symbol: string;
  name: string;
  tokenProgram: 'TOKEN' | 'TOKEN_2022';
}

/**
 * Derive bonding curve PDA from mint address
 */
export function deriveBondingCurve(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive creator vault for PumpFun Bonding Curve
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

export class TokenManager {
  constructor(private rpcManager: RpcManager) {}

  /**
   * Discover tokens with fallbacks for large datasets
   */
  async discoverTokens(creator: PublicKey): Promise<DiscoveredToken[]> {
    const connection = this.rpcManager.getConnection();
    const creatorOffset = 49;

    try {
      // Attempt standard discovery
      const [classicAccounts, mayhemAccounts] = await Promise.all([
        connection.getProgramAccounts(PUMP_PROGRAM_ID, {
          filters: [
            { dataSize: 81 },
            { memcmp: { offset: creatorOffset, bytes: creator.toBase58() } },
          ],
        }),
        connection.getProgramAccounts(PUMP_PROGRAM_ID, {
          filters: [
            { dataSize: 82 },
            { memcmp: { offset: creatorOffset, bytes: creator.toBase58() } },
          ],
        }),
      ]);

      const tokens: DiscoveredToken[] = [];

      // Process classic
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

      // Process mayhem
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

    } catch (error: any) {
      // Check for "Too many accounts requested" error or other RPC limits
      const msg = error?.message || error?.toString() || '';
      if (
        msg.includes('Too many accounts') || 
        error?.code === -32600 || 
        msg.includes('5000001 pubkeys')
      ) {
        console.warn('⚠️  Warning: Too many tokens found for creator (RPC limit exceeded). Switching to active tracking only.');
        console.warn('   The daemon will discover tokens dynamically as they are traded.');
        // Return empty list - the FeeTracker will dynamically discover tokens from transactions
        return [];
      }
      throw error;
    }
  }

  async resolveMint(bondingCurve: PublicKey): Promise<{ mint: PublicKey; tokenProgram: 'TOKEN' | 'TOKEN_2022' } | null> {
    const connection = this.rpcManager.getConnection();
    try {
      let tokenAccounts = await connection.getTokenAccountsByOwner(bondingCurve, {
        programId: SPL_TOKEN_PROGRAM_ID,
      });

      let tokenProgram: 'TOKEN' | 'TOKEN_2022' = 'TOKEN';

      if (tokenAccounts.value.length === 0) {
        tokenAccounts = await connection.getTokenAccountsByOwner(bondingCurve, {
          programId: TOKEN_2022_PROGRAM_ID,
        });
        tokenProgram = 'TOKEN_2022';
      }

      if (tokenAccounts.value.length === 0) return null;

      const data = tokenAccounts.value[0].account.data;
      const mint = new PublicKey(data.slice(0, 32));
      return { mint, tokenProgram };
    } catch {
      return null;
    }
  }

  async refreshBondingCurves(
    tokens: { bondingCurve: string; migrated: boolean }[]
  ): Promise<Map<string, { reserves: bigint; migrated: boolean }>> {
    const results = new Map<string, { reserves: bigint; migrated: boolean }>();
    const nonMigrated = tokens.filter(t => !t.migrated);

    if (nonMigrated.length === 0) return results;

    const pubkeys = nonMigrated.map(t => new PublicKey(t.bondingCurve));
    const accounts = await this.rpcManager.getMultipleAccountsInfoBatch(pubkeys);

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const bcAddress = pubkeys[i].toBase58();

      if (account) {
        const data = deserializeBondingCurve(account.data);
        if (data) {
          results.set(bcAddress, {
            reserves: data.realSolReserves,
            migrated: data.complete,
          });
        }
      }
    }

    return results;
  }

  /**
   * Fetch token metadata from Metaplex or Token-2022 Extensions
   */
  async fetchMetadata(mint: PublicKey): Promise<{ name: string; symbol: string } | null> {
    try {
      // 1. Try Token-2022 Metadata Extension first (optimization: check account owner)
      const mintAccount = await this.rpcManager.getAccountInfo(mint);
      if (mintAccount && mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        const metadata = deserializeToken2022Metadata(mintAccount.data);
        if (metadata) return metadata;
      }

      // 2. Fallback to Metaplex PDA (Works for SPL Token and Token-2022 with external metadata)
      const [pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METAPLEX_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        METAPLEX_PROGRAM_ID
      );

      const account = await this.rpcManager.getAccountInfo(pda);
      if (!account) return null;

      return deserializeMetadata(account.data);
    } catch {
      return null;
    }
  }
}
