/**
 * A small MCP client over stdio.
 *
 * This is a protocol client, not a claude-mem client: it speaks the Model
 * Context Protocol to whatever server the caller names, and knows nothing about
 * where that server lives, which compiler it needs or which tools it offers.
 * Those are the host adapter's business — it owns the command line, the
 * environment and the working directory, and passes them in.
 *
 * One process per call. A server that would benefit from a long-lived session
 * can be wrapped later without changing this surface: `callTool` is the whole
 * contract, and every failure is a typed error rather than a thrown string.
 * @module dsh-claude-mem/mcp
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** Protocol revision offered at initialize; a server may answer its own. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** Upper bound for one rendered tool answer. */
export const MCP_TEXT_LIMIT = 64 * 1024

/** Default deadline for one request, initialize included. */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000

/** How to start a server: exactly what `spawn` needs, and nothing more. */
export interface McpServerSpec {
  readonly command: string
  readonly args?: readonly string[]
  /** Environment the child inherits; defaults to the current process's. */
  readonly env?: NodeJS.ProcessEnv
}

/** Per-call knobs: where it runs and how long the caller is willing to wait. */
export interface McpCallOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** One tool as `tools/list` reports it. */
export interface McpToolSummary {
  readonly name: string
  readonly description?: string
}

/** One rendered tool answer: text plus the server's own failure flag. */
export interface McpToolResult {
  readonly text: string
  readonly isError: boolean
}

export interface McpClientOptions {
  readonly timeoutMs?: number
  readonly clientName?: string
  readonly clientVersion?: string
}

/** A failure the caller can route on without parsing the message. */
export class McpError extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'McpError'
    this.code = code
  }
}

interface RpcResponse {
  readonly id?: number | string
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
}

/**
 * One server process, one request.
 *
 * `callTool` renders text and preserves the server's `isError` as an
 * `MCP_TOOL_ERROR`; `listTools` answers the advertised tool list. The child is
 * always killed before a call settles.
 */
export class McpClient {
  private readonly timeoutMs: number
  private readonly clientName: string
  private readonly clientVersion: string

  constructor(private readonly server: McpServerSpec, options: McpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
    this.clientName = options.clientName ?? 'dsh-claude-mem'
    this.clientVersion = options.clientVersion ?? '1'
  }

  async listTools(options: McpCallOptions = {}): Promise<readonly McpToolSummary[]> {
    const result = await this.request('tools/list', {}, options)
    if (result === null || typeof result !== 'object') return []
    const tools = (result as { tools?: unknown }).tools
    if (!Array.isArray(tools)) return []
    return tools
      .filter((tool): tool is { name?: unknown; description?: unknown } => tool !== null && typeof tool === 'object')
      .flatMap(tool => typeof tool.name === 'string'
        ? [{ name: tool.name, ...typeof tool.description === 'string' ? { description: tool.description } : {} }]
        : [])
  }

  async callTool(tool: string, args: Readonly<Record<string, unknown>>, options: McpCallOptions = {}): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name: tool, arguments: args }, options)
    return normalizeToolResult(result, tool)
  }

  private async request(method: string, params: unknown, options: McpCallOptions): Promise<unknown> {
    if (this.server.command.trim().length === 0) throw new McpError('an MCP server command is required', 'MCP_INVALID_REQUEST')
    if (options.signal?.aborted === true) throw new McpError('the MCP request was aborted', 'MCP_ABORTED')

    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const child = spawn(this.server.command, [...this.server.args ?? []], {
      cwd: options.cwd ?? process.cwd(),
      env: this.server.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    try {
      return await converse(child, method, params, {
        timeoutMs,
        signal: options.signal,
        clientName: this.clientName,
        clientVersion: this.clientVersion,
      })
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

interface ConverseOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly clientName: string
  readonly clientVersion: string
}

/** Drive one initialize + request exchange over a fresh channel. */
async function converse(
  child: ChildProcessWithoutNullStreams,
  method: string,
  params: unknown,
  options: ConverseOptions,
): Promise<unknown> {
  const channel = new Channel(child)
  let timedOut = false
  const stop = (error: McpError): void => {
    channel.fail(error)
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    stop(new McpError(`MCP request timed out after ${options.timeoutMs}ms`, 'MCP_TIMEOUT'))
  }, options.timeoutMs)
  const onAbort = (): void => stop(new McpError('the MCP request was aborted', 'MCP_ABORTED'))
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const initialized = await channel.request(0, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: options.clientName, version: options.clientVersion },
    })
    if (initialized.error !== undefined) {
      throw new McpError(`MCP server refused initialize: ${initialized.error.message ?? 'unknown error'}`, 'MCP_HANDSHAKE')
    }
    channel.notify('notifications/initialized', {})
    const response = await channel.request(1, method, params)
    if (response.error !== undefined) {
      throw new McpError(`MCP request ${method} failed: ${response.error.message ?? 'unknown error'}`, 'MCP_ERROR')
    }
    return response.result
  } catch (error) {
    if (timedOut) throw new McpError(`MCP request timed out after ${options.timeoutMs}ms`, 'MCP_TIMEOUT')
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    channel.close()
  }
}

/** Turn one `tools/call` result into text, refusing a silent empty answer. */
function normalizeToolResult(result: unknown, tool: string): McpToolResult {
  if (result === null || typeof result !== 'object') {
    throw new McpError(`MCP tool ${tool} answered nothing`, 'MCP_EMPTY')
  }
  const record = result as { content?: unknown; isError?: unknown }
  const text = Array.isArray(record.content)
    ? record.content
      .filter((block): block is { type?: unknown; text?: unknown } => block !== null && typeof block === 'object')
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
    : ''
  if (text.trim().length === 0) {
    throw new McpError(`MCP tool ${tool} answered an empty result`, 'MCP_EMPTY')
  }
  if (record.isError === true) throw new McpError(capText(text), 'MCP_TOOL_ERROR')
  return { text: capText(text), isError: false }
}

function capText(text: string): string {
  const body = text.trim()
  if (body.length <= MCP_TEXT_LIMIT) return body
  return `${body.slice(0, MCP_TEXT_LIMIT)}\n… [mcp] output truncated`
}

/** Line-delimited JSON-RPC over one child's stdio. */
class Channel {
  private buffer = ''
  private readonly waiting = new Map<number, { resolve: (response: RpcResponse) => void; reject: (error: McpError) => void }>()
  private failure: McpError | undefined
  private readonly stderr: { toString(): string }

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.stderr = collectStderr(child)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.ingest(chunk) })
    child.on('error', (error: Error) => {
      this.fail(new McpError(`MCP server could not start: ${error.message}`, 'MCP_UNAVAILABLE'))
    })
    child.on('close', (code: number | null) => {
      if (this.failure !== undefined) return
      if (this.waiting.size === 0) return
      const tail = this.stderr.toString().trim().split('\n').slice(-2).join(' | ').slice(0, 300)
      this.fail(new McpError(
        `MCP server exited (code ${code ?? 'killed'}) before answering${tail.length > 0 ? `: ${tail}` : ''}`,
        'MCP_FAILED',
      ))
    })
  }

  request(id: number, method: string, params: unknown): Promise<RpcResponse> {
    const failure = this.failure
    if (failure !== undefined) return Promise.reject(failure)
    const promise = new Promise<RpcResponse>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
    })
    this.send({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  fail(error: McpError): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const waiter of this.waiting.values()) waiter.reject(error)
    this.waiting.clear()
  }

  close(): void {
    this.waiting.clear()
    this.child.stdin.destroy()
  }

  private send(message: Readonly<Record<string, unknown>>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      this.fail(new McpError('MCP server stopped accepting input', 'MCP_FAILED'))
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
    const waiter = this.waiting.get(message.id)
    if (waiter === undefined) return
    this.waiting.delete(message.id)
    waiter.resolve(message)
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
