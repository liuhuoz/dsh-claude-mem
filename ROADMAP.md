# 路线图 / Roadmap

Phase 1 已在 0.4.0–0.8.3 之间完成，1.0.0 作为收尾；Phase 2 尚未开始。
Phase 1 shipped across 0.4.0–0.8.3 and is closed by 1.0.0; Phase 2 has not started.

## 中文


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

---

## English


### Phase 1 — complete the feature surface

#### MCP tools

- [x] **Work state** — `work_state_write` / `work_state_read`, plus a DSH stand-in for claude-mem's **auto-clear**: re-injecting unfinished items after DSH compacts the context (0.4.0).
- [x] `dumb_search` — title-word lookup without reasoning: fast and shallow (0.5.0).
- [x] `get_tool_uses` — fetch the original `tool_input` / `tool_response` for tool calls you already found by id (0.5.0).
- [x] `smart_search` / `smart_outline` / `smart_unfold` — tree-sitter symbol search, file outline, and symbol expansion, reached through claude-mem's own MCP server (0.8.0). The search is scoped to the session directory, and a language's grammar is compiled the first time it is used.
- [x] `corpora` — build, prime, query, rebuild, reprime, and list knowledge corpora through the same MCP server (0.8.0).

#### Hooks

- [x] **file-context** — attach the observations related to a file after `read`, and optionally after `ops_bash` / `pwsh` / `grep` / `glob`. DSH's `tools/pre-execute` has no injection slot, so the block rides `agent/pre-step`; claude-mem's own hook keeps the path extraction, the staleness gate and the per-session dedupe. A separate opt-in switch can also deny a full read of a large file memory already covers, with an explicit-prompt bypass (0.6.0).
- [x] **subagent-stop** — a delegated run’s tool calls are stored on the parent session, tagged with its agent id, and its end is archived through claude-mem’s own `SubagentStop` hook (0.7.0). Nothing is injected into the subagent: what it may know is the parent’s decision.
- [x] ~~**session-end**~~ — decided against. DSH has no clean “session over” signal (`session/disposed` is storage teardown), claude-mem’s own DSH adapter treats `turn/end` as the end, and this plugin already summarises on `agent/turn-stopping`.
- [x] **Failure observations** — a failed tool call is recorded like any other, on the same `PostToolUse` event: `tool_response` carries `{ is_error: true, error }`, the shape claude-mem's merged adapters already send, so this side needs no second hook event. The observer keeps its own noise filter — a single trivial failure is queued, not forced into an observation — and failures stay out of the per-file index the read gate consults (0.8.1).
- [x] **Post-compaction context** — the compaction branch of `SessionStart`: a compaction keeps the summary but drops the block the session started with, so `compaction/end` re-injects `/api/context/inject`, one message, and that block already carries the project's open work state. One copy is in flight per session: a trigger that fires while the previous block is still queued steps aside (0.8.3).

### Phase 2 — efficiency and control

- [ ] **file-context over HTTP** — replace the `claude-mem` CLI spawn (`hook claude-code file-context`, measured at 386–650 ms) with a direct `GET /api/observations/by-file` (74–114 ms) behind the existing `FileContextSource` seam. This takes over rendering, per-session dedupe, mtime staleness and MSYS path normalization, which claude-mem owns today. The `format` query parameter is inert, so rendering has to move client-side anyway. The gate's "does memory still cover this file" check gets sharper in the same pass.
- [ ] **Platform identity** — every stored observation currently reports `platform_source=claude`, and the plugin sends no label by default. Retrieval is unaffected; a write-side change plus a one-time backfill is needed before `dsh` can be filtered on.
- [ ] **Observation transport cost** — the adapter-of-adapter path spawns one `claude-mem` process per recorded tool result. Batching or rate-limiting it is a transport change only: observation generation stays inside the worker.
- [ ] **Injection budget** — the file-context block is capped at 4,000 characters here while claude-mem caps its own session-start block at 10,000. Pick one policy per surface.

### Not planned

- TeamBrain
- The server-side `observation_*` tools
- The My Work viewer and deliverables
- The stats / export / admin routes
- claude-mem's bundled skills and modes