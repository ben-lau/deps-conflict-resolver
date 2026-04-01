/**
 * 模块请求字符串相关工具
 * 用于在各构建工具插件中统一判断：哪些请求应当跳过（相对路径/绝对路径/虚拟模块等）。
 */

/**
 * 是否为 Vite/rollup 风格的虚拟模块请求（以 \0 开头）
 */
export function isVirtualModuleRequest(request: string): boolean {
  return request.startsWith('\0');
}

/**
 * 是否为“路径型”请求（相对/绝对/Windows 盘符/UNC），而非 bare module import。
 */
export function isPathLikeRequest(request: string): boolean {
  if (!request) return false;

  // 相对路径
  if (request.startsWith('.')) {
    return true;
  }

  // Unix/URL 风格绝对路径（/foo），以及某些场景下的网络路径（//server/share）
  if (request.startsWith('/')) {
    return true;
  }

  // Windows 盘符绝对路径：C:\foo 或 C:/foo
  if (/^[a-zA-Z]:[\\/]/.test(request)) {
    return true;
  }

  // Windows UNC：\\server\share
  if (request.startsWith('\\\\')) {
    return true;
  }

  return false;
}

/**
 * Webpack 内部请求（无需/不应重写）
 */
export function isWebpackInternalRequest(request: string): boolean {
  return request.startsWith('webpack/') || request.startsWith('!');
}
