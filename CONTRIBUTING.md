# Contributing

Thank you for your interest in contributing to `deps-conflict-resolver`!

## Development Setup

### Prerequisites

- Node.js >= 18 (recommended: 22)
- pnpm >= 9

### Getting Started

```bash
# Clone the repository
git clone https://github.com/ben-lau/deps-conflict-resolver.git
cd deps-conflict-resolver

# Install dependencies
pnpm install

# Build the project
pnpm build

# Run tests in watch mode
pnpm test

# Run tests once
pnpm test:run

# Run tests with coverage
pnpm test:coverage
```

## Common Commands

| Command               | Description                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| pnpm test:compat:vite | Check cold optimization and SSR with actual Vue runtimes after building |
| pnpm bench:resolve    | Build and benchmark a resident working set; assert zero realpath calls  |
| pnpm bench:scale      | Compare grouping work, importer working sets, I/O counts and heap use   |
| `pnpm build`          | Build with tsup (CJS + ESM + types)                                     |
| `pnpm dev`            | Build in watch mode                                                     |
| `pnpm test`           | Run tests in watch mode                                                 |
| `pnpm test:run`       | Run tests once                                                          |
| `pnpm test:coverage`  | Run tests with coverage report                                          |
| `pnpm lint`           | Lint with oxlint                                                        |
| `pnpm lint:fix`       | Lint and auto-fix with oxlint                                           |
| `pnpm fmt`            | Format with oxfmt                                                       |
| `pnpm fmt:check`      | Check formatting                                                        |
| `pnpm typecheck`      | TypeScript type checking                                                |
| `pnpm publint`        | Check package publish quality                                           |
| `pnpm attw`           | Check type resolution (arethetypeswrong)                                |
| `pnpm validate`       | Run all checks (lint + fmt + typecheck + test + publint + attw)         |

## Git Hooks

This project uses [lefthook](https://github.com/evilmartians/lefthook) for git hooks:

- **pre-commit**: Runs `oxlint` (`--fix --deny-warnings`) and `oxfmt` (`--write`) on staged files, then re-stages auto-fixes. Coverage matches CI `pnpm lint` / `pnpm fmt:check` (including `.md` / `.yml`); CI still re-checks the full tree.
- **commit-msg**: Runs `commitlint` to enforce conventional commit format.

Hooks are automatically installed when you run `pnpm install` (via the `prepare` script).

## Commit Convention

This project follows [Conventional Commits](https://www.conventionalcommits.org/). All commit messages must match the format:

```
<type>(<scope>): <description>
```

### Commit Types

| Type       | Description                  | Version Bump |
| ---------- | ---------------------------- | ------------ |
| `feat`     | New feature                  | Minor        |
| `fix`      | Bug fix                      | Patch        |
| `perf`     | Performance improvement      | Patch        |
| `refactor` | Code refactoring             | None         |
| `docs`     | Documentation                | None         |
| `test`     | Tests                        | None         |
| `chore`    | Maintenance tasks            | None         |
| `ci`       | CI/CD changes                | None         |
| `build`    | Build system changes         | None         |
| `style`    | Code style (formatting, etc) | None         |

### Breaking Changes

Add `BREAKING CHANGE:` in the commit body or append `!` after the type to trigger a major version bump:

```
feat!: change public API signature

BREAKING CHANGE: `createResolver` now requires a config object instead of positional arguments.
```

### Examples

```
feat: add support for yarn workspaces
fix(core): handle missing peer dependencies gracefully
docs: update API reference in README
chore(deps): bump vitest to v4
```

## Release Process

CI runs on pull requests and pushes to `main`. Open a draft PR to test a work-in-progress branch or build a preview package. The `CI checks` status summarizes all required CI jobs. After it passes, CI publishes the preview to pkg.pr.new.

1. Merge Conventional Commits into `main`. [Release Please](https://github.com/googleapis/release-please) creates or updates a release PR when a new version is due.
2. Review and merge the release PR. If GitHub asks to approve workflow runs on the bot's PR, approve them and wait for `CI checks` to pass.
3. Release Please creates the GitHub Release and tag. The Release workflow then builds the tarball at that commit and verifies it in consumer projects.
4. After verification passes, the workflow publishes that same tarball to npm via OIDC.

To check a candidate without publishing, run **Verify Release** on the desired branch or tag.

```bash
gh workflow run verify-release.yml --ref vX.Y.Z
```

If verification or npm publishing fails after GitHub creates the release, use **Re-run failed jobs** on the original run. If its commit differs from the release tag or the artifact has expired, run **Release** on the existing release tag. The tag must contain this workflow. The workflow verifies a newly packed candidate before publishing it.

```bash
gh workflow run release-please.yml --ref vX.Y.Z
```

## Project Structure

```
src/
  index.ts              # Main entry point (re-exports core + types)
  constants.ts          # Constants
  core/                 # Core logic
    alias-manager.ts        # Indexed, generation-scoped runtime resolution
    alias-peer-resolver.ts  # Selected-version peer linkage
    cli-runner.ts           # doctor / prepare command implementation
    dependency-analyzer.ts  # Recursive dependency tree analysis
    environment-detector.ts # Package manager & registry detection
    registry-client.ts      # npm registry versions and selected manifests
    package-installer.ts    # Alias installation
    resolver.ts             # Main DepsConflictResolver class
    workspace-detector.ts   # pnpm workspace detection
  plugins/
    vite/index.ts       # Vite plugin
    webpack/index.ts    # Webpack plugin
  types/                # TypeScript type definitions
  utils/                # Utility functions
tests/                  # Test files (vitest)
```

## Code Style

- TypeScript with strict mode
- 2-space indentation, single quotes, trailing commas
- Enforced by oxlint (linting) and oxfmt (formatting)
- Run `pnpm fmt` before committing to ensure consistent style

## Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes following the conventions above
4. Ensure all checks pass: `pnpm validate`
5. Submit your pull request
