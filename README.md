# dsh-memory-checkpoint

DSH（DeepSeek Harness）的**轮末记忆质检**插件 —— 用原生扩展点替代已失效的 Claude Code Stop 钩子。

## 为什么需要它

`~/.dsh/hooks.json` 是 Claude Code 格式的钩子配置，但 DSH 桌面端**不打包**
`@deepseek-ai/dsh-hooks-claude-code`，且它依赖的 `@deepseek-ai/dsh-hook-protocol`
从未进入内核（asar 内引用数为 0）。结果是：配置写对了，但**没有任何组件读它**。

DSH 官方文档把 `agent/turn-stopping` 列为 lifecycle extension point，语义正是
「本轮可完成、关闭前运行，可通过 `steer` 让本轮继续」。本插件就挂在这里。

## 行为（四条判据，宁可少打扰）

| 情况 | 动作 |
|---|---|
| 今天已经提示过 | 静默 |
| 本轮有**改变状态**的工具调用，且今天还没提示过 | `steer` 提示一次 + 写标记 |
| 本轮只有只读操作（read/grep/glob）或纯问答 | 静默 |
| 任何异常（写标记失败、steer 报错） | 静默放行，绝不打断对话 |

**只有「干了活」的轮次才会被提醒**：`write` / `edit` / `bash` / `ops_bash` /
`apply_patch` 等，以及名字里带 `write|edit|create|delete|patch|exec|bash` 的
MCP 自定义工具。只读一轮但没结论的轮次不该被催着写记忆。

一天最多打扰一次，标记文件：`<DSH_HOME>/logs/memory-checkpoint-last.json`。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: memory-checkpoint
  config:
    enabled: true          # 设为 false 即完全关闭
    reason: "自定义提示语"   # 可选
```

## 安装（桌面端）

桌面 profile 被 Electron 独占，`dsh plugin --profile desktop add` 会报
`managed exclusively`。因此手动装：

1. 把本目录拷到 `<profile>/node_modules/dsh-memory-checkpoint/`
2. 在 profile 的 `package.json` 里：
   - `dependencies` 加 `"dsh-memory-checkpoint": "0.1.0"`
   - `dsh.profile.bundles` 数组里加 `"dsh-memory-checkpoint"`
3. **完全退出并重启** DSH 桌面端

> 注意：bundle 型插件在启动时被加载，写错会导致启动失败，改完先备份。

## 卸载

从 `dsh.profile.bundles` 与 `dependencies` 移除该包名，删目录，重启。

## 给插件作者的关键教训：steer 消息四件套

`agent.steer()` 的契约是**完整的 UserMessage 对象**，缺字段不会当场报错，而是把坏数据写进会话日志，
下次加载该会话时才报 `SessionFormatError`（会话永久 corrupt）。两种翻车形态都实测过：

| 传参形态 | 日志里变成 | 加载时报错 |
|---|---|---|
| 裸字符串 `agent.steer(reason)` | `inserted:["..."]` | `agent/inbox/spliced requires message objects` |
| 文档示例形态 `{content, source}`（缺 id/role） | `inserted:[{content:[...],source:{...}}]` | `user/message lacks an identified message` |

正确形态（v4 读取端按 `assertMessageEventShape` 校验 user/message 四件套：非空 `id`、`role === "user"`、
对象 `source`（kind 非空且非 `plugin`）、数组 `content`）：

```js
import { randomUUID } from 'node:crypto';
await agent.steer({
  id: randomUUID(),            // 必需：非空串，且 inbox 内唯一
  role: 'user',                // 必需：读取端按 role 校验
  content: [{ type: 'text', text: reason }],
  source: { kind: 'memory-checkpoint' },   // kind 非空且不等于 plugin
});
```

官方内核的 `createUserMessage` 会自动补 id/role，但第三方插件拿不到该内部 API，必须自建全字段。
验证口径：修完插件必须对真实会话日志逐行跑等价校验收尾，只断言函数返回值测不出这类问题。

## 已知边界

- 插件**判不出「该不该写」**，只知道「今天提过没有」和「本轮干没干活」。
  它把「可能漏写」变成一次可见提醒，不保证写得好。
- 记忆内容本身归 `AGENTS.md` / `topics/`（规则与踩坑）或 `dsh-tdai-memory`
  （自动事实与画像），本插件只做提醒，不写记忆。

## 许可

MIT
