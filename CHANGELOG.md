# Changelog

Fork of [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem), starting from upstream 0.1.5.

## 1.0.1

### Changed

- LICENSE carries the complete Apache-2.0 text, with copyright lines for Bleed00 and liuhuoz. It held only the short notice before, which made GitHub report "Other" while package.json declared Apache-2.0.
- The install steps drop the pnpm allowBuilds paragraph.

### Notes

- No code change. The release exists so a published tarball can carry the license and the trimmed README.

## 1.0.0

### Changed

- Phase 1 is closed. The surface this fork set out to match — the MCP tools, the hook coverage and the context injection — is complete, and 1.0.0 is the release that says so. It landed across 0.4.0–0.8.3: work state and its post-compaction stand-in, `dumb_search`, `get_tool_uses`, `file-context` and the read gate, `subagent-stop`, failure observations, post-compaction context, the `smart_*` and `corpus_*` tools, and one in-flight context injection per session.
- Tool defaults now live in one place. The config schema kept its own copies of both lists, so what the plugin used could drift from what the settings page and the docs described; the schema now derives from `settings.ts`. The observed-tool default gains `pwsh`, which 0.8.1 documented but the schema never applied.
- `ops_bash` leaves both default lists. It arrives with the dsh-ops tools rather than with the platform, so observing it, and attaching file context after it, is now an explicit opt-in; `bash` joins the file-context default in its place.
- The settings page describes what each switch does, instead of referring to subsystems the page never introduces (injected context, the launcher, an observer model, grammar compilation). Both tool-list fields show the current selection as a line of text instead of a row of tag pills.
- Published to npm as `@liuhuoz/dsh-claude-mem`; the package description is Chinese, and the README installs from the registry first while keeping the GitHub source as the alternative.
- README.md is now Chinese, the English copy moved to README.en.md, and the roadmap chapter moved to ROADMAP.md.

### Notes

- Behaviour is unchanged from 0.8.3 apart from the two default-list corrections above. This is a naming release: Phase 1 is done, so the version stops pretending otherwise.

## 0.8.3

### Fixed

- The context block is injected once per session. Session start and compaction can fire before the first block is delivered — restart, then compact without an intervening turn — and a queued block survives a compaction, so the second injection repeated the same ~10 KB block in the next step. A per-session pending entry now records the message id the harness accepted: the message reappearing in the transcript with that id ends it, a later trigger steps aside and logs the skip, and a 30 minute bound covers a delivery that never reports back.
- The open work state no longer appears twice. `/api/context/inject` already opens the block with it, so the extra `/api/work-state` fetch and its appended section are gone.

## 0.8.2

### Changed

- A compaction now re-injects the block a session starts with, not just the open work state. DSH compacts in place: the summary survives, but the memory context that entered the conversation at session start does not. On `compaction/end` the plugin re-injects `/api/context/inject` — the same block, which already opens with the project's open work state when there is one, so it must not be fetched twice. Session start and compaction now share one function, so the two paths cannot drift apart.
- The `workState` switch is down to what it names: the write permission. Off now only keeps `work_state_write` / `work_state_read` unregistered; the injected context is exactly the same either way, and a compaction always re-injects. The "work state is disabled" notice is gone with it: it existed to paper over injecting state the model could not update.

### Notes

- Compaction no longer depends on `workState`. Turning the switch off used to suppress the post-compaction re-injection entirely.
- Cost: one extra block per compaction, the same block a session already starts with (7-10 KB of timeline in this project's context cache).

## 0.8.1

### Fixed

- Failed tool calls are recorded instead of dropped. The plugin had always sent `PostToolUse` with `is_error: false` and returned early on `result.isError`, so memory held only successful work. A failure now carries the same structured marker claude-mem's other harness adapters send — `tool_response: { is_error: true, error }` on the unchanged `PostToolUse` event — so no second hook event is needed here.
- The default observed-tool list now includes `ops_bash` and `pwsh`. The inherited Claude Code names (`bash`) never matched this host's shell tools, so shell calls sat outside the observation path unless configured by hand.

### Notes

- A failure that carries no body of its own falls back to the tool's error message as the observation text.
- Single trivial failures still get claude-mem's own `<skip_summary reason="noise" />`: they are queued, not forced into an observation.
- Failed reads and edits stay out of the per-file observation index that `fileContextGate` queries, so the gate is unaffected.
- The change lives in the hooks, which load at plugin start: restart DSH to pick it up.

## 0.8.0

### Added

- Nine tools served by claude-mem's own MCP server. Structural reading: `mem_smart_search`, `mem_smart_outline`, `mem_smart_unfold` return symbols, outlines and single-symbol source instead of whole files. Knowledge corpora: `mem_corpus_list`, `mem_corpus_build`, `mem_corpus_prime`, `mem_corpus_query`, `mem_corpus_rebuild`, `mem_corpus_reprime`.
- The server is not searched for. The worker is the single source of truth for an installation: its health payload names the script it runs from, and `mcp-server.cjs` ships beside it, so one path join replaces any cache or registry scanning.
- A small MCP stdio client (`src/mcp.ts`) speaks the protocol and nothing else; where the server lives and which environment it needs are the adapter's decisions. One process per call, one deadline, typed failures.
- Two switches, `smart` and `corpora` (both on), with a settings-page section of their own.

### Notes

- The smart tools are scoped to the session's working directory, following claude-mem's own rule; a path outside it is refused by the server.
- A grammar is compiled the first time a language is used, which needs a C toolchain in the environment. When it is missing the tools answer with claude-mem's own diagnostic instead of failing — the same message a Claude Code user would see.
- Tools are registered when the plugin loads, so flipping a switch takes effect after DSH restarts.

## 0.7.0

### Added

- Subagent observation: tool calls made inside a delegated run are stored on the parent session and tagged with `agent_id` / `agent_type`, so memory keeps the work without pretending the subagent is a session of its own.
- Subagent archiving: `subagent/end` drives claude-mem's own `SubagentStop` hook, which records the run in its `agent-lifecycle` work state. A run that disappears without `end` (a thrown run) is archived on `agent/disposed`.
- `subagent` and `subagent_fork` joined the observed-tool defaults, so the parent's tool result — the subagent's answer, including a failure — is recorded like any other call.
- A `subagents` switch (on by default) governs all three stages above.

### Notes

- A subagent is not a memory session: the parent is what a user reads. Nothing is injected into a subagent; what it may know is the parent's or the preset's decision.
- The SubagentStop payload mirrors Claude Code's input field for field, `last_assistant_message` included. claude-mem currently keeps only the identity from that payload; what it does with the rest is its own policy, not this adapter's decision. `stopReason` has no Claude Code counterpart, so it stays out.
- `session-end` stays unimplemented: DSH has no clean session-over signal and summarising already happens on every turn.

## 0.6.0

### Added

- File context: after a read-like tool call, the plugin asks claude-mem's `file-context` hook what memory already knows about that file and attaches the answer to the next step through `agent/pre-step`. Covers `read` by default, plus `ops_bash` / `pwsh` / `grep` / `glob` when enabled.
- An optional read gate (`fileContextGate`, off by default): a full read of a file at or above 32 KB that the worker already has observations for is denied in `tools/pre-execute`, with a reason that points at offset/limit reads and `mem_search`. DSH already caps one read at about 50 KB and resumes with `offset`/`limit`, so the gain is small — hence the default. Narrowed reads, prose and configuration files, and any file the user names in their prompt always pass.

### Notes

- The translation layer only renames the tool and normalises its arguments (MSYS drive paths included); path extraction, the mtime gate and the `file_context_injections` dedupe stay in claude-mem.
- A hook that exits non-zero, times out (3 s) or answers no `additionalContext` silently contributes nothing; a file context never fails a tool call.

## 0.5.0

### Added

- `mem_dumb_search`: claude-mem's one-call dumb search (index → nearby context → selected details) over the worker's `/api/dumb-search`. The worker renders the whole answer, so the tool returns that text unchanged.
- `mem_get_tool_uses`: the original `tool_input` / `tool_response` of tool calls, by id, over `/api/tool-uses/batch`. Rendered text is capped at the worker's own 32 KiB budget with its own shortening note.
- `mem_search` gains claude-mem's `deep` flag, forwarded untouched. The T ids that `mem_get_tool_uses` needs come from that path, and the worker only fills them when `CLAUDE_MEM_TOOL_USES_SEARCH_ENABLED` is set on its side; otherwise it answers "Raw tool search: disabled", which is passed through as-is.

### Notes

- A dumb-search reply carries the worker's own `isError` tag as a field instead of a thrown error: a DSH tool result has no `isError` slot, and throwing would flatten the text into an error message.

## 0.4.1

### Changed

- `mem_search` and `mem_timeline` return the worker's rendered text as-is: the output value is a `content` string, matching claude-mem's own MCP `search` tool, which answers with a table of IDs, dates and titles. The worker never returns structured items on these two endpoints, so the old `items` field was always empty.
- The `mem_timeline` schema no longer claims a field the worker cannot fill.

### Removed

- The `items` field from both tools' output schema. Breaking for a caller that read structured results; the text was always the only real payload.

## 0.4.0

### Added

- `work_state_write` and `work_state_read`: claude-mem's per-project to-do lists and working state, over the worker's HTTP API.
- Re-injection of a project's still-open work state right after DSH compacts a session — the DSH stand-in for claude-mem's `/clear` auto-clear, which needs a command DSH does not have.
- A `workState` setting that governs the two tools and the re-injection together; when it is off, the session-start context says the tools are unavailable.

## 0.3.0

### Added

- A configuration page inside DSH, on the plugin's own row: worker address with a connection test, launcher path, worker auto-start, the two capture switches, and the observed-tool filter.
- A plugin icon, declared through the package manifest.
- Health read from the worker's own `/api/health`, answered through a host route so the page works where the desktop renderer's origin is refused by the worker.
- `hookPath` and `autoStartWorker` settings.

### Changed

- The loader row is now `dsh-claude-mem`; existing profiles must rename the row to keep their configuration.
- Tool observation and turn summaries default to on, matching claude-mem. Turn them off from the page.
- The worker address is discovered instead of assumed: explicit setting, then `DSH_MEM_BASE_URL`, then the port the running worker publishes in `~/.claude-mem/worker.pid`, then 37777.

### Removed

- The `injectContext` setting. Session registration, prompt capture and session-start context always follow claude-mem, which exposes no switch for them either.

## 0.2.0

### Changed

- Rebranded the fork as `@liuhuoz/dsh-claude-mem`; upstream remains credited as the original author.
- Rewrote the README for this fork and added a Chinese version.
