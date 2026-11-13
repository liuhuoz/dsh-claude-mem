# Changelog

Fork of [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem), starting from upstream 0.1.5.

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
