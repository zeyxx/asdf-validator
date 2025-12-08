/**
 * ValidatorDaemon Tests
 *
 * Tests for daemon functionality including vault derivation and token stats.
 */

import { PublicKey } from '@solana/web3.js';
import {
  ValidatorDaemon,
  deriveBondingCurveVault,
  derivePumpSwapVault,
  PUMP_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  TokenConfig,
  TokenStats,
} from '../daemon';

describe('Vault Derivation', () => {
  describe('deriveBondingCurveVault', () => {
    it('should derive consistent vault for same creator', () => {
      const creator = new PublicKey('11111111111111111111111111111111');

      const vault1 = deriveBondingCurveVault(creator);
      const vault2 = deriveBondingCurveVault(creator);

      expect(vault1.equals(vault2)).toBe(true);
    });

    it('should derive different vaults for different creators', () => {
      const creator1 = new PublicKey('11111111111111111111111111111111');
      const creator2 = new PublicKey('So11111111111111111111111111111111111111112');

      const vault1 = deriveBondingCurveVault(creator1);
      const vault2 = deriveBondingCurveVault(creator2);

      expect(vault1.equals(vault2)).toBe(false);
    });

    it('should return valid PublicKey', () => {
      const creator = new PublicKey('11111111111111111111111111111111');
      const vault = deriveBondingCurveVault(creator);

      expect(vault).toBeInstanceOf(PublicKey);
      expect(vault.toBase58()).toHaveLength(44); // Base58 pubkey length
    });
  });

  describe('derivePumpSwapVault', () => {
    it('should derive consistent vault for same creator', () => {
      const creator = new PublicKey('11111111111111111111111111111111');

      const vault1 = derivePumpSwapVault(creator);
      const vault2 = derivePumpSwapVault(creator);

      expect(vault1.equals(vault2)).toBe(true);
    });

    it('should derive different vaults for different creators', () => {
      const creator1 = new PublicKey('11111111111111111111111111111111');
      const creator2 = new PublicKey('So11111111111111111111111111111111111111112');

      const vault1 = derivePumpSwapVault(creator1);
      const vault2 = derivePumpSwapVault(creator2);

      expect(vault1.equals(vault2)).toBe(false);
    });

    it('should derive different vault than BC for same creator', () => {
      const creator = new PublicKey('11111111111111111111111111111111');

      const bcVault = deriveBondingCurveVault(creator);
      const ammVault = derivePumpSwapVault(creator);

      // Different programs and seeds = different vaults
      expect(bcVault.equals(ammVault)).toBe(false);
    });
  });
});

describe('ValidatorDaemon', () => {
  // Note: Full daemon tests require mocking RPC calls
  // These tests focus on configuration and state management

  describe('Configuration', () => {
    it('should accept minimal configuration', () => {
      const config = {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      };

      // Should not throw
      const daemon = new ValidatorDaemon(config);
      expect(daemon.isRunning()).toBe(false);
    });

    it('should accept full configuration', () => {
      const tokens: TokenConfig[] = [
        {
          mint: 'So11111111111111111111111111111111111111112',
          symbol: 'TEST',
          bondingCurve: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          poolType: 'bonding_curve',
        },
      ];

      const onFeeDetected = jest.fn();
      const onStats = jest.fn();
      const onHistoryEntry = jest.fn();

      const config = {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        tokens,
        pollInterval: 3000,
        statsInterval: 30000,
        verbose: true,
        historyFile: '/tmp/test-history.json',
        onFeeDetected,
        onStats,
        onHistoryEntry,
      };

      const daemon = new ValidatorDaemon(config);
      expect(daemon.isRunning()).toBe(false);
    });

    it('should throw for invalid creator address', () => {
      const config = {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: 'invalid-address',
      };

      expect(() => new ValidatorDaemon(config)).toThrow();
    });
  });

  describe('Token Management', () => {
    it('should start with empty stats when no tokens configured', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      const stats = daemon.getStats();
      expect(stats).toHaveLength(0);
    });

    it('should initialize stats for configured tokens', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        tokens: [
          {
            mint: 'So11111111111111111111111111111111111111112',
            symbol: 'TOKEN1',
            bondingCurve: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            poolType: 'bonding_curve',
          },
          {
            mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            symbol: 'TOKEN2',
            bondingCurve: 'So11111111111111111111111111111111111111112',
            poolType: 'pumpswap_amm',
          },
        ],
      });

      const stats = daemon.getStats();
      expect(stats).toHaveLength(2);
      expect(stats[0].symbol).toBe('TOKEN1');
      expect(stats[1].symbol).toBe('TOKEN2');
      expect(stats[0].totalFees).toBe(0n);
      expect(stats[0].feeCount).toBe(0);
    });

    it('should allow adding tokens after creation', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      daemon.addToken({
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'ADDED',
        bondingCurve: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        poolType: 'bonding_curve',
      });

      const stats = daemon.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].symbol).toBe('ADDED');
    });
  });

  describe('Total Fees', () => {
    it('should return 0n when no fees tracked', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      expect(daemon.getTotalFees()).toBe(0n);
    });
  });

  describe('History Management', () => {
    it('should return undefined history when not enabled', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      expect(daemon.getHistoryLog()).toBeUndefined();
      expect(daemon.getHistoryFilePath()).toBeUndefined();
    });

    it('should initialize history when file path provided', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        historyFile: '/tmp/test-history-daemon.json',
      });

      const history = daemon.getHistoryLog();
      expect(history).toBeDefined();
      expect(history?.version).toBe('1.0.0');
      expect(history?.entries).toHaveLength(0);
      expect(daemon.getHistoryFilePath()).toBe('/tmp/test-history-daemon.json');
    });

    it('should fail verification when history not enabled', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      const result = daemon.verifyHistory();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not enabled');
    });

    it('should pass verification for empty history', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
        historyFile: '/tmp/test-history-verify.json',
      });

      const result = daemon.verifyHistory();
      expect(result.valid).toBe(true);
    });
  });

  describe('Lifecycle', () => {
    it('should not be running initially', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      expect(daemon.isRunning()).toBe(false);
    });

    it('should stop gracefully when not running', () => {
      const daemon = new ValidatorDaemon({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        creatorAddress: '11111111111111111111111111111111',
      });

      // Should not throw
      daemon.stop();
      expect(daemon.isRunning()).toBe(false);
    });
  });
});

describe('Program IDs', () => {
  it('should export PUMP_PROGRAM_ID', () => {
    expect(PUMP_PROGRAM_ID).toBeInstanceOf(PublicKey);
    expect(PUMP_PROGRAM_ID.toBase58()).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  });

  it('should export PUMPSWAP_PROGRAM_ID', () => {
    expect(PUMPSWAP_PROGRAM_ID).toBeInstanceOf(PublicKey);
    expect(PUMPSWAP_PROGRAM_ID.toBase58()).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  });
});
