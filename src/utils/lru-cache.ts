/**
 * 一个轻量的 LRU 缓存封装（基于 Map 的插入顺序实现）。
 *
 * 设计目标：
 * - 足够简单：只支持最常用的 get/set/clear
 * - 可控容量：maxEntries 超限时淘汰最旧条目
 * - 泛型友好：支持缓存 null 等值
 */

export interface LruCacheOptions {
  /**
   * 最大缓存条目数
   * - <= 0：等价于禁用缓存（set 不生效，get 永远 miss）
   */
  maxEntries: number;
}

export class LruCache<K, V> {
  private map = new Map<K, V>();
  private maxEntries: number;

  constructor(options: LruCacheOptions) {
    this.maxEntries = options.maxEntries;
  }

  /**
   * 当前缓存条目数
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * 获取最大条目数
   */
  getMaxEntries(): number {
    return this.maxEntries;
  }

  /**
   * 动态调整最大条目数
   * - 调小会立即触发淘汰
   */
  setMaxEntries(maxEntries: number): void {
    this.maxEntries = maxEntries;
    if (this.maxEntries <= 0) {
      this.map.clear();
      return;
    }
    this.trim();
  }

  clear(): void {
    this.map.clear();
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * 获取并刷新 LRU 顺序（命中后会变成“最近使用”）
   */
  get(key: K): V | undefined {
    if (this.maxEntries <= 0) {
      return undefined;
    }

    if (!this.map.has(key)) {
      return undefined;
    }

    const value = this.map.get(key) as V;
    // 刷新顺序
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /**
   * 写入并刷新 LRU 顺序
   */
  set(key: K, value: V): void {
    if (this.maxEntries <= 0) {
      return;
    }

    // 刷新顺序：先删后加
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);

    this.trim();
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  private trim(): void {
    if (this.maxEntries <= 0) return;
    while (this.map.size > this.maxEntries) {
      const iter = this.map.keys().next();
      if (iter.done) break;
      this.map.delete(iter.value);
    }
  }
}
