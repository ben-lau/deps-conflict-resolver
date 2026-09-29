# deps-conflict-resolver

[![npm version](https://img.shields.io/npm/v/deps-conflict-resolver.svg)](https://www.npmjs.com/package/deps-conflict-resolver)
[![CI](https://github.com/ben-lau/deps-conflict-resolver/actions/workflows/ci.yml/badge.svg)](https://github.com/ben-lau/deps-conflict-resolver/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/ben-lau/deps-conflict-resolver/branch/main/graph/badge.svg)](https://codecov.io/gh/ben-lau/deps-conflict-resolver)

> [中文文档](./README.md)

A Webpack and Vite plugin that automatically resolves peer dependency conflicts by creating aliases for conflicting versions, allowing different versions of the same dependency to coexist.

## Features

- **Recursive Dependency Analysis**: Deep traversal of the entire dependency tree, including nested sub-dependencies, while preserving nested instances by their installed paths
- **Smart Conflict Detection**: Automatically identifies peer dependency version conflicts against the host project
- **Automatic Alias Installation**: Creates aliases for conflicting dependencies and installs the appropriate versions
- **Module Resolution Redirection**: At build time, redirects module imports from conflicting libraries to their aliased versions
- **Remote Version Querying**: Fetches version lists from the npm registry and intelligently selects the best version
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

| Option             | Type                                  | Default         | Description                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependencies`     | `string[]`                            | -               | **Required.** List of package names to analyze                                                                                                                                                                                                                  |
| `projectRoot`      | `string`                              | `process.cwd()` | Project root directory path                                                                                                                                                                                                                                     |
| `autoInstall`      | `boolean`                             | `true`          | Whether to auto-install missing aliased dependencies                                                                                                                                                                                                            |
| `packageManager`   | `'auto' \| 'npm' \| 'yarn' \| 'pnpm'` | `'auto'`        | Package manager type. `'auto'` detects automatically                                                                                                                                                                                                            |
| `registry`         | `string`                              | Auto-detected   | npm registry URL; an explicit value is used for both version queries and alias installation                                                                                                                                                                     |
| `debug`            | `boolean`                             | `false`         | Whether to enable debug logging                                                                                                                                                                                                                                 |
| `aliasPrefix`      | `string`                              | `'aliased-'`    | Prefix for generated alias names                                                                                                                                                                                                                                |
| `excludeRedirects` | `Record<string, string[]>`            | `{}`            | Exclude specific packages from the redirect list. Keys are original package names, values are importer package names to exclude. Example: `{ vue: ['vue-demi', 'pinia'] }`                                                                                      |
| `includeRedirects` | `Record<string, string[]>`            | `{}`            | Force specific packages into the redirect list. Applied before `excludeRedirects`. Useful when semver ranges are too broad (e.g., `>=2.5.0`) but the package still needs the older version at runtime. Example: `{ vue: ['@rili/ui', '@kmt/meeting-setting'] }` |

### Vite Plugin Exclusive Options

| Option          | Type      | Default | Description                                |
| --------------- | --------- | ------- | ------------------------------------------ |
| `enableInDev`   | `boolean` | `true`  | Whether to enable in development mode      |
| `enableInBuild` | `boolean` | `true`  | Whether to enable in production build mode |

### Auto-Detection

The plugin supports automatic detection of the package manager and registry:

**Package Manager Detection Priority:**

1. `packageManager` field in `package.json` (e.g., `"pnpm@8.0.0"`)
2. Lock file presence (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm)
3. Falls back to npm

**Registry Detection Priority:**

1. Project-level `.npmrc` file
2. User-level `~/.npmrc` file
3. User-level `.pnpmrc` for pnpm or `.yarnrc.yml` in yarn projects
4. Falls back to `https://registry.npmjs.org`

An explicit `registry` option overrides this detection. The resolver uses it for remote version queries, and the package manager uses the same registry when installing aliases.

## How It Works

### 1. Dependency Analysis

The plugin recursively analyzes the entire dependency tree of the specified packages:

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

- **Conflict Detection Scope**: Only the first-level `peerDependencies` of user-specified `dependencies` are checked for version conflicts against the host project. Sub-dependency `peerDependencies` still contribute to graph construction and runtime redirect matching, but do not independently trigger alias installation. First-level peers marked `optional: true` are skipped entirely: they produce no conflict, missing-peer warning, or alias.
- **Redirect Scope**: Packages that declare conflicting peers and all their sub-dependencies (`dependencies` + `peerDependencies` recursively) are added to the redirect candidate list. The conflict target packages themselves (e.g., `vue`, `vue-router`) are automatically excluded during collection to prevent host project imports from being incorrectly redirected.
- **Nested Versions**: The installed dependency graph is keyed by normalized package directories, and each child is resolved relative to its owning package. Nested instances with the same name but different versions remain distinct; generated redirect rules prefer importer-path matching. Consequently, `excludeRedirects` applies to concrete package instances and their subtrees rather than globally deduplicating by name.
- **`excludeRedirects`**: Removes specified packages from the redirect candidate list. Useful for shared packages (e.g., `vue-demi`, `pinia`) that actually use the host's Vue 3 version at runtime.
- **`includeRedirects`**: Forces specified packages into the redirect list. Useful when semver ranges are too broad (e.g., `vue: ">=2.5.0"` satisfies both Vue 2 and Vue 3) but the package still needs the older version at runtime. `includeRedirects` is applied before `excludeRedirects`.
- **Alias Installation and Reuse**: Aliases are only auto-installed for dependencies that are "declared by the host project with a version conflict." Undeclared peer dependencies only emit a warning without auto-installation. A matching installed local or workspace alias is reused without registry access or installation; a declared but uninstalled workspace alias is not reusable. If an existing alias directory has the wrong identity or version, the resolver reports a collision and leaves that directory unchanged rather than replacing it.
- **Registry**: An explicit `registry` value controls both remote version resolution and package-manager alias installation; automatic detection is used only when it is omitted.
- **Initialization Failure Policy**: `createResolver()` and the Vite plugin propagate initialization failures to the caller. The Webpack plugin remains fail-open: initialization or module-resolution errors are logged and compilation continues without aliases for that generation. Each Webpack `watchRun` invalidates the previous generation, waits for a fresh analysis, and can retry on the next watch cycle if initialization fails.

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
      // Return a new module name, or null to skip
      if (source === 'special-module') {
        return 'custom-alias';
      }
      return null;
    },
  },
});
```

`onInstallComplete` runs after the installation attempt; its argument is the alias mappings produced by that analysis and does not guarantee that every mapping was installed successfully (reused, installed, and failed outcomes must be checked in logs or installation results).

### Fine-Grained Redirect Control (includeRedirects + excludeRedirects)

When a project contains both Vue 2 and Vue 3 dependencies, auto-detection may not accurately distinguish them. Use these two options for manual control:

```typescript
new DepsConflictResolverWebpackPlugin({
  dependencies: ['@uikit/vue-finder', '@rili/ui'],

  // Force these packages (broad semver range, but actually need Vue 2) into the redirect list
  includeRedirects: {
    vue: ['@rili/ui', '@kmt/meeting-setting'],
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

1. Merge commits to `main` following [Conventional Commits](https://www.conventionalcommits.org/)
2. release-please automatically creates/updates a Release PR with changelog
3. Review and merge the Release PR
4. A GitHub Release + tag is automatically created
5. Manually run `npm publish` to publish to npm

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

MIT
