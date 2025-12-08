import { PublicKey } from '@solana/web3.js';
import {
  deriveBondingCurve,
  deriveBondingCurveVault,
  derivePumpSwapVault,
  deriveAMMPool,
  TokenManager,
} from '../lib/token-manager';
import { RpcManager } from '../lib/rpc-manager';
import { PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID } from '../lib/utils';

// Mock RpcManager
jest.mock('../lib/rpc-manager');

describe('Token Manager', () => {
  describe('deriveBondingCurve', () => {
    it('should derive consistent PDA for same mint', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const pda1 = deriveBondingCurve(mint);
      const pda2 = deriveBondingCurve(mint);
      expect(pda1.equals(pda2)).toBe(true);
    });

    it('should derive different PDAs for different mints', () => {
      const mint1 = new PublicKey('So11111111111111111111111111111111111111112');
      const mint2 = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const pda1 = deriveBondingCurve(mint1);
      const pda2 = deriveBondingCurve(mint2);
      expect(pda1.equals(pda2)).toBe(false);
    });

    it('should return valid PublicKey', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const pda = deriveBondingCurve(mint);
      expect(pda).toBeInstanceOf(PublicKey);
      expect(pda.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    });

    it('should use PUMP_PROGRAM_ID for derivation', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const [expectedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()],
        PUMP_PROGRAM_ID
      );
      const pda = deriveBondingCurve(mint);
      expect(pda.equals(expectedPda)).toBe(true);
    });
  });

  describe('deriveBondingCurveVault', () => {
    it('should derive consistent vault for same creator', () => {
      const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
      const vault1 = deriveBondingCurveVault(creator);
      const vault2 = deriveBondingCurveVault(creator);
      expect(vault1.equals(vault2)).toBe(true);
    });

    it('should derive different vaults for different creators', () => {
      const creator1 = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
      const creator2 = new PublicKey('5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE');
      const vault1 = deriveBondingCurveVault(creator1);
      const vault2 = deriveBondingCurveVault(creator2);
      expect(vault1.equals(vault2)).toBe(false);
    });

    it('should return valid PublicKey', () => {
      const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
      const vault = deriveBondingCurveVault(creator);
      expect(vault).toBeInstanceOf(PublicKey);
    });
  });

  describe('derivePumpSwapVault', () => {
    it('should derive consistent vault for same creator', () => {
      const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
      const vault1 = derivePumpSwapVault(creator);
      const vault2 = derivePumpSwapVault(creator);
      expect(vault1.equals(vault2)).toBe(true);
    });

    it('should derive different vaults for different creators', () => {
      const creator1 = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
      const creator2 = new PublicKey('5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE');
      const vault1 = derivePumpSwapVault(creator1);
      const vault2 = derivePumpSwapVault(creator2);
      expect(vault1.equals(vault2)).toBe(false);
    });

    it('should derive different vault than BC for same creator', () => {
      const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
      const bcVault = deriveBondingCurveVault(creator);
      const ammVault = derivePumpSwapVault(creator);
      expect(bcVault.equals(ammVault)).toBe(false);
    });

    it('should use PUMPSWAP_PROGRAM_ID for derivation', () => {
      const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
      const [expectedVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator_vault'), creator.toBuffer()],
        PUMPSWAP_PROGRAM_ID
      );
      const vault = derivePumpSwapVault(creator);
      expect(vault.equals(expectedVault)).toBe(true);
    });
  });

  describe('deriveAMMPool', () => {
    it('should derive consistent pool for same mint and index', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const pool1 = deriveAMMPool(mint, 0);
      const pool2 = deriveAMMPool(mint, 0);
      expect(pool1.equals(pool2)).toBe(true);
    });

    it('should derive different pools for different mints', () => {
      const mint1 = new PublicKey('So11111111111111111111111111111111111111112');
      const mint2 = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const pool1 = deriveAMMPool(mint1);
      const pool2 = deriveAMMPool(mint2);
      expect(pool1.equals(pool2)).toBe(false);
    });

    it('should derive different pools for different indices', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const pool0 = deriveAMMPool(mint, 0);
      const pool1 = deriveAMMPool(mint, 1);
      expect(pool0.equals(pool1)).toBe(false);
    });

    it('should default to index 0', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const poolDefault = deriveAMMPool(mint);
      const pool0 = deriveAMMPool(mint, 0);
      expect(poolDefault.equals(pool0)).toBe(true);
    });
  });

  describe('TokenManager', () => {
    let tokenManager: TokenManager;
    let mockRpcManager: jest.Mocked<RpcManager>;

    beforeEach(() => {
      mockRpcManager = {
        getConnection: jest.fn().mockReturnValue({
          getProgramAccounts: jest.fn(),
          getTokenAccountsByOwner: jest.fn(),
        }),
        getMultipleAccountsInfoBatch: jest.fn(),
        getAccountInfo: jest.fn(),
      } as any;

      tokenManager = new TokenManager(mockRpcManager);
    });

    describe('constructor', () => {
      it('should create instance with RpcManager', () => {
        expect(tokenManager).toBeInstanceOf(TokenManager);
      });
    });

    describe('discoverTokens', () => {
      it('should return empty array when no tokens found', async () => {
        const mockConnection = mockRpcManager.getConnection();
        (mockConnection.getProgramAccounts as jest.Mock).mockResolvedValue([]);

        const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
        const tokens = await tokenManager.discoverTokens(creator);

        expect(tokens).toEqual([]);
      });

      it('should discover classic tokens (81 bytes)', async () => {
        // Create valid 81-byte bonding curve data (8-byte discriminator + 73 bytes data)
        const bcData = Buffer.alloc(81);
        let offset = 8; // Skip discriminator
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // virtualTokenReserves
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // virtualSolReserves
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // realTokenReserves
        bcData.writeBigUInt64LE(500000n, offset); offset += 8;  // realSolReserves
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // tokenTotalSupply
        bcData.writeUInt8(0, offset); offset += 1; // complete (false)
        // Creator at offset 49
        const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
        creator.toBuffer().copy(bcData, offset);

        const mockConnection = mockRpcManager.getConnection();
        (mockConnection.getProgramAccounts as jest.Mock)
          .mockResolvedValueOnce([
            {
              pubkey: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
              account: { data: bcData },
            },
          ])
          .mockResolvedValueOnce([]); // mayhem accounts

        const tokens = await tokenManager.discoverTokens(creator);

        expect(tokens).toHaveLength(1);
        expect(tokens[0].isMayhemMode).toBe(false);
        expect(tokens[0].realSolReserves).toBe(500000n);
      });

      it('should discover mayhem tokens (82 bytes)', async () => {
        // Create valid 82-byte mayhem mode bonding curve data
        const bcData = Buffer.alloc(82);
        let offset = 8; // Skip discriminator
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // virtualTokenReserves
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // virtualSolReserves
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // realTokenReserves
        bcData.writeBigUInt64LE(750000n, offset); offset += 8;  // realSolReserves
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // tokenTotalSupply
        bcData.writeUInt8(0, offset); offset += 1; // complete (false)
        const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
        creator.toBuffer().copy(bcData, offset); offset += 32;
        bcData.writeUInt8(1, offset); // isMayhemMode = true

        const mockConnection = mockRpcManager.getConnection();
        (mockConnection.getProgramAccounts as jest.Mock)
          .mockResolvedValueOnce([]) // classic
          .mockResolvedValueOnce([
            {
              pubkey: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
              account: { data: bcData },
            },
          ]); // mayhem

        const tokens = await tokenManager.discoverTokens(creator);

        expect(tokens).toHaveLength(1);
        expect(tokens[0].isMayhemMode).toBe(true);
      });

      it('should handle "Too many accounts" error gracefully', async () => {
        const mockConnection = mockRpcManager.getConnection();
        (mockConnection.getProgramAccounts as jest.Mock).mockRejectedValue(
          new Error('Too many accounts requested')
        );

        const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
        const tokens = await tokenManager.discoverTokens(creator);

        expect(tokens).toEqual([]);
      });

      it('should rethrow other errors', async () => {
        const mockConnection = mockRpcManager.getConnection();
        (mockConnection.getProgramAccounts as jest.Mock).mockRejectedValue(
          new Error('Network error')
        );

        const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

        await expect(tokenManager.discoverTokens(creator)).rejects.toThrow('Network error');
      });
    });

    describe('resolveMint', () => {
      it('should resolve TOKEN mint', async () => {
        const mint = new PublicKey('So11111111111111111111111111111111111111112');
        const tokenAccountData = Buffer.alloc(165);
        mint.toBuffer().copy(tokenAccountData, 0);

        const mockConnection = mockRpcManager.getConnection();
        (mockConnection.getTokenAccountsByOwner as jest.Mock).mockResolvedValue({
          value: [{ account: { data: tokenAccountData } }],
        });

        const bondingCurve = new PublicKey('11111111111111111111111111111111');
        const result = await tokenManager.resolveMint(bondingCurve);

        expect(result).not.toBeNull();
        expect(result?.mint.equals(mint)).toBe(true);
        expect(result?.tokenProgram).toBe('TOKEN');
      });

      it('should resolve TOKEN_2022 mint as fallback', async () => {
        const mint = new PublicKey('So11111111111111111111111111111111111111112');
        const tokenAccountData = Buffer.alloc(165);
        mint.toBuffer().copy(tokenAccountData, 0);

        const mockConnection = mockRpcManager.getConnection();
        (mockConnection.getTokenAccountsByOwner as jest.Mock)
          .mockResolvedValueOnce({ value: [] }) // TOKEN empty
          .mockResolvedValueOnce({
            value: [{ account: { data: tokenAccountData } }],
          }); // TOKEN_2022

        const bondingCurve = new PublicKey('11111111111111111111111111111111');
        const result = await tokenManager.resolveMint(bondingCurve);

        expect(result).not.toBeNull();
        expect(result?.tokenProgram).toBe('TOKEN_2022');
      });

      it('should return null when no token accounts found', async () => {
        const mockConnection = mockRpcManager.getConnection();
        (mockConnection.getTokenAccountsByOwner as jest.Mock).mockResolvedValue({
          value: [],
        });

        const bondingCurve = new PublicKey('11111111111111111111111111111111');
        const result = await tokenManager.resolveMint(bondingCurve);

        expect(result).toBeNull();
      });

      it('should return null on error', async () => {
        const mockConnection = mockRpcManager.getConnection();
        (mockConnection.getTokenAccountsByOwner as jest.Mock).mockRejectedValue(
          new Error('RPC error')
        );

        const bondingCurve = new PublicKey('11111111111111111111111111111111');
        const result = await tokenManager.resolveMint(bondingCurve);

        expect(result).toBeNull();
      });
    });

    describe('refreshBondingCurves', () => {
      it('should return empty map for empty input', async () => {
        const result = await tokenManager.refreshBondingCurves([]);
        expect(result.size).toBe(0);
      });

      it('should skip migrated tokens', async () => {
        const tokens = [
          { bondingCurve: '11111111111111111111111111111111', migrated: true },
        ];

        const result = await tokenManager.refreshBondingCurves(tokens);

        expect(result.size).toBe(0);
        expect(mockRpcManager.getMultipleAccountsInfoBatch).not.toHaveBeenCalled();
      });

      it('should refresh non-migrated tokens', async () => {
        const bcData = Buffer.alloc(81);
        let offset = 8; // Skip discriminator
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // virtualTokenReserves
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // virtualSolReserves
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // realTokenReserves
        bcData.writeBigUInt64LE(999000n, offset); offset += 8;  // realSolReserves
        bcData.writeBigUInt64LE(1000000n, offset); offset += 8; // tokenTotalSupply
        bcData.writeUInt8(0, offset); offset += 1; // complete (false)
        const creator = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
        creator.toBuffer().copy(bcData, offset);

        mockRpcManager.getMultipleAccountsInfoBatch.mockResolvedValue([
          { data: bcData, executable: false, owner: PUMP_PROGRAM_ID, lamports: 0 },
        ]);

        const bcPubkey = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
        const tokens = [
          { bondingCurve: bcPubkey.toBase58(), migrated: false },
        ];

        const result = await tokenManager.refreshBondingCurves(tokens);

        expect(result.size).toBe(1);
        expect(result.get(bcPubkey.toBase58())?.reserves).toBe(999000n);
      });

      it('should handle null account results', async () => {
        mockRpcManager.getMultipleAccountsInfoBatch.mockResolvedValue([null]);

        const tokens = [
          { bondingCurve: '11111111111111111111111111111111', migrated: false },
        ];

        const result = await tokenManager.refreshBondingCurves(tokens);

        expect(result.size).toBe(0);
      });
    });

    describe('fetchMetadata', () => {
      it('should return null when account not found', async () => {
        mockRpcManager.getAccountInfo.mockResolvedValue(null);

        const mint = new PublicKey('So11111111111111111111111111111111111111112');
        const result = await tokenManager.fetchMetadata(mint);

        expect(result).toBeNull();
      });

      it('should return null on error', async () => {
        mockRpcManager.getAccountInfo.mockRejectedValue(new Error('Network error'));

        const mint = new PublicKey('So11111111111111111111111111111111111111112');
        const result = await tokenManager.fetchMetadata(mint);

        expect(result).toBeNull();
      });
    });
  });
});
