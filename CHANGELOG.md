# Changelog

Fork of [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem), starting from upstream 0.1.5.

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
