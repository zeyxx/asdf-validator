/**
 * Input Validation Tests
 *
 * Tests for URL, address, and config validation functions.
 */

import {
  validateRpcUrl,
  validateSolanaAddress,
  validateTokenConfig,
  validateHistoryLog,
  validatePollInterval,
  GENESIS_HASH,
  TRUSTED_RPC_DOMAINS,
} from '../daemon';

describe('Input Validation', () => {
  describe('validateRpcUrl', () => {
    it('should accept valid HTTPS URL', () => {
      const result = validateRpcUrl('https://api.mainnet-beta.solana.com');
      expect(result.valid).toBe(true);
    });

    it('should accept valid HTTP URL (non-localhost)', () => {
      const result = validateRpcUrl('http://example-rpc.com:8899');
      expect(result.valid).toBe(true);
    });

    it('should reject localhost URLs (SSRF protection)', () => {
      const result = validateRpcUrl('http://localhost:8899');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('internal/private');
    });

    it('should reject private IP addresses', () => {
      expect(validateRpcUrl('http://192.168.1.1').valid).toBe(false);
      expect(validateRpcUrl('http://10.0.0.1').valid).toBe(false);
      expect(validateRpcUrl('http://172.16.0.1').valid).toBe(false);
      expect(validateRpcUrl('http://127.0.0.1').valid).toBe(false);
    });

    it('should accept URL with port', () => {
      const result = validateRpcUrl('https://rpc.helius.xyz:8899');
      expect(result.valid).toBe(true);
    });

    it('should accept URL with path', () => {
      const result = validateRpcUrl('https://rpc.helius.xyz/v1/mainnet');
      expect(result.valid).toBe(true);
    });

    it('should reject empty URL', () => {
      const result = validateRpcUrl('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject non-string URL', () => {
      const result = validateRpcUrl(null as any);
      expect(result.valid).toBe(false);
    });

    it('should reject invalid URL format', () => {
      const result = validateRpcUrl('not-a-url');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('should reject non-http protocols', () => {
      const result = validateRpcUrl('ftp://example.com');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('protocol');
    });

    it('should reject ws protocol', () => {
      const result = validateRpcUrl('wss://api.mainnet-beta.solana.com');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('protocol');
    });

    describe('strict mode', () => {
      it('should accept trusted domain in strict mode', () => {
        const result = validateRpcUrl('https://api.mainnet-beta.solana.com', { strict: true });
        expect(result.valid).toBe(true);
      });

      it('should accept subdomain of trusted domain', () => {
        const result = validateRpcUrl('https://my-app.rpc.helius.xyz', { strict: true });
        expect(result.valid).toBe(true);
      });

      it('should reject unknown domain in strict mode', () => {
        const result = validateRpcUrl('https://unknown-rpc.example.com', { strict: true });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('trusted list');
      });

      it('should accept custom domain with additionalDomains', () => {
        const result = validateRpcUrl('https://my-custom-rpc.io', {
          strict: true,
          additionalDomains: ['my-custom-rpc.io']
        });
        expect(result.valid).toBe(true);
      });

      it('should have correct trusted domains count', () => {
        expect(TRUSTED_RPC_DOMAINS.length).toBeGreaterThan(5);
        expect(TRUSTED_RPC_DOMAINS).toContain('api.mainnet-beta.solana.com');
        expect(TRUSTED_RPC_DOMAINS).toContain('rpc.helius.xyz');
      });
    });
  });

  describe('validateSolanaAddress', () => {
    it('should accept valid Solana address', () => {
      const result = validateSolanaAddress('11111111111111111111111111111111');
      expect(result.valid).toBe(true);
    });

    it('should accept valid 44-char address', () => {
      const result = validateSolanaAddress('So11111111111111111111111111111111111111112');
      expect(result.valid).toBe(true);
    });

    it('should accept valid program ID', () => {
      const result = validateSolanaAddress('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
      expect(result.valid).toBe(true);
    });

    it('should reject empty address', () => {
      const result = validateSolanaAddress('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject non-string address', () => {
      const result = validateSolanaAddress(123 as any);
      expect(result.valid).toBe(false);
    });

    it('should reject address with invalid characters', () => {
      const result = validateSolanaAddress('0OIl1111111111111111111111111111'); // 0, O, I, l are invalid
      expect(result.valid).toBe(false);
      expect(result.error).toContain('base58');
    });

    it('should reject too short address', () => {
      const result = validateSolanaAddress('1111111111111111111111111111111'); // 31 chars
      expect(result.valid).toBe(false);
      expect(result.error).toContain('32-44');
    });

    it('should reject too long address', () => {
      const result = validateSolanaAddress('111111111111111111111111111111111111111111111'); // 45 chars
      expect(result.valid).toBe(false);
      expect(result.error).toContain('32-44');
    });
  });

  describe('validateTokenConfig', () => {
    const validMint = 'So11111111111111111111111111111111111111112';
    const validBc = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

    it('should accept valid token config', () => {
      const result = validateTokenConfig({
        mint: validMint,
        symbol: 'TEST',
        bondingCurve: validBc,
        poolType: 'bonding_curve',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept config with name instead of symbol', () => {
      const result = validateTokenConfig({
        mint: validMint,
        name: 'Test Token',
        bondingCurve: validBc,
      });
      expect(result.valid).toBe(true);
    });

    it('should accept config with pool instead of bondingCurve', () => {
      const result = validateTokenConfig({
        mint: validMint,
        symbol: 'TEST',
        pool: validBc,
      });
      expect(result.valid).toBe(true);
    });

    it('should accept pumpswap_amm poolType', () => {
      const result = validateTokenConfig({
        mint: validMint,
        symbol: 'TEST',
        bondingCurve: validBc,
        poolType: 'pumpswap_amm',
      });
      expect(result.valid).toBe(true);
    });

    it('should reject null config', () => {
      const result = validateTokenConfig(null);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('object');
    });

    it('should reject config without mint', () => {
      const result = validateTokenConfig({
        symbol: 'TEST',
        bondingCurve: validBc,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('mint');
    });

    it('should reject config with invalid mint', () => {
      const result = validateTokenConfig({
        mint: 'invalid',
        symbol: 'TEST',
        bondingCurve: validBc,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('mint');
    });

    it('should reject config without symbol or name', () => {
      const result = validateTokenConfig({
        mint: validMint,
        bondingCurve: validBc,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('symbol');
    });

    it('should reject config without bondingCurve or pool', () => {
      const result = validateTokenConfig({
        mint: validMint,
        symbol: 'TEST',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('bondingCurve');
    });

    it('should reject invalid poolType', () => {
      const result = validateTokenConfig({
        mint: validMint,
        symbol: 'TEST',
        bondingCurve: validBc,
        poolType: 'invalid_type',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('poolType');
    });
  });

  describe('validateHistoryLog', () => {
    const validCreator = '11111111111111111111111111111111';

    const validLog = {
      version: '1.0.0',
      creator: validCreator,
      bcVault: validCreator,
      ammVault: validCreator,
      startedAt: '2023-01-01T00:00:00.000Z',
      lastUpdated: '2023-01-02T00:00:00.000Z',
      totalFees: '1000000000',
      entryCount: 0,
      latestHash: GENESIS_HASH,
      entries: [],
    };

    it('should accept valid history log', () => {
      const result = validateHistoryLog(validLog);
      expect(result.valid).toBe(true);
    });

    it('should reject null log', () => {
      const result = validateHistoryLog(null);
      expect(result.valid).toBe(false);
    });

    it('should reject log missing version', () => {
      const { version, ...invalid } = validLog;
      const result = validateHistoryLog(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('version');
    });

    it('should reject log missing creator', () => {
      const { creator, ...invalid } = validLog;
      const result = validateHistoryLog(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('creator');
    });

    it('should reject log missing entries', () => {
      const { entries, ...invalid } = validLog;
      const result = validateHistoryLog(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('entries');
    });

    it('should reject log with non-array entries', () => {
      const result = validateHistoryLog({ ...validLog, entries: 'not-array' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('array');
    });

    it('should reject log with non-number entryCount', () => {
      const result = validateHistoryLog({ ...validLog, entryCount: '5' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('number');
    });

    it('should reject log with invalid creator address', () => {
      const result = validateHistoryLog({ ...validLog, creator: 'invalid' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('creator');
    });
  });

  describe('validatePollInterval', () => {
    it('should accept valid interval (5000ms)', () => {
      const result = validatePollInterval(5000);
      expect(result.valid).toBe(true);
    });

    it('should accept minimum interval (1000ms)', () => {
      const result = validatePollInterval(1000);
      expect(result.valid).toBe(true);
    });

    it('should accept maximum interval (300000ms)', () => {
      const result = validatePollInterval(300000);
      expect(result.valid).toBe(true);
    });

    it('should reject too short interval', () => {
      const result = validatePollInterval(500);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 1000ms');
    });

    it('should reject too long interval', () => {
      const result = validatePollInterval(600000);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceed');
    });

    it('should reject non-number interval', () => {
      const result = validatePollInterval('5000' as any);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('number');
    });

    it('should reject NaN', () => {
      const result = validatePollInterval(NaN);
      expect(result.valid).toBe(false);
    });
  });
});
