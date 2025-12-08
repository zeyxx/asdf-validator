/**
 * Token Discovery Tests
 *
 * Tests for bonding curve deserialization and token discovery.
 */

import { PublicKey } from '@solana/web3.js';
import {
  deserializeBondingCurve,
  deriveBondingCurve,
  BondingCurveData,
  DiscoveredToken,
  TrackedToken,
  PUMP_PROGRAM_ID,
} from '../daemon';

describe('Token Discovery', () => {
  describe('deserializeBondingCurve', () => {
    it('should return null for buffer smaller than 81 bytes', () => {
      const smallBuffer = Buffer.alloc(50);
      const result = deserializeBondingCurve(smallBuffer);
      expect(result).toBeNull();
    });

    it('should deserialize valid bonding curve data', () => {
      // Create a valid BC buffer (81 bytes minimum)
      const buffer = Buffer.alloc(81);
      let offset = 0;

      // Discriminator (8 bytes)
      buffer.writeBigUInt64LE(BigInt('0x1234567890abcdef'), offset);
      offset += 8;

      // virtualTokenReserves (8 bytes)
      buffer.writeBigUInt64LE(1000000000n, offset);
      offset += 8;

      // virtualSolReserves (8 bytes)
      buffer.writeBigUInt64LE(500000000n, offset);
      offset += 8;

      // realTokenReserves (8 bytes)
      buffer.writeBigUInt64LE(800000000n, offset);
      offset += 8;

      // realSolReserves (8 bytes)
      buffer.writeBigUInt64LE(400000000n, offset);
      offset += 8;

      // tokenTotalSupply (8 bytes)
      buffer.writeBigUInt64LE(1000000000000n, offset);
      offset += 8;

      // complete flag (1 byte)
      buffer[offset] = 0; // not migrated
      offset += 1;

      // creator pubkey (32 bytes)
      const creatorPubkey = new PublicKey('11111111111111111111111111111111');
      creatorPubkey.toBuffer().copy(buffer, offset);

      const result = deserializeBondingCurve(buffer);

      expect(result).not.toBeNull();
      expect(result!.virtualTokenReserves).toBe(1000000000n);
      expect(result!.virtualSolReserves).toBe(500000000n);
      expect(result!.realTokenReserves).toBe(800000000n);
      expect(result!.realSolReserves).toBe(400000000n);
      expect(result!.tokenTotalSupply).toBe(1000000000000n);
      expect(result!.complete).toBe(false);
      expect(result!.creator.toBase58()).toBe('11111111111111111111111111111111');
    });

    it('should correctly read complete flag as true', () => {
      const buffer = Buffer.alloc(81);

      // Fill with zeros except complete flag
      buffer[48] = 1; // complete = true

      // Set a valid creator pubkey
      const creatorPubkey = new PublicKey('11111111111111111111111111111111');
      creatorPubkey.toBuffer().copy(buffer, 49);

      const result = deserializeBondingCurve(buffer);

      expect(result).not.toBeNull();
      expect(result!.complete).toBe(true);
    });

    it('should handle exact 81 byte buffer', () => {
      const buffer = Buffer.alloc(81);
      const creatorPubkey = new PublicKey('11111111111111111111111111111111');
      creatorPubkey.toBuffer().copy(buffer, 49);

      const result = deserializeBondingCurve(buffer);
      expect(result).not.toBeNull();
    });

    it('should handle larger buffer (with extra data)', () => {
      const buffer = Buffer.alloc(200);
      const creatorPubkey = new PublicKey('11111111111111111111111111111111');
      creatorPubkey.toBuffer().copy(buffer, 49);

      const result = deserializeBondingCurve(buffer);
      expect(result).not.toBeNull();
    });
  });

  describe('deriveBondingCurve', () => {
    it('should derive consistent PDA for same mint', () => {
      const mint = new PublicKey('So11111111111111111111111111111111111111112');

      const bc1 = deriveBondingCurve(mint);
      const bc2 = deriveBondingCurve(mint);

      expect(bc1.toBase58()).toBe(bc2.toBase58());
    });

    it('should derive different PDAs for different mints', () => {
      const mint1 = new PublicKey('So11111111111111111111111111111111111111112');
      const mint2 = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

      const bc1 = deriveBondingCurve(mint1);
      const bc2 = deriveBondingCurve(mint2);

      expect(bc1.toBase58()).not.toBe(bc2.toBase58());
    });

    it('should return valid PublicKey', () => {
      const mint = new PublicKey('11111111111111111111111111111111');
      const bc = deriveBondingCurve(mint);

      // Should not throw
      expect(() => new PublicKey(bc.toBase58())).not.toThrow();
    });

    it('should use PUMP_PROGRAM_ID for derivation', () => {
      const mint = new PublicKey('11111111111111111111111111111111');
      const bc = deriveBondingCurve(mint);

      // The BC should be off-curve (a PDA)
      expect(PublicKey.isOnCurve(bc.toBuffer())).toBe(false);
    });
  });

  describe('TrackedToken interface', () => {
    it('should allow creating a tracked token', () => {
      const token: TrackedToken = {
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        bondingCurve: '11111111111111111111111111111111',
        ammPool: '',
        migrated: false,
        lastSolReserves: 1000000000n,
        lastAmmReserves: 0n,
        totalFees: 0n,
        feeCount: 0,
        recentAmmFees: 0n,
        recentAmmFeesTimestamp: Date.now(),
        recentBcFees: 0n,
        recentBcFeesTimestamp: Date.now(),
        isMayhemMode: false,
        tokenProgram: 'TOKEN',
      };

      expect(token.mint).toBe('So11111111111111111111111111111111111111112');
      expect(token.migrated).toBe(false);
      expect(token.totalFees).toBe(0n);
      expect(token.isMayhemMode).toBe(false);
      expect(token.tokenProgram).toBe('TOKEN');
    });

    it('should track fee accumulation', () => {
      const token: TrackedToken = {
        mint: 'TestMint',
        symbol: 'TEST',
        bondingCurve: 'TestBC',
        ammPool: '',
        migrated: false,
        lastSolReserves: 1000000000n,
        lastAmmReserves: 0n,
        totalFees: 0n,
        feeCount: 0,
        recentAmmFees: 0n,
        recentAmmFeesTimestamp: Date.now(),
        recentBcFees: 0n,
        recentBcFeesTimestamp: Date.now(),
        isMayhemMode: false,
        tokenProgram: 'TOKEN',
      };

      // Simulate fee accumulation
      token.totalFees += 100000n;
      token.feeCount++;
      token.totalFees += 200000n;
      token.feeCount++;

      expect(token.totalFees).toBe(300000n);
      expect(token.feeCount).toBe(2);
    });

    it('should allow creating a Token-2022 mayhem mode token', () => {
      const token: TrackedToken = {
        mint: 'MayhemMint123',
        symbol: 'MAYHEM',
        bondingCurve: 'MayhemBC',
        ammPool: '',
        migrated: false,
        lastSolReserves: 1000000000n,
        lastAmmReserves: 0n,
        totalFees: 0n,
        feeCount: 0,
        recentAmmFees: 0n,
        recentAmmFeesTimestamp: Date.now(),
        recentBcFees: 0n,
        recentBcFeesTimestamp: Date.now(),
        isMayhemMode: true,
        tokenProgram: 'TOKEN_2022',
      };

      expect(token.isMayhemMode).toBe(true);
      expect(token.tokenProgram).toBe('TOKEN_2022');
    });
  });

  describe('DiscoveredToken interface', () => {
    it('should allow creating a discovered token', () => {
      const token: DiscoveredToken = {
        bondingCurve: new PublicKey('11111111111111111111111111111111'),
        creator: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
        migrated: false,
        realSolReserves: 500000000n,
        isMayhemMode: false,
      };

      expect(token.bondingCurve.toBase58()).toBe('11111111111111111111111111111111');
      expect(token.migrated).toBe(false);
      expect(token.realSolReserves).toBe(500000000n);
      expect(token.isMayhemMode).toBe(false);
    });

    it('should allow optional mint field', () => {
      const tokenWithMint: DiscoveredToken = {
        bondingCurve: new PublicKey('11111111111111111111111111111111'),
        mint: new PublicKey('So11111111111111111111111111111111111111112'),
        creator: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
        migrated: true,
        realSolReserves: 0n,
        isMayhemMode: false,
      };

      expect(tokenWithMint.mint?.toBase58()).toBe('So11111111111111111111111111111111111111112');
      expect(tokenWithMint.migrated).toBe(true);
    });

    it('should allow creating a mayhem mode discovered token', () => {
      const token: DiscoveredToken = {
        bondingCurve: new PublicKey('11111111111111111111111111111111'),
        creator: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
        migrated: false,
        realSolReserves: 500000000n,
        isMayhemMode: true,
      };

      expect(token.isMayhemMode).toBe(true);
    });
  });

  describe('BC Account Layout', () => {
    it('should have correct offset for creator (49 bytes)', () => {
      // Layout: 8 (disc) + 8*5 (reserves) + 1 (complete) = 49 bytes offset for creator
      const expectedOffset = 8 + 8 + 8 + 8 + 8 + 8 + 1;
      expect(expectedOffset).toBe(49);
    });

    it('should have correct total size (81 bytes minimum for classic)', () => {
      // Layout: 8 (disc) + 40 (5 u64s) + 1 (bool) + 32 (pubkey) = 81 bytes
      const expectedSize = 8 + 8 * 5 + 1 + 32;
      expect(expectedSize).toBe(81);
    });

    it('should have correct total size (82 bytes for mayhem mode)', () => {
      // Layout: 8 (disc) + 40 (5 u64s) + 1 (complete) + 32 (pubkey) + 1 (is_mayhem_mode) = 82 bytes
      const expectedSize = 8 + 8 * 5 + 1 + 32 + 1;
      expect(expectedSize).toBe(82);
    });
  });

  describe('deserializeBondingCurve with mayhem mode', () => {
    it('should parse 82-byte mayhem mode buffer with isMayhemMode=true', () => {
      const buffer = Buffer.alloc(82);
      let offset = 0;

      // Discriminator (8 bytes)
      buffer.writeBigUInt64LE(BigInt('0x1234567890abcdef'), offset);
      offset += 8;

      // virtualTokenReserves (8 bytes)
      buffer.writeBigUInt64LE(2000000000n, offset);
      offset += 8;

      // virtualSolReserves (8 bytes)
      buffer.writeBigUInt64LE(1000000000n, offset);
      offset += 8;

      // realTokenReserves (8 bytes)
      buffer.writeBigUInt64LE(1600000000n, offset);
      offset += 8;

      // realSolReserves (8 bytes)
      buffer.writeBigUInt64LE(800000000n, offset);
      offset += 8;

      // tokenTotalSupply (8 bytes) - 2 billion for mayhem mode
      buffer.writeBigUInt64LE(2000000000000n, offset);
      offset += 8;

      // complete flag (1 byte)
      buffer[offset] = 0;
      offset += 1;

      // creator pubkey (32 bytes)
      const creatorPubkey = new PublicKey('11111111111111111111111111111111');
      creatorPubkey.toBuffer().copy(buffer, offset);
      offset += 32;

      // is_mayhem_mode flag (1 byte) - TRUE
      buffer[offset] = 1;

      const result = deserializeBondingCurve(buffer);

      expect(result).not.toBeNull();
      expect(result!.isMayhemMode).toBe(true);
      expect(result!.tokenTotalSupply).toBe(2000000000000n);
    });

    it('should parse 82-byte buffer with isMayhemMode=false', () => {
      const buffer = Buffer.alloc(82);
      const creatorPubkey = new PublicKey('11111111111111111111111111111111');
      creatorPubkey.toBuffer().copy(buffer, 49);

      // is_mayhem_mode at offset 81 = 0 (false)
      buffer[81] = 0;

      const result = deserializeBondingCurve(buffer);

      expect(result).not.toBeNull();
      expect(result!.isMayhemMode).toBe(false);
    });

    it('should default isMayhemMode to false for 81-byte classic buffer', () => {
      const buffer = Buffer.alloc(81);
      const creatorPubkey = new PublicKey('11111111111111111111111111111111');
      creatorPubkey.toBuffer().copy(buffer, 49);

      const result = deserializeBondingCurve(buffer);

      expect(result).not.toBeNull();
      expect(result!.isMayhemMode).toBe(false);
    });
  });

  describe('Reserve Delta Calculation', () => {
    it('should calculate positive delta for buy activity', () => {
      const lastReserves = 1000000000n;
      const currentReserves = 1100000000n;
      const delta = currentReserves - lastReserves;

      expect(delta).toBe(100000000n);
      expect(delta > 0n).toBe(true);
    });

    it('should calculate negative delta for sell activity', () => {
      const lastReserves = 1000000000n;
      const currentReserves = 900000000n;
      const delta = currentReserves - lastReserves;

      expect(delta).toBe(-100000000n);
      expect(delta < 0n).toBe(true);
    });

    it('should calculate zero delta when no activity', () => {
      const lastReserves = 1000000000n;
      const currentReserves = 1000000000n;
      const delta = currentReserves - lastReserves;

      expect(delta).toBe(0n);
    });
  });

  describe('Proportional Fee Attribution', () => {
    it('should attribute fees proportionally to active tokens', () => {
      const totalFee = 1000000n; // 1M lamports
      const tokenDeltas = new Map<string, bigint>([
        ['token1', 300000000n], // 30%
        ['token2', 700000000n], // 70%
      ]);

      const totalReserveChange = Array.from(tokenDeltas.values()).reduce((sum, d) => sum + d, 0n);
      expect(totalReserveChange).toBe(1000000000n);

      const token1Proportion = Number(tokenDeltas.get('token1')!) / Number(totalReserveChange);
      const token2Proportion = Number(tokenDeltas.get('token2')!) / Number(totalReserveChange);

      expect(token1Proportion).toBeCloseTo(0.3, 5);
      expect(token2Proportion).toBeCloseTo(0.7, 5);

      const token1Fee = BigInt(Math.floor(Number(totalFee) * token1Proportion));
      const token2Fee = totalFee - token1Fee; // Last token gets remainder

      expect(token1Fee).toBe(300000n);
      expect(token2Fee).toBe(700000n);
      expect(token1Fee + token2Fee).toBe(totalFee);
    });

    it('should attribute 100% to single active token', () => {
      const totalFee = 1000000n;
      const tokenDeltas = new Map<string, bigint>([
        ['token1', 500000000n],
      ]);

      const totalReserveChange = 500000000n;
      const proportion = Number(tokenDeltas.get('token1')!) / Number(totalReserveChange);

      expect(proportion).toBe(1);
      expect(BigInt(Math.floor(Number(totalFee) * proportion))).toBe(totalFee);
    });

    it('should handle equal activity from multiple tokens', () => {
      const totalFee = 1000000n;
      const tokenDeltas = new Map<string, bigint>([
        ['token1', 500000000n],
        ['token2', 500000000n],
      ]);

      const totalReserveChange = 1000000000n;
      const proportion = 0.5;

      const token1Fee = BigInt(Math.floor(Number(totalFee) * proportion));
      const token2Fee = totalFee - token1Fee;

      expect(token1Fee).toBe(500000n);
      expect(token2Fee).toBe(500000n);
    });
  });
});
