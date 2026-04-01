import semver from 'semver';

/**
 * 检查版本是否满足版本范围
 */
export function satisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: false });
  } catch {
    return false;
  }
}

/**
 * 比较两个版本
 * @returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2；无法解析时视为相等
 */
export function compare(v1: string, v2: string): -1 | 0 | 1 {
  try {
    return semver.compare(v1, v2);
  } catch {
    return 0;
  }
}

/**
 * 找出满足所有版本范围的版本（交集）
 * @param versions 可用版本列表
 * @param ranges 版本范围列表
 * @returns 满足所有范围的版本列表
 */
export function findIntersection(versions: string[], ranges: string[]): string[] {
  if (ranges.length === 0) return versions;

  return versions.filter(version => {
    return ranges.every(range => satisfies(version, range));
  });
}

/**
 * 从版本列表中找出满足所有范围的最新版本
 */
export function findBestVersion(versions: string[], ranges: string[]): string | null {
  const satisfyingVersions = findIntersection(versions, ranges);

  if (satisfyingVersions.length === 0) {
    return null;
  }

  // 浅拷贝后排序，避免修改传入的 versions 数组
  const sorted = [...satisfyingVersions].sort((a, b) => compare(b, a));
  return sorted[0] ?? null;
}

/**
 * 检查两个版本范围是否有交集
 */
export function rangesIntersect(range1: string, range2: string): boolean {
  try {
    const intersection = semver.intersects(range1, range2);
    return intersection;
  } catch {
    return false;
  }
}

/**
 * 生成 npm 别名安装字符串
 */
export function createAliasInstallSpec(
  alias: string,
  packageName: string,
  version: string,
): string {
  return `${alias}@npm:${packageName}@${version}`;
}

/**
 * 生成别名名称
 * 例如 vue + 2.6.14 -> vue2
 */
export function generateAliasName(packageName: string, version: string): string {
  let major: number;
  try {
    major = semver.major(version);
  } catch {
    // 非标准版本号：取第一段数字，兜底为 0
    const m = version.match(/^(\d+)/);
    major = m ? Number(m[1]) : 0;
  }
  const cleanName = packageName.replace(/^@/, '').replace(/\//g, '-');
  return `${cleanName}${major}`;
}
