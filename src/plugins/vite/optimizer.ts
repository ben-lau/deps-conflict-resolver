import type { Plugin } from 'vite';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DepsConflictResolver } from '../../core/resolver';
import { escapeRegex } from '../../utils/regex';

export interface OptimizerOptions {
  include: string[];
  esbuildOptions?: { plugins: EsbuildPlugin[] };
  rolldownOptions?: { plugins: Plugin[] };
}

function esbuildPlugin(resolver: DepsConflictResolver, projectRoot: string): EsbuildPlugin {
  return {
    name: 'deps-conflict-resolver-esbuild',
    setup(build) {
      const originals = [
        ...new Set(resolver.getAliasPathMappings().map((mapping) => mapping.originalName)),
      ];
      if (originals.length === 0) return;
      const filter = new RegExp('^(' + originals.map(escapeRegex).join('|') + ')(?:[/?#].*)?$');
      build.onResolve({ filter }, async (args) => {
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
function rolldownPlugin(resolver: DepsConflictResolver, projectRoot: string): Plugin {
  return {
    name: 'deps-conflict-resolver-rolldown',
    async resolveId(source, importer, resolveOptions) {
      if (!importer) return null;
      const redirected = resolver.resolveModule(source, importer);
      if (!redirected) return null;
      const resolved = await this.resolve(redirected, join(projectRoot, 'package.json'), {
        ...resolveOptions,
        skipSelf: true,
      });
      if (!resolved) throw new Error('Cannot resolve active alias: ' + redirected);
      return resolved;
    },
  };
}

export function createOptimizerOptions(
  resolver: DepsConflictResolver,
  projectRoot: string,
  viteVersion: string,
): OptimizerOptions {
  const include = [...new Set(resolver.getAliasPathMappings().map((mapping) => mapping.aliasName))];
  return Number.parseInt(viteVersion, 10) >= 8
    ? { include, rolldownOptions: { plugins: [rolldownPlugin(resolver, projectRoot)] } }
    : { include, esbuildOptions: { plugins: [esbuildPlugin(resolver, projectRoot)] } };
}
