/**
 * Client for claude-mem's own MCP server.
 *
 * Two tool families exist only there: `smart_search` / `smart_outline` /
 * `smart_unfold` parse source files with tree-sitter, and the six corpus tools
 * drive the worker's knowledge-agent routes. The worker exposes no HTTP shortcut
 * for the first family and the second is streamed by the server itself, so the
 * plugin drives the server the way a harness does: one child process per call,
 * JSON-RPC over stdio.
 *
 * Two Windows facts shape this module:
 *
 * - The server's smart tools compile a grammar with `cl.exe` the first time a
 *   language is used. A GUI host does not inherit an MSVC environment, so the
 *   child gets `PATH` / `INCLUDE` / `LIB` composed here rather than relying on
 *   whatever the harness happens to export.
 * - The server resolves relative smart-search paths against its own working
 *   directory, so the child's cwd is the agent session's cwd.
 * @module dsh-claude-mem/mcp
 */

import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MemError } from './types.js'

/** claude-mem ships the server beside its hooks, under `scripts/`. */
export const MCP_SERVER_RELATIVE = join('scripts', 'mcp-server.cjs')

/** Protocol revision the server negotiates; any modern harness value is accepted. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** Upper bound for one rendered tool answer; smart output can be tens of kilobytes. */
export const MCP_TEXT_LIMIT = 64 * 1024

/** Default deadline for one tool call, initialize included. */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000

/** Resolved MSVC + Windows SDK layout, as the compiler expects it. */
export interface Toolchain {
  /** MSVC installation directory, e.g. `…/VC/Tools/MSVC/14.44.35207`. */
  readonly msvc: string
  /** Windows SDK version, e.g. `10.0.26100.0`. */
  readonly sdk: string
  readonly path: readonly string[]
  readonly include: readonly string[]
  readonly lib: readonly string[]
}

/** Everything one tool call needs; the caller owns the patience budget. */
export interface McpCallOptions {
  /** Working directory of the child, i.e. the session the call belongs to. */
  readonly cwd: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** One rendered tool answer: text plus the server's own failure flag. */
export interface McpToolResult {
  readonly text: string
  readonly isError: boolean
}

export interface McpClientOptions {
  readonly timeoutMs?: number
  /** Environment the child inherits; defaults to `process.env` plus the toolchain. */
  readonly env?: NodeJS.ProcessEnv
  /** Node binary used to start the server; defaults to `process.execPath`. */
  readonly node?: string
}

export interface LocateOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
}

interface RpcResponse {
  readonly id?: number | string
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
}

/**
 * Path of `mcp-server.cjs`, in precedence order: explicit configuration, the
 * plugin root a harness exports, the Claude/Codex plugin caches (newest version
 * first), then an npx install. Search only: nothing is installed or downloaded.
 */
export function locateMcpServer(explicit: string, options: LocateOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  for (const candidate of serverCandidates(explicit, env, home)) {
    if (isFile(candidate)) return candidate
  }
  return undefined
}

function serverCandidates(explicit: string, env: NodeJS.ProcessEnv, home: string): readonly string[] {
  const out: string[] = []
  const push = (candidate: string | undefined): void => {
    if (candidate !== undefined && candidate.trim().length > 0) out.push(candidate.trim())
  }

  push(explicit)
  if (env.CLAUDE_PLUGIN_ROOT !== undefined) push(join(env.CLAUDE_PLUGIN_ROOT, MCP_SERVER_RELATIVE))
  if (env.PLUGIN_ROOT !== undefined) push(join(env.PLUGIN_ROOT, MCP_SERVER_RELATIVE))

  const configDirs = [env.CLAUDE_CONFIG_DIR, join(home, '.claude'), join(home, '.codex')]
  for (const dir of configDirs) {
    if (dir === undefined || dir.length === 0) continue
    const base = join(dir, 'plugins', 'cache', 'thedotmack', 'claude-mem')
    for (const version of newestFirst(safeReaddir(base))) push(join(base, version, MCP_SERVER_RELATIVE))
  }

  const local = env.LOCALAPPDATA
  if (local !== undefined && local.length > 0) {
    const npx = join(local, 'npm-cache', '_npx')
    for (const hash of safeReaddir(npx)) {
      push(join(npx, hash, 'node_modules', 'claude-mem', MCP_SERVER_RELATIVE))
    }
  }
  return out
}

/** Numeric version directories, newest first; anything else is ignored. */
function newestFirst(names: readonly string[]): readonly string[] {
  return names
    .filter(name => /^\d+(\.\d+){1,3}/.test(name))
    .sort((left, right) => compareVersions(right, left))
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] =>
    value.split('.').slice(0, 4).map(part => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Compose the compiler layout from a known MSVC directory and SDK version. */
export function composeToolchain(msvc: string, kits: string, sdk: string): Toolchain {
  return {
    msvc,
    sdk,
    path: [
      join(msvc, 'bin', 'Hostx64', 'x64'),
      join(kits, 'bin', sdk, 'x64'),
    ],
    include: [
      join(msvc, 'include'),
      join(kits, 'Include', sdk, 'ucrt'),
      join(kits, 'Include', sdk, 'um'),
      join(kits, 'Include', sdk, 'shared'),
      join(kits, 'Include', sdk, 'winrt'),
    ],
    lib: [
      join(msvc, 'lib', 'x64'),
      join(kits, 'Lib', sdk, 'ucrt', 'x64'),
      join(kits, 'Lib', sdk, 'um', 'x64'),
    ],
  }
}

/**
 * Find an installed MSVC + Windows SDK on this machine, or `undefined`.
 *
 * Discovery is deliberately filesystem-only on the common layouts, with
 * `vswhere` as a last resort for a custom install location: this runs once per
 * process, and a missing toolchain must degrade to the server's own diagnostic
 * rather than fail the tool call.
 */
export function discoverToolchain(env: NodeJS.ProcessEnv = process.env): Toolchain | undefined {
  if (process.platform !== 'win32') return undefined
  const kits = findKits(env)
  if (kits === undefined) return undefined
  for (const root of findVisualStudioRoots(env)) {
    const msvcRoot = join(root, 'VC', 'Tools', 'MSVC')
    const newest = newestFirst(safeReaddir(msvcRoot))[0]
    if (newest === undefined) continue
    const sdk = newestFirst(safeReaddir(join(kits, 'Include')))[0]
    if (sdk === undefined) continue
    return composeToolchain(join(msvcRoot, newest), kits, sdk)
  }
  return undefined
}

function findKits(env: NodeJS.ProcessEnv): string | undefined {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles]
  for (const root of roots) {
    if (root === undefined) continue
    const kits = join(root, 'Windows Kits', '10')
    if (existsSync(join(kits, 'Include'))) return kits
  }
  return undefined
}

function findVisualStudioRoots(env: NodeJS.ProcessEnv): readonly string[] {
  const out: string[] = []
  const editions = ['BuildTools', 'Community', 'Professional', 'Enterprise']
  for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles]) {
    if (base === undefined) continue
    for (const edition of editions) out.push(join(base, 'Microsoft Visual Studio', '2022', edition))
  }

  const vswhere = env['ProgramFiles(x86)'] === undefined
    ? undefined
    : join(env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (vswhere !== undefined && existsSync(vswhere)) {
    try {
      const found = execFileSync(vswhere, [
        '-latest', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath',
      ], { encoding: 'utf8', timeout: 5_000, windowsHide: true }).trim()
      if (found.length > 0) out.push(found)
    } catch {
      // A broken vswhere is not worth reporting: the fixed candidates stay.
    }
  }
  return out
}

/**
 * Environment for the child: the caller's own, with an MSVC toolchain prepended
 * when one is installed. Prepending (never replacing) keeps a host that already
 * exports a toolchain working unchanged.
 */
export function withToolchainEnv(base: NodeJS.ProcessEnv = process.env, toolchain = discoverToolchain(base)): NodeJS.ProcessEnv {
  if (toolchain === undefined) return { ...base }
  const separator = process.platform === 'win32' ? ';' : ':'
  const joinList = (first: readonly string[], existing: string | undefined): string =>
    [...first, ...(existing ?? '').split(separator).filter(part => part.length > 0)].join(separator)
  return {
    ...base,
    PATH: joinList(toolchain.path, base.PATH),
    INCLUDE: joinList(toolchain.include, base.INCLUDE),
    LIB: joinList(toolchain.lib, base.LIB),
  }
}

/**
 * One MCP server process, one tool call.
 *
 * Every failure is a `MemError` with a stable code; a tool that reports
 * `isError` keeps its text and surfaces as `MCP_TOOL_ERROR`. The child is always
 * killed before this resolves.
 */
export class McpClient {
  private readonly timeoutMs: number
  private readonly env: NodeJS.ProcessEnv
  private readonly node: string

  constructor(private readonly script: string, options: McpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
    this.env = options.env ?? withToolchainEnv(process.env)
    this.node = options.node ?? process.env.DSH_MEM_NODE ?? process.execPath
  }

  async callTool(tool: string, args: Readonly<Record<string, unknown>>, options: McpCallOptions): Promise<McpToolResult> {
    const cwd = options.cwd.trim()
    if (cwd.length === 0) throw new MemError('an MCP tool call needs a working directory', 'MCP_INVALID_REQUEST')
    if (!isFile(this.script)) throw new MemError(`claude-mem MCP server not found at ${this.script}`, 'MCP_UNAVAILABLE')
    if (options.signal?.aborted === true) throw new MemError('the MCP tool call was aborted', 'MCP_ABORTED')

    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const child = spawn(this.node, [this.script], {
      cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    try {
      return await converse(child, tool, args, timeoutMs, options.signal)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
    }
  }
}

/** Drive one initialize + tools/call exchange over a fresh channel. */
async function converse(
  child: ChildProcessWithoutNullStreams,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<McpToolResult> {
  const channel = new Channel(child)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    channel.fail(new MemError(`claude-mem MCP call timed out after ${timeoutMs}ms`, 'MCP_TIMEOUT'))
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }, timeoutMs)
  const onAbort = (): void => {
    channel.fail(new MemError('the MCP tool call was aborted', 'MCP_ABORTED'))
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const initialized = await channel.request(0, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-claude-mem', version: '1' },
    })
    if (initialized.error !== undefined) {
      throw new MemError(`claude-mem MCP server refused initialize: ${initialized.error.message ?? 'unknown error'}`, 'MCP_HANDSHAKE')
    }
    channel.notify('notifications/initialized', {})
    const response = await channel.request(1, 'tools/call', { name: tool, arguments: args })
    if (response.error !== undefined) {
      throw new MemError(`claude-mem MCP tool ${tool} failed: ${response.error.message ?? 'unknown error'}`, 'MCP_ERROR')
    }
    return normalizeResult(response.result, tool)
  } catch (error) {
    if (timedOut) throw new MemError(`claude-mem MCP call timed out after ${timeoutMs}ms`, 'MCP_TIMEOUT')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    channel.close()
  }
}

/** Turn one JSON-RPC result into text, refusing a silent empty answer. */
function normalizeResult(result: unknown, tool: string): McpToolResult {
  if (result === null || typeof result !== 'object') {
    throw new MemError(`claude-mem MCP tool ${tool} answered nothing`, 'MCP_EMPTY')
  }
  const record = result as { content?: unknown; isError?: unknown }
  const text = Array.isArray(record.content)
    ? record.content
      .filter((block): block is { type?: unknown; text?: unknown } => block !== null && typeof block === 'object')
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
    : ''
  const isError = record.isError === true
  if (text.trim().length === 0) {
    throw new MemError(`claude-mem MCP tool ${tool} answered an empty result`, 'MCP_EMPTY')
  }
  if (isError) throw new MemError(capText(text), 'MCP_TOOL_ERROR')
  return { text: capText(text), isError: false }
}

function capText(text: string): string {
  const body = text.trim()
  if (body.length <= MCP_TEXT_LIMIT) return body
  return `${body.slice(0, MCP_TEXT_LIMIT)}\n… [claude-mem] MCP output truncated`
}

/** Line-delimited JSON-RPC over one child's stdio. */
class Channel {
  private buffer = ''
  private readonly waiting = new Map<number, (response: RpcResponse) => void>()
  private failure: MemError | undefined
  private readonly stderr: { toString(): string }

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.stderr = collectStderr(child)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.ingest(chunk) })
    child.on('error', (error: Error) => {
      this.fail(new MemError(`claude-mem MCP server could not start: ${error.message}`, 'MCP_UNAVAILABLE'))
    })
    child.on('close', (code: number | null) => {
      if (this.failure !== undefined) return
      if (this.waiting.size > 0) {
        const tail = this.stderrTail()
        this.fail(new MemError(
          `claude-mem MCP server exited (code ${code ?? 'killed'}) before answering${tail.length > 0 ? `: ${tail}` : ''}`,
          'MCP_FAILED',
        ))
      }
    })
  }

  request(id: number, method: string, params: unknown): Promise<RpcResponse> {
    const failure = this.failure
    if (failure !== undefined) return Promise.reject(failure)
    const promise = new Promise<RpcResponse>(resolve => {
      this.waiting.set(id, resolve)
    })
    this.send({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  fail(error: MemError): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const resolve of this.waiting.values()) resolve({ error: { message: error.message } })
    this.waiting.clear()
  }

  close(): void {
    for (const resolve of this.waiting.values()) resolve({ error: { message: 'the MCP call is over' } })
    this.waiting.clear()
    this.child.stdin.destroy()
  }

  private send(message: Readonly<Record<string, unknown>>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      this.fail(new MemError('claude-mem MCP server stopped accepting input', 'MCP_FAILED'))
    }
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    let end = this.buffer.indexOf('\n')
    while (end >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (line.length > 0) this.accept(line)
      end = this.buffer.indexOf('\n')
    }
  }

  private accept(line: string): void {
    let message: RpcResponse
    try {
      message = JSON.parse(line) as RpcResponse
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const resolve = this.waiting.get(message.id)
    if (resolve === undefined) return
    this.waiting.delete(message.id)
    resolve(message)
  }

  private stderrTail(): string {
    return this.stderr.toString().trim().split('\n').slice(-2).join(' | ').slice(0, 300)
  }

}

/** Keep the child's stderr available for one actionable failure message. */
function collectStderr(child: ChildProcessWithoutNullStreams): { toString(): string } {
  let text = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (text.length < 4_000) text += chunk
  })
  return { toString: () => text }
}

function safeReaddir(dir: string): readonly string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
