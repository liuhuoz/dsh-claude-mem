# dsh-claude-mem

Cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai): a new session starts with what this project was last working on.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x%2B-4D6BFE)](https://github.com/deepseek-ai)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![claude-mem](https://img.shields.io/badge/claude--mem-15.x-6E56CF)](https://github.com/thedotmack/claude-mem)

English · [中文](README.zh-CN.md)

> Fork of [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem). This fork targets DSH 0.2.x, starts the claude-mem worker when DSH loads, records tool use through claude-mem's own PostToolUse pipeline, and adds a configuration page inside DSH.

## Requirements

- DSH ≥ 0.2.1
- [claude-mem](https://github.com/thedotmack/claude-mem) 15.x (tested on 15.17.0), with `claude-mem` on `PATH`. The worker is started for you.

## Install

```sh
dsh plugin --profile <profile> add github:liuhuoz/dsh-claude-mem
```

If `dsh` is not on `PATH`:

```sh
npx -y @deepseek-ai/dsh plugin --profile <profile> add github:liuhuoz/dsh-claude-mem
```

pnpm will not run a git dependency's build script until it is allowed: the first `add` fails and names the package — put it under `allowBuilds` in the profile's `pnpm-workspace.yaml`, then run the command again. Restart DSH afterwards.

## Settings

Everything lives in the plugin's own page: **Plugins → dsh-claude-mem → Configure**.

| Setting | What it controls |
|---|---|
| Worker address | Where the worker listens. Empty uses the address it publishes in `~/.claude-mem/worker.pid`. **Test connection** asks the worker's `/api/health`. |
| Launcher | The `claude-mem` executable used to record observations. Empty uses `claude-mem` on `PATH`. |
| Start the worker | Whether the plugin starts a worker when none is running. |
| Record tool calls | Send every observed tool result through claude-mem's observer. |
| Summarize turns | Write a session summary when a turn ends. |
| Work state | Registers the two `work_state` tools — the write permission for the project's to-do list in claude-mem. Off only hides them: the injected memory context, including the open work state re-injected after a compaction, is the same either way. |
| File context | Attach what memory already knows about a file after a read-like tool call. Off by default: each new file costs one hook start (about 0.4 s). The watched tools are configurable (advanced). |
| Refuse full reads | Optional, off by default: deny a full read of a 32 KB+ file memory already covers and point at `offset`/`limit` reads and `mem_search`. DSH already caps one read at about 50 KB, so the gain is small; a file named in the user's prompt always passes. |
| Subagents | A delegated run’s tool calls are stored on the parent session and tagged with its agent id, and its end is archived. The subagent gets no memory context of its own: what it may know is the parent’s decision. |
| Smart reading | Adds `mem_smart_search` / `mem_smart_outline` / `mem_smart_unfold`, served by claude-mem's MCP server: symbol outlines and single-symbol source instead of whole files. Scoped to the session directory. A language's grammar is compiled on first use. |
| Knowledge corpora | Adds the six `mem_corpus_*` tools: build a corpus from filtered observations, prime it, ask it questions, rebuild and reprime. Priming and querying start a model session inside the worker. |
| Observed tools | Which tools the previous switch watches (advanced). |

## Roadmap

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

