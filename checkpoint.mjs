/**
 * dsh-agent-auto-memory/checkpoint — 轮末记忆质检能力。
 *
 * 为什么存在：DSH 桌面端不打包 @deepseek-ai/dsh-hooks-claude-code，
 * 且其依赖的 dsh-hook-protocol 从未进入内核，所以 ~/.dsh/hooks.json 不会被读取。
 * 本插件改用 DSH 原生扩展点 agent/turn-stopping 实现同样的「轮末提醒」。
 *
 * ===== 语义 v3：三模式 + settled success =====
 * - strict（默认）：有改变状态的工具才做常规检查；
 * - trigger-aware：strict 之外，用户消息命中字面触发词也检查；
 * - manual：只保留命令直写记忆与专用 writer 失败这两类硬提醒。
 *
 * 三档共同规则：专用记忆工具只有 settled 结果成功才算已沉淀；失败不能压掉提醒。
 * 同一 (会话, 轮次) 只提醒一次，去重集合与审计历史均有上限；任何异常静默放行。
 * 用错通道优先于常规提醒，因为它是确定性的硬错误。
 *
 * 工具名与参数来源（两路并用）：
 *   - `tools/pre-execute` 的 exec.name：只覆盖模型直接发起的顶层工具调用；
 *   - `session/event` 的 `tool/call` / `tool/ptc-dispatch` 的 data.name / data.arguments：
 *     PTC 模式下嵌套工具由 dsh-ops 自己的执行层派发，不经过 dsh-tools 的
 *     `prepare()`，`tools/pre-execute` 不会触发，只靠它会漏判。
 *   （`tool/result` 里只有 `source.callId`，拿不到工具名，不能用作判据。）
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NS = 'agent-auto-memory-checkpoint';

/** 常规提醒：只在「该沉淀却没沉淀」时出现。 */
const DEFAULT_REASON =
  '记忆沉淀检查：先判断本轮是否产生了值得沉淀的内容——通用习惯与偏好、可复用的知识点或做法、' +
  '踩过的坑、被用户纠正的判断、用户说「记住」的结论、被推翻的旧事实。有则落盘；确实没有，' +
  '回一句「本轮无新记忆」，不要为应付检查硬写。\n\n' +
  '落盘前先对照你的自动记忆技能：在技能目录里按 description 找描述「自动记忆 / 记忆沉淀 / 记忆分流」' +
  '的那一个（技能名可能变，按能力认、别按名字认），加载它并按其中的工具判据执行。要点：' +
  '共享根（AGENTS.md、topics/*.md）用 write_shared_memory（若可用），' +
  '项目根（AGENTS.md、.agents/topics/*.md）用 write_project_memory（若可用），两者都零提权；' +
  '禁止 bash/python 直写、禁止提权，判据是目标路径形态而不是手顺。';

/** 强提醒：检测到本轮用命令通道碰了记忆文件。 */
const SUSPICIOUS_REASON =
  '通道检查（硬错误）：本轮你在 bash/pwsh/python 命令里碰了记忆文件路径（.agents / topics / AGENTS.md）。\n\n' +
  '写记忆**不要**走命令通道：\n' +
  '- `$DSH_AGENTS_HOME/AGENTS.md`、`topics/<单个>.md` → `write_shared_memory`\n' +
  '- `<项目根>/AGENTS.md`、`<项目根>/.agents/topics/<单个>.md` → `write_project_memory`\n' +
  '- 两者都在宿主进程里直接调 Node fs，**不参与沙箱可写根判定，零提权、不弹审批**。\n\n' +
  '用 bash/python 直写会撞上 `PermissionError` / `file access denied`，再去提权会被审批拦下，' +
  '而且 Windows 子进程根本不吃额外可写根。\n\n' +
  '如果刚才那条命令确实只是**读**这些路径（grep/cat/ls/stat），忽略本提醒即可；' +
  '如果是写，请立刻改用上面的专用工具重做，别把「我的脚本失败了」当成「文件写不了」。';

/**
 * 会改变外部状态的工具 = 「干了活」。
 * 纯读取（read/grep/glob/ls）刻意不算：读一圈但没结论的轮次不该被催着写记忆。
 */
const MUTATING_TOOLS = new Set([
  'write', 'edit', 'create', 'delete', 'move', 'copy', 'rename',
  'bash', 'ops_bash', 'shell', 'exec', 'run', 'pwsh', 'powershell',
  'apply_patch', 'str_replace', 'multi_edit', 'patch',
  'notebook_edit', 'update_file',
]);

/** 走命令通道的工具：需要检查参数里有没有碰记忆文件。 */
const COMMAND_TOOLS = new Set([
  'bash', 'ops_bash', 'shell', 'exec', 'run', 'pwsh', 'powershell',
]);

/** 记忆写入专用工具：调用只记 attempt，settled success 才算已尽责。 */
const MEMORY_TOOLS = new Set(['write_shared_memory', 'write_shared_memory_pair', 'write_project_memory']);

const CHECKPOINT_MODES = new Set(['strict', 'trigger-aware', 'manual']);
const DEFAULT_MODE = 'strict';
const DEFAULT_MAX_REMEMBERED = 256;
const DEFAULT_AUDIT_HISTORY_LIMIT = 100;
const DEFAULT_TRIGGER_WORDS = [
  '记住', '记一下', '记到记忆', '别忘', '以后', '下次', '不要再', '别再', '纠正', '更正',
  'remember', "don't forget", 'do not forget', 'from now on', 'next time',
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function triggerPattern(words) {
  const list = Array.isArray(words) && words.length > 0 ? words : DEFAULT_TRIGGER_WORDS;
  const clean = list.map((item) => String(item || '').trim()).filter(Boolean);
  return clean.length > 0 ? new RegExp(clean.map(escapeRegExp).join('|'), 'i') : null;
}

function messageText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.filter((item) => item?.type === 'text').map((item) => String(item.text || '')).join('\n');
}

/** 记忆文件路径特征。 */
const MEMORY_PATH_RE = /(\.agents[\\/]|\.agents\b|topics[\\/]|AGENTS\.md)/i;

/** 命令里的写意图特征（读操作不会命中，避免误报）。 */
const WRITE_HINT_RE = new RegExp(
  [
    '>>?\\s*\\S',                       // 重定向
    'Set-Content', 'Out-File', 'Add-Content',
    'write_text', 'write_bytes', 'writelines', '\\.write\\s*\\(',
    'open\\s*\\([^)]*[\'"][wax]',        // open(..., 'w')
    '\\bcp\\b', '\\bmv\\b', '\\brm\\b', '\\bmkdir\\b', '\\btouch\\b',
    'Remove-Item', 'Move-Item', 'Copy-Item', 'New-Item',
    '\\btee\\b', '\\bdd\\b',
    'os\\.rename', 'shutil\\.', 'os\\.remove',
  ].join('|'),
  'i',
);

/**
 * 从命令文本里提取「真正会被写入的路径」。
 *
 * 为什么不能只看「文本里出现过记忆路径」：`echo "见 ~/.agents/topics/x.md" > /dev/null`
 * 和 `grep -n foo ~/.agents/topics/x.md > /tmp/o.txt` 都会同时命中「路径特征 + 重定向」，
 * 但它们的写入目标是 /dev/null 与 /tmp/o.txt。误报多了，提醒就会被忽略——
 * 那正好抵消这个检测存在的意义。所以按目标而不是按出现位置判定。
 */
function writeTargets(text) {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const clean = String(p).trim().replace(/^["'`]|["'`]$/g, '');
    if (clean) out.push(clean);
  };

  // 重定向目标：> X / >> X（排除 2>&1 这类 fd 复制）
  for (const m of text.matchAll(/>>?\s*([^\s;&|)"'`]+)/g)) {
    const t = m[1];
    if (/^&\d+$/.test(t)) continue;
    push(t);
  }

  // PowerShell 写文件 cmdlet 的目标
  for (const m of text.matchAll(
    /(?:Set-Content|Out-File|Add-Content|New-Item|Copy-Item|Move-Item|Remove-Item)\b([^;&|]*)/gi,
  )) {
    const seg = m[1];
    const named = seg.match(/-Path\s+("[^"]+"|'[^']+'|\S+)/i);
    if (named) push(named[1]);
    else {
      const pos = seg.trim().split(/\s+/).filter((x) => x && !x.startsWith('-'));
      if (pos.length) push(pos[0]);
    }
  }

  // cp / mv / copy / move：目标取最后一个非选项参数
  for (const m of text.matchAll(/\b(?:cp|mv|copy|move|robocopy)\b([^;&|]*)/gi)) {
    const parts = m[1].trim().split(/\s+/).filter((x) => x && !x.startsWith('-'));
    if (parts.length) push(parts[parts.length - 1]);
  }

  // Python 写模式 open('path', 'w')
  for (const m of text.matchAll(/open\s*\(\s*["']([^"']+)["']\s*,\s*["'][wax]/g)) {
    push(m[1]);
  }

  // 目录类命令：rm -rf X / mkdir X / touch X
  for (const m of text.matchAll(/\b(?:rm|mkdir|touch|del|rmdir)\b([^;&|]*)/gi)) {
    const parts = m[1].trim().split(/\s+/).filter((x) => x && !x.startsWith('-'));
    for (const p of parts) push(p);
  }

  return out;
}

/** 本轮是否「用命令通道写记忆文件」。 */
function looksLikeMemoryWriteViaCommand(toolName, args) {
  const n = String(toolName || '').toLowerCase();
  if (!COMMAND_TOOLS.has(n)) return false;
  const text = argText(args);
  if (!text) return false;
  if (!MEMORY_PATH_RE.test(text)) return false;
  if (!WRITE_HINT_RE.test(text)) return false;

  const targets = writeTargets(text);
  if (targets.length > 0) {
    // 有可解析的写入目标：只有目标本身落在记忆路径上才算
    return targets.some((t) => MEMORY_PATH_RE.test(t));
  }
  // 解析不出目标时保守放行（宁可多提醒一次，也不漏掉真实直写）
  return true;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 标记文件（仅作审计/统计用，不再是「一天一次」的闸门）。 */
function markerPaths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dir = path.join(home, 'logs');
  return {
    dir,
    file: path.join(dir, 'agent-auto-memory-checkpoint-last.json'),
    history: path.join(dir, 'agent-auto-memory-checkpoint-history.json'),
  };
}

/** 记一条审计痕迹；last 供快速体检，history 有界保留；失败不影响功能。 */
function markPrompted(kind, mode, historyLimit) {
  try {
    const { dir, file, history } = markerPaths();
    fs.mkdirSync(dir, { recursive: true });
    const entry = { date: todayStr(), at: new Date().toISOString(), kind, mode };
    fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8');
    if (historyLimit > 0) {
      let rows = [];
      try {
        const value = JSON.parse(fs.readFileSync(history, 'utf8'));
        if (Array.isArray(value)) rows = value;
      } catch {
        /* Missing or corrupt history starts a fresh bounded ledger. */
      }
      rows.push(entry);
      if (rows.length > historyLimit) rows = rows.slice(-historyLimit);
      fs.writeFileSync(history, JSON.stringify(rows, null, 2), 'utf8');
    }
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

/** 参数统一成可检索的文本。 */
function argText(args) {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

export function applyCheckpoint(ctx, config = {}) {
  const reason = config.reason || DEFAULT_REASON;
  const suspiciousReason = config.suspiciousReason || SUSPICIOUS_REASON;
  const enabled = config.enabled !== false;
  const detectSuspicious = config.detectSuspicious !== false;
  const mode = CHECKPOINT_MODES.has(config.mode) ? config.mode : DEFAULT_MODE;
  const triggers = triggerPattern(config.triggerWords);
  const maxRemembered = Number.isInteger(config.maxRemembered) && config.maxRemembered > 0
    ? Math.min(config.maxRemembered, 10000) : DEFAULT_MAX_REMEMBERED;
  const auditHistoryLimit = Number.isInteger(config.auditHistoryLimit) && config.auditHistoryLimit >= 0
    ? Math.min(config.auditHistoryLimit, 1000) : DEFAULT_AUDIT_HISTORY_LIMIT;

  if (!enabled) {
    ctx.logger?.debug?.(`[${NS}] disabled by config`);
    return;
  }

  /** sessionId -> per-turn observation state. */
  const state = new Map();
  /** One reminder per session and turn, with bounded retention for long-lived sessions. */
  const reminded = new Set();
  const reminderOrder = [];
  const remember = (key) => {
    if (reminded.has(key)) return false;
    reminded.add(key);
    reminderOrder.push(key);
    while (reminderOrder.length > maxRemembered) reminded.delete(reminderOrder.shift());
    return true;
  };

  const ensure = (sid) => {
    let st = state.get(sid);
    if (!st) {
      st = { sawMutation: false, wroteMemory: false, memoryWriteFailed: false, suspiciousWrite: false, triggered: false, pendingMemoryCalls: new Map() };
      state.set(sid, st);
    }
    return st;
  };

  /** Observe a call start. A memory attempt is work, but not success yet. */
  const observeCall = (sid, toolName, args, callId) => {
    if (!sid || !toolName) return;
    const st = ensure(sid);
    const n = String(toolName).toLowerCase();
    if (isMutating(toolName) || MEMORY_TOOLS.has(n)) st.sawMutation = true;
    if (MEMORY_TOOLS.has(n) && callId != null) st.pendingMemoryCalls.set(String(callId), n);
    if (detectSuspicious && looksLikeMemoryWriteViaCommand(toolName, args)) st.suspiciousWrite = true;
  };

  /** Mark memory complete only after the durable result says success. */
  const observeMemoryResult = (sid, callId, isError) => {
    if (!sid || callId == null) return;
    const st = ensure(sid);
    const key = String(callId);
    if (!st.pendingMemoryCalls.has(key)) return;
    st.pendingMemoryCalls.delete(key);
    if (isError) st.memoryWriteFailed = true;
    else st.wroteMemory = true;
  };

  // Top-level calls expose name, arguments, and callId before execution.
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      observeCall(exec?.agent?.session?.id, exec?.name, exec?.arguments, exec?.callId);
    } catch {
      /* Quality checks must never block execution. */
    }
    return next();
  });

  // Native calls settle through tool/result; PTC subcalls settle in tool/ptc-dispatch.
  ctx.on('session/event', (session, event) => {
    try {
      if (!session?.id) return;
      if (event?.type === 'turn/start') {
        const st = ensure(session.id);
        st.sawMutation = false;
        st.wroteMemory = false;
        st.memoryWriteFailed = false;
        st.suspiciousWrite = false;
        st.triggered = false;
        st.pendingMemoryCalls.clear();
        return;
      }
      if (event?.type === 'user/message') {
        const message = event?.data?.message || event?.data;
        const sourceKind = message?.source?.kind;
        if ((sourceKind === 'user' || sourceKind == null) && triggers?.test(messageText(message))) {
          ensure(session.id).triggered = true;
        }
        return;
      }
      if (event?.type === 'tool/call') {
        observeCall(session.id, event?.data?.name, event?.data?.arguments, event?.data?.callId);
        return;
      }
      if (event?.type === 'tool/result') {
        const block = event?.data?.message?.content?.find?.((item) => item?.type === 'tool-result');
        observeMemoryResult(session.id, block?.toolCallId, block?.isError === true);
        return;
      }
      if (event?.type === 'tool/ptc-dispatch') {
        const callId = event?.data?.subCallId;
        observeCall(session.id, event?.data?.name, event?.data?.arguments, callId);
        observeMemoryResult(session.id, callId, event?.data?.isError === true);
      }
    } catch {
      /* Silent by design. */
    }
  });

  ctx.on('session/disposed', (session) => {
    try {
      if (session?.id) {
        state.delete(session.id);
        for (const k of reminded) {
          if (k.startsWith(`${session.id}#`)) reminded.delete(k);
        }
      }
    } catch {
      /* 静默 */
    }
  });

  // 轮末质检：本可结束的轮次关闭前运行
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      const sid = agent?.session?.id;
      if (!sid) return;

      const st = state.get(sid);
      if (!st) return;
      if (st.wroteMemory === true) return;   // 专用工具已成功落盘
      const eligible = mode === 'strict'
        ? st.sawMutation === true
        : mode === 'trigger-aware'
          ? (st.sawMutation === true || st.triggered === true)
          : (st.suspiciousWrite === true || st.memoryWriteFailed === true);
      if (!eligible) return;

      const key = `${sid}#${turn}`;
      if (reminded.has(key)) return;         // 同轮只提醒一次

      let text;
      let kind;
      if (st.suspiciousWrite === true) {     // 判据 3：用错通道，硬错误
        text = suspiciousReason;
        kind = 'suspicious';
      } else {                               // 判据 4：干了活但没写记忆
        text = reason;
        kind = 'remind';
      }

      if (!remember(key)) return;
      ctx.logger?.info?.(`[${NS}] turn-stopping: ${kind} (mode=${mode}, turn=${turn})`);
      // steer 契约是完整 UserMessage：v4 读取端 assertMessageEventShape 要求
      // id（非空串）、role:'user'、source 对象、content 数组，缺一即判会话 corrupt。
      // 官方 createUserMessage 会自动补 id/role；插件拿不到该内部 API，必须自建全字段。
      await agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: NS },
      });
      markPrompted(kind, mode, auditHistoryLimit);
    } catch (error) {
      // 判据 6：任何异常静默放行，绝不打断对话
      ctx.logger?.warn?.(`[${NS}] turn-stopping check failed: ${String(error)}`);
    }
  });

  ctx.logger?.info?.(`[${NS}] loaded (mode=${mode}, maxRemembered=${maxRemembered}, auditHistoryLimit=${auditHistoryLimit})`);
}
