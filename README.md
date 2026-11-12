# dsh-agent-auto-memory

DeepSeek Harness（DSH）的自动记忆基础设施插件，与 Agent Skill `agent-auto-memory` 配套使用。

## 分工

- **Skill：agent-auto-memory** —— 告诉 Agent 什么值得记、跨项目/项目级怎么分流、怎样判重、维护索引与控制预算。
- **插件：dsh-agent-auto-memory** —— 提供程序层能力：轮末漏写提醒 + 最小权限共享记忆写入。

插件不总结对话，也不自行决定记什么；内容决策始终由 Agent 按 Skill 执行。

## 一个包，两项独立能力

Bundle 安装两个 Cordis 插件行，可在插件管理器分别启停：

| 行 ID | 能力 | 默认 |
|---|---|---|
| `agent-auto-memory-checkpoint` | 在 `agent/turn-stopping` 检查本轮是否可能漏写记忆，必要时 steer 提醒 | 开 |
| `agent-auto-memory-writer` | 注册 `write_shared_memory`，只写共享 Agent 记忆根 | 开 |

也可在 profile patch 中按 ID 设置 `disabled: true`，互不影响。

## 轮末检查能力

它只在本轮发生写/编辑/命令等改变状态的工具调用、且今天尚未提醒时 steer 一次。纯问答和只读轮次静默；任何提醒异常均放行，不影响正常对话。

标记文件：`$DSH_HOME/logs/agent-auto-memory-checkpoint-last.json`。

## 安全写入能力

工具 `write_shared_memory` 只接受：

- `AGENTS.md`
- `topics/<单个安全 Markdown 文件名>.md`

必传完整 UTF-8 内容和 `expectedRevision`（已读取的 SHA-256；**创建新文件时传字面量字符串 `"absent"`，不能省略该参数**——省略、空串、`null` 都会被拒为 `expectedRevision must be absent or a lowercase SHA-256`）。工具拒绝删除、移动、路径穿越、嵌套目录、Windows 保留名、非法字符、超过 1 MiB、符号链接/junction 和 revision 冲突。

更新流程：临时目录备份 → 同目录独占临时文件 → flush/fsync → 再核对 revision 与真实目录 → 原子 rename。Host 内写入串行排队；同 revision 并发竞争最多一个成功。

共享根按 `$DSH_AGENTS_HOME` 解析，默认 `~/.agents`。根目录必须在安装/迁移时预先创建，工具不会自行创建或扩大权限。

## 配置

### 自定义 checkpoint

```yaml
- id: agent-auto-memory-checkpoint
  config:
    enabled: true
    reason: "可选的自定义提醒文本"
```

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
node test-integration.mjs
npm pack --dry-run
```

## 许可

MIT
