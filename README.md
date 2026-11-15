# dsh-agent-auto-memory

DeepSeek Harness（DSH）的自动记忆基础设施插件，与 Agent Skill `agent-auto-memory` 配套使用。

## 分工

- **Skill：agent-auto-memory** —— 告诉 Agent 什么值得记、跨项目/项目级怎么分流、怎样判重、维护索引与控制预算。
- **插件：dsh-agent-auto-memory** —— 提供程序层能力：轮末漏写提醒 + 最小权限共享记忆写入 + 所属项目的项目级记忆写入。

插件不总结对话，也不自行决定记什么；内容决策始终由 Agent 按 Skill 执行。

## 一个包，三项独立能力

Bundle 安装三个 Cordis 插件行，可在插件管理器分别启停：

| 行 ID | 能力 | 默认 |
|---|---|---|
| `agent-auto-memory-checkpoint` | 在 `agent/turn-stopping` 逐轮检查是否可能漏写记忆，或是否用命令通道直写了记忆文件，必要时 steer 提醒 | 开 |
| `agent-auto-memory-writer` | 注册 `write_shared_memory`，只写共享 Agent 记忆根 | 开 |
| `agent-auto-memory-project-writer` | 注册 `write_project_memory`，写会话所属项目的 `AGENTS.md` 与 `.agents/topics/` | 开 |

也可在 profile patch 中按 ID 设置 `disabled: true`，互不影响。

## 轮末检查能力

**逐轮判定，不再「全局一天一次」。** v1.0.x 的标记文件不带 sessionId，任何一个会话用掉当天额度后，其余会话当天全部静默——多会话场景下会整轮漏提醒。v1.1.0 起改为按 (会话, 轮次) 判定，判据按顺序：

1. 本轮没有任何改变状态的工具调用 → 静默（纯问答、只读轮次不打扰）。
2. 本轮已调用 `write_shared_memory` / `write_project_memory` → 静默（已尽责）。
3. 本轮在 `bash` / `pwsh` / `python` 等命令里碰了 `.agents`、`topics/`、`AGENTS.md` **且带写意图** → **强提醒**：立刻改用专用工具，别用命令通道直写、别提权。
4. 其余「干了活但没写记忆」→ 常规提醒一次。
5. 同一 (会话, 轮次) 只提醒一次，防重入。
6. 任何提醒异常均放行，不影响正常对话。

第 3 条优先于第 4 条：用错通道是硬错误（会撞沙箱拒绝或白费一次审批），必须在同一轮点破；「该不该沉淀」是判断题，可以温和提醒。

**判据 3 看的是「写入目标」，不是「文本里出现过记忆路径」。** 只有解析出的写入目标（`>` / `>>` 的重定向对象、`Set-Content -Path`、`cp`/`mv` 的目的地、`rm`/`mkdir`/`touch` 的操作数、Python `open(path,'w')` 的路径）本身落在记忆路径上才提醒。否则
`echo "见 ~/.agents/topics/x.md" > /dev/null`、`grep foo ~/.agents/topics/a.md > /tmp/o.txt`、
`cp ~/.agents/topics/a.md D:/work/backup.md` 这些都会误报——误报多了提醒就会被忽略，正好抵消检测的意义。解析不出目标时保守放行（宁可多提醒一次，也不漏掉真实直写）。

标记文件 `$DSH_HOME/logs/agent-auto-memory-checkpoint-last.json` 仍会写，但只作审计与统计，**不再作为闸门**。

## 安全写入能力

工具 `write_shared_memory` 只接受：

- `AGENTS.md`
- `topics/<单个安全 Markdown 文件名>.md`

必传完整 UTF-8 内容和 `expectedRevision`（已读取的 SHA-256；**创建新文件时传字面量字符串 `"absent"`，不能省略该参数**——省略、空串、`null` 都会被拒为 `expectedRevision must be absent or a lowercase SHA-256`）。工具拒绝删除、移动、路径穿越、嵌套目录、Windows 保留名、非法字符、超过 1 MiB、符号链接/junction 和 revision 冲突。

更新流程：临时目录备份 → 同目录独占临时文件 → flush/fsync → 再核对 revision 与真实目录 → 原子 rename。Host 内写入串行排队；同 revision 并发竞争最多一个成功。

共享根按 `$DSH_AGENTS_HOME` 解析，默认 `~/.agents`。根目录必须在安装/迁移时预先创建，工具不会自行创建或扩大权限。

## 项目记忆写入能力

会话工作区常常是项目的子目录（例如 `项目/撰写/2026-11-08-某题`），此时沙箱可写根只有那个子目录，父项目的 `.agents/topics/` 在可写根之外，普通 `write` 一律 `file access denied`，提权又会走审批。工具 `write_project_memory` 补上这条路：

- 从**会话工作区**（`exec.agent.session.header.cwd`，不是宿主进程 cwd）向上找最近的、含 `.agents` 或 `AGENTS.md` 的目录，**最多上溯 3 层**；找不到就报错并列出查过的目录，不静默回退到共享根。
- 只接受 `AGENTS.md` 与 `.agents/topics/<单个安全 Markdown 文件名>.md`，同样必须带 `expectedRevision`（新建传 `"absent"`），同样的备份、原子替换、串行队列与链接拒绝。
- 越界防护：路径逃逸、嵌套目录、Windows 保留名、符号链接/junction、超过 1 MiB、revision 冲突一律拒绝。

可配置（通常不需要）：

```yaml
- id: agent-auto-memory-project-writer
  config:
    enabled: true
    toolName: write_project_memory
    markers: ['.agents', 'AGENTS.md']   # 判定项目根的标记
    maxLevels: 3                        # 最多上溯几层
    projectRoot: D:\\work\\my-project    # 钉死项目根（不自动探测）
    projectRoots: [D:\\work\\my-project] # 允许列表；探测结果不在此列即拒绝
```

## 配置

### 自定义 checkpoint

```yaml
- id: agent-auto-memory-checkpoint
  config:
    enabled: true
    reason: "可选的自定义提醒文本"
    suspiciousReason: "可选：检测到命令通道直写记忆文件时的提醒文本"
    detectSuspicious: true   # 关掉则只保留「干了活但没写记忆」的常规提醒
```

默认提醒语的判据是**本轮是否产生了值得沉淀的内容**（通用习惯、可复用做法、踩过的坑、被纠正的判断、
用户说「记住」、被推翻的旧事实），没有就回「本轮无新记忆」。它**不写死技能名**，只按 description
指代「自动记忆 / 记忆沉淀 / 记忆分流」类技能——技能改名不影响对应关系；并顺带给出工具判据
（共享根 → `write_shared_memory`，项目根 → `write_project_memory`，都零提权；禁止直写与提权）。

`suspiciousReason` 是另一条独立文案，专门对付「用 `bash`/`pwsh`/`python` 去写 `~/.agents/**` 或
`.agents/topics/**`」这类硬错误：它会在同一轮就点破通道选错，并说明用命令通道会撞 `PermissionError`
/ `file access denied`、提权会被审批拦下、Windows 子进程不吃额外可写根。检测只看命令工具的参数里
是否同时出现记忆路径特征与写意图特征（重定向、`Set-Content`、`open(...,'w')`、`cp`/`mv`/`rm` 等），
纯读取（`grep`/`cat`/`ls`/`stat`）不会误报。

### 自定义 writer 工具名

```yaml
- id: agent-auto-memory-writer
  config:
    enabled: true
    toolName: write_shared_memory
```

通常无需配置；独立启停优先用插件管理器。

## 安装与升级

使用 DSH 正规插件管理器安装 bundle，不手改 profile：

```text
plugin_manager install_bundle <本地目录、tgz、npm spec 或 GitHub spec>
```

从旧 `dsh-memory-checkpoint` 升级时：先安装并验证新包，再移除旧包，避免同一轮末事件被两个插件重复监听。旧 GitHub 仓库改名后应由 GitHub 自动重定向；profile 依赖仍需切到新包名。

## 与记忆目录迁移的顺序

1. 安装并确认两项插件行 active，工具目录可见 `write_shared_memory`。
2. 原子创建 `~/.agents/AGENTS.md` 与 `~/.agents/topics/`。
3. 把 `~/.dsh/AGENTS.md` 缩减为受保护规则层；旧 `~/.dsh/topics` 暂留作回滚副本。
4. 新会话验证两份根均自动注入。
5. 用专用工具写共享 topic；普通文件/命令工具仍不能写保护层。

## 开发验证

```powershell
node --check index.js
node --check checkpoint.mjs
node --check memory-tool.mjs
node --check memory-store.mjs
node test-offline.mjs
node test-writer.mjs
node test-project-writer.mjs
node test-integration.mjs
npm pack --dry-run
```

## 许可

MIT
## Workspace grant: 让子工作区会话能写父项目根

DSH 的 `workspace-write` 只放行**会话工作区根**。会话开在 `<项目根>\<子目录>` 时，父项目根的
`AGENTS.md`、`.agents/topics/`、项目登记表、`skills/` 全在可写根之外，普通 `write`/`edit` 一律
`file access denied`，只能逐次提权。

本插件行 `agent-auto-memory-workspace-grant` 用 sandbox-policy 的正规运行时接口按会话授权项目根：

```
ctx.sandboxPolicy.registerWritableRoot(session, directory)
```

项目根判定与 `project-writer` 完全一致（从会话 `header.cwd` 向上找最近的、含 `.agents` 或
`AGENTS.md` 的目录，最多 `maxLevels` 层）。会话一建立就注册，恢复/派生的会话在下一个
`turn/start` 补登记；同一会话只注册一次。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 关闭本行。 |
| `markers` | `['.agents', 'AGENTS.md']` | 判定项目根用的标记文件/目录。 |
| `maxLevels` | `3` | 最多向上找几层。 |
| `extraRoots` | `[]` | 额外授权目录；**只发给 cwd 落在该目录之内的会话**。 |
| `audit` | `true` | 追加一行到 `<DSH_HOME>/logs/agent-auto-memory-workspace-grant.log`。 |

### 边界（必须知道）

- **Windows 上额外目录授权只对 harness 文件工具生效**，沙箱子进程（bash / pwsh）忽略它。命令里建
  `.bak`、跑脚本仍会被拒。
- **额外根覆盖「写」但不覆盖「删」**：`write`/`edit` 可以，`unlink`/`rm`/`Remove-Item` 仍报
  `EPERM` / `Permission denied`。
- 授权只属于**这一个存活 Session**：其它会话、子 agent 的会话不继承；恢复或派生的会话需要重新注册。
- 会话中途改 cwd **不会**重新授权（`granted.has(session)` 短路），需要新会话。
- `read-only` 模式下不授予任何写入。
