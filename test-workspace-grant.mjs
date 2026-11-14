/**
 * 离线单测：workspace-grant 的项目根判定与注册行为，用假 ctx 与自建临时夹具，
 * 不依赖 DSH 运行时，也不依赖本仓库目录里有没有 .agents / AGENTS.md。
 * 运行：node test-workspace-grant.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('./workspace-grant-entry.js');
const { findProjectRoot } = await import('./project-memory-tool.mjs');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
};

// 显式基准目录：有的执行环境没有 TEMP/TMP 环境变量，os.tmpdir() 会返回异常路径。
const TMP_BASE = process.env.TEMP || process.env.TMP || os.tmpdir();
const TMP = path.join(TMP_BASE, 'wsgrant-' + Date.now());
const PROJ = path.join(TMP, 'proj');
fs.mkdirSync(path.join(PROJ, '.agents', 'topics'), { recursive: true });
fs.mkdirSync(path.join(PROJ, 'sub', 'deeper'), { recursive: true });
const BARE = path.join(TMP, 'bare');
fs.mkdirSync(BARE, { recursive: true });

function makeCtx() {
  const handlers = new Map();
  const registered = [];
  return {
    registered,
    ctx: {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); return () => {}; },
      sandboxPolicy: { registerWritableRoot(session, dir) { registered.push({ session, dir }); return () => {}; } },
    },
    fire(ev, ...args) { for (const fn of handlers.get(ev) ?? []) fn(...args); },
    events() { return [...handlers.keys()]; },
  };
}

console.log('workspace-grant 离线单测');

// 1. 导出契约
check('导出 name', mod.name === 'agent-auto-memory-workspace-grant');
check('inject 含 sandboxPolicy', Array.isArray(mod.inject) && mod.inject.includes('sandboxPolicy'));
check('apply 是函数', typeof mod.apply === 'function');

// 2. 监听事件
{
  const c = makeCtx();
  mod.apply(c.ctx, { audit: false });
  check('监听 session/created', c.events().includes('session/created'));
  check('监听 session/event', c.events().includes('session/event'));
}

// 3. 子目录会话 → 注册父项目根
{
  const c = makeCtx();
  mod.apply(c.ctx, { audit: false });
  const session = { id: 's-sub', header: { cwd: path.join(PROJ, 'sub', 'deeper') } };
  c.fire('session/created', session);
  check('子目录会话注册到含 .agents 的祖先根', c.registered.length === 1 && c.registered[0].dir.toLowerCase() === PROJ.toLowerCase());
  check('注册的是同一个 session 对象', c.registered[0] && c.registered[0].session === session);
}

// 4. 幂等
{
  const c = makeCtx();
  mod.apply(c.ctx, { audit: false });
  const session = { id: 's-dup', header: { cwd: path.join(PROJ, 'sub') } };
  c.fire('session/created', session);
  c.fire('session/event', session, { type: 'turn/start' });
  c.fire('session/event', session, { type: 'turn/start' });
  check('同一会话只注册一次', c.registered.length === 1);
}

// 5. cwd 就是项目根 → 不注册
{
  const c = makeCtx();
  mod.apply(c.ctx, { audit: false });
  c.fire('session/created', { id: 's-root', header: { cwd: PROJ } });
  check('cwd 就是项目根时不注册', c.registered.length === 0);
}

// 6. 找不到标记 → 不注册
{
  const c = makeCtx();
  mod.apply(c.ctx, { audit: false });
  c.fire('session/created', { id: 's-none', header: { cwd: BARE } });
  check('找不到项目根时不注册', c.registered.length === 0);
}

// 7. 无 session cwd → 不抛错、不注册
{
  const c = makeCtx();
  mod.apply(c.ctx, { audit: false });
  let threw = false;
  try { c.fire('session/created', { id: 's-nocwd' }); } catch { threw = true; }
  check('缺 cwd 时不抛错且不注册', !threw && c.registered.length === 0);
}

// 8. extraRoots 只发给落在其内的会话
{
  const extra = path.join(TMP, 'extra');
  fs.mkdirSync(path.join(extra, 'inner'), { recursive: true });
  const c = makeCtx();
  mod.apply(c.ctx, { audit: false, extraRoots: [extra] });
  c.fire('session/created', { id: 's-in', header: { cwd: path.join(extra, 'inner') } });
  check('cwd 在 extraRoots 内 → 注册 extraRoot', c.registered.some(r => r.dir.toLowerCase() === extra.toLowerCase()));

  const c2 = makeCtx();
  mod.apply(c2.ctx, { audit: false, extraRoots: [extra] });
  c2.fire('session/created', { id: 's-out', header: { cwd: BARE } });
  check('cwd 不在 extraRoots 内 → 不注册', c2.registered.length === 0);
}

// 9. enabled=false 关闭
{
  const c = makeCtx();
  mod.apply(c.ctx, { enabled: false });
  check('enabled=false 不挂任何监听', c.events().length === 0);
}

// 10. registerWritableRoot 抛错时不打断会话
{
  const handlers = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); return () => {}; },
    sandboxPolicy: { registerWritableRoot() { throw new Error('boom'); } },
  };
  mod.apply(ctx, { audit: false });
  let threw = false;
  try { for (const fn of handlers.get('session/created') ?? []) fn({ id: 's-err', header: { cwd: path.join(PROJ, 'sub') } }); } catch { threw = true; }
  check('注册失败被吞掉、不打断会话', !threw);
}

// 11. findProjectRoot 契约
{
  const located = findProjectRoot(path.join(PROJ, 'sub', 'deeper'), ['.agents', 'AGENTS.md'], 3);
  check('findProjectRoot 上溯到含标记的祖先', located.root && located.root.toLowerCase() === PROJ.toLowerCase());
  check('findProjectRoot 返回 inspected 列表', Array.isArray(located.inspected) && located.inspected.length > 0);
  const tooDeep = findProjectRoot(path.join(PROJ, 'sub', 'deeper'), ['.agents', 'AGENTS.md'], 0);
  check('maxLevels=0 时只看自身、找不到就返回 undefined', tooDeep.root === undefined);
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
