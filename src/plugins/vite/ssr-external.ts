import type { ResolvedConfig } from 'vite';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { extname, isAbsolute } from 'node:path';
import { findPackagePath } from '../../utils/fs';
import type { SsrExternalPolicy } from './optimizer';
import { LruCache } from '../../utils/lru-cache';

export function createSsrExternalPolicy(
  config: ResolvedConfig,
  projectRoot: string,
  isExternal: (packageName: string) => boolean,
): SsrExternalPolicy {
  const conditions = config.environments?.ssr?.resolve.externalConditions ??
    config.ssr?.resolve?.externalConditions ?? ['node'];
  const importResolver = config.createResolver({
    asSrc: false,
    scan: true,
    mainFields: [],
    conditions,
    isRequire: false,
  });
  const requireResolver = config.createResolver({
    asSrc: false,
    scan: true,
    mainFields: [],
    conditions,
    isRequire: true,
  });
  const specifiers = new LruCache<string, string>({ maxEntries: 1000 });
  return {
    isExternal,
    async resolve(source, importer, isRequire) {
      const resolved = await (isRequire ? requireResolver : importResolver)(
        source,
        importer,
        false,
        true,
      );
      if (!resolved || !isAbsolute(resolved)) return undefined;
      const extension = extname(resolved);
      if (extension && !['.js', '.mjs', '.cjs'].includes(extension)) return undefined;
      if (isRequire) return resolved;
      const key = source + '\0' + resolved;
      const cached = specifiers.get(key);
      if (cached) return cached;
      const request = source.split(/[?#]/, 1)[0] ?? '';
      const packageName = request.startsWith('@')
        ? request.split('/').slice(0, 2).join('/')
        : request.split('/')[0]!;
      const host = findPackagePath(packageName, projectRoot);
      if (host) {
        const directory = realpathSync(host).replace(/\\/g, '/');
        if (resolved.replace(/\\/g, '/').startsWith(directory + '/')) {
          specifiers.set(key, source);
          return source;
        }
      }
      // Node resolves dynamic imports through the Promise resolution protocol.
      // This native thenable hands Vite the original namespace, instead of a
      // re-export facade's namespace. No export parsing or cache files needed.
      // https://tc39.es/ecma262/2024/multipage/ecmascript-language-expressions.html#sec-continuedynamicimport
      const url = JSON.stringify(pathToFileURL(resolved).href);
      const code = `export function then(resolve,reject){import(${url}).then(resolve,reject)}`;
      const specifier = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
      specifiers.set(key, specifier);
      return specifier;
    },
  };
}
