import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/core/cli-runner';
import { resetGlobalLogLevel } from '../../src/utils/logger';
import { clearPackageJsonCache } from '../../src/utils/fs';

describe('doctor and prepare commands', () => {
  let root: string;
  let stdout: string;
  let stderr: string;
  const output = {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  };

  function writeAlias(): void {
    const directory = join(root, 'node_modules/vue2');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'vue', version: '2.7.16' }),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deps-cli-'));
    stdout = '';
    stderr = '';
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'host',
        dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.7.16' },
      }),
    );
    for (const [name, manifest] of Object.entries({
      legacy: { name: 'legacy', version: '1.0.0', peerDependencies: { vue: '^2.0.0' } },
      vue: { name: 'vue', version: '3.5.0' },
    })) {
      const directory = join(root, 'node_modules', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetGlobalLogLevel();
    clearPackageJsonCache();
    vi.restoreAllMocks();
  });

  it('emits clean JSON, discovers runtime dependencies, and leaves files unchanged', async () => {
    writeAlias();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const before = readFileSync(join(root, 'package.json'), 'utf8');
    const code = await runCli(
      ['doctor', '--root', root, '--offline', '--strict', '--json'],
      output,
    );
    const report = JSON.parse(stdout);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(report.dependencies).toEqual(['legacy', 'vue']);
    expect(report.activeAliases).toEqual([expect.objectContaining({ aliasName: 'vue2' })]);
    expect(report.diagnostics).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
  });

  it('returns a failing strict status with machine-readable unresolved diagnostics', async () => {
    const code = await runCli(
      ['doctor', 'legacy', '--root', root, '--offline', '--strict', '--json'],
      output,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'OFFLINE_ALIAS_MISSING' })]),
    );
  });

  it('allows a non-strict doctor to report issues without failing the command', async () => {
    const code = await runCli(['doctor', 'legacy', '--root', root, '--offline'], output);
    expect(code).toBe(0);
    expect(stdout).toContain('OFFLINE_ALIAS_MISSING');
  });

  it('requires explicit package selection before prepare can write dependencies', async () => {
    expect(await runCli(['prepare', '--root', root], output)).toBe(1);
    expect(stderr).toContain('requires at least one dependency');
  });

  it('keeps prepare offline when requested', async () => {
    writeAlias();
    const code = await runCli(['prepare', 'legacy', '--root', root, '--offline', '--json'], output);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).installation).toBeNull();
  });

  it.each([['--unknown'], ['--root'], ['--package-manager', 'unknown']])(
    'rejects invalid options %j',
    async (...args) => {
      expect(await runCli(['doctor', ...args, '--json'], output)).toBe(1);
      expect(JSON.parse(stdout).error).toBeTypeOf('string');
    },
  );

  it('prints help without analyzing the project', async () => {
    expect(await runCli(['--help'], output)).toBe(0);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('--offline');
  });
});
