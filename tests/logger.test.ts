import winston from 'winston';
import { logger, createLogger, logFee, logBalanceChange, logConnection, logRequest } from '../lib/logger';

// Mock winston
jest.mock('winston', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    child: jest.fn(),
    add: jest.fn(),
  };

  return {
    createLogger: jest.fn().mockReturnValue(mockLogger),
    format: {
      combine: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn().mockReturnValue(jest.fn()),
      colorize: jest.fn(),
      json: jest.fn(),
    },
    transports: {
      Console: jest.fn(),
      File: jest.fn(),
    },
  };
});

describe('Logger Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('logger', () => {
    it('should be a valid logger object', () => {
      // The logger is created when the module is first imported
      // Before our mock is set up, so we just verify it exists
      expect(logger).toBeDefined();
    });

    it('should be a valid winston logger instance', () => {
      expect(logger).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
    });
  });

  describe('createLogger', () => {
    it('should create a child logger with component name', () => {
      const mockChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(mockChild);

      const childLogger = createLogger('TestComponent');

      expect(logger.child).toHaveBeenCalledWith({ component: 'TestComponent' });
      expect(childLogger).toBe(mockChild);
    });

    it('should create different child loggers for different components', () => {
      const mockChild1 = { info: jest.fn() };
      const mockChild2 = { info: jest.fn() };

      (logger.child as jest.Mock)
        .mockReturnValueOnce(mockChild1)
        .mockReturnValueOnce(mockChild2);

      const logger1 = createLogger('Component1');
      const logger2 = createLogger('Component2');

      expect(logger1).not.toBe(logger2);
    });
  });

  describe('logFee', () => {
    let mockLogger: winston.Logger;

    beforeEach(() => {
      mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
      } as unknown as winston.Logger;
    });

    it('should log fee detection with amount and vault', () => {
      logFee(mockLogger, 1000000n, 'BC');

      expect(mockLogger.info).toHaveBeenCalledWith('Fee detected', {
        event: 'fee',
        amount: '1000000',
        vault: 'BC',
        mint: undefined,
        symbol: undefined,
      });
    });

    it('should log fee with mint and symbol when provided', () => {
      logFee(mockLogger, 5000000000n, 'AMM', 'mintAddress123', 'TEST');

      expect(mockLogger.info).toHaveBeenCalledWith('Fee detected', {
        event: 'fee',
        amount: '5000000000',
        vault: 'AMM',
        mint: 'mintAddress123',
        symbol: 'TEST',
      });
    });

    it('should convert bigint amount to string', () => {
      const bigAmount = 9876543210123456789n;
      logFee(mockLogger, bigAmount, 'BC');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Fee detected',
        expect.objectContaining({
          amount: '9876543210123456789',
        })
      );
    });
  });

  describe('logBalanceChange', () => {
    let mockLogger: winston.Logger;

    beforeEach(() => {
      mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
      } as unknown as winston.Logger;
    });

    it('should log balance increase', () => {
      logBalanceChange(mockLogger, 'BC', 1000000n, 2000000n);

      expect(mockLogger.info).toHaveBeenCalledWith('Balance changed', {
        event: 'balance_change',
        vault: 'BC',
        oldBalance: '1000000',
        newBalance: '2000000',
        delta: '1000000',
      });
    });

    it('should log balance decrease with negative delta', () => {
      logBalanceChange(mockLogger, 'AMM', 5000000n, 3000000n);

      expect(mockLogger.info).toHaveBeenCalledWith('Balance changed', {
        event: 'balance_change',
        vault: 'AMM',
        oldBalance: '5000000',
        newBalance: '3000000',
        delta: '-2000000',
      });
    });

    it('should handle zero balance change', () => {
      logBalanceChange(mockLogger, 'BC', 1000000n, 1000000n);

      expect(mockLogger.info).toHaveBeenCalledWith('Balance changed', {
        event: 'balance_change',
        vault: 'BC',
        oldBalance: '1000000',
        newBalance: '1000000',
        delta: '0',
      });
    });

    it('should convert large bigint values to strings', () => {
      const oldBalance = 123456789012345678901n;
      const newBalance = 234567890123456789012n;

      logBalanceChange(mockLogger, 'BC', oldBalance, newBalance);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Balance changed',
        expect.objectContaining({
          oldBalance: '123456789012345678901',
          newBalance: '234567890123456789012',
        })
      );
    });
  });

  describe('logConnection', () => {
    let mockLogger: winston.Logger;

    beforeEach(() => {
      mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
      } as unknown as winston.Logger;
    });

    it('should log websocket connected status', () => {
      logConnection(mockLogger, 'websocket', 'connected');

      expect(mockLogger.log).toHaveBeenCalledWith('info', 'websocket connected', {
        event: 'connection',
        connectionType: 'websocket',
        status: 'connected',
        details: undefined,
      });
    });

    it('should log rpc disconnected status', () => {
      logConnection(mockLogger, 'rpc', 'disconnected');

      expect(mockLogger.log).toHaveBeenCalledWith('info', 'rpc disconnected', {
        event: 'connection',
        connectionType: 'rpc',
        status: 'disconnected',
        details: undefined,
      });
    });

    it('should log error status at error level', () => {
      logConnection(mockLogger, 'websocket', 'error', 'Connection refused');

      expect(mockLogger.log).toHaveBeenCalledWith('error', 'websocket error', {
        event: 'connection',
        connectionType: 'websocket',
        status: 'error',
        details: 'Connection refused',
      });
    });

    it('should include details when provided', () => {
      logConnection(mockLogger, 'rpc', 'connected', 'Primary RPC endpoint');

      expect(mockLogger.log).toHaveBeenCalledWith('info', 'rpc connected', {
        event: 'connection',
        connectionType: 'rpc',
        status: 'connected',
        details: 'Primary RPC endpoint',
      });
    });
  });

  describe('logRequest', () => {
    let mockLogger: winston.Logger;

    beforeEach(() => {
      mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
      } as unknown as winston.Logger;
    });

    it('should log successful request at info level', () => {
      logRequest(mockLogger, 'GET', '/api/stats', 200, 45);

      expect(mockLogger.log).toHaveBeenCalledWith('info', 'GET /api/stats 200', {
        event: 'http_request',
        method: 'GET',
        path: '/api/stats',
        statusCode: 200,
        durationMs: 45,
        ip: undefined,
      });
    });

    it('should log 4xx request at warn level', () => {
      logRequest(mockLogger, 'POST', '/api/tokens', 400, 12);

      expect(mockLogger.log).toHaveBeenCalledWith('warn', 'POST /api/tokens 400', {
        event: 'http_request',
        method: 'POST',
        path: '/api/tokens',
        statusCode: 400,
        durationMs: 12,
        ip: undefined,
      });
    });

    it('should log 404 at warn level', () => {
      logRequest(mockLogger, 'GET', '/notfound', 404, 5);

      expect(mockLogger.log).toHaveBeenCalledWith('warn', 'GET /notfound 404', {
        event: 'http_request',
        method: 'GET',
        path: '/notfound',
        statusCode: 404,
        durationMs: 5,
        ip: undefined,
      });
    });

    it('should log 5xx request at error level', () => {
      logRequest(mockLogger, 'GET', '/api/health', 500, 1500);

      expect(mockLogger.log).toHaveBeenCalledWith('error', 'GET /api/health 500', {
        event: 'http_request',
        method: 'GET',
        path: '/api/health',
        statusCode: 500,
        durationMs: 1500,
        ip: undefined,
      });
    });

    it('should log 503 at error level', () => {
      logRequest(mockLogger, 'GET', '/api/data', 503, 30000);

      expect(mockLogger.log).toHaveBeenCalledWith('error', 'GET /api/data 503', {
        event: 'http_request',
        method: 'GET',
        path: '/api/data',
        statusCode: 503,
        durationMs: 30000,
        ip: undefined,
      });
    });

    it('should include IP when provided', () => {
      logRequest(mockLogger, 'GET', '/api/stats', 200, 45, '192.168.1.1');

      expect(mockLogger.log).toHaveBeenCalledWith('info', 'GET /api/stats 200', {
        event: 'http_request',
        method: 'GET',
        path: '/api/stats',
        statusCode: 200,
        durationMs: 45,
        ip: '192.168.1.1',
      });
    });

    it('should handle different HTTP methods', () => {
      logRequest(mockLogger, 'DELETE', '/api/tokens/123', 204, 100);

      expect(mockLogger.log).toHaveBeenCalledWith('info', 'DELETE /api/tokens/123 204', expect.any(Object));
    });
  });
});

describe('Logger Integration', () => {
  it('should export all required functions', () => {
    expect(logger).toBeDefined();
    expect(createLogger).toBeDefined();
    expect(logFee).toBeDefined();
    expect(logBalanceChange).toBeDefined();
    expect(logConnection).toBeDefined();
    expect(logRequest).toBeDefined();
  });

  it('should export logger as default', async () => {
    const defaultExport = await import('../lib/logger');
    expect(defaultExport.default).toBeDefined();
  });
});
