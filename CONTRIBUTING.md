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

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `pnpm build`         | Build with tsup (CJS + ESM + types)      |
| `pnpm dev`           | Build in watch mode                      |
| `pnpm test`          | Run tests in watch mode                  |
| `pnpm test:run`      | Run tests once                           |
| `pnpm test:coverage` | Run tests with coverage report           |
| `pnpm lint`          | Lint with oxlint                         |
| `pnpm lint:fix`      | Lint and auto-fix with oxlint            |
| `pnpm fmt`           | Format with oxfmt                        |
| `pnpm fmt:check`     | Check formatting                         |
| `pnpm typecheck`     | TypeScript type checking                 |
| `pnpm publint`       | Check package publish quality            |
| `pnpm attw`          | Check type resolution (arethetypeswrong) |

## Git Hooks

This project uses [lefthook](https://github.com/evilmartians/lefthook) for git hooks:

- **pre-commit**: Runs `oxlint` and `oxfmt` on staged files. Auto-fixed changes are re-staged.
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

This project uses [release-please](https://github.com/googleapis/release-please) for automated releases:

1. Merge commits to `main` following conventional commit format
2. release-please automatically creates/updates a Release PR with changelog
3. Review and merge the Release PR
4. A GitHub Release + tag is automatically created
5. Manually run `npm publish` from the tagged release to publish to npm

## Project Structure

```
src/
  index.ts              # Main entry point (re-exports core + types)
  constants.ts          # Constants
  core/                 # Core logic
    alias-manager.ts        # Alias name generation
    dependency-analyzer.ts  # Recursive dependency tree analysis
    environment-detector.ts # Package manager & registry detection
    npm-registry.ts         # npm registry version fetching
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
4. Ensure all checks pass: `pnpm lint && pnpm fmt:check && pnpm typecheck && pnpm test:run`
5. Submit your pull request
