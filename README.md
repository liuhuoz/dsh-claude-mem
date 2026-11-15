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
| Work state | Keep to-do lists across sessions: the two `work_state` tools, plus re-injecting unfinished items after the context is compacted. Off hides all three. |
| Observed tools | Which tools the previous switch watches (advanced). |

## Roadmap

### MCP tools

- [x] **Work state** — `work_state_write` / `work_state_read`, plus a DSH stand-in for claude-mem's **auto-clear**: re-injecting unfinished items after DSH compacts the context (0.4.0).
- [ ] `dumb_search` — title-word lookup without reasoning: fast and shallow.
- [ ] `get_tool_uses` — fetch the original `tool_input` / `tool_response` for tool calls you already found by id.
- [ ] `smart_search` / `smart_outline` / `smart_unfold` — tree-sitter symbol search, file outline, and symbol expansion.
- [ ] `corpora` — build, prime, query, rebuild, reprime, and list knowledge corpora.

### Hooks

- [ ] **file-context** — inject the observations related to a file before `Read` / `Bash` / `Grep` / `Glob`. DSH's `tools/pre-execute` only answers allow / deny / cancel / ask, so this needs an injection path (or a `mem_file_context` tool instead).
- [ ] **session-end / subagent-stop** — archive and summarise when a session or a subagent ends.

### Not planned

- TeamBrain
- The server-side `observation_*` tools
- The My Work viewer and deliverables
- The stats / export / admin routes
- claude-mem's bundled skills and modes

