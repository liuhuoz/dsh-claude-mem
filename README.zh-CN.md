# dsh-claude-mem

给 [DeepSeek Harness](https://github.com/deepseek-ai) 接上 [claude-mem](https://github.com/thedotmack/claude-mem) 的跨会话记忆：开新会话时，自动带着这个项目上次做到哪了。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x%2B-4D6BFE)](https://github.com/deepseek-ai)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![claude-mem](https://img.shields.io/badge/claude--mem-15.x-6E56CF)](https://github.com/thedotmack/claude-mem)

[English](README.md) · 中文

> Fork 自 [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem)。本仓库面向 DSH 0.2.x，会在 DSH 加载时启动 claude-mem worker，把工具调用交给 claude-mem 自己的 PostToolUse 管线记录，并在 DSH 内提供配置页面。

## 前置条件

- DSH ≥ 0.2.1
- [claude-mem](https://github.com/thedotmack/claude-mem) 15.x（在 15.17.0 上验证），且 `claude-mem` 在 `PATH` 上。worker 由插件负责启动。

## 安装

```sh
dsh plugin --profile <profile> add github:liuhuoz/dsh-claude-mem
```

`dsh` 不在 `PATH` 上时：

```sh
npx -y @deepseek-ai/dsh plugin --profile <profile> add github:liuhuoz/dsh-claude-mem
```

pnpm 默认不允许执行 git 依赖的构建脚本：第一次 `add` 会失败并给出包名，把它加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，再执行一次。装完重启 DSH。

## 设置

全部在插件自己的页面里：**插件 → dsh-claude-mem → 配置**。

| 设置项 | 作用 |
|---|---|
| worker 地址 | worker 监听的地址。留空则使用它在 `~/.claude-mem/worker.pid` 里公布的地址。「测试连接」直接询问 worker 的 `/api/health`。 |
| 启动器 | 记录观察所用的 `claude-mem` 可执行文件。留空则使用 `PATH` 上的 `claude-mem`。 |
| worker 未运行时自动拉起 | 没有 worker 在跑时，是否由插件启动一个。 |
| 观察工具调用 | 把每条被观察的工具结果交给 claude-mem 的观察者。 |
| 回合结束时生成会话摘要 | 每轮结束时写一次会话摘要。 |
| 跨会话待办 | 跨会话保存待办与工作状态：两个 `work_state` 工具，以及上下文压缩后重新注入未完成项。关闭则三者一起隐藏。 |
| 观察白名单 | 上一个开关作用于哪些工具（高级）。 |

## 路线图

### MCP 工具

- [x] **Work state** — `work_state_write` / `work_state_read`，以及 claude-mem **auto-clear** 在 DSH 下的替代实现：上下文压缩后重新注入未完成项（0.4.0）。
- [ ] `dumb_search` — 不做推理的标题词匹配检索，快但浅。
- [ ] `get_tool_uses` — 按 id 取回工具调用的原始 `tool_input` / `tool_response`。
- [ ] `smart_search` / `smart_outline` / `smart_unfold` — tree-sitter 符号搜索、文件结构大纲、符号展开。
- [ ] `corpora` — 构建、prime、查询、重建、重新 prime、列出知识库。

### Hooks

- [ ] **file-context** — 在 `Read` / `Bash` / `Grep` / `Glob` 之前注入与该文件相关的观察。DSH 的 `tools/pre-execute` 只返回 allow / deny / cancel / ask，所以要额外做注入通道（或改成 `mem_file_context` 工具）。
- [ ] **session-end / subagent-stop** — 会话或子代理结束时归档并总结。

### 不计划

- TeamBrain
- 服务端 `observation_*` 工具
- My Work 面板与交付物
- stats / export / admin 这些路由
- claude-mem 自带的 skills 与 modes

