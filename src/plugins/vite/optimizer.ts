import type { Plugin } from 'vite';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DepsConflictResolver } from '../../core/resolver';
import type { AliasPathMapping } from '../../types';
import { escapeRegex } from '../../utils/regex';

export interface OptimizerOptions {
  include: string[];
  esbuildOptions?: { plugins: EsbuildPlugin[] };
  rolldownOptions?: { plugins: Plugin[] };
}

export interface SsrExternalPolicy {
  isExternal: (packageName: string) => boolean;
  resolve: (source: string, importer: string, isRequire: boolean) => Promise<string | undefined>;
}

export function aliasRequestFilter(mappings: readonly AliasPathMapping[]): RegExp | undefined {
  const originals = [...new Set(mappings.map(({ originalName }) => originalName))];
  return originals.length
    ? new RegExp('^(' + originals.map(escapeRegex).join('|') + ')([/?#]|$)')
    : undefined;
}

function resolveExternalId(
  policy: SsrExternalPolicy,
  source: string,
  importer: string,
  isRequire: boolean,
): Promise<string | undefined> | undefined {
  // Leave paths, private imports, protocols and virtual IDs to their normal
  // resolvers. Only installed Node-compatible package entries are externalized.
  if (!/^[\w@]/.test(source) || source.includes(':')) return undefined;
  const request = source.split(/[?#]/, 1)[0] ?? '';
  const parts = request.split('/');
  const packageName = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return policy.isExternal(packageName) ? policy.resolve(source, importer, isRequire) : undefined;
}

function esbuildExternalPlugin(policy: SsrExternalPolicy): EsbuildPlugin {
  return {
    name: 'deps-conflict-resolver-ssr-external',
    setup(build) {
      build.onResolve({ filter: /^[\w@]/ }, (args) => {
        if (!args.importer || args.kind === 'entry-point') return null;
        const resolution = resolveExternalId(
          policy,
          args.path,
          args.importer,
          args.kind.startsWith('require'),
        );
        return resolution?.then((id) => (id ? { path: id, external: true } : null)) ?? null;
      });
    },
  };
}

function rolldownExternalPlugin(policy: SsrExternalPolicy): Plugin {
  return {
    name: 'deps-conflict-resolver-ssr-external',
    resolveId(source, importer, options) {
      if (!importer || options.isEntry) return null;
      const kind = (options as typeof options & { kind?: string }).kind;
      const isRequire =
        kind?.startsWith('require') ?? options.custom?.['node-resolve']?.isRequire === true;
      return (
        resolveExternalId(policy, source, importer, isRequire)?.then((id) =>
          id ? { id, external: true } : null,
        ) ?? null
      );
    },
  };
}

function esbuildPlugin(
  resolver: DepsConflictResolver,
  projectRoot: string,
  fingerprint: string,
): EsbuildPlugin {
  return {
    name: 'deps-conflict-resolver-esbuild-' + fingerprint,
    setup(build) {
      const filter = aliasRequestFilter(resolver.getAliasPathMappings());
      if (!filter) return;
      build.onResolve({ filter }, (args) => {
        if (!args.importer) return null;
        const redirected = resolver.resolveModule(args.path, args.importer);
        if (!redirected) return null;
        if (typeof build.resolve === 'function') {
          // Preserve external/namespace/sideEffects/suffix and diagnostics.
          return build.resolve(redirected, {
            kind: args.kind,
            resolveDir: projectRoot,
            importer: args.importer,
          });
        }
        try {
          return { path: createRequire(join(projectRoot, 'package.json')).resolve(redirected) };
        } catch (error) {
          return {
            errors: [{ text: 'Cannot resolve alias ' + redirected + ': ' + String(error) }],
          };
        }
      });
    },
  };
}

/** Vite 8's optimizer consumes native Rolldown hooks, not esbuild setup hooks. */
function rolldownPlugin(
  resolver: DepsConflictResolver,
  projectRoot: string,
  fingerprint: string,
  filter: RegExp | undefined,
): Plugin {
  return {
    name: 'deps-conflict-resolver-rolldown-' + fingerprint,
    resolveId: {
      ...(filter && { filter: { id: filter } }),
      handler(source, importer, resolveOptions) {
        if (!importer || (filter && !filter.test(source))) return null;
        const redirected = resolver.resolveModule(source, importer);
        if (!redirected) return null;
        return this.resolve(redirected, join(projectRoot, 'package.json'), {
          ...resolveOptions,
          skipSelf: true,
        }).then((resolved) => {
          if (!resolved) throw new Error('Cannot resolve active alias: ' + redirected);
          return resolved;
        });
      },
    },
  };
}

export function createOptimizerOptions(
  resolver: DepsConflictResolver,
  projectRoot: string,
  viteVersion: string,
  ssrExternal?: SsrExternalPolicy,
  filterRequests = true,
): OptimizerOptions {
  const mappings = resolver.getAliasPathMappings();
  const include = [...new Set(mappings.map((mapping) => mapping.aliasName))];
  // Vite hashes optimizer plugin names across esbuild and Rolldown releases.
  const fingerprint = resolver.getResolutionFingerprint();
  if (Number.parseInt(viteVersion, 10) >= 8) {
    const filter = filterRequests ? aliasRequestFilter(mappings) : undefined;
    return {
      include,
      rolldownOptions: {
        plugins: [
          ...(!filterRequests || filter
            ? [rolldownPlugin(resolver, projectRoot, fingerprint, filter)]
            : []),
          ...(ssrExternal ? [rolldownExternalPlugin(ssrExternal)] : []),
        ],
      },
    };
  }
  return {
    include,
    esbuildOptions: {
      plugins: [
        esbuildPlugin(resolver, projectRoot, fingerprint),
        ...(ssrExternal ? [esbuildExternalPlugin(ssrExternal)] : []),
      ],
    },
  };
}
