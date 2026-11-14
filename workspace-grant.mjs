/**
 * agent-auto-memory-workspace-grant —— 让「开在项目子目录里的会话」能直接写父项目根。
 *
 * 为什么需要：DSH 的 workspace-write 只放行会话工作区根。会话开在
 * <项目根>\<子目录> 时，父项目根的 AGENTS.md、.agents/topics/、会话总表.md、
 * skills/ 全在可写根之外，普通 write/edit 一律 file access denied，只能提权。
 *
 * 做法：用 sandbox-policy 暴露的正规运行时接口
 *   ctx.sandboxPolicy.registerWritableRoot(session, directory)
 * 按会话把「项目根」注册进额外可写目录。它返回 Cordis effect disposer，卸载即收回；
 * 配置里的 extraRoots 也走同一接口，供不靠 .agents/AGENTS.md 判定的项目使用。
 *
 * 边界（源码已确认，不要夸大）：
 *  - Windows 上额外目录授权只对 harness 文件工具生效，沙箱子进程（bash/pwsh）忽略它，
 *    因此命令里建 .bak、跑脚本仍会被拒 —— 这是平台限制，本插件绕不过去。
 *  - 授权只属于这一个存活 Session；其它会话、子 agent 的会话不继承，
 *    恢复或派生的会话需要自己再注册一次（本插件在 turn/start 会补登记）。
 *  - 项目根判定与 project-writer 完全一致：从会话 header.cwd 向上找最近的、
 *    含 .agents 或 AGENTS.md 的目录，最多上溯 maxLevels 层。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findProjectRoot } from './project-memory-tool.mjs'

export const name = 'agent-auto-memory-workspace-grant'

// 硬注入：sandboxPolicy 不在的组合（headless / minimal）静默不激活，不报错。
export const inject = ['sandboxPolicy']

const DEFAULT_MARKERS = ['.agents', 'AGENTS.md']
const DEFAULT_MAX_LEVELS = 3

/** session -> disposer，避免同一会话每轮重复注册。 */
const granted = new WeakMap()

/** 审计行：每会话一次授权记一行，既是证据也可排障；写失败一律静默。 */
function auditLine(line) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const dirPath = path.join(home, 'logs')
    fs.mkdirSync(dirPath, { recursive: true })
    fs.appendFileSync(path.join(dirPath, 'agent-auto-memory-workspace-grant.log'), new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    /* 审计不能影响会话 */
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const markers = Array.isArray(config.markers) && config.markers.length > 0 ? config.markers : DEFAULT_MARKERS
  const maxLevels = Number.isInteger(config.maxLevels) && config.maxLevels >= 0 ? config.maxLevels : DEFAULT_MAX_LEVELS
  const extraRoots = Array.isArray(config.extraRoots) ? config.extraRoots.filter((r) => typeof r === 'string' && r.trim()) : []
  const audit = config.audit !== false

  const note = (line) => { if (audit) auditLine(line); try { ctx.logger?.debug?.('[' + name + '] ' + line) } catch {} }

  // 加载即记一笔：这是「Host 真的把本行组合进来了」的唯一直接证据。
  note('loaded; markers=' + JSON.stringify(markers) + ' maxLevels=' + maxLevels + ' extraRoots=' + JSON.stringify(extraRoots))

  /** 同步完成判定与注册：findProjectRoot 是纯同步函数，所以不存在「授权晚于首个工具调用」的竞态。 */
  const grant = (session) => {
    try {
      if (!session || granted.has(session)) return
      const cwd = session?.header?.cwd
      const targets = []
      if (typeof cwd === 'string' && cwd.trim() !== '') {
        const root = findProjectRoot(cwd.trim(), markers, maxLevels).root
        if (root !== undefined && path.resolve(root) !== path.resolve(cwd.trim())) targets.push(root)
      }
      // extraRoots 只发给「cwd 落在该根之内」的会话，避免闲聊等无关会话白拿授权。
      if (typeof cwd === 'string' && cwd.trim() !== '') {
        const here = path.resolve(cwd.trim())
        for (const extra of extraRoots.map((r) => path.resolve(r))) {
          if (here === extra || here.startsWith(extra + path.sep)) targets.push(extra)
        }
      }
      if (targets.length === 0) return
      const disposers = []
      for (const target of [...new Set(targets.map((t) => path.resolve(t)))]) {
        try {
          disposers.push(ctx.sandboxPolicy.registerWritableRoot(session, target))
          note('granted ' + target + ' for session ' + (session.id ?? '?'))
        } catch (error) {
          note('skip ' + target + ': ' + (error && error.message))
        }
      }
      if (disposers.length > 0) {
        granted.set(session, () => { for (const dispose of disposers) { try { dispose() } catch {} } })
      }
    } catch (error) {
      /* 静默：授权失败退化为原来的拒绝 + 提权路径，不打断会话 */
      note('failed: ' + (error && error.message))
    }
  }

  // 会话一建立就授权；恢复/派生的会话在下一个 turn/start 补登记。
  ctx.on('session/created', (session) => { grant(session) })
  // 不带 global 选项：与同包 checkpoint.mjs 已验证可用的 session/event 写法保持一致。
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') grant(session)
  })
}
