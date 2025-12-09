/**
 * ValidatorSDK Tests
 *
 * Tests for SDK functionality including PDA derivation, calculations, and more.
 */

import { PublicKey, Connection } from '@solana/web3.js';
import {
  ValidatorSDK,
  deriveValidatorPDA,
  ASDF_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  TokenContribution,
} from '../index';

// Mock Connection for testing
const mockConnection = {
  getAccountInfo: jest.fn(),
  getMultipleAccountsInfo: jest.fn(),
  getLatestBlockhash: jest.fn(),
} as unknown as Connection;

describe('ValidatorSDK', () => {
  let sdk: ValidatorSDK;

  beforeEach(() => {
    sdk = new ValidatorSDK(mockConnection);
    jest.clearAllMocks();
  });

  describe('Constants', () => {
    it('should export valid program IDs', () => {
      expect(ASDF_PROGRAM_ID).toBeInstanceOf(PublicKey);
      expect(PUMP_PROGRAM_ID).toBeInstanceOf(PublicKey);
      expect(PUMPSWAP_PROGRAM_ID).toBeInstanceOf(PublicKey);

      expect(ASDF_PROGRAM_ID.toBase58()).toBe('ASDFc5hkEM2MF8mrAAtCPieV6x6h1B5BwjgztFt7Xbui');
      expect(PUMP_PROGRAM_ID.toBase58()).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
      expect(PUMPSWAP_PROGRAM_ID.toBase58()).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    });
  });

  describe('deriveValidatorPDA', () => {
    it('should derive consistent PDA for same mint', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');

      const [pda1, bump1] = sdk.deriveValidatorPDA(mint);
      const [pda2, bump2] = sdk.deriveValidatorPDA(mint);

      expect(pda1.equals(pda2)).toBe(true);
      expect(bump1).toBe(bump2);
    });

    it('should derive different PDAs for different mints', () => {
      const mint1 = new PublicKey('So11111111111111111111111111111111111111112');
      const mint2 = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

      const [pda1] = sdk.deriveValidatorPDA(mint1);
      const [pda2] = sdk.deriveValidatorPDA(mint2);

      expect(pda1.equals(pda2)).toBe(false);
    });

    it('should work with standalone function', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');

      const [pda1] = sdk.deriveValidatorPDA(mint);
      const [pda2] = deriveValidatorPDA(mint, ASDF_PROGRAM_ID);

      expect(pda1.equals(pda2)).toBe(true);
    });

    it('should use custom program ID', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const customProgramId = new PublicKey('11111111111111111111111111111111');

      const [pda1] = deriveValidatorPDA(mint, ASDF_PROGRAM_ID);
      const [pda2] = deriveValidatorPDA(mint, customProgramId);

      expect(pda1.equals(pda2)).toBe(false);
    });
  });

  describe('isInitialized', () => {
    it('should return true when account exists', async () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      (mockConnection.getAccountInfo as jest.Mock).mockResolvedValue({ data: Buffer.alloc(100) });

      const result = await sdk.isInitialized(mint);

      expect(result).toBe(true);
    });

    it('should return false when account does not exist', async () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      (mockConnection.getAccountInfo as jest.Mock).mockResolvedValue(null);

      const result = await sdk.isInitialized(mint);

      expect(result).toBe(false);
    });
  });

  describe('calculateDistribution', () => {
    it('should calculate proportional distribution', () => {
      const contributions = new Map<string, TokenContribution>([
        ['mint1', { mint: 'mint1', totalLamports: 100n, totalSOL: 0.0000001, validationCount: 1, lastSlot: 0, feeRateBps: 100 }],
        ['mint2', { mint: 'mint2', totalLamports: 200n, totalSOL: 0.0000002, validationCount: 1, lastSlot: 0, feeRateBps: 100 }],
        ['mint3', { mint: 'mint3', totalLamports: 300n, totalSOL: 0.0000003, validationCount: 1, lastSlot: 0, feeRateBps: 100 }],
      ]);

      const distribution = sdk.calculateDistribution(contributions, 600n);

      expect(distribution.get('mint1')).toBe(100n); // 100/600 * 600
      expect(distribution.get('mint2')).toBe(200n); // 200/600 * 600
      expect(distribution.get('mint3')).toBe(300n); // 300/600 * 600
    });

    it('should return empty map for zero total', () => {
      const contributions = new Map<string, TokenContribution>([
        ['mint1', { mint: 'mint1', totalLamports: 0n, totalSOL: 0, validationCount: 0, lastSlot: 0, feeRateBps: 100 }],
      ]);

      const distribution = sdk.calculateDistribution(contributions, 1000n);

      expect(distribution.size).toBe(0);
    });

    it('should handle single contributor', () => {
      const contributions = new Map<string, TokenContribution>([
        ['mint1', { mint: 'mint1', totalLamports: 1000n, totalSOL: 0.000001, validationCount: 1, lastSlot: 0, feeRateBps: 100 }],
      ]);

      const distribution = sdk.calculateDistribution(contributions, 5000n);

      expect(distribution.get('mint1')).toBe(5000n);
    });

    it('should handle large amounts', () => {
      const contributions = new Map<string, TokenContribution>([
        ['mint1', { mint: 'mint1', totalLamports: 1000000000n, totalSOL: 1, validationCount: 1, lastSlot: 0, feeRateBps: 100 }],
        ['mint2', { mint: 'mint2', totalLamports: 2000000000n, totalSOL: 2, validationCount: 1, lastSlot: 0, feeRateBps: 100 }],
      ]);

      const distribution = sdk.calculateDistribution(contributions, 3000000000n);

      expect(distribution.get('mint1')).toBe(1000000000n);
      expect(distribution.get('mint2')).toBe(2000000000n);
    });
  });

  describe('buildInitializeTransaction', () => {
    it('should build valid transaction', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const bondingCurve = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const payer = new PublicKey('11111111111111111111111111111111');

      const tx = sdk.buildInitializeTransaction(mint, bondingCurve, payer);

      expect(tx).toBeDefined();
      expect(tx.instructions).toHaveLength(1);
      expect(tx.feePayer?.equals(payer)).toBe(true);
    });

    it('should include correct accounts in instruction', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const bondingCurve = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const payer = new PublicKey('11111111111111111111111111111111');

      const tx = sdk.buildInitializeTransaction(mint, bondingCurve, payer);
      const ix = tx.instructions[0];

      expect(ix.keys).toHaveLength(5);
      expect(ix.programId.equals(ASDF_PROGRAM_ID)).toBe(true);

      // Check payer is signer
      const payerKey = ix.keys.find(k => k.pubkey.equals(payer));
      expect(payerKey?.isSigner).toBe(true);
      expect(payerKey?.isWritable).toBe(true);
    });
  });

  describe('getContributions', () => {
    it('should batch fetch multiple accounts', async () => {
      const mints = [
        new PublicKey('So11111111111111111111111111111111111111112'),
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      ];

      (mockConnection.getMultipleAccountsInfo as jest.Mock).mockResolvedValue([null, null]);

      const result = await sdk.getContributions(mints);

      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
      expect(result.size).toBe(0);
    });
  });

  describe('getLeaderboard', () => {
    it('should return empty array for no contributions', async () => {
      const mints = [new PublicKey('So11111111111111111111111111111111111111112')];
      (mockConnection.getMultipleAccountsInfo as jest.Mock).mockResolvedValue([null]);

      const result = await sdk.getLeaderboard(mints);

      expect(result).toHaveLength(0);
    });

    it('should return ranked contributions sorted by amount', async () => {
      const mints = [
        new PublicKey('So11111111111111111111111111111111111111112'),
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      ];

      // Layout: discriminator(8) + mint(32) + bonding_curve(32) +
      //         last_validated_slot(8) + total_validated_lamports(8) +
      //         total_validated_count(8) + fee_rate_bps(2) + bump(1)
      const mockData1 = Buffer.alloc(100);
      mints[0].toBuffer().copy(mockData1, 8); // mint at 8
      mockData1.writeBigUInt64LE(12345n, 72); // lastValidatedSlot at 72
      mockData1.writeBigUInt64LE(100n, 80); // totalValidatedLamports at 80
      mockData1.writeBigUInt64LE(1n, 88); // totalValidatedCount at 88
      mockData1.writeUInt16LE(100, 96); // feeRateBps at 96

      const mockData2 = Buffer.alloc(100);
      mints[1].toBuffer().copy(mockData2, 8);
      mockData2.writeBigUInt64LE(12346n, 72);
      mockData2.writeBigUInt64LE(300n, 80);
      mockData2.writeBigUInt64LE(3n, 88);
      mockData2.writeUInt16LE(100, 96);

      (mockConnection.getMultipleAccountsInfo as jest.Mock).mockResolvedValue([
        { data: mockData1 },
        { data: mockData2 },
      ]);

      const result = await sdk.getLeaderboard(mints);

      expect(result).toHaveLength(2);
      // Should be sorted by totalLamports descending
      expect(result[0].rank).toBe(1);
      expect(result[1].rank).toBe(2);
    });

    it('should calculate percentages correctly', async () => {
      const mints = [new PublicKey('So11111111111111111111111111111111111111112')];

      const mockData = Buffer.alloc(100);
      mints[0].toBuffer().copy(mockData, 8);
      mockData.writeBigUInt64LE(12345n, 72);
      mockData.writeBigUInt64LE(1000n, 80);
      mockData.writeBigUInt64LE(10n, 88);
      mockData.writeUInt16LE(100, 96);

      (mockConnection.getMultipleAccountsInfo as jest.Mock).mockResolvedValue([
        { data: mockData },
      ]);

      const result = await sdk.getLeaderboard(mints);

      expect(result).toHaveLength(1);
      expect(result[0].percentage).toBe(100); // Single contributor = 100%
    });
  });

  describe('getValidatorState', () => {
    it('should return null when account does not exist', async () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      (mockConnection.getAccountInfo as jest.Mock).mockResolvedValue(null);

      const result = await sdk.getValidatorState(mint);

      expect(result).toBeNull();
    });

    it('should parse and return validator state when account exists', async () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');

      // Layout: discriminator(8) + mint(32) + bonding_curve(32) +
      //         last_validated_slot(8) + total_validated_lamports(8) +
      //         total_validated_count(8) + fee_rate_bps(2) + bump(1)
      const mockData = Buffer.alloc(100);
      mint.toBuffer().copy(mockData, 8); // mint at 8
      mockData.writeBigUInt64LE(12345678n, 72); // lastValidatedSlot at 72
      mockData.writeBigUInt64LE(1000000000n, 80); // totalValidatedLamports at 80
      mockData.writeBigUInt64LE(5n, 88); // totalValidatedCount at 88
      mockData.writeUInt16LE(100, 96); // feeRateBps at 96
      mockData[98] = 255; // bump at 98

      (mockConnection.getAccountInfo as jest.Mock).mockResolvedValue({ data: mockData });

      const result = await sdk.getValidatorState(mint);

      expect(result).not.toBeNull();
      expect(result?.totalValidatedLamports).toBe(1000000000n);
      expect(result?.totalValidatedCount).toBe(5);
      expect(result?.feeRateBps).toBe(100);
    });
  });

  describe('getContribution', () => {
    it('should return null when validator state does not exist', async () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      (mockConnection.getAccountInfo as jest.Mock).mockResolvedValue(null);

      const result = await sdk.getContribution(mint);

      expect(result).toBeNull();
    });

    it('should return contribution data when state exists', async () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');

      const mockData = Buffer.alloc(100);
      mint.toBuffer().copy(mockData, 8);
      mockData.writeBigUInt64LE(12345678n, 72); // lastValidatedSlot
      mockData.writeBigUInt64LE(2000000000n, 80); // totalValidatedLamports (2 SOL)
      mockData.writeBigUInt64LE(10n, 88); // totalValidatedCount
      mockData.writeUInt16LE(150, 96); // feeRateBps

      (mockConnection.getAccountInfo as jest.Mock).mockResolvedValue({ data: mockData });

      const result = await sdk.getContribution(mint);

      expect(result).not.toBeNull();
      expect(result?.mint).toBe(mint.toBase58());
      expect(result?.totalLamports).toBe(2000000000n);
      expect(result?.totalSOL).toBe(2);
      expect(result?.validationCount).toBe(10);
      expect(result?.feeRateBps).toBe(150);
    });
  });

  describe('getContributions with actual data', () => {
    it('should return contributions for accounts that exist', async () => {
      const mint1 = new PublicKey('So11111111111111111111111111111111111111112');
      const mint2 = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

      const mockData1 = Buffer.alloc(100);
      mint1.toBuffer().copy(mockData1, 8);
      mockData1.writeBigUInt64LE(12345n, 72);
      mockData1.writeBigUInt64LE(1000000000n, 80);
      mockData1.writeBigUInt64LE(5n, 88);
      mockData1.writeUInt16LE(100, 96);

      const mockData2 = Buffer.alloc(100);
      mint2.toBuffer().copy(mockData2, 8);
      mockData2.writeBigUInt64LE(12346n, 72);
      mockData2.writeBigUInt64LE(2000000000n, 80);
      mockData2.writeBigUInt64LE(10n, 88);
      mockData2.writeUInt16LE(200, 96);

      (mockConnection.getMultipleAccountsInfo as jest.Mock).mockResolvedValue([
        { data: mockData1 },
        { data: mockData2 },
      ]);

      const result = await sdk.getContributions([mint1, mint2]);

      expect(result.size).toBe(2);
      expect(result.get(mint1.toBase58())?.totalSOL).toBe(1);
      expect(result.get(mint2.toBase58())?.totalSOL).toBe(2);
    });

    it('should skip accounts that do not exist', async () => {
      const mint1 = new PublicKey('So11111111111111111111111111111111111111112');
      const mint2 = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

      const mockData1 = Buffer.alloc(100);
      mint1.toBuffer().copy(mockData1, 8);
      mockData1.writeBigUInt64LE(12345n, 72);
      mockData1.writeBigUInt64LE(1000000000n, 80);
      mockData1.writeBigUInt64LE(5n, 88);
      mockData1.writeUInt16LE(100, 96);

      (mockConnection.getMultipleAccountsInfo as jest.Mock).mockResolvedValue([
        { data: mockData1 },
        null, // Second account doesn't exist
      ]);

      const result = await sdk.getContributions([mint1, mint2]);

      expect(result.size).toBe(1);
      expect(result.has(mint1.toBase58())).toBe(true);
      expect(result.has(mint2.toBase58())).toBe(false);
    });
  });

  describe('parseValidatorState', () => {
    it('should parse buffer into ValidatorState', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const bc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

      // Layout: discriminator(8) + mint(32) + bonding_curve(32) +
      //         last_validated_slot(8) + total_validated_lamports(8) +
      //         total_validated_count(8) + fee_rate_bps(2) + bump(1)
      const mockData = Buffer.alloc(100);
      mint.toBuffer().copy(mockData, 8); // mint at offset 8
      bc.toBuffer().copy(mockData, 40); // bondingCurve at offset 40
      mockData.writeBigUInt64LE(99999n, 72); // lastValidatedSlot at 72
      mockData.writeBigUInt64LE(5000000000n, 80); // totalValidatedLamports at 80
      mockData.writeBigUInt64LE(25n, 88); // totalValidatedCount at 88
      mockData.writeUInt16LE(250, 96); // feeRateBps at 96
      mockData[98] = 254; // bump at 98

      // Access internal method via bracket notation
      const state = (sdk as any).parseValidatorState(mockData);

      expect(state.totalValidatedLamports).toBe(5000000000n);
      expect(state.totalValidatedCount).toBe(25);
      expect(state.lastValidatedSlot).toBe(99999);
      expect(state.feeRateBps).toBe(250);
      expect(state.bump).toBe(254);
    });
  });
});
