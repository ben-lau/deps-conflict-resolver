import type { ResolvedConfig } from 'vite';
import * as vite from 'vite';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFunction } from 'node:vm';
import { findPackagePath, iterateParentDirs, readPackageJsonCached } from '../../utils/fs';
import type { SsrExternalPolicy } from './optimizer';
import { LruCache } from '../../utils/lru-cache';

interface ExportNode {
  type: string;
  exported?: { name?: string; value?: unknown };
  specifiers?: Array<{ exported?: { name?: string; value?: unknown } }>;
}

function isDefault(name: ExportNode['exported']): boolean {
  return name?.name === 'default' || name?.value === 'default';
}

function hasDefaultExport(file: string): boolean {
  const extension = extname(file);
  if (extension === '.cjs') return true;
  let format = extension === '.mjs' ? 'module' : undefined;
  if (!format) {
    for (const directory of iterateParentDirs(dirname(file))) {
      const manifest = readPackageJsonCached(directory);
      if (manifest) {
        format = manifest.type;
        break;
      }
    }
  }
  if (format === 'commonjs') return true;
  const source = readFileSync(file, 'utf8');
  if (format !== 'module') {
    try {
      // Match Node's syntax detection without executing the dependency. A
      // CommonJS body permits top-level return and dynamic import, whereas ESM
      // declarations, import.meta, top-level await and wrapper redeclarations
      // fail compilation here and are validated by the ESM parser below.
      compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname']);
      return true;
    } catch {
      // Ambiguous .js can be native ESM even without a package "type" field.
    }
  }
  // Vite 5+ exposes its parser. Namespace lookup keeps ordinary Vite 4 imports
  // compatible; external=true itself is not a Vite 4 SSR option.
  const parse = Reflect.get(vite, 'parseAst') as
    | ((source: string) => { body: ExportNode[] })
    | undefined;
  if (!parse) throw new Error('Inspecting ESM SSR externals requires Vite 5 or newer');
  return parse(source).body.some(
    (node) =>
      node.type === 'ExportDefaultDeclaration' ||
      isDefault(node.exported) ||
      node.specifiers?.some((specifier) => isDefault(specifier.exported)),
  );
}

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
      // A bare import from deps_ssr could select the wrong nested provider.
      // A native data module re-exports that exact file: Vite's runner loads it
      // through Node, preserving import conditions, live bindings and Node's
      // cache for the underlying module. Its specifier also survives warm caches.
      const url = JSON.stringify(pathToFileURL(resolved).href);
      const code =
        `export * from ${url};` +
        (hasDefaultExport(resolved) ? `export { default } from ${url};` : '');
      const specifier = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
      specifiers.set(key, specifier);
      return specifier;
    },
  };
}
