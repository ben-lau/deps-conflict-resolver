/**
 * 通用正则相关工具
 */

/**
 * 转义字符串，使其可安全拼接到正则表达式中
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
