/**
 * 离线单测：用假的 ctx 验证四条判据，不依赖 DSH 运行时。
 * 工具名来源已修正为 tools/pre-execute 的 exec.name。
 * 运行：node test-offline.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'memckpt-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.DSH_HOME = TMP;

const mod = await import('./index.js');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
};

function makeCtx() {
  const handlers = new Map();
  const logs = [];
  const steers = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      debug: (m) => logs.push(['debug', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    async emit(ev, ...args) {
      const list = handlers.get(ev) || [];
      return Promise.all(list.map((f) => f(...args)));
    },
    _logs: logs, _steers: steers, _handlers: handlers,
  };
  return ctx;
}

function mkAgent(ctx, sessionId) {
  return {
    session: { id: sessionId },
    steer: async (t) => { ctx._steers.push(t); },
  };
}

/** 模拟一次工具调用（走 tools/pre-execute waterfall） */
async function callTool(ctx, sid, toolName) {
  const exec = { name: toolName, arguments: {}, agent: { session: { id: sid } } };
  const next = async () => ({ ok: true });
  const list = ctx._handlers.get('tools/pre-execute') || [];
  for (const fn of list) await fn(exec, next);
}

function resetHome(tag) {
  const d = path.join(os.tmpdir(), 'memckpt-' + tag + '-' + Date.now());
  fs.mkdirSync(d, { recursive: true });
  process.env.DSH_HOME = d;
  return d;
}

console.log('\n=== 1. 模块形态 ===');
check('导出 apply', typeof mod.apply === 'function');
check('导出 name', mod.name === 'memory-checkpoint');

console.log('\n=== 2. 纯问答（无工具）→ 静默 ===');
{
  resetHome('q'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's1' }, { type: 'turn/start' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's1'), turn: 1 });
  check('未 steer', ctx._steers.length === 0);
}

console.log('\n=== 3. 只读工具 read/grep → 静默 ===');
{
  resetHome('ro'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's2' }, { type: 'turn/start' });
  await callTool(ctx, 's2', 'read');
  await callTool(ctx, 's2', 'grep');
  await callTool(ctx, 's2', 'glob');
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's2'), turn: 1 });
  check('未 steer', ctx._steers.length === 0);
}

console.log('\n=== 4. 写操作 write → 提示一次 ===');
{
  resetHome('w'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's3' }, { type: 'turn/start' });
  await callTool(ctx, 's3', 'write');
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's3'), turn: 1 });
  check('steer 恰好一次', ctx._steers.length === 1);
  // steer 现在传完整 UserMessage 对象（id/role/content/source），文本在 content[0].text
  const msg = ctx._steers[0];
  check('提示语正确', typeof msg === 'object' && String(msg?.content?.[0]?.text || '').includes('记忆沉淀检查'));
  check('消息形态合法（id/role/content/source）',
    typeof msg?.id === 'string' && msg.id.length > 0 &&
    msg?.role === 'user' &&
    Array.isArray(msg?.content) &&
    msg?.source && typeof msg.source.kind === 'string' && msg.source.kind.length > 0);
}

console.log('\n=== 5. bash/edit/ops_bash 同样算干活 ===');
{
  for (const t of ['bash', 'edit', 'ops_bash', 'apply_patch']) {
    resetHome('t-' + t); const ctx = makeCtx(); mod.apply(ctx, {});
    await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
    await callTool(ctx, 's', t);
    await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
    check(`${t} 触发`, ctx._steers.length === 1);
  }
}

console.log('\n=== 6. 自定义/MCP 工具名兜底匹配 ===');
{
  resetHome('mcp'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'mcp__fs__write_file');
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  check('mcp__fs__write_file 触发', ctx._steers.length === 1);
}

console.log('\n=== 7. 一天最多提示一次 ===');
{
  resetHome('once'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'write');
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  const before = ctx._steers.length;
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'bash');
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 2 });
  check('第二轮未再提示', ctx._steers.length === before);
}

console.log('\n=== 8. 异常不外抛 ===');
{
  resetHome('err'); const ctx = makeCtx(); mod.apply(ctx, {});
  const agent = { session: { id: 's' }, steer: async () => { throw new Error('boom'); } };
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'write');
  let threw = false;
  try { await ctx.emit('agent/turn-stopping', { agent, turn: 1 }); } catch { threw = true; }
  check('未外抛', threw === false);
  check('有 warn 日志', ctx._logs.some(([lv]) => lv === 'warn'));
}

console.log('\n=== 9. tools/pre-execute 必须放行（waterfall）===');
{
  resetHome('wf'); const ctx = makeCtx(); mod.apply(ctx, {});
  const exec = { name: 'read', arguments: {}, agent: { session: { id: 's' } } };
  let called = false;
  const next = async () => { called = true; return { ok: 1 }; };
  const list = ctx._handlers.get('tools/pre-execute') || [];
  for (const fn of list) await fn(exec, next);
  check('调用了 next()', called === true);
}

console.log('\n=== 10. enabled:false → 不挂钩 ===');
{
  resetHome('off'); const ctx = makeCtx(); mod.apply(ctx, { enabled: false });
  check('未注册 turn-stopping', !ctx._handlers.has('agent/turn-stopping'));
}

console.log('\n=== 11. 标记文件位置与内容 ===');
{
  const home = resetHome('mark'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'write');
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  const mf = path.join(home, 'logs', 'memory-checkpoint-last.json');
  check('标记文件存在', fs.existsSync(mf));
  if (fs.existsSync(mf)) {
    const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
    check('日期是今天', j.date === new Date().toISOString().slice(0, 10));
    check('含时间戳', typeof j.at === 'string');
  }
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
