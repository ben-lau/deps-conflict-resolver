/**
 * 版本规格/协议相关的小工具
 */

/** 匹配 npm:package@version 格式（支持 scoped package） */
const NPM_ALIAS_PATTERN = /^npm:(@?[^@]+)@(.+)$/;

/**
 * 解析 npm 别名格式 (npm:package@version)
 * @returns [targetPackage, versionSpec] 或 null
 */
export function parseNpmAlias(versionSpec: string): [string, string] | null {
  const match = versionSpec.match(NPM_ALIAS_PATTERN);
  if (match?.[1] && match?.[2]) {
    return [match[1], match[2]];
  }
  return null;
}
