import type { Plugin } from 'vite';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  getResolverBuild,
  type DepsConflictResolver,
  type ModuleRedirect,
} from '../../core/resolver';
import type { AliasPathMapping } from '../../types';
import { isPathLikeRequest, isVirtualModuleRequest } from '../../utils/module-request';
import { escapeRegex } from '../../utils/regex';

// Bump when the optimizer's redirect policy changes.
const OPTIMIZER_CACHE_VERSION = 3;
const bareRequestFilter = /^[^./]/;

export interface OptimizerOptions {
  include: string[];
  esbuildOptions?: { plugins: EsbuildPlugin[] };
  rolldownOptions?: { plugins: Plugin[] };
}

export interface SsrExternalPolicy {
  isExternal: (packageName: string) => boolean;
  resolve: (source: string, importer: string, isRequire: boolean) => Promise<string | undefined>;
}

interface OptimizerResolveOptions {
  filterRequests: boolean;
  hookKey?: string;
  ssrExternal?: SsrExternalPolicy;
  guardChanges?: boolean;
  reportRun?: (engine: 'esbuild' | 'rolldown', key: string, milliseconds: number) => void;
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
  filter: RegExp,
  { guardChanges, reportRun }: OptimizerResolveOptions,
): EsbuildPlugin {
  const resolvingRedirect = {};
  return {
    name: 'deps-conflict-resolver-esbuild-' + fingerprint,
    setup(build) {
      if (guardChanges || reportRun) {
        let verify: (() => void) | undefined;
        let start = 0;
        build.onStart(() => {
          start = performance.now();
          verify = guardChanges ? getResolverBuild(resolver).guardGeneration() : undefined;
        });
        build.onEnd(() => {
          reportRun?.('esbuild', fingerprint, performance.now() - start);
          verify?.();
        });
      }
      build.onResolve({ filter }, (args) => {
        if (args.pluginData === resolvingRedirect) return null;
        const redirected = resolveOptimizerRequest(resolver, args.path, args.importer);
        if (!redirected?.target) return null;
        const resolveDir =
          redirected.source === 'alias' ? projectRoot : args.resolveDir || dirname(args.importer);
        if (typeof build.resolve === 'function') {
          // Preserve external/namespace/sideEffects/suffix and diagnostics.
          return build.resolve(redirected.target, {
            kind: args.kind,
            resolveDir,
            importer: args.importer,
            pluginData: resolvingRedirect,
          });
        }
        try {
          return {
            path: createRequire(join(resolveDir, 'package.json')).resolve(redirected.target),
          };
        } catch (error) {
          return {
            errors: [
              { text: 'Cannot resolve redirect ' + redirected.target + ': ' + String(error) },
            ],
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
  filter: RegExp,
  { guardChanges, reportRun }: OptimizerResolveOptions,
): Plugin {
  let verify: (() => void) | undefined;
  let start = 0;
  return {
    name: 'deps-conflict-resolver-rolldown-' + fingerprint,
    ...((guardChanges === true || reportRun !== undefined) &&
      ({
        buildStart() {
          start = performance.now();
          verify = guardChanges ? getResolverBuild(resolver).guardGeneration() : undefined;
        },
        buildEnd(error) {
          reportRun?.('rolldown', fingerprint, performance.now() - start);
          if (!error) verify?.();
        },
        generateBundle() {
          verify?.();
        },
      } satisfies Partial<Plugin>)),
    resolveId: {
      filter: { id: filter },
      handler(source, importer, resolveOptions) {
        if (!filter.test(source)) return null;
        const redirected = resolveOptimizerRequest(resolver, source, importer);
        if (!redirected?.target) return null;
        const origin = redirected.source === 'alias' ? join(projectRoot, 'package.json') : importer;
        return this.resolve(redirected.target, origin, {
          ...resolveOptions,
          skipSelf: true,
        }).then((resolved) => {
          if (!resolved) throw new Error('Cannot resolve active redirect: ' + redirected.target);
          return resolved;
        });
      },
    },
  };
}

function resolveOptimizerRequest(
  resolver: DepsConflictResolver,
  request: string,
  importer?: string,
): ModuleRedirect | null {
  if (!importer || isPathLikeRequest(request) || isVirtualModuleRequest(request)) return null;
  return getResolverBuild(resolver).redirect(request, importer);
}

export function createOptimizerOptions(
  resolver: DepsConflictResolver,
  projectRoot: string,
  viteVersion: string,
  options: OptimizerResolveOptions = { filterRequests: true },
): OptimizerOptions {
  const { filterRequests, hookKey, ssrExternal, guardChanges, reportRun } = options;
  const mappings = resolver.getAliasPathMappings();
  const include = [...new Set(mappings.map((mapping) => mapping.aliasName))];
  // Vite hashes optimizer plugin names across esbuild and Rolldown releases.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([OPTIMIZER_CACHE_VERSION, resolver.getResolutionFingerprint(), hookKey]))
    .digest('hex');
  const filter = filterRequests
    ? (aliasRequestFilter(mappings) ?? (guardChanges || reportRun ? /^$/ : undefined))
    : bareRequestFilter;
  if (Number.parseInt(viteVersion, 10) >= 8) {
    return {
      include,
      rolldownOptions: {
        plugins: [
          ...(filter ? [rolldownPlugin(resolver, projectRoot, fingerprint, filter, options)] : []),
          ...(ssrExternal ? [rolldownExternalPlugin(ssrExternal)] : []),
        ],
      },
    };
  }
  return {
    include,
    esbuildOptions: {
      plugins: [
        ...(filter ? [esbuildPlugin(resolver, projectRoot, fingerprint, filter, options)] : []),
        ...(ssrExternal ? [esbuildExternalPlugin(ssrExternal)] : []),
      ],
    },
  };
}
