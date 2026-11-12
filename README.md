# dsh-claude-mem

Cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai): a new session starts with what this project was last working on.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x%2B-4D6BFE)](https://github.com/deepseek-ai)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![claude-mem](https://img.shields.io/badge/claude--mem-15.x-6E56CF)](https://github.com/thedotmack/claude-mem)

English · [中文](README.zh-CN.md)

> Fork of [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem). This fork targets DSH 0.2.x, starts the claude-mem worker when DSH loads, and records tool use through claude-mem's own PostToolUse pipeline.

## Requirements

- DSH ≥ 0.2.1
- [claude-mem](https://github.com/thedotmack/claude-mem) 15.x (tested on 15.12.0), with `claude-mem` on `PATH`. The worker is started for you.

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

Recording tool use and summarizing sessions are switches in the plugin settings page (`ingest` / `summarize`).
