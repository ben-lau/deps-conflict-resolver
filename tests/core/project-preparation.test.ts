import { afterEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProjectPreparation, withProjectPreparation } from '../../src/core/project-preparation';

const roots: string[] = [];
const children: ChildProcess[] = [];
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-project-lock-')));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"host"}');
  return root;
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Preparation fixture timed out');
    await new Promise((done) => setTimeout(done, 10));
  }
}
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((done) => child.once('close', () => done()));
        child.kill('SIGKILL');
        await closed;
      }
    }),
  );
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('project preparation ownership', () => {
  it('coordinates workspace projects and canonical paths while unrelated projects proceed', async () => {
    const root = fixture();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const app = join(root, 'packages/app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"app"}');
    const linked = join(fixture(), 'linked');
    symlinkSync(app, linked, 'junction');
    const a = getProjectPreparation(app);
    const b = getProjectPreparation(linked);
    expect(a).toBe(b);
    expect(a.owner).toBe(root);
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let started = false;
    const holding = withProjectPreparation(a, async () => {
      started = true;
      await gate;
    });
    await until(() => started);
    try {
      await withProjectPreparation(getProjectPreparation(fixture()), async () => 42);
      let entered = false;
      const waiting = withProjectPreparation(b, async () => {
        entered = true;
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(entered).toBe(false);
      release();
      await Promise.all([holding, waiting]);
    } finally {
      release();
      await holding;
    }
  });

  it('releases ownership after a rejected task', async () => {
    const state = getProjectPreparation(fixture());
    await expect(
      withProjectPreparation(state, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await expect(withProjectPreparation(state, async () => 'ready')).resolves.toBe('ready');
  });

  it('refreshes observers across separately bundled CJS and ESM entry points', () => {
    const root = fixture();
    const cjs = join(root, 'preparation.cjs');
    const esm = join(root, 'preparation.mjs');
    const entryPoints = [resolve('src/core/project-preparation.ts')];
    buildSync({ entryPoints, outfile: cjs, bundle: true, platform: 'node', format: 'cjs' });
    buildSync({
      entryPoints,
      outfile: esm,
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: {
        js: 'import {createRequire as nativeRequire} from "node:module"; const require=nativeRequire(import.meta.url);',
      },
    });
    const script = [
      'import assert from "node:assert/strict"; import {createRequire} from "node:module";',
      'const [cjs,esm,root]=process.argv.slice(1);',
      'const a=createRequire(import.meta.url)(cjs),b=await import(esm);',
      'let refreshed=false;const observer={refresh:async()=>{refreshed=true}};',
      'a.getProjectPreparation(root).observers.add(new WeakRef(observer));',
      'await b.withProjectPreparation(b.getProjectPreparation(root),async changed=>changed());',
      'assert.equal(refreshed,true);',
    ].join('\n');
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script, cjs, pathToFileURL(esm).href, root],
      { timeout: 5000 },
    );
  });

  it.each([false, true])(
    'coordinates separate processes and recovers an exited holder: killed=%s',
    async (killed) => {
      const root = fixture();
      const bundle = join(root, 'preparation.cjs');
      buildSync({
        entryPoints: [resolve('src/core/project-preparation.ts')],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
      });
      const script = [
        'const fs=require("node:fs"),p=require("node:path");',
        'const [bundle,root,id]=process.argv.slice(1);',
        'const {getProjectPreparation,withProjectPreparation}=require(bundle);',
        'setTimeout(()=>process.exit(3),8000).unref();',
        'fs.writeFileSync(p.join(root,id+"queued"),"");',
        'withProjectPreparation(getProjectPreparation(root),async()=>{',
        'fs.appendFileSync(p.join(root,"events"),id+"start\\n");',
        'fs.writeFileSync(p.join(root,id+"started"),"");',
        'if(id==="a")while(!fs.existsSync(p.join(root,"release")))await new Promise(r=>setTimeout(r,10));',
        'fs.appendFileSync(p.join(root,"events"),id+"end\\n");',
        '}).catch(e=>{console.error(e);process.exitCode=1;});',
      ].join('\n');
      function start(id: string) {
        const child = spawn(process.execPath, ['-e', script, bundle, root, id], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(child);
        let stderr = '';
        child.stderr.on('data', (data) => {
          stderr += String(data);
        });
        const done = new Promise<void>((success, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => {
            if (code === 0 || signal === 'SIGKILL') success();
            else reject(new Error('Child failed: ' + code + ' ' + stderr));
          });
        });
        return { child, done };
      }
      const a = start('a');
      await until(() => existsSync(join(root, 'astarted')));
      if (killed) {
        a.child.kill('SIGKILL');
        await a.done;
      }
      const b = start('b');
      if (!killed) {
        await until(() => existsSync(join(root, 'bqueued')));
        await new Promise((done) => setTimeout(done, 100));
        expect(existsSync(join(root, 'bstarted'))).toBe(false);
        writeFileSync(join(root, 'release'), '');
      }
      await Promise.all([a.done, b.done]);
      expect(readFileSync(join(root, 'events'), 'utf8').trim().split('\n')).toEqual(
        killed ? ['astart', 'bstart', 'bend'] : ['astart', 'aend', 'bstart', 'bend'],
      );
    },
  );
});
