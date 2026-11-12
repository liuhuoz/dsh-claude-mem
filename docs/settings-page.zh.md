# 设置页方案（claude-mem DSH 插件）

> 状态：方案待评审，尚未实现。
> 目标读者：这份 fork 的维护者。

## 0. 结论

1. 配置页挂在 DSH 插件管理页的行配置槽 `plugins.row.config` 上（key = `@liuhuoz/dsh-claude-mem#claude-mem`），页面是本插件自己的 React 组件。
2. 保存走宿主提供的 `form.state` / `form.mutate(operations, expectedRevision)`，写回 profile 的 `cordis.patch.yml`，再由 `loader.update` 重启该行 → **插件粒度热生效，无需重启应用，因此页面不显示"重启后生效"**。
3. 连通性检测**不使用**写 prompt 的方式，改用 claude-mem 自带的 `GET /api/health`（只读、零副作用、返回信息足够多）。

## 1. 边界

判据：这个开关改的是"claude-mem 怎么工作"，还是"插件怎么跟它打交道"。前者不做。

不进入本页面的内容：

- worker 监听哪个端口（claude-mem 自己决定，插件只负责**找到**它）
- 观察者模型、压缩策略、上下文条数、记忆保留与合并
- 数据库路径、索引、迁移
- 任何"替 claude-mem 改配置"的入口（包括 `CLAUDE_MEM_*` 环境变量）

保留在 `Config` 里但**不渲染**的字段：`dedupe`、`project`、`platformSource`、`timeoutMs`。
理由：手改 yml / CLI 的用户仍需它们；自定义表单可以选择不画。

## 2. 页面结构

```
插件 › @liuhuoz/dsh-claude-mem › claude-mem
┌──────────────────────────────────────────────────────────┐
│ 连接                                                      │
│  worker 地址                                              │
│  [ http://127.0.0.1:37777                              ]  │
│  ● 已连接 · v15.17.0 · pid 36480 · 观察者 claude          │
│  [ 测试连接 ]                                             │
│                                                          │
│  hook 可执行文件                                           │
│  [ C:\...\claude-mem\bin\claude-mem.exe                ] [浏览] │
│  ● 文件存在且可执行                                        │
│                                                          │
│ 行为                                                      │
│  [x] 会话开始时注入记忆上下文        injectContext         │
│  [ ] 观察工具调用并写入记忆          ingest                │
│  [ ] 回合结束时生成会话摘要          summarize             │
│  [x] worker 未运行时自动拉起         autoStartWorker       │
│                                                          │
│ ▸ 高级                                                    │
│    观察白名单  [read] [write] [edit] [bash]               │
│    仅当"观察工具调用"开启时生效；留空则使用默认四项          │
└──────────────────────────────────────────────────────────┘
```

`toolFilter` 采用**常驻显示 + 说明文字**，不按 `ingest` 状态条件显示：条件显示会让高级区条目跳动，且先看白名单再开启 ingest 更安全。

## 3. 字段

控件除特别说明外全部复用 `@deepseek-ai/dsh-client-ui-primitives`（签名已核对，见 §8）。

| 字段 | 控件 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | `Input` | 见 §5 的发现顺序 | 不拆 host/port |
| — | `Button`（size `sm`）+ `StateDot` | — | 用草稿值，不改运行中配置 |
| `hookPath`（新增） | `Input` | `$DSH_MEM_HOOK_BIN` → 平台默认 | Windows: `%LOCALAPPDATA%\claude-mem\bin\claude-mem.exe` |
| `injectContext` | `Switch` | 开 | |
| `ingest` | `Switch` | 关 | |
| `summarize` | `Switch` | 关 | |
| `autoStartWorker`（新增） | `Switch` | 开 | gating `ensureWorkerStarted()` |
| `toolFilter.names` | `Input` + `Tag`（只读展示） | `read/write/edit/bash` | 收在 `DisclosureRow` 折叠的高级区 |

状态点与语义的对应（`StateDotState`）：

| 场景 | state |
|---|---|
| 检测中 | `ongoing` |
| 已连接 | `done` |
| 已响应但未就绪 | `warning` |
| 连不上 | `error` |
| 尚未检测 | `idle` |

### 3.1 为什么不使用 `ConfigField`

`ConfigField` 的 props 是 `value: string` + `choices: readonly string[]`，外加 `overridden` / `onReset` / `labels.inherited` —— 它是给"用户覆盖某个继承来的默认值"这种设置模型用的。我们的配置写在 `cordis.patch.yml` 里，没有可表达的"继承值"，硬套就得伪造 `overridden=false` 并给一个不生效的重置入口，反而更糟。

文本字段用 `Input` + 自己排 label 和说明文字，外观依然是宿主同一套 token，不会跑样式。

## 4. 连通性检测：`GET /api/health`

claude-mem v15 的 worker 自带健康检查端点，实测（2026-11-12，worker v15.17.0，端口 37777）：

| 端点 | 结果 |
|---|---|
| `GET /api/health` | 200，JSON 见下 |
| `GET /health` | 200，`{status,timestamp,activeSessions,pid}` |
| `GET /healthz` | 200，`{status:"ok"}` |
| `GET /api/ready` | 200，SSE（`phase: ready`）|
| `GET /api/status` | 404 |

`/api/health` 实际返回（截断）：

```json
{"status":"ok","version":"15.17.0","workerPath":"...worker-service.cjs","uptime":37905,
 "managed":false,"hasIpc":false,"platform":"win32","pid":36480,"initialized":true,
 "mcpReady":true,"ai":{"provider":"claude","authMethod":"Gateway auth token (from ~/.claude-mem/.env)", ...}}
```

用它的收益：一次请求同时回答"通不通"和"是哪个版本、哪个进程、初始化完成没有、观察者凭据是否就绪"。

**不使用写 prompt 的原因**：`POST /api/sessions/init` 会往 claude-mem 数据库落 `sdk_sessions` / `user_prompts` 记录；若带上真实 `contentSessionId`，还会重绑该会话的 project 归属。一个"测试连接"按钮不应产生这种副作用。（该副作用机制在 2026-11-08 的调研中已实证。）

状态呈现三档：

| 状态 | 判据 | 文案 |
|---|---|---|
| 已连接 | 200 且 `status === "ok"` | `● 已连接 · v15.17.0 · pid 36480 · 观察者 claude` |
| 已响应但异常 | 200 但 `initialized/mcpReady` 为 false | `● 服务在，但未就绪：initialized=false` |
| 不可达 | fetch 抛错 / 超时 / 非 2xx / CORS | `● 连不上：<错误码>` |

`hookPath` 单独一行判断（文件存在 + 可执行），因为它和 worker 是两条独立链路，`ingest` 失败时必须能指出是哪条断了。

## 5. worker 地址的默认值

**已发现的偏差**：插件 `src/index.ts:25-28` 的 `defaultWorkerPort()` 是 `37700 + uid % 100`，Windows 上 `getuid` 不存在 → 恒为 **37700**；而本机 claude-mem v15 实际监听 **37777**（`~/.claude-mem/worker.pid` 与 `/api/health` 均确认）。当前之所以能用，是因为 profile 里显式写了 `baseUrl: http://127.0.0.1:37777`。

建议的解析顺序（"找到"而非"决定"，不越界）：

1. 页面/配置文件里显式填的 `baseUrl`
2. `$DSH_MEM_BASE_URL`
3. `~/.claude-mem/worker.pid` 里的 `port`（读运行时状态，只读）
4. 硬编码兜底 `37777`
5. 最后才是旧的 `37700 + uid % 100`

页面上的输入框 placeholder 显示当前解析结果，避免"看起来填了其实没生效"。

## 6. 保存与生效

```
表单草稿 ──保存──▶ form.mutate(operations, expectedRevision)
                     ├─ 版本不符 → settings-conflict（宿主 toast，草稿保留）
                     └─ 成功 → 写 profile/cordis.patch.yml 该行 config
                                → loader.update(id) → 该行卸载并重挂 → 新配置生效
```

依据：`@cordisjs/plugin-loader` 的 `loader.update(id, options, ...)` 语义为 "Update, move, and **restart** an entry"。

**浏览器半侧不会跟着重载**：`dsh-client-modules` 的说明是，条目重启后的对账会重读 manifest 与 bundle 元数据，"读到相同 manifest 与 bundle 元数据的对账不发布任何内容…**未变化的 bundle 保留其 revision，因此浏览器会保留已加载的插件**"。配置变更不改变 bundle 字节，所以页面与其草稿在保存后存活。

因此：**不显示"重启后生效"提示**。只有实现期改代码触发 HMR（revision 变化）时页面才会重挂，那是开发场景。

## 7. 实现改动清单

| 文件 | 改动 |
|---|---|
| `src/index.ts` | Config 增 `hookPath` / `autoStartWorker`；`apply()` 用 `resolveBaseUrl` 解析地址 |
| `src/endpoint.ts`（新） | `parseWorkerPid` + `resolveBaseUrl`，纯函数，可单测 |
| `src/hooks.ts` | `hookLauncher(config)` 三级回落；`ensureWorkerStarted(config)` 受 `autoStartWorker` 约束 |
| `src/probe.ts`（新） | `/api/health` 的解析与分级，纯模块，服务端与浏览器共用 |
| `src/client/index.ts`（新） | 注册 locale 字典与 `plugins.row.config` 条目 |
| `src/client/page.tsx`（新） | 页面组件（草稿、检测、保存） |
| `src/client/messages.ts`（新） | 中英文字典 + `LocaleNamespaceMap` 增补 |
| `tsconfig.json` | `exclude: ["src/client"]`（服务端不编译 JSX） |
| `tsconfig.client.json`（新） | 客户端类型检查（`noEmit`） |
| `package.json` | `exports["./client"]`、`dsh.client`、客户端 devDependencies、`typecheck:client` |
| `tsdown.config.ts` | 双入口：`lib/index.js`（node）+ `lib/client.js`（browser，外部化 react 与 `@deepseek-ai/*`） |
| `cordis.patch.yml` | 不改（行 id 已是 `claude-mem`） |

slot 注册形态（参照官方文档示例）：

```tsx
ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
  name: 'plugins.row.config',
  key: '@liuhuoz/dsh-claude-mem#claude-mem',
  locale: 'claudeMem',
}, ({ t, view }) => view === 'summary' ? t('summary') : <ClaudeMemForm t={t} />))
```

## 8. 验证记录

已实证：

- **healthcheck 存在且可用**：`/api/health`、`/health`、`/healthz`、`/api/ready` 全部 200，`/api/status` 404。
- **浏览器可直连 worker**：带 `Origin: http://127.0.0.1:8240` 的 GET 返回 200 且 `Access-Control-Allow-Origin` 回显该 origin；OPTIONS 预检 204。
- **CORS 是 loopback 放行、非 loopback 拒绝**：`127.0.0.1:9999`、`localhost:8240`、`127.0.0.1:31245` 均 200；`http://evil.example`、`Origin: null` 均 403。→ 桌面端 GUI 换端口不影响直连。
- **保存触发行重启**：`loader.update` 语义（见 §6）。
- **页面不会因保存而重载**：`dsh-client-modules` 的 revision 规则（见 §6）。
- **端口默认值有偏差**：37700 vs 实际 37777（见 §5）。
- **`ConfigField` 签名已核对**（`@deepseek-ai/dsh-client-ui-primitives@0.2.2-rc.1` 的 `lib/types/ConfigField.d.ts`）：`{ label, value: string, secret, choices: readonly string[], disabled, overridden, invalid, labels: { reset, inherited, invalid }, onChange, onReset }`。结论是**不用**（见 §3.1）。
- **可复用的其余 primitive 已核对**：`Input`（透传 `InputHTMLAttributes`）、`Switch`（受控 `checked`/`onChange`）、`Button`（`variant`/`size`/`icon`）、`StateDot`（`done|warning|ongoing|error|idle`）、`DisclosureRow`（受控 `open`/`onToggle`）、`Tag`（只读）。整页不需要手写控件。
- **`view: 'summary'` 不作为独立验证项**：按官方示例的形态处理即可，`view === 'summary' ? t('summary') : <ClaudeMemForm t={t} />`。

仍待验证（不阻塞方案，实现时确认）：

- 非 loopback 的 `baseUrl`（远程 worker）会被 CORS 拒，需在 UI 上给出可区分文案（"浏览器被拒绝" vs "服务连不上"）。
- `form.state` / `form.mutate` 的实际形状（每个字段的草稿值、校验态、写入操作列表），按 `@deepseek-ai/dsh-client-ui-plugin-manager` 的发布类型定义对齐。
- 插件的 `dsh.client.inject` 实际需要哪些 client 包（`ui-plugin-manager`、`ui-primitives` 之外还有哪些是必须的）。

## 9. 未纳入

- 子代理是否入库（`isSubagent()` 硬编码排除）
- 工具结果截断长度（`recordToolUse()` 当前无截断，属成本问题，`ingest` 打开后再议）
- `project` 覆盖入口（决定不做）
- `dedupe` / `platformSource` / `timeoutMs` 的界面暴露（决定不做）

## 10. 落地记录（分支 `feat/setting-page`）

已实现并验证：

- 服务端：37 个单测通过（原 21 + 新增 16），`tsc` 干净，`lib/index.js` 46.6 kB。
- 浏览器端：对着 npm 上的真实类型（`dsh-client-ui-plugin-manager@0.2.2-rc.1` 等）通过类型检查，`lib/client.js` 16.2 kB，未打入任何 Node 内置模块，`react` 与 `@deepseek-ai/*` 保持外部依赖。

与原方案的偏差（均为查证后收窄）：

- **没有给 `WorkerClient` 加 `health()`**。实测 loopback 的 CORS 放行后，浏览器半侧直接 `fetch` `/api/health` 即可；在宿主侧再放一份健康检查会成为无人调用的死代码。若将来要支持远程 worker，再补这一层。
- **`ConfigField` 不用**（见 §3.1），页面由 `Input` / `Switch` / `Button` / `StateDot` / `DisclosureRow` / `Tag` 组合。
- **locale 字典写在 `src/client/messages.ts` 并由 `ctx.locale.register` 运行时注册**，不额外产出 `locale/*.json`：少一个宿主需要发现的文件来源。
- `dsh.client.inject` 只列真正在运行时 import 的 `@deepseek-ai/dsh-client-ui-primitives`；其余客户端包只在类型层使用。

**尚未验证**（需要把插件真正装进 DSH 才能确认，代码因此尚未合并）：

1. 页面在插件管理页能否正常打开、保存后行重启是否如 §6 所述不重载页面。
2. `ctx.slots.inject(...)` 的运行时行为与 `ctx.locale.register(...)` 的注册时序——两处都按官方文档与类型签名写，但没有跑起来的证据。
3. `form.state.writable` 与 `revision` 在保存前后的实际取值。

要在本机验证，需要一次 `pnpm install` 重建这个包的开发依赖（现有 `node_modules.dev` 是从 `dsh-claude-mem-git` 搬来的，pnpm 拒绝在其上增量安装），然后重启 DSH。

### 10.1 首次真实启动的故障与修复

第一次重启直接导致 web boot 失败，日志在 `%APPDATA%/@deepseek-ai/dsh-desktop/logs/crash-*-web-boot.log`：

```
Error: web boot: 1 entry did not activate
@liuhuoz/dsh-claude-mem: import failed (see console for the import error)
dsh-app://app/plugins/??...@liuhuoz/dsh-claude-mem/client.js:1 Uncaught SyntaxError: Cannot use import statement outside a module
```

原因：`dsh-client-modules` 把每个插件的 `client.js` 当**经典脚本**加载，执行宿主自带的 lazy-CJS 模块表（`window.__ModuleLoader__.load`）；而 tsdown 当时按 ESM 输出，顶层 `import` 在经典脚本里是语法错误，而且这一份坏的 ESM 还被拼进启动 combo，连带打乱了同批其他插件。

修复：客户端产物改为 CJS，并用 `banner`/`footer` 包成宿主期望的工厂形态：

```js
window.__ModuleLoader__.load({ id: "@liuhuoz/dsh-claude-mem", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* …CJS 正文，react 与 @deepseek-ai/* 走 require… */
  return module.exports;
}});
```

形态对照的是已在本机正常运行的 `dsh-notify-me` 与 `@michengai/dsh-code-review` 两个产物。新增 `tests/client-bundle.spec.ts`：用 `node:vm` 按宿主的方式加载产物、跑 `apply()`，产物若退回 ESM 该测试即失败。

### 10.2 插件标识统一为 `dsh-claude-mem`

原先两套叫法并存：包名是 `@liuhuoz/dsh-claude-mem`，而行 id 与 cordis 插件名是 `claude-mem`（两者都来自上游首个提交 `32ec6bd`）。统一为：

| 位置 | 旧 | 新 |
|---|---|---|
| `cordis.patch.yml` 行 id | `claude-mem` | `dsh-claude-mem` |
| `src/index.ts` 插件名 | `claude-mem` | `dsh-claude-mem` |
| `src/client/index.ts` 插件名 | `claude-mem-client` | `dsh-claude-mem-client` |
| 客户端 locale 命名空间 | `claude-mem` | `dsh-claude-mem` |
| 配置页 slot key 后缀 | `#claude-mem` | `#dsh-claude-mem` |

**没有改**的两处，因为它们指的不是插件：`src/hooks.ts` 的 `'claude-mem'` 是 PATH 上的可执行文件名回退值；`{ kind: 'claude-mem' }` 是注入消息的来源标记。

迁移代价：profile 里已有的行（`~/.dsh/profiles/desktop/cordis.patch.yml`）必须同步改 id，否则该行会变成找不到同名 bundle 行的孤儿，配置失效。发布给他人前应作为不兼容变更处理。

### 10.3 设置表单只认 volatile 字段

页面第一次真正打开时显示“插件配置加载完成前此页不可用”，即宿主传给条目的 `form` 是 `undefined`。

根因在 `dsh-client-ui-plugin-manager` 的 `formFor`：

```js
const configurations = props.useConfigurations((snapshot) => snapshot.view?.namespaces)
const formFor = (id) => {
  if (!configurations?.some((view) => view.ns === id)) return undefined   // ← 没有命名空间就没有 form
  ...
}
```

而命名空间由 `@deepseek-ai/dsh-settings` 的 `describe()` 投影，其中 `volatileForm(schema)` 只保留 `meta.volatile` 为真的字段；若一个字段都不剩，整个命名空间不出现：

```js
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') { /* 只递归保留 volatile 子字段 */ }
  // 非对象且非 volatile → undefined
}
```

所以：**想出现在设置表单里的字段必须 `.volatile()`**，否则该行的配置命名空间根本不存在，`form` 永远是 `undefined`。

对应改动：

- `Config` 里页面要编辑的 7 个字段（`baseUrl`、`hookPath`、`injectContext`、`ingest`、`summarize`、`autoStartWorker`、`toolFilter`）加 `.volatile()`；`timeoutMs`、`dedupe`、`project`、`platformSource` 保持普通字段，改它们仍需重载。
- volatile 字段在运行时是**单元格**而不是值，宿主原地写入该单元格——这正是“改完立即生效”的机制。因此新增 `src/settings.ts` 的 `resolveSettings()`，在**每次使用**时解包读取，而不是在 `apply()` 里读一次。
- `hooks.ts` 由“注册时读取配置”改为“每次钩子触发时读取”；`ingest`/`summarize` 的监听器改为**始终注册**、在回调内判断开关，否则页面上的开关拨不动行为。
- `WorkerClient` 的 `baseUrl` 接受 `string | () => string`，从而地址改动立即对后续请求生效。
- `tests/settings.spec.ts` 断言两件事：`resolveSettings` 能解包单元格；序列化后的 schema 里那 7 个字段都带 `meta.volatile`。后者正是这次事故的回归护栏。
