/**
 * Network Resilience Tests
 *
 * Tests for retry logic, circuit breaker, and health checks.
 */

import {
  fetchWithRetry,
  CircuitBreaker,
  RetryConfig,
} from '../daemon';

describe('Network Resilience', () => {
  describe('fetchWithRetry', () => {
    it('should return result on first successful attempt', async () => {
      const fn = jest.fn().mockResolvedValue('success');

      const result = await fetchWithRetry(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('First fail'))
        .mockRejectedValueOnce(new Error('Second fail'))
        .mockResolvedValue('success');

      const config: RetryConfig = {
        maxRetries: 3,
        baseDelayMs: 10, // Short delay for tests
        maxDelayMs: 50,
      };

      const result = await fetchWithRetry(fn, config);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries exhausted', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Always fails'));

      const config: RetryConfig = {
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
      };

      await expect(fetchWithRetry(fn, config)).rejects.toThrow('Always fails');
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should call onRetry callback on each retry', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');

      const onRetry = jest.fn();
      const config: RetryConfig = {
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
      };

      await fetchWithRetry(fn, config, onRetry);

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), expect.any(Number));
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), expect.any(Number));
    });

    it('should respect maxDelayMs', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValue('success');

      const onRetry = jest.fn();
      const config: RetryConfig = {
        maxRetries: 1,
        baseDelayMs: 100000, // Very long base delay
        maxDelayMs: 20, // But capped at 20ms
      };

      const start = Date.now();
      await fetchWithRetry(fn, config, onRetry);
      const elapsed = Date.now() - start;

      // Should complete within reasonable time due to maxDelayMs cap
      expect(elapsed).toBeLessThan(100);
    });

    it('should handle non-Error rejections', async () => {
      const fn = jest.fn().mockRejectedValue('string error');

      const config: RetryConfig = {
        maxRetries: 0,
        baseDelayMs: 10,
        maxDelayMs: 50,
      };

      await expect(fetchWithRetry(fn, config)).rejects.toThrow('string error');
    });
  });

  describe('CircuitBreaker', () => {
    describe('Initial state', () => {
      it('should start in CLOSED state', () => {
        const cb = new CircuitBreaker();
        expect(cb.getState()).toBe('CLOSED');
      });

      it('should allow execution initially', () => {
        const cb = new CircuitBreaker();
        expect(cb.canExecute()).toBe(true);
      });
    });

    describe('State transitions', () => {
      it('should remain CLOSED after successful executions', () => {
        const cb = new CircuitBreaker(5);

        cb.recordSuccess();
        cb.recordSuccess();
        cb.recordSuccess();

        expect(cb.getState()).toBe('CLOSED');
        expect(cb.canExecute()).toBe(true);
      });

      it('should open after threshold failures', () => {
        const cb = new CircuitBreaker(3);

        cb.recordFailure();
        expect(cb.getState()).toBe('CLOSED');

        cb.recordFailure();
        expect(cb.getState()).toBe('CLOSED');

        cb.recordFailure();
        expect(cb.getState()).toBe('OPEN');
        expect(cb.canExecute()).toBe(false);
      });

      it('should reset failure count on success', () => {
        const cb = new CircuitBreaker(3);

        cb.recordFailure();
        cb.recordFailure();
        cb.recordSuccess();
        cb.recordFailure();
        cb.recordFailure();

        // Should still be CLOSED because success reset the count
        expect(cb.getState()).toBe('CLOSED');
      });

      it('should transition to HALF_OPEN after timeout', () => {
        const cb = new CircuitBreaker(1, 10); // 1 failure threshold, 10ms timeout

        cb.recordFailure();
        expect(cb.getState()).toBe('OPEN');

        // Wait for timeout
        return new Promise<void>(resolve => {
          setTimeout(() => {
            expect(cb.getState()).toBe('HALF_OPEN');
            expect(cb.canExecute()).toBe(true);
            resolve();
          }, 15);
        });
      });

      it('should close after successful executions in HALF_OPEN', async () => {
        const cb = new CircuitBreaker(1, 10, 2); // 2 successes needed

        cb.recordFailure();
        expect(cb.getState()).toBe('OPEN');

        await new Promise(resolve => setTimeout(resolve, 15));
        expect(cb.getState()).toBe('HALF_OPEN');

        cb.recordSuccess();
        expect(cb.getState()).toBe('HALF_OPEN');

        cb.recordSuccess();
        expect(cb.getState()).toBe('CLOSED');
      });

      it('should reopen if failure in HALF_OPEN', async () => {
        const cb = new CircuitBreaker(1, 10, 2);

        cb.recordFailure();
        await new Promise(resolve => setTimeout(resolve, 15));
        expect(cb.getState()).toBe('HALF_OPEN');

        cb.recordFailure();
        expect(cb.getState()).toBe('OPEN');
      });
    });

    describe('reset()', () => {
      it('should reset to CLOSED state', () => {
        const cb = new CircuitBreaker(1);

        cb.recordFailure();
        expect(cb.getState()).toBe('OPEN');

        cb.reset();
        expect(cb.getState()).toBe('CLOSED');
        expect(cb.canExecute()).toBe(true);
      });
    });

    describe('execute()', () => {
      it('should execute function when CLOSED', async () => {
        const cb = new CircuitBreaker();
        const fn = jest.fn().mockResolvedValue('result');

        const result = await cb.execute(fn);

        expect(result).toBe('result');
        expect(fn).toHaveBeenCalledTimes(1);
      });

      it('should record success on successful execution', async () => {
        const cb = new CircuitBreaker(2);
        cb.recordFailure(); // 1 failure

        await cb.execute(async () => 'ok');

        // Success should reset failures
        cb.recordFailure();
        expect(cb.getState()).toBe('CLOSED'); // Not open because reset
      });

      it('should record failure on failed execution', async () => {
        const cb = new CircuitBreaker(1);

        await expect(cb.execute(async () => {
          throw new Error('fail');
        })).rejects.toThrow('fail');

        expect(cb.getState()).toBe('OPEN');
      });

      it('should reject when OPEN', async () => {
        const cb = new CircuitBreaker(1);
        cb.recordFailure();

        await expect(cb.execute(async () => 'result')).rejects.toThrow('Circuit breaker is OPEN');
      });
    });
  });
});
