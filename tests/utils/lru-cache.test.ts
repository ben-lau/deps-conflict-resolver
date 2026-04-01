import { describe, it, expect, beforeEach } from 'vitest';
import { LruCache } from '../../src/utils/lru-cache';

describe('LruCache', () => {
  let cache: LruCache<string, number | null>;

  beforeEach(() => {
    cache = new LruCache({ maxEntries: 2 });
  });

  it('should return undefined when key does not exist', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('should store and return values (including null)', () => {
    cache.set('a', 1);
    cache.set('b', null);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeNull();
  });

  it('should evict least-recently-used entry when over capacity', () => {
    cache.set('a', 1);
    cache.set('b', 2);

    // 访问 a，使 b 成为 LRU
    expect(cache.get('a')).toBe(1);

    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('should disable cache when maxEntries <= 0', () => {
    cache.setMaxEntries(0);
    cache.set('a', 1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
