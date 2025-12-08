/**
 * Performance Optimization Tests
 *
 * Tests for LRU cache and rate limiter.
 */

import { LRUCache, RateLimiter, getMemoryUsage } from '../daemon';

describe('Performance Optimization', () => {
  describe('LRUCache', () => {
    describe('Basic operations', () => {
      it('should store and retrieve values', () => {
        const cache = new LRUCache<string, number>();
        cache.set('key1', 100);
        expect(cache.get('key1')).toBe(100);
      });

      it('should return undefined for missing keys', () => {
        const cache = new LRUCache<string, number>();
        expect(cache.get('missing')).toBeUndefined();
      });

      it('should check existence with has()', () => {
        const cache = new LRUCache<string, number>();
        cache.set('key1', 100);
        expect(cache.has('key1')).toBe(true);
        expect(cache.has('missing')).toBe(false);
      });

      it('should delete values', () => {
        const cache = new LRUCache<string, number>();
        cache.set('key1', 100);
        expect(cache.delete('key1')).toBe(true);
        expect(cache.get('key1')).toBeUndefined();
      });

      it('should clear all values', () => {
        const cache = new LRUCache<string, number>();
        cache.set('key1', 100);
        cache.set('key2', 200);
        cache.clear();
        expect(cache.size).toBe(0);
      });

      it('should track size', () => {
        const cache = new LRUCache<string, number>();
        expect(cache.size).toBe(0);
        cache.set('key1', 100);
        expect(cache.size).toBe(1);
        cache.set('key2', 200);
        expect(cache.size).toBe(2);
      });
    });

    describe('TTL expiration', () => {
      it('should expire entries after TTL', async () => {
        const cache = new LRUCache<string, number>(100, 50); // 50ms TTL
        cache.set('key1', 100);
        expect(cache.get('key1')).toBe(100);

        await new Promise(resolve => setTimeout(resolve, 60));
        expect(cache.get('key1')).toBeUndefined();
      });

      it('should allow custom TTL per entry', async () => {
        const cache = new LRUCache<string, number>(100, 1000);
        cache.set('short', 100, 30); // 30ms TTL
        cache.set('long', 200, 200); // 200ms TTL

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(cache.get('short')).toBeUndefined();
        expect(cache.get('long')).toBe(200);
      });

      it('should cleanup expired entries', async () => {
        const cache = new LRUCache<string, number>(100, 30);
        cache.set('key1', 100);
        cache.set('key2', 200);

        await new Promise(resolve => setTimeout(resolve, 50));
        const removed = cache.cleanup();
        expect(removed).toBe(2);
        expect(cache.size).toBe(0);
      });
    });

    describe('LRU eviction', () => {
      it('should evict oldest entry when at capacity', () => {
        const cache = new LRUCache<string, number>(3, 10000);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        cache.set('d', 4); // Should evict 'a'

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe(2);
        expect(cache.get('c')).toBe(3);
        expect(cache.get('d')).toBe(4);
        expect(cache.size).toBe(3);
      });

      it('should update LRU order on access', () => {
        const cache = new LRUCache<string, number>(3, 10000);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);

        // Access 'a' to make it most recently used
        cache.get('a');

        cache.set('d', 4); // Should evict 'b' instead of 'a'

        expect(cache.get('a')).toBe(1);
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('c')).toBe(3);
        expect(cache.get('d')).toBe(4);
      });

      it('should update LRU order on set', () => {
        const cache = new LRUCache<string, number>(3, 10000);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);

        // Update 'a' to make it most recently used
        cache.set('a', 10);

        cache.set('d', 4); // Should evict 'b'

        expect(cache.get('a')).toBe(10);
        expect(cache.get('b')).toBeUndefined();
      });
    });

    describe('Edge cases', () => {
      it('should handle complex key types', () => {
        interface KeyType {
          id: number;
          name: string;
        }
        const cache = new LRUCache<string, KeyType>();
        cache.set('key1', { id: 1, name: 'test' });
        expect(cache.get('key1')).toEqual({ id: 1, name: 'test' });
      });

      it('should handle size of 1', () => {
        const cache = new LRUCache<string, number>(1, 10000);
        cache.set('a', 1);
        cache.set('b', 2);
        expect(cache.size).toBe(1);
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe(2);
      });
    });
  });

  describe('RateLimiter', () => {
    describe('Basic operations', () => {
      it('should allow requests within limit', () => {
        const limiter = new RateLimiter(5, 1);
        expect(limiter.tryAcquire()).toBe(true);
        expect(limiter.tryAcquire()).toBe(true);
        expect(limiter.tryAcquire()).toBe(true);
      });

      it('should block when limit exceeded', () => {
        const limiter = new RateLimiter(2, 0.1);
        expect(limiter.tryAcquire()).toBe(true);
        expect(limiter.tryAcquire()).toBe(true);
        expect(limiter.tryAcquire()).toBe(false);
      });

      it('should report available tokens', () => {
        const limiter = new RateLimiter(5, 1);
        expect(limiter.getAvailableTokens()).toBe(5);
        limiter.tryAcquire();
        expect(limiter.getAvailableTokens()).toBe(4);
      });
    });

    describe('Token refill', () => {
      it('should refill tokens over time', async () => {
        const limiter = new RateLimiter(2, 10); // 10 tokens per second
        limiter.tryAcquire();
        limiter.tryAcquire();
        expect(limiter.tryAcquire()).toBe(false);

        await new Promise(resolve => setTimeout(resolve, 150));
        expect(limiter.tryAcquire()).toBe(true);
      });

      it('should not exceed max tokens', async () => {
        const limiter = new RateLimiter(3, 100);
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(limiter.getAvailableTokens()).toBeLessThanOrEqual(3);
      });
    });

    describe('acquire()', () => {
      it('should resolve immediately when tokens available', async () => {
        const limiter = new RateLimiter(5, 1);
        const start = Date.now();
        await limiter.acquire();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(10);
      });

      it('should wait when no tokens available', async () => {
        const limiter = new RateLimiter(1, 20); // 20 tokens/sec = 50ms per token
        await limiter.acquire(); // Use the only token

        const start = Date.now();
        await limiter.acquire(); // Should wait for refill
        const elapsed = Date.now() - start;

        expect(elapsed).toBeGreaterThan(30);
        expect(elapsed).toBeLessThan(100);
      });
    });

    describe('reset()', () => {
      it('should restore full tokens', () => {
        const limiter = new RateLimiter(5, 1);
        limiter.tryAcquire();
        limiter.tryAcquire();
        limiter.tryAcquire();

        limiter.reset();
        expect(limiter.getAvailableTokens()).toBe(5);
      });
    });
  });

  describe('getMemoryUsage', () => {
    it('should return memory statistics', () => {
      const usage = getMemoryUsage();

      expect(typeof usage.heapUsed).toBe('number');
      expect(typeof usage.heapTotal).toBe('number');
      expect(typeof usage.rss).toBe('number');

      expect(usage.heapUsed).toBeGreaterThan(0);
      expect(usage.heapTotal).toBeGreaterThan(0);
      expect(usage.rss).toBeGreaterThan(0);
    });

    it('should return values in MB', () => {
      const usage = getMemoryUsage();

      // Reasonable bounds for MB values
      expect(usage.heapUsed).toBeLessThan(10000); // Less than 10GB
      expect(usage.heapTotal).toBeLessThan(10000);
      expect(usage.rss).toBeLessThan(10000);
    });
  });
});
