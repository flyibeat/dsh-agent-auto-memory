/**
 * 离线单测：用假的 ctx 验证 v2 的逐轮判据，不依赖 DSH 运行时。
 * 工具名与参数来源：tools/pre-execute 的 exec.name / exec.arguments，
 * 以及 session/event 的 tool/call、tool/ptc-dispatch 的 data.name / data.arguments。
 * 运行：node test-offline.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'memckpt-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.DSH_HOME = TMP;

const mod = await import('./checkpoint-entry.js');

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

/** 模拟一次顶层工具调用（走 tools/pre-execute waterfall） */
async function callTool(ctx, sid, toolName, args = {}) {
  const exec = { name: toolName, arguments: args, agent: { session: { id: sid } } };
  const next = async () => ({ ok: true });
  const list = ctx._handlers.get('tools/pre-execute') || [];
  for (const fn of list) await fn(exec, next);
}

/** 模拟一次 PTC 派发（走 session/event，绕过 tools/pre-execute） */
async function ptcDispatch(ctx, sid, toolName, args = {}) {
  await ctx.emit('session/event', { id: sid }, {
    type: 'tool/ptc-dispatch',
    data: { name: toolName, arguments: args },
  });
}

function resetHome(tag) {
  const d = path.join(os.tmpdir(), 'memckpt-' + tag + '-' + Date.now());
  fs.mkdirSync(d, { recursive: true });
  process.env.DSH_HOME = d;
  return d;
}

const textOf = (msg) => String(msg?.content?.[0]?.text || '');

console.log('\n=== 1. 模块形态 ===');
check('导出 apply', typeof mod.apply === 'function');
check('导出 name', mod.name === 'agent-auto-memory-checkpoint');

console.log('\n=== 2. 纯问答（无工具）→ 静默 ===');
{
  resetHome('q'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's1' }, { type: 'turn/start' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's1'), turn: 1 });
  check('未 steer', ctx._steers.length === 0);
}

console.log('\n=== 3. 只读工具 read/grep/glob → 静默 ===');
{
  resetHome('ro'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's2' }, { type: 'turn/start' });
  await callTool(ctx, 's2', 'read');
  await callTool(ctx, 's2', 'grep');
  await callTool(ctx, 's2', 'glob');
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's2'), turn: 1 });
  check('未 steer', ctx._steers.length === 0);
}

console.log('\n=== 4. 写操作 write → 常规提醒一次 ===');
{
  resetHome('w'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's3' }, { type: 'turn/start' });
  await callTool(ctx, 's3', 'write', { file_path: 'D:/work/a.md', content: 'x' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's3'), turn: 1 });
  check('steer 恰好一次', ctx._steers.length === 1);
  const msg = ctx._steers[0];
  check('走常规提醒文案', textOf(msg).includes('记忆沉淀检查'));
  check('消息形态合法（id/role/content/source）',
    typeof msg?.id === 'string' && msg.id.length > 0 &&
    msg?.role === 'user' &&
    Array.isArray(msg?.content) &&
    msg?.source && typeof msg.source.kind === 'string' && msg.source.kind.length > 0);
}

console.log('\n=== 5. bash/edit/ops_bash/pwsh 同样算干活 ===');
{
  for (const t of ['bash', 'edit', 'ops_bash', 'apply_patch', 'pwsh']) {
    resetHome('t-' + t); const ctx = makeCtx(); mod.apply(ctx, {});
    await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
    await callTool(ctx, 's', t, { command: 'echo hi', file_path: 'x' });
    await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
    check(`${t} 触发`, ctx._steers.length === 1);
  }
}

console.log('\n=== 6. 自定义/MCP 工具名兜底匹配 ===');
{
  resetHome('mcp'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'mcp__fs__write_file', {});
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  check('mcp__fs__write_file 触发', ctx._steers.length === 1);
}

console.log('\n=== 7. v2：逐轮判定，不再「全局一天一次」 ===');
{
  resetHome('per-turn'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'write', { file_path: 'a.md' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  check('第 1 轮提醒', ctx._steers.length === 1);

  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'bash', { command: 'ls' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 2 });
  check('第 2 轮仍提醒（旧版这里会静默）', ctx._steers.length === 2);

  await ctx.emit('session/event', { id: 's2' }, { type: 'turn/start' });
  await callTool(ctx, 's2', 'write', { file_path: 'b.md' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's2'), turn: 1 });
  check('另一会话同一天也提醒（旧版这里会静默）', ctx._steers.length === 3);
}

console.log('\n=== 8. v2：已用专用工具写过记忆 → 静默 ===');
{
  for (const t of ['write_shared_memory', 'write_project_memory']) {
    resetHome('mem-' + t); const ctx = makeCtx(); mod.apply(ctx, {});
    await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
    await callTool(ctx, 's', 'write', { file_path: 'a.md' });
    await callTool(ctx, 's', t, { path: 'AGENTS.md', content: 'x', expectedRevision: 'absent' });
    await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
    check(`${t} 已调用 → 不打扰`, ctx._steers.length === 0);
  }
}

console.log('\n=== 9. v2：命令通道直写记忆文件 → 强提醒 ===');
{
  const cases = [
    ['ops_bash', { command: 'python x.py >> ~/.agents/topics/a.md' }],
    ['bash', { command: "echo hi > ~/.agents/topics/通用经验.md" }],
    ['ops_bash', { command: "python -c \"open('/home/u/.agents/AGENTS.md','w').write('x')\"" }],
    ['pwsh', { command: "Set-Content -Path ~/.agents/topics/a.md -Value x" }],
    ['ops_bash', { command: 'cp a.md ~/.agents/topics/b.md' }],
  ];
  for (const [tool, args] of cases) {
    resetHome('sus-' + tool + Math.random()); const ctx = makeCtx(); mod.apply(ctx, {});
    await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
    await callTool(ctx, 's', tool, args);
    await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
    check(`${tool}: ${String(args.command).slice(0, 42)}… 走强提醒`,
      ctx._steers.length === 1 && textOf(ctx._steers[0]).includes('通道检查'));
  }
}

console.log('\n=== 10. v2：纯读取记忆路径 → 不误报强提醒 ===');
{
  const cases = [
    ['ops_bash', { command: 'grep -n "foo" ~/.agents/topics/a.md' }],
    ['ops_bash', { command: 'cat ~/.agents/AGENTS.md | head -20' }],
    ['ops_bash', { command: 'ls -la ~/.agents/topics/' }],
    ['ops_bash', { command: 'stat ~/.agents/topics/a.md' }],
  ];
  for (const [tool, args] of cases) {
    resetHome('ro2-' + Math.random()); const ctx = makeCtx(); mod.apply(ctx, {});
    await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
    await callTool(ctx, 's', tool, args);
    await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
    check(`${String(args.command).slice(0, 40)}… 未误报强提醒`,
      ctx._steers.length === 1 && !textOf(ctx._steers[0]).includes('通道检查'));
  }
}

console.log('\n=== 11. v2：命令碰无关路径 → 常规提醒 ===');
{
  resetHome('unrel'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'ops_bash', { command: 'echo hi > /tmp/x.txt' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  check('走常规提醒', ctx._steers.length === 1 && textOf(ctx._steers[0]).includes('记忆沉淀检查'));
}

console.log('\n=== 12. v2：PTC 派发路径也能识别（不经 tools/pre-execute）===');
{
  resetHome('ptc'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await ptcDispatch(ctx, 's', 'ops_bash', { command: 'python w.py > ~/.agents/topics/x.md' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  check('PTC 路径识别为强提醒', ctx._steers.length === 1 && textOf(ctx._steers[0]).includes('通道检查'));
}

console.log('\n=== 13. v2：同一轮只提醒一次（防重入）===');
{
  resetHome('dedupe'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'write', { file_path: 'a.md' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  check('三轮 turn-stopping 只 steer 一次', ctx._steers.length === 1);
}

console.log('\n=== 14. v2：detectSuspicious:false → 退化为常规提醒 ===');
{
  resetHome('nosus'); const ctx = makeCtx(); mod.apply(ctx, { detectSuspicious: false });
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'ops_bash', { command: 'python x.py > ~/.agents/topics/a.md' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  check('仍提醒但不含「通道检查」',
    ctx._steers.length === 1 && !textOf(ctx._steers[0]).includes('通道检查'));
}

console.log('\n=== 15. 异常不外抛 ===');
{
  resetHome('err'); const ctx = makeCtx(); mod.apply(ctx, {});
  const agent = { session: { id: 's' }, steer: async () => { throw new Error('boom'); } };
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'write', { file_path: 'a.md' });
  let threw = false;
  try { await ctx.emit('agent/turn-stopping', { agent, turn: 1 }); } catch { threw = true; }
  check('未外抛', threw === false);
  check('有 warn 日志', ctx._logs.some(([lv]) => lv === 'warn'));
}

console.log('\n=== 16. tools/pre-execute 必须放行（waterfall）===');
{
  resetHome('wf'); const ctx = makeCtx(); mod.apply(ctx, {});
  const exec = { name: 'read', arguments: {}, agent: { session: { id: 's' } } };
  let called = false;
  const next = async () => { called = true; return { ok: 1 }; };
  const list = ctx._handlers.get('tools/pre-execute') || [];
  for (const fn of list) await fn(exec, next);
  check('调用了 next()', called === true);
}

console.log('\n=== 17. enabled:false → 不挂钩 ===');
{
  resetHome('off'); const ctx = makeCtx(); mod.apply(ctx, { enabled: false });
  check('未注册 turn-stopping', !ctx._handlers.has('agent/turn-stopping'));
}

console.log('\n=== 18. 标记文件位置与内容（仅审计，非闸门）===');
{
  const home = resetHome('mark'); const ctx = makeCtx(); mod.apply(ctx, {});
  await ctx.emit('session/event', { id: 's' }, { type: 'turn/start' });
  await callTool(ctx, 's', 'write', { file_path: 'a.md' });
  await ctx.emit('agent/turn-stopping', { agent: mkAgent(ctx, 's'), turn: 1 });
  const mf = path.join(home, 'logs', 'agent-auto-memory-checkpoint-last.json');
  check('标记文件存在', fs.existsSync(mf));
  if (fs.existsSync(mf)) {
    const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
    check('日期是今天', j.date === new Date().toISOString().slice(0, 10));
    check('含时间戳', typeof j.at === 'string');
    check('含 kind', j.kind === 'remind' || j.kind === 'suspicious');
  }
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
