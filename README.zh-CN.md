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
| 跨会话待办 | 注册两个 `work_state` 工具，即 claude-mem 里待办与工作状态的写入权限。关闭只是隐藏这两个工具；注入的记忆上下文（含压缩后回注的未完成项）两种情况完全相同。 |
| 文件上下文 | 读取类工具调用之后，附上记忆里已有的该文件信息。默认关闭：每个新文件都要起一次 hook（约 0.4 秒）。观察哪些工具可配置（高级）。 |
| 拒绝完整读取 | 可选，默认关闭：当记忆已经覆盖某个 32 KB 以上的文件时，拒绝完整读取，并指向 `offset` / `limit` 分段读取与 `mem_search`。DSH 本身已把单次读取限制在约 50 KB，所以收益有限；用户在 prompt 里点名的文件一律放行。 |
| 子代理 | 子代理里的工具调用记到父会话名下并标注 agent id，结束时归档一条。子代理本身不获得记忆上下文——它能看到什么由主会话或预设决定。 |
| 结构化阅读 | 新增 `mem_smart_search` / `mem_smart_outline` / `mem_smart_unfold`，由 claude-mem 的 MCP server 提供：给符号大纲与单个符号源码，而不是整篇文件。作用范围限于会话目录；每种语言的语法库首次使用时编译。 |
| 知识语料库 | 新增六个 `mem_corpus_*` 工具：从筛选后的观察构建语料、prime、提问、重建、重新 prime。prime 与 query 会在 worker 内起模型会话。 |
| 观察白名单 | 上一个开关作用于哪些工具（高级）。 |

## 路线图

### Phase 1 — 功能完备

#### MCP 工具

- [x] **Work state** — `work_state_write` / `work_state_read`，以及 claude-mem **auto-clear** 在 DSH 下的替代实现：上下文压缩后重新注入未完成项（0.4.0）。
- [x] `dumb_search` — 不做推理的标题词匹配检索，快但浅（0.5.0）。
- [x] `get_tool_uses` — 按 id 取回工具调用的原始 `tool_input` / `tool_response`（0.5.0）。
- [x] `smart_search` / `smart_outline` / `smart_unfold` — tree-sitter 符号搜索、文件结构大纲、符号展开，经 claude-mem 自己的 MCP server 提供（0.8.0）。检索范围限于会话目录，每种语言的语法库首次使用时编译。
- [x] `corpora` — 构建、prime、查询、重建、重新 prime、列出知识库，走同一个 MCP 通道（0.8.0）。

#### Hooks

- [x] **file-context** — 在 `read`（以及可选的 `ops_bash` / `pwsh` / `grep` / `glob`）之后，附上记忆里与该文件相关的观察。DSH 的 `tools/pre-execute` 没有注入槽，所以注入走 `agent/pre-step`；路径提取、新鲜度门控、按会话去重仍交给 claude-mem 自己的 hook。另有一个默认关闭的开关，可以在读取被记忆覆盖的大文件时拦截并给出指引，用户在 prompt 里点名该文件时放行（0.6.0）。
- [x] **subagent-stop** — 子代理里的工具调用记到父会话名下并标注 agent id，结束时通过 claude-mem 自己的 `SubagentStop` hook 归档一条（0.7.0）。不对子代理注入任何记忆：它能看到什么由主会话或预设决定。
- [x] ~~**session-end**~~ — 决定不做。DSH 没有干净的「会话结束」信号（`session/disposed` 是存储层 teardown），claude-mem 自己的 DSH 适配层把 `turn/end` 当作结束，而本插件已经在 `agent/turn-stopping` 上做摘要。
- [x] **失败观察** — 失败的工具调用和成功的一样入库，事件仍是 `PostToolUse`：`tool_response` 带 `{ is_error: true, error }`，与其他 harness 已采用的归一化写法一致，本侧不需要第二个 hook 事件。观察器自己的噪声过滤不变——单条琐碎失败只入队、不强制生成观测；失败也不会进入读闸查询的文件索引（0.8.1）。
- [x] **压缩后上下文** — `SessionStart` 的 compaction 分支：压缩保留摘要、丢掉会话起始时的上下文块，所以 `compaction/end` 会把 `/api/context/inject` 重新注入一遍（一条消息，块内本就带未完成待办，不另取）；同一会话同时只有一份在途，前一份尚未投递时新的触发会让位（0.8.3）。

### Phase 2 — 效率与控制

- [ ] **file-context 直连 worker** — 把 `claude-mem` CLI 调用（`hook claude-code file-context`，实测 386–650 ms）换成直连 `GET /api/observations/by-file`（74–114 ms），实现落在已有的 `FileContextSource` 接口后面。渲染、按会话去重、mtime 新鲜度、MSYS 路径归一都从 claude-mem 手里收回。by-file 的 `format` 参数实际无效，渲染本来也只能由客户端做。读闸里「记忆是否仍覆盖该文件」的判断也在同一次改动里变准。
- [ ] **平台身份** — 现在所有落库的观察都记为 `platform_source=claude`，插件默认也不带标签。检索不受影响；要按 `dsh` 过滤，需要写侧改动加一次性回填。
- [ ] **观察上报成本** — adapter-of-adapter 这条路径为每条工具结果 spawn 一个 `claude-mem` 进程。批量化或降频只是传输层改动；观察生成本身仍在 worker 内。
- [ ] **注入预算** — 这里 file-context 块截到 4000 字符，claude-mem 自己的会话起始块截到 10000。给每个面统一一个策略。

### 不计划

- TeamBrain
- 服务端 `observation_*` 工具
- My Work 面板与交付物
- stats / export / admin 这些路由
- claude-mem 自带的 skills 与 modes

