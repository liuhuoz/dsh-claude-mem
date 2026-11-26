# dsh-claude-mem

<p align="center"><img src="icon.png" width="96" alt="dsh-claude-mem"></p>

The full [claude-mem](https://github.com/thedotmack/claude-mem) cross-session memory surface for [DeepSeek Harness](https://github.com/deepseek-ai): context injection at session start, plus the memory tools, file context, subagent archiving, failure observations and post-compaction re-injection that the official DSH adapter does not cover.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![claude-mem](https://img.shields.io/badge/claude--mem-%E2%89%A515.17-6E56CF)](https://github.com/thedotmack/claude-mem)

English · [中文](README.md)

> Forked from [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem): on top of its DSH integration, memory search and manual save, this fork adds more claude-mem interfaces — `mem_get_tool_uses`, `mem_dumb_search`, `mem_smart_search` / `mem_smart_outline` / `mem_smart_unfold`, `mem_corpus_*`, `work_state_*` — plus file context, subagent archiving, failure observations and post-compaction re-injection.

## Requirements

- DSH ≥ 0.2.1-rc.2
- [claude-mem](https://github.com/thedotmack/claude-mem) ≥ 15.17.0 (verified on 15.17.0 and 16.0.2), with `claude-mem` on `PATH`. The worker is started for you.

## What's new

A per-session read-only memory mode: the session keeps reading project memory and writes none of it back. Where its control appears is up to the settings page, and `/mem-readonly` switches it directly. (2026-11-26, v1.3.0)

## Install

Install into the profile you actually run (DSH ships `desktop` and `web`):

```sh
dsh plugin --profile desktop add @liuhuoz/dsh-claude-mem
# for the web app:
dsh plugin --profile web add @liuhuoz/dsh-claude-mem
```

The same package can be installed straight from the repository, which tracks `main`:

```sh
dsh plugin --profile desktop add github:liuhuoz/dsh-claude-mem
```

To follow the `dev` branch, where unreleased work lands first:

```sh
dsh plugin --profile desktop add github:liuhuoz/dsh-claude-mem#dev
```

`dev` integrates changes before they are released, so it may move at any time; use the npm install or `main` above for a stable version.

If `dsh` is not on `PATH`:

```sh
npx -y @deepseek-ai/dsh plugin --profile desktop add @liuhuoz/dsh-claude-mem
```

## Panel

The entry is off by default: turning on **Sidebar entry** in the settings puts a dsh-claude-mem icon and entry in the left rail.

| Tab | What it shows |
|---|---|
| Overview | Worker status, the five totals, token savings and the most recent observations. |
| Trend | Daily stacked bars, a twelve-week heatmap, composition rings and the project ranking, filterable by type or project. |
| Sessions | The newest context injection plus the sessions that produced summaries. |
| Settings | The configuration below. |

<table>
  <tr>
    <td><img src="docs/screenshots/overview.png" width="256" alt="Overview"></td>
    <td><img src="docs/screenshots/trend.png" width="256" alt="Trend"></td>
    <td><img src="docs/screenshots/settings.png" width="256" alt="Settings"></td>
  </tr>
  <tr>
    <td align="center"><sub>Overview</sub></td>
    <td align="center"><sub>Trend</sub></td>
    <td align="center"><sub>Settings</sub></td>
  </tr>
</table>

## Settings

Everything lives in the plugin's own page: **Plugins → dsh-claude-mem → Configure**.

| Setting | What it controls |
|---|---|
| Worker address | Address of the memory service. Empty uses the address claude-mem publishes at startup; **Test connection** probes the service with it. |
| Executable | The `claude-mem` command used to record observations. Empty uses `claude-mem` on `PATH`. |
| Start the worker when it is not running | Starts a worker when none is running. |
| Record tool calls as memory | Tool results are kept as searchable memories. |
| Write a session summary when a turn ends | claude-mem summarizes the turn each time a turn ends. |
| Keep to-do lists and work state across sessions | Keeps to-do lists and work progress the next session picks up. Turning it off only removes that ability; the rest of memory is unaffected. |
| Bring memory into file reads | Adds what memory already knows about the file you read. |
| Refuse full reads of large files memory already covers | A large file memory already covers is no longer read whole; read it in slices. Off by default; a file the user names in the prompt always passes. |
| File delegated runs under the session that started them | Work done by a delegated run is recorded under the session that started it, and archived when the run ends. |
| Read code structurally through claude-mem | Adds `mem_smart_search` / `mem_smart_outline` / `mem_smart_unfold`: a file outline and single-symbol source instead of whole files. The model calls them when it wants structure; scoped to the working directory. |
| Knowledge corpora | Adds the six `mem_corpus_*` tools: topic-scoped slices of memory you can ask questions about. |
| Sidebar entry | Puts the panel behind a left-rail icon. With it off, **Plugins → dsh-claude-mem → Configure** still opens it (see Panel above). |
| In-session control position | Where the read-only control appears inside a session: the composer tool row, the session header, the row under the composer, or Off (none of the three). Takes effect after saving. |
| Show the control on the New Session page | Whether the control appears beside the New Session dropdowns. |
| Observed tools | Only used while “Record tool calls as memory” is on. Comma-separated; leave empty for the built-in default list (advanced). |
| File-context tools | Only used while “Bring memory into file reads” is on. Comma-separated; the default is `read`. `ops_bash` / `pwsh` are scanned for files and must be added explicitly; `grep` / `glob` are not supported yet. |
