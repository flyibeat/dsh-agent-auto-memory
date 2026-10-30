/**
 * dsh-memory-checkpoint — 轮末记忆质检插件（替代失效的 Claude Code Stop 钩子）
 *
 * 为什么存在：DSH 桌面端不打包 @deepseek-ai/dsh-hooks-claude-code，
 * 且其依赖的 dsh-hook-protocol 从未进入内核，所以 ~/.dsh/hooks.json 不会被读取。
 * 本插件改用 DSH 原生扩展点 agent/turn-stopping 实现同样的「轮末提醒」。
 *
 * 语义（照抄原钩子的四条判据，宁可少打扰）：
 *   1. 今天已提示过        → 静默
 *   2. 本轮有「改变状态」的
 *      工具调用，且今天
 *      还没提示过          → steer 提示一次并刷新标记
 *   3. 本轮无此类工具活动  → 静默（纯问答/只读不打扰）
 *   4. 任何异常            → 静默放行（绝不因为质检失败而打断对话）
 *
 * 工具名来源：`tools/pre-execute` 的 `exec.name`（`session/event` 的
 * `tool/result` 里只有 `source.callId`，拿不到工具名，不能用作判据）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'memory-checkpoint';

const NS = 'memory-checkpoint';

/** 默认提示语：只在「该沉淀却没沉淀」时出现一次。 */
const DEFAULT_REASON =
  '记忆沉淀检查：今天还没有写过记忆文件。如果本回合产生了新结论、踩了坑、' +
  '被用户纠正，或用户说过「记住」，请先把结论写进记忆文件（' +
  '跨项目→topics/ 或 AGENTS.md，只属本项目→项目 AGENTS.md）再结束；' +
  '确实没有可沉淀的内容，回一句「本轮无新记忆」即可。';

/**
 * 会改变外部状态的工具 = 「干了活」。
 * 纯读取（read/grep/glob/ls）刻意不算：读一圈但没结论的轮次不该被催着写记忆。
 */
const MUTATING_TOOLS = new Set([
  'write', 'edit', 'create', 'delete', 'move', 'copy', 'rename',
  'bash', 'ops_bash', 'shell', 'exec', 'run',
  'apply_patch', 'str_replace', 'multi_edit', 'patch',
  'notebook_edit', 'update_file',
]);

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 标记文件：<DSH_HOME>/logs/memory-checkpoint-last.json */
function markerPaths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dir = path.join(home, 'logs');
  return { dir, file: path.join(dir, 'memory-checkpoint-last.json') };
}

function alreadyPromptedToday() {
  try {
    const { file } = markerPaths();
    if (!fs.existsSync(file)) return false;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return String(j?.date || '') === todayStr();
  } catch {
    return false;
  }
}

function markPrompted() {
  try {
    const { dir, file } = markerPaths();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ date: todayStr(), at: new Date().toISOString() }, null, 2),
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/** 工具名是否属于「改变状态」那一类。 */
function isMutating(toolName) {
  if (!toolName) return false;
  const n = String(toolName).toLowerCase();
  if (MUTATING_TOOLS.has(n)) return true;
  // 兜底：名字里带这些词也算（覆盖 MCP / 自定义工具）
  return /(^|[_-])(write|edit|create|delete|remove|move|copy|patch|exec|bash|shell|run)([_-]|$)/.test(n);
}

export function apply(ctx, config) {
  const reason = config?.reason || DEFAULT_REASON;
  const enabled = config?.enabled !== false;

  if (!enabled) {
    ctx.logger?.debug?.(`[${NS}] disabled by config`);
    return;
  }

  /** sessionId -> 本轮是否出现过写类工具调用 */
  const sawMutation = new Map();

  // 判据来源：per-tool 的 exec.name（唯一能拿到工具名的地方）
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const sid = exec?.agent?.session?.id;
      if (sid && isMutating(exec?.name)) sawMutation.set(sid, true);
    } catch {
      /* 静默：质检不能影响工具执行 */
    }
    return next(); // 这是 waterfall，必须放行
  });

  // 轮次开始 → 重置本轮的「干过活」状态
  ctx.on('session/event', (session, event) => {
    try {
      if (session?.id && event?.type === 'turn/start') sawMutation.set(session.id, false);
    } catch {
      /* 静默 */
    }
  });

  ctx.on('session/disposed', (session) => {
    try {
      if (session?.id) sawMutation.delete(session.id);
    } catch {
      /* 静默 */
    }
  });

  // 轮末质检：本可结束的轮次关闭前运行
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      const sid = agent?.session?.id;
      if (!sid) return;

      if (sawMutation.get(sid) !== true) return; // 判据 3：没干活不打扰
      if (alreadyPromptedToday()) return;        // 判据 1：今天已提示过
      if (!markPrompted()) return;               // 写不了标记就别打扰

      ctx.logger?.info?.(`[${NS}] turn-stopping: reminding once (turn=${turn})`);
      // steer 契约是完整 UserMessage：v4 读取端 assertMessageEventShape 要求
      // id（非空串）、role:'user'、source 对象、content 数组，缺一即判会话 corrupt。
      // 官方 createUserMessage 会自动补 id/role；插件拿不到该内部 API，必须自建全字段。
      await agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: reason }],
        source: { kind: NS },
      });
    } catch (error) {
      // 判据 4：任何异常静默放行，绝不打断对话
      ctx.logger?.warn?.(`[${NS}] turn-stopping check failed: ${String(error)}`);
    }
  });

  ctx.logger?.info?.(`[${NS}] loaded`);
}
