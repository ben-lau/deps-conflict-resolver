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
  it('runs readers concurrently while an earlier writer blocks later readers', async () => {
    const root = fixture();
    const bundle = join(root, 'preparation.cjs');
    buildSync({
      entryPoints: [resolve('src/core/project-preparation.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
    });
    const script = String.raw`
      const fs = require('node:fs'), path = require('node:path');
      const [bundle, root, id, mode] = process.argv.slice(1);
      const flag = (name) => path.join(root, id + '-' + name);
      const rename = fs.promises.rename;
      fs.promises.rename = async (...args) => {
        await rename(...args);
        fs.writeFileSync(flag('queued'), '');
      };
      const {getProjectPreparation, withProjectPreparation} = require(bundle);
      withProjectPreparation(getProjectPreparation(root), async () => {
        fs.writeFileSync(flag('entered'), '');
        while (!fs.existsSync(flag('release'))) await new Promise(done => setTimeout(done, 10));
      }, undefined, mode).catch(error => { console.error(error); process.exitCode = 1 });
    `;
    const start = (id: string, mode: string) => {
      const child = spawn(process.execPath, ['-e', script, bundle, root, id, mode], {
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
        stdio: 'inherit',
      });
      children.push(child);
      return {
        queued: () => existsSync(join(root, id + '-queued')),
        entered: () => existsSync(join(root, id + '-entered')),
        release: () => writeFileSync(join(root, id + '-release'), ''),
        done: new Promise<number | null>((done) => child.once('close', done)),
      };
    };
    const first = start('first', 'read');
    const second = start('second', 'read');
    await until(() => first.entered() && second.entered());
    const writer = start('writer', 'write');
    await until(writer.queued);
    const last = start('last', 'read');
    await until(last.queued);
    expect(writer.entered()).toBe(false);
    expect(last.entered()).toBe(false);
    first.release();
    expect(await first.done).toBe(0);
    expect(writer.entered()).toBe(false);
    second.release();
    await until(writer.entered);
    expect(last.entered()).toBe(false);
    writer.release();
    await until(last.entered);
    last.release();
    expect(await Promise.all([second.done, writer.done, last.done])).toEqual([0, 0, 0]);
  }, 10_000);

  it.each(['unpublished', 'choosing', 'numbered'] as const)(
    'recovers a process killed at the %s publication boundary without stealing a live lock',
    async (phase) => {
      const root = fixture();
      const bundle = join(root, 'preparation.cjs');
      buildSync({
        entryPoints: [resolve('src/core/project-preparation.ts')],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
      });
      const script = String.raw`
        const fs=require('node:fs'),path=require('node:path');
        const [bundle,root,id,phase]=process.argv.slice(1);
        if(id==='publisher'){
          for(const method of ['link','rename']){
            const original=fs.promises[method].bind(fs.promises);
            fs.promises[method]=async(...args)=>{
              const pause=()=>{fs.writeFileSync(path.join(root,'paused'),'');return new Promise(()=>{})};
              if(method==='link'&&phase==='unpublished')await pause();
              const result=await original(...args);
              if((method==='link'&&phase==='choosing')||(method==='rename'&&phase==='numbered'))await pause();
              return result;
            };
          }
        }else{
          const readdir=fs.promises.readdir.bind(fs.promises);let polls=0;
          fs.promises.readdir=async(...args)=>{
            fs.writeFileSync(path.join(root,'polls'),String(++polls));
            return readdir(...args);
          };
        }
        const {getProjectPreparation,withProjectPreparation}=require(bundle);
        const timeout=setTimeout(()=>process.exit(3),8000);
        withProjectPreparation(getProjectPreparation(root),async()=>{
          fs.writeFileSync(path.join(root,id+'-entered'),'');
        }).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>clearTimeout(timeout));
      `;
      function start(id: string) {
        const child = spawn(process.execPath, ['-e', script, bundle, root, id, phase], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
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
      const publisher = start('publisher');
      await until(() => existsSync(join(root, 'paused')));
      const waiter = start('waiter');
      if (phase === 'unpublished') {
        await until(() => existsSync(join(root, 'waiter-entered')));
      } else {
        await until(
          () =>
            existsSync(join(root, 'polls')) &&
            Number(readFileSync(join(root, 'polls'), 'utf8')) >= 3,
        );
        expect(existsSync(join(root, 'waiter-entered'))).toBe(false);
      }
      expect(existsSync(join(root, 'publisher-entered'))).toBe(false);
      publisher.child.kill('SIGKILL');
      await publisher.done;
      await waiter.done;
      expect(existsSync(join(root, 'waiter-entered'))).toBe(true);
    },
    10_000,
  );

  it('recovers when the process reclaiming an exited holder is also killed', async () => {
    const root = fixture();
    const bundle = join(root, 'preparation.cjs');
    buildSync({
      entryPoints: [resolve('src/core/project-preparation.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    const script = String.raw`
      const fs=require('node:fs'),path=require('node:path');
      const [bundle,root,id,deadPid]=process.argv.slice(1);
      const unlink=fs.promises.unlink.bind(fs.promises);
      fs.promises.unlink=async(file)=>{
        let isDeadOwner=false;
        try {isDeadOwner=JSON.parse(fs.readFileSync(file,'utf8')).pid===Number(deadPid)} catch {}
        if(id==='recoverer'&&isDeadOwner){
          fs.writeFileSync(path.join(root,'recovering'),'');
          await new Promise(()=>{});
        }
        return unlink(file);
      };
      const {getProjectPreparation,withProjectPreparation}=require(bundle);
      const timeout=setTimeout(()=>process.exit(3),8000);
      withProjectPreparation(getProjectPreparation(root),async()=>{
        fs.writeFileSync(path.join(root,id+'-entered'),'');
        if(id==='holder')await new Promise(()=>{});
        const sentinel=path.join(root,'active');
        fs.closeSync(fs.openSync(sentinel,'wx'));
        fs.appendFileSync(path.join(root,'events'),id+' start\n');
        await new Promise(done=>setTimeout(done,20));
        fs.appendFileSync(path.join(root,'events'),id+' end\n');
        fs.unlinkSync(sentinel);
      }).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>clearTimeout(timeout));
    `;
    function start(id: string, deadPid = 0) {
      const child = spawn(process.execPath, ['-e', script, bundle, root, id, String(deadPid)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
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
    const holder = start('holder');
    await until(() => existsSync(join(root, 'holder-entered')));
    holder.child.kill('SIGKILL');
    await holder.done;
    const recoverer = start('recoverer', holder.child.pid);
    await until(() => existsSync(join(root, 'recovering')));
    recoverer.child.kill('SIGKILL');
    await recoverer.done;
    const waiters = Array.from({ length: 4 }, (_, index) => start('waiter' + index));
    await Promise.all(waiters.map((waiter) => waiter.done));
    const events = readFileSync(join(root, 'events'), 'utf8').trim().split('\n');
    expect(events).toHaveLength(8);
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index + 1]).toBe(events[index]!.replace(' start', ' end'));
    }
  }, 15_000);

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
