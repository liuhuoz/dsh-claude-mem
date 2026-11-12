# dsh-claude-mem

给 [DeepSeek Harness](https://github.com/deepseek-ai) 接上 [claude-mem](https://github.com/thedotmack/claude-mem) 的跨会话记忆：开新会话时，自动带着这个项目上次做到哪了。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x%2B-4D6BFE)](https://github.com/deepseek-ai)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![claude-mem](https://img.shields.io/badge/claude--mem-15.x-6E56CF)](https://github.com/thedotmack/claude-mem)

[English](README.md) · 中文

> Fork 自 [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem)。本仓库面向 DSH 0.2.x，会在 DSH 加载时启动 claude-mem worker，并把工具调用交给 claude-mem 自己的 PostToolUse 管线记录。

## 前置条件

- DSH ≥ 0.2.1
- [claude-mem](https://github.com/thedotmack/claude-mem) 15.x（在 15.12.0 上验证），且 `claude-mem` 在 `PATH` 上。worker 由插件负责启动。

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

记录工具调用与会话总结，在插件设置页里开关（`ingest` / `summarize`）。
