# deps-conflict-resolver

[![npm version](https://img.shields.io/npm/v/deps-conflict-resolver.svg)](https://www.npmjs.com/package/deps-conflict-resolver)
[![CI](https://github.com/ben-lau/deps-conflict-resolver/actions/workflows/ci.yml/badge.svg)](https://github.com/ben-lau/deps-conflict-resolver/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/ben-lau/deps-conflict-resolver/branch/main/graph/badge.svg)](https://codecov.io/gh/ben-lau/deps-conflict-resolver)

> [中文文档](./README.md)

A Webpack and Vite plugin that automatically resolves peer dependency conflicts by creating aliases for conflicting versions, allowing different versions of the same dependency to coexist.

## Features

- **Recursive Dependency Analysis**: Deep traversal of the entire dependency tree, including nested sub-dependencies, while preserving nested instances by their installed paths
- **Smart Conflict Detection**: Identifies peer dependency conflicts using the host version and the installed providers visible to configured packages
- **Automatic Alias Installation**: Creates aliases for conflicting dependencies and installs the appropriate versions
- **Module Resolution Redirection**: At build time, redirects module imports from conflicting libraries to their aliased versions
- **Remote Version Querying**: Uses version and peer metadata from the npm registry to select compatible candidates
- **Webpack & Vite Support**: Provides plugin implementations for both build tools

## Use Case

The canonical scenario: your Vue 3 project needs to use a third-party library that only supports Vue 2. The library's dependency chain may include Vue 2, vue-router 3, and other older dependencies. This plugin can:

1. Automatically detect these version conflicts
2. Create aliases for conflicting dependencies (e.g., `aliased-vue2` for `vue@2.x`)
3. Automatically install the aliased dependencies
4. Redirect module resolution at build time: `import Vue from 'vue'` inside the third-party library resolves to `vue@2.x`, while the same import in your host project still resolves to `vue@3.x`

## Installation

```bash
npm install deps-conflict-resolver --save-dev
# or
yarn add deps-conflict-resolver -D
# or
pnpm add deps-conflict-resolver -D
```

## Usage

### Vite

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { depsConflictResolverVitePlugin } from 'deps-conflict-resolver/vite';

export default defineConfig({
  plugins: [
    depsConflictResolverVitePlugin({
      // Packages to analyze
      dependencies: ['legacy-vue2-library'],

      // Optional
      autoInstall: true, // Auto-install missing aliased dependencies
      packageManager: 'npm', // npm | yarn | pnpm
      debug: false, // Enable debug logging
    }),
  ],
});
```

When Worker builds need the same conflict resolution, create separate instances in `worker.plugins`. This example uses Vite 5+; for Vite 4, use `worker.plugins: [conflictResolver()]`:

```typescript
const conflictResolver = () =>
  depsConflictResolverVitePlugin({
    dependencies: ['legacy-vue2-library'],
    offline: true,
    strict: true,
  });

export default defineConfig({
  plugins: [conflictResolver()],
  worker: { plugins: () => [conflictResolver()] },
});
```

### Webpack

```typescript
// webpack.config.js
const { DepsConflictResolverWebpackPlugin } = require('deps-conflict-resolver/webpack');

module.exports = {
  plugins: [
    new DepsConflictResolverWebpackPlugin({
      dependencies: ['legacy-vue2-library'],
      autoInstall: true,
      packageManager: 'npm',
    }),
  ],
};
```

### Programmatic Usage

```typescript
import { createResolver } from 'deps-conflict-resolver';

const resolver = await createResolver({
  dependencies: ['legacy-vue2-library'],
  projectRoot: process.cwd(),
  autoInstall: true,
});

// Get analysis results
const result = resolver.getAnalysisResult();
console.log('Peer conflicts:', result.peerConflicts);
console.log('Alias mappings:', result.aliasMappings);

// Manually resolve a module
const resolved = resolver.resolveModule('vue', '/path/to/importer.js');
```

## Configuration

| Option             | Type                                     | Default                           | Description                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dependencies`     | `string[]`                               | -                                 | Package names to analyze. Required by the build plugins and `createResolver`. See Diagnose, Prepare, and Build Offline for CLI package selection.                                                                                                                                                                                                                                          |
| `projectRoot`      | `string`                                 | Vite root / Webpack context / cwd | Project root directory path                                                                                                                                                                                                                                                                                                                                                                |
| `autoInstall`      | `boolean`                                | `true`                            | Whether to auto-install missing aliased dependencies                                                                                                                                                                                                                                                                                                                                       |
| `packageManager`   | `'auto' \| 'npm' \| 'yarn' \| 'pnpm'`    | `'auto'`                          | Package manager type. `'auto'` detects automatically                                                                                                                                                                                                                                                                                                                                       |
| `registry`         | `string`                                 | Auto-detected                     | npm registry URL; an explicit value is used for both version queries and alias installation                                                                                                                                                                                                                                                                                                |
| `debug`            | `boolean`                                | `false`                           | Whether to enable debug logging                                                                                                                                                                                                                                                                                                                                                            |
| `offline`          | `boolean`                                | `false`                           | Only reuse verified installed aliases; never query registries or install                                                                                                                                                                                                                                                                                                                   |
| `strict`           | `boolean`                                | `false`                           | Reject unresolved required dependencies, failed installation, or ambiguous requests                                                                                                                                                                                                                                                                                                        |
| `aliasPrefix`      | `string`                                 | `'aliased-'`                      | Prefix for generated alias names                                                                                                                                                                                                                                                                                                                                                           |
| `excludeRedirects` | `Record<string, string[]>`               | `{}`                              | Exclude specific packages from the redirect list. Keys are original package names, values are importer package names to exclude. Example: `{ vue: ['vue-demi', 'pinia'] }`                                                                                                                                                                                                                 |
| `includeRedirects` | `Record<string, string[]>`               | `{}`                              | Force specific packages by name into the redirect list. `excludeRedirects` wins if both match. Does not trigger new alias creation or traverse subtrees. Example: `{ vue: ['legacy-helper'] }`                                                                                                                                                                                             |
| `peerOverrides`    | `Record<string, Record<string, string>>` | `{}`                              | Override declared `peerDependencies` ranges for specific packages. Keys accept `<name>` or `<name>@<semverRange>` (matching prereleases; precedence: name-only < range < exact version). Useful when an upstream package declares an overly broad range (e.g., `>=2.5.0`), omits a peer, or coexists across multiple major versions. Example: `{ '@rili/ui@1.x': { vue: '>=2.5.17 <3' } }` |

### Vite Plugin Exclusive Options

| Option          | Type                 | Default    | Description                                |
| --------------- | -------------------- | ---------- | ------------------------------------------ |
| `enableInDev`   | `boolean`            | `true`     | Whether to enable in development mode      |
| `enableInBuild` | `boolean`            | `true`     | Whether to enable in production build mode |
| `ssr`           | `'manual' \| 'auto'` | `'manual'` | auto bundles affected SSR dependencies     |

### Auto-Detection

The plugin supports automatic detection of the package manager and registry:

**Package Manager Detection Priority:**

1. `packageManager` field in `package.json` (e.g., `"pnpm@8.0.0"`)
2. Lock file presence (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm)
3. Falls back to npm

**Registry Detection Priority:**

1. `npm_config_registry` and `NPM_CONFIG_REGISTRY` environment variables (Yarn checks `YARN_NPM_REGISTRY_SERVER` first)
2. Project configuration (Yarn checks `.yarnrc.yml` before `.npmrc`)
3. User-level `.npmrc` and pnpm's `.pnpmrc`
4. Falls back to `https://registry.npmjs.org`

Version queries use the detected registry. Alias installation inherits the package manager's own configuration. An explicit `registry` applies to both version queries and installation.

## Diagnose, Prepare, and Build Offline

You can pass package names directly to the CLI. To share `peerOverrides`, an alias prefix, or redirect scopes with your build plugin, extract the options into a module in your project. This example uses `tools/legacy-deps.cjs`.

```js
// tools/legacy-deps.cjs
module.exports = {
  dependencies: ['legacy-lib'],
  peerOverrides: { 'legacy-lib': { vue: '^2' } },
};
```

Pass `--config` to import that object. The CLI accepts JSON, an ESM `export default`, or a CommonJS `module.exports`. Options set to `undefined` are treated as omitted. Positional package names and CLI flags override the corresponding options from the file. Relative paths passed in `--config`, `--root`, or `projectRoot` are resolved from the CLI's working directory. To anchor `projectRoot` to the module, build an absolute path with `require('node:path').resolve(__dirname, '..')` in the module.

```bash
pnpm exec deps-conflict-resolver doctor --config ./tools/legacy-deps.cjs --json
pnpm exec deps-conflict-resolver prepare --config ./tools/legacy-deps.cjs --strict
pnpm exec deps-conflict-resolver doctor --config ./tools/legacy-deps.cjs --offline --strict --json
```

`doctor` analyzes the installed tree. When neither source selects package names, it scans the project's `dependencies` and installed `optionalDependencies`, skipping npm aliases. `prepare` takes package names from either source and uses the package manager to update the manifest and lockfile in online mode. `prepare --strict` stops before installing if analysis finds a blocking error. `--json` emits a version 1 report containing planned aliases, active aliases, diagnostics, and installation outcomes.

Commit the manifest and lockfile produced by `prepare`. Run a frozen install in CI. When npm prepared the aliases, use `npm ci --legacy-peer-deps` to match the installation flags. Then build in offline strict mode. [npm ci](https://docs.npmjs.com/cli/v10/commands/npm-ci/#description)

Import the same options object in Vite or Webpack and add any build-specific settings there.

```js
// vite.config.mjs
import { depsConflictResolverVitePlugin } from 'deps-conflict-resolver/vite';
import legacyDeps from './tools/legacy-deps.cjs';

export default {
  plugins: [
    depsConflictResolverVitePlugin({ ...legacyDeps, offline: true, strict: true, ssr: 'auto' }),
  ],
};
```

```js
// webpack.config.cjs
const { DepsConflictResolverWebpackPlugin } = require('deps-conflict-resolver/webpack');
const legacyDeps = require('./tools/legacy-deps.cjs');

module.exports = {
  plugins: [new DepsConflictResolverWebpackPlugin({ ...legacyDeps, offline: true, strict: true })],
};
```

offline=true prohibits registry queries and package-manager installation, including when autoInstall=true is also supplied. Missing verified aliases produce OFFLINE_ALIAS_MISSING. strict=true rejects unresolved required dependencies, installation failures, and ambiguous runtime requests. Automatic installation and permissive handling remain the defaults. autoInstall=false alone does not prohibit registry queries.

Vite's ssr='auto' adds affected packages and active aliases to ssr.noExternal. During development it also includes them in SSR pre-bundling with the same alias resolution rules, redirecting both CommonJS require and ESM import requests. The default is ssr='manual'. Existing noExternal=true and SSR optimizer settings are preserved and merged. Explicit ssr.external entries retain Vite's own precedence; avoid externalizing affected packages or disabling SSR pre-bundling when automatic redirection is needed.

Development pre-bundling uses active aliases, direct consumers, and includeRedirects as entries, then follows actual import / require requests instead of eagerly loading every declared dependency. Explicit ssr.external and SSR optimizeDeps.exclude settings, including environments.ssr settings, take precedence over generated configuration. Externals are also forwarded to the SSR optimizer. Consumers explicitly excluded from automatic handling require manual resolution configuration.

ssr.external=true (Vite 5+) also applies inside pre-bundled entries; dependencies matching noExternal package names or patterns remain bundled. External entry points resolve from their original consumer, preserving nested versions and import/require conditions instead of resolving from the optimizer cache directory. Native external loading preserves namespace identity, Node's module cache and live bindings without guessing default exports.

Vite applies scoped redirects before global aliases for matching importers. Other requests follow Vite's configured aliases and resolution. Optimizer caches are invalidated when active rules or installed providers change. The development server watches the project and linked workspace manifests used by analysis.

`PEER_PROVIDER_MISMATCH` reports a nested provider that shadows a compatible host version. An entry can use its installed provider when the affected peer requests already share that compatible instance. `TRANSITIVE_PEER_CONFLICT` points out incompatible peers of direct children when the selected entry omits the declaration.

### Explain a Resolution

```typescript
const resolver = await createResolver({
  dependencies: ['legacy-lib'],
  offline: true,
});

console.log(resolver.getDiagnostics());
console.log(resolver.getInstallResult());
console.log(resolver.explainResolution('vue', '/absolute/path/to/legacy-lib/index.js'));
```

explainResolution returns resolved, reason, aliases, and matchedPaths. Reasons distinguish redirection, exclusion, no match, inactive state, ambiguity, and beforeResolve hook handling. Diagnostics have stable codes and do not require parsing log messages. Strict initialization failures throw the exported ResolutionError, which exposes diagnostics.

Pass `{ skipHook: true }` as the third argument to inspect static rules without executing user callbacks. Concurrent installDependencies() calls on one instance share preparation; invalidate() rejects while installation is pending.

Initialization with `offline: true` or `autoInstall: false` takes a shared read lock, so processes in a workspace can analyze and reuse installed aliases concurrently. Preparation that can invoke the package manager takes an exclusive lock from analysis through publication. Each preparation reuses its own registry metadata for corrective installation. Participating processes use the same OS user and temporary directory. Lock records can be reclaimed when their processes exit. Generated aliases save exact versions. After a package-manager attempt, preparation rebuilds consumer scopes, peer linkage and watch inputs and verifies every alias. Preparation allows one corrective installation and reports PROJECT_STATE_CHANGED if inputs keep changing.

An initialized instance is invalidated if another preparation changes its effective rules or provider. Strict resolution rejects until invalidate() and initialize() run again, or the build restarts. Concurrent initialization waits for the project preparation queue. User hooks run outside preparation locks; internal replanning does not repeat analysis notifications. onAnalysisComplete observes a candidate analysis; query getAnalysisResult() after initialize() completes for the final result.

Vite's implicit projectRoot follows the final configured root, including changes made by other config hooks. An explicit projectRoot takes precedence. Preparation locks coordinate this library's preparations; avoid other processes or package managers rewriting the installation during a running build. For parallel CI, prepare once, perform a frozen install and build with offline + strict.

Run `pnpm bench:scale` to measure repeated version ranges, plus cold and warm resolution time, filesystem calls and memory use for dense, sparse and distributed imports. Once several importers in an installed directory are requested, verified regular files can share the directory's resolution decision. File symlinks are resolved individually, and requests with a query check the full filename first. Directory, file and decision caches are bounded and rebuilt when a new generation of rules is published.

### Compatibility and Verification

- Vite 4–7 use an esbuild optimizer adapter. Vite 8 uses native Rolldown hooks. The compatibility script checks actual Vue 2 / Vue 3 versions and instance identities during client cold optimization, SSR build, and SSR development with both ESM and CommonJS. It also verifies client cold optimization with a global `resolve.alias`. CI runs both strict and default filtering modes on Vite 4.0.0, 5, 6, 7, and 8.
- Native Vite 4.0 SSR pre-bundling creates separate Vue 2 instances when ESM and CommonJS entries are mixed; the plugin shares this limitation. Use Vite 5 or newer for that scenario. Vite resolves conditional exports; the plugin does not force distinct export entry points into one implementation.
- Webpack 5 uses beforeResolve. Initialization failures remain permissive by default; strict=true propagates failures to the compiler.
- Installed optionalDependencies participate in the runtime graph. The existing optional-peer policy is unchanged.
- Installed aliases declared in workspace-root dependencies, devDependencies, or optionalDependencies can be reused offline when the installation visible from the host has the correct package name and satisfies the target peer. A local directory shadowing a root alias is checked by its own actual identity and version; the hidden root installation is not selected instead.
- Workspace real paths and node_modules links both match. Multiple aliases for the same physical importer produce AMBIGUOUS_IMPORTER rather than a name-based arbitrary choice; strict=true rejects the request.
- When a consumer and an alias declare the same peer, the redirected provider informs version selection and final validation. An incompatible provider produces `ALIAS_PEER_UNSATISFIED` and strict mode rejects initialization. Multiple consumers requiring different compatible providers produce `AMBIGUOUS_IMPORTER`. Validation applies include/exclude rules to the actual importer paths.
- Ordinary shared packages declaring a relevant peer emit SHARED_PEER_CONTEXT when configured entries bring different effective providers to one physical instance. The check covers the installed graph reachable from configured entries, including direct host dependencies that share a physical instance with a redirected subtree. Explicit include/exclude choices remain in effect. A broad peer range cannot establish that application behavior is invalid, so this advisory does not reject strict initialization. Configure the intended redirect scope or isolate package instances when crossing runtime contexts.
- Redirects from linked/workspace packages resolve from the host while preserving the bundler's exports and import/require conditions for roots and subpaths. Webpack watch tracks consulted package manifests and re-resolves affected modules when redirects change, retaining unrelated module caches.
- Full Yarn PnP support and private-registry scope/authentication inheritance are not implemented.
- Coexisting framework versions still require suitable mount/update/unmount bridges. SFC compiler conversion, cross-version component protocols, and CSS isolation are outside this plugin's scope.

## How It Works

### 1. Dependency Analysis

The plugin resolves configured packages from `projectRoot` and follows the host's installed workspace runtime dependencies to find additional instances. When a reachable workspace package directly declares a configured package, the plugin resolves it from that workspace package's directory. Each entry instance supplies its own peer requirements and redirect scope. Peers of ordinary transitive dependencies do not independently trigger alias installation.

```
package-a
├── package-b
│   └── package-c (peerDeps: vue@^2.0.0)
└── package-d (peerDeps: vue-router@^3.0.0)
```

### 2. Conflict Detection

Compares installed versions in the host project against peer dependency requirements:

- Host project: `vue@3.2.0`, `vue-router@4.1.0`
- Peer dependency requirements: `vue@^2.0.0`, `vue-router@^3.0.0`
- Conflict detected ✗

### 3. Version Resolution

Before making a remote request, the resolver checks installed local and workspace npm aliases whose package identity and version satisfy the conflicting range. A matching alias is reused offline with no registry access or reinstall; only unresolved requests query the registry and select the best version that satisfies all peer dependency ranges:

- `vue@^2.0.0` → selects `vue@2.7.14`
- `vue-router@^3.0.0` → selects `vue-router@3.6.5`

### 4. Alias Installation

Creates and installs aliased dependencies:

```bash
npm install aliased-vue2@npm:vue@2.7.14
npm install aliased-vue-router3@npm:vue-router@3.6.5
```

### 5. Module Resolution Redirection

At build time, module imports are automatically redirected:

```javascript
// Inside package-c
import Vue from 'vue'; // → resolves to aliased-vue2

// In the host project
import Vue from 'vue'; // → resolves to vue (3.x)
```

### Behavioral Boundaries

- **Conflict Detection Scope**: The resolver checks each entry instance selected by `dependencies` for peer conflicts against the host project. Transitive peers contribute to the installed graph and redirect matching. Entry peers marked `optional: true` are skipped entirely and produce no conflict, missing-peer warning, or alias.
- **Redirect Scope**: Packages that declare conflicting peers and all their sub-dependencies (`dependencies` + `peerDependencies` recursively) are added to the redirect candidate list. The conflict target packages themselves (e.g., `vue`, `vue-router`), as well as descendants whose declared `peerDependencies` or `dependencies` match the host version but are incompatible with the selected alias (for example a Vue 3 package with `peerDependencies: { vue: "3.x" }` reached through a Vue 2 tree, along with its exclusive subtree), are automatically skipped to prevent host-compatible packages from being redirected to the older alias.
- **Nested Versions**: The installed dependency graph is keyed by normalized package directories, and each child is resolved relative to its owning package. Nested instances with the same name but different versions remain distinct; generated redirect rules prefer importer-path matching. Consequently, `excludeRedirects` applies to concrete package instances and their subtrees rather than globally deduplicating by name.
- **`excludeRedirects`**: Removes specified packages from the redirect candidate list. Useful for shared packages (e.g., `vue-demi`, `pinia`) that actually use the host's Vue 3 version at runtime.
- **`includeRedirects`**: Forces specified packages by name into the redirect list. Applied before `excludeRedirects`; does not trigger new alias installation or expand dependency subtrees.
- **`peerOverrides`**: Overrides declared `peerDependencies` ranges for specified packages (replacing existing ranges, promoting optional peers, or supplying omitted peers). Keys support `<name>` or `<name>@<semverRange>` (e.g., `'@rili/ui@1.x'`, matching prerelease versions so multi-version trees can target only the legacy major without affecting host-compatible versions; multiple matches merge per peer with `name-only < range < exact version` precedence). Overridden entry packages participate in conflict detection, alias reuse/installation, and path-scoped subtree collection automatically (while still skipping descendants that only match the host).
- **Alias Installation and Reuse**: Aliases are only auto-installed for dependencies that are "declared by the host project with a version conflict." Undeclared peer dependencies only emit a warning without auto-installation. A matching installed local or workspace alias is reused without registry access or installation; a declared but uninstalled workspace alias is not reusable. If an existing alias directory has the wrong identity or version, the resolver reports a collision and leaves that directory unchanged rather than replacing it.
- **Registry**: An explicit `registry` value controls both remote version resolution and package-manager alias installation; automatic detection is used only when it is omitted.
- **Initialization Failure Policy**. `createResolver()` and the Vite plugin propagate initialization failures to the caller. Webpack logs errors by default and propagates them in strict mode. Webpack watch validates dependency inputs under the project preparation lock and reuses confirmed rules until those inputs change. A failed initialization can be retried on the next watch cycle.

## Advanced Usage

### Hooks

```typescript
depsConflictResolverVitePlugin({
  dependencies: ['legacy-lib'],
  hooks: {
    // After analysis completes
    onAnalysisComplete: (result) => {
      console.log('Found conflicts:', result.peerConflicts);
    },

    // After the installation attempt completes
    onInstallComplete: (mappings) => {
      console.log('Alias mappings after install attempt:', mappings);
    },

    // Custom module resolution
    beforeResolve: (source, importer) => {
      // Return undefined to continue with the default redirect rules
      if (source === 'special-module') {
        return 'custom-alias';
      }
      return undefined;
    },
  },
});
```

`beforeResolve` can return a replacement request. Returning `null` leaves the request to the bundler, and returning `undefined` continues with the automatic redirect rules.

Vite captures `beforeResolve` during configuration resolution, including callbacks registered by `onAnalysisComplete` or `onInstallComplete`. To update behavior from `buildStart`, declare a `beforeResolve` callback up front and update the data it closes over. Both esbuild and Rolldown apply the configured callback to imports within pre-bundled dependencies. To reuse the pre-bundle, use `beforeResolveCacheKey` to identify external state the callback reads, such as environment variables or redirect tables. Changes to the callback source also invalidate the cache. Vite rebuilds the pre-bundle on configuration resolution when a custom callback has no cache key.

`onInstallComplete` runs after an installation attempt and receives only confirmed installed or reused mappings. Use `getInstallResult()` for complete outcomes and `getDiagnostics()` for unresolved conditions.

### Fine-Grained Redirect Control (peerOverrides + includeRedirects + excludeRedirects)

When an upstream package declares an overly broad `peerDependencies` range (e.g., `vue: ">=2.5.17"`, which also satisfies Vue 3), prefer `peerOverrides` to correct its peer constraint so it triggers conflict resolution and covers its entire physical dependency subtree automatically:

```typescript
new DepsConflictResolverWebpackPlugin({
  dependencies: ['@uikit/vue-finder', '@rili/ui'],

  // Correct an overly broad upstream peer range so @rili/ui@1.x and its physical subtree are redirected
  // Supports `<name>` or `<name>@<semverRange>` so newer host-compatible majors (e.g., 2.x) stay untouched
  peerOverrides: {
    '@rili/ui@1.x': { vue: '>=2.5.17 <3' },
  },

  // Optionally force individual package names when needed
  includeRedirects: {
    vue: ['legacy-helper'],
  },

  // Exclude these packages from the redirect list (they use the host's Vue 3 at runtime)
  excludeRedirects: {
    vue: ['vue-demi', 'pinia', '@ks-email/editor'],
  },

  aliasPrefix: 'never-ever-gonna-import-',
  autoInstall: true,
});
```

Priority: `includeRedirects` is applied first, then `excludeRedirects`. If the same package appears in both, `excludeRedirects` wins (not redirected).

### Reusing Existing Aliases

If the project already has aliases installed with suitable versions (e.g., `vue2@npm:vue@2.6.14`), the plugin detects and reuses them before contacting the registry, without reinstalling. Workspace aliases are reusable only when actually installed and when package identity/version validation succeeds. A mismatched existing directory is reported as a collision and left unchanged.

## API Reference

### `createResolver(options): Promise<DepsConflictResolver>`

Creates and initializes a dependency resolver.

### `DepsConflictResolver`

Main resolver class:

- `initialize(): Promise<void>` — Initialize the resolver
- `resolveModule(request, importer): string | null` — Resolve a module
- `getAnalysisResult(): AnalysisResult` — Get the analysis result
- `getDiagnostics(): ResolverDiagnostic[]` - Inspect structured diagnostics
- `getInstallResult(): InstallReport | null` - Inspect verified installation/reuse/failure outcomes
- `explainResolution(request, importer): ResolutionExplanation` - Explain a particular resolution
- `getAliasPathMappings(): AliasPathMapping[]` — Get generic alias path mappings

> The core module returns a generic `AliasPathMapping[]` format, which each build tool plugin (Webpack/Vite) converts to its own alias configuration format.

### Utility Functions

To minimize the public API surface and improve tree-shaking, internal utility functions (semver, fs, npm registry, etc.) are no longer exported from the main entry point. For capabilities like version comparison, use the `semver` package directly.

## Development

```bash
# Install dependencies
pnpm install

# Development mode
pnpm dev

# Build
pnpm build

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Lint
pnpm lint

# Format
pnpm fmt
```

## Release Process

This project uses [release-please](https://github.com/googleapis/release-please) for automated releases:

1. Merge [Conventional Commits](https://www.conventionalcommits.org/) into `main`
2. Release Please creates or updates a release PR when a new version is due
3. Review and merge the release PR to create the GitHub Release and tag
4. The workflow packs and verifies the `.tgz` at the release commit, then publishes that same file to npm via OIDC

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

### Testing preview packages

Opening or updating a PR and pushing to `main` trigger CI. Once all checks pass, [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new) publishes a temporary package. Open a draft PR to build a preview for a branch. PR comments contain commit-specific install commands. The pending release PR also offers an `@main` link. Find install commands in the CI run summary or on the [preview page](https://pkg.pr.new/~/ben-lau/deps-conflict-resolver).

```bash
pnpm add -D https://pkg.pr.new/ben-lau/deps-conflict-resolver/deps-conflict-resolver@main
```

`@main` points to the most recent successful preview. After a new commit, check that its preview has been published. For reproducible testing, use a fixed SHA link and update the lockfile when changing previews. PR CI tests the simulated merge with the target branch. The preview builds the PR head so the contents match the SHA link. Previews expire. Restore a regular release after testing.

With npm 12, enable `--allow-remote=root` when installing a preview URL and on subsequent installs.

## License

MIT
