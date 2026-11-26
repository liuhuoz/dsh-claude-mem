# Changelog

Fork of [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem), starting from upstream 0.1.5.

## 1.3.0

### Added

- A per-session read-only memory mode: the session keeps reading memory (search, context injection, the read tools) but writes none of it back — no session row, no observations, no turn summary, no delegated-run archive. The mode is derived from the `/mem-readonly` record the session log already keeps, folded by a `memReadOnly` projection, switched from the seat the plugin settings choose or with `/mem-readonly`, and it survives restarts and archives.
- The settings page chooses where that control appears: one in-session position (composer tool row, session header, dock row, or off) plus a separate switch for the New Session page. A saved choice moves the control without a reload, and every hint on the page was shortened.

### Changed

- The viewer and repository links moved from the overview tab's footer to the right of the tab strip, so every tab shows them.
- The read-only control follows the panel's card system: the composer keeps a light-outline pill, the header and dock rows drop to a dot and a word, and the settings dropdown matches the card's surface and edge.

### Fixed

- A session that switched its memory mode can reopen again. The mode used to be written as a `claude-mem/read-only` session event; the harness accepts an unknown stored event only when its envelope carries `ignorable: true`, which `Session.append()` cannot set, so every session that had toggled the switch refused to load its own history ("unknown to this harness and not marked ignorable"). The mode now folds the `command/run` record the host writes for `/mem-readonly`, and nothing appends a custom event type.
- A delegated run started from a read-only session no longer writes by itself: the write guard and the turn summary resolve the parent session's mode instead of the child's.

## 1.2.0

### Added

- A four-tab sidebar panel (Overview, Trend, Sessions, Settings) over one host payload, `GET /api/dsh-claude-mem/overview`: a twelve-week activity heatmap, type and project breakdowns, the session list, and the existing settings page behind an opt-in left-rail entry. The page cannot call the worker itself (its origin is refused), so the host gathers worker, database and SQLite-derived numbers once and the panel renders them.
- A twelve-week activity heatmap with a theme-aware intensity ramp, per-cell hover text and a two-column summary (7-day share, active days, longest streak, daily average).
- Daily stacked bars split by observation type or by project over a 7 / 14 / 30-day window: a three-step value scale (0, half and a top rounded to a multiple of twenty), a dated x axis, and a hover that dims every block not under the pointer.
- Composition rings and a project ranking beside the bars; a click on a block, an arc or a ranking row filters the other distribution charts, and picking a heatmap day narrows them to that day.
- The sessions tab renders the newest context injection one field at a time, with the remaining fields one fold away.
- A settings page rebuilt on the panel's card system: four cards, switches on the right, a foldable advanced card, and a save bar pinned to the bottom edge with its result beside the button.

### Changed

- The panel's overview route now admits requests through the host connection service, the same way the sibling host-route plugins do (`admit()`, or `requestRejection()` on hosts that predate it): a caller the app has not authenticated gets its rejection status instead of the memory payload. A host without a reachable connection service keeps the route open, so the panel still renders there. The health probe stays open on purpose — it only reports the worker's own health after the target is narrowed to loopback.
- The panel's own header, gutter, cards and type scale follow the market panel, so it reads as a page of the app rather than one bolted onto it.
- `engines.dsh` now names the prerelease line the host actually publishes (`>=0.2.1-rc.2 <0.3.0-0`); the source typechecks against both 0.2.1-rc.5 and 0.2.0-rc.2.
- README documents the panel: one row per tab, the sidebar entry, and a three-up screenshot strip.

### Fixed

- The overview's savings line no longer blanks out after local midnight. claude-mem stamps its daily telemetry `day` on a UTC clock and only rolls the file when it has something to record, while the aggregator demanded the local date; east of the meridian that dropped the numbers for the first hours of every local day. The day comparison is gone: the panel shows the day the file carries and names it under the line, so a quiet day keeps the last numbers instead of an empty line.
- A hovered composition arc grew past the ring's viewBox and was clipped; the ring now lets its stroke draw outside the frame.
- The tab strip's rule spanned the whole window; it covers only the reading column.
- The daily bars drew no value scale and their date labels drifted away from the columns.
- The settings page's saved notice sat at the far end of the bar instead of beside the button that produced it.

## 1.1.0

### Changed

- Captures now report the plugin's own platform. claude-mem keys a session on `(platform_source, content_session_id)`, so the identity is a constant (`dsh`) carried by every write instead of one the CLI decided: session init and summaries put it on their HTTP bodies, and tool results go straight to `POST /api/sessions/observations`.
- Tool results no longer spawn the `claude-mem` CLI. Direct capture drops the per-call process start (measured 386–650 ms), and because DSH's call id now travels as `tool_use_id`, the raw `tool_uses` backup and the `already_processed` dedupe finally cover this plugin's own captures. A failed direct capture falls back to `claude-mem hook dsh observation`, which keeps platform `dsh` and claude-mem's own spool.
- A delegated run's end is filed through `POST /api/work-state/entries` as the same `agent-lifecycle` entry the upstream SubagentStop hook writes, with `platform_source=dsh`. It retries three times and then drops: the entry is one more piece of My Work evidence, not memory.
- `platformSource` in the config is now a read filter only (empty means every platform's memory); it is no longer written to captures.
- File context no longer spawns the CLI either. A read asks `GET /api/observations/by-file` itself and renders, staleness-checks and dedupes the block here, so one read costs a millisecond-scale request instead of a 386–650 ms process start; the rendered block is byte-for-byte the one the CLI produced. `ops_bash` and `pwsh` are scanned conservatively for the files a read-only command names.
- The read gate consults the same lookup and now requires the file to be unchanged since its newest observation, so a file edited after its notes is no longer denied a full read.
- The file-context tool default shrinks to `read`. `grep` and `glob` no longer attach memory: upstream fed them a pattern-search branch that this change does not implement, so they are documented as unsupported rather than silently doing nothing.

### Notes

- No backfill. Sessions captured before this change stay on `claude`, and an unfiltered read still sees them.

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
