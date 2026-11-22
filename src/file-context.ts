/**
 * Phase-1 file context: turn one DSH tool call into claude-mem's PreToolUse
 * payload, run claude-mem's own hook, and hand back the rendered context.
 *
 * The translation layer is deliberately thin: claude-mem keeps the path
 * extraction, the staleness gate and the per-session dedupe, so this module only
 * renames the tool, normalises the arguments and parses one JSON field back out.
 * @module dsh-claude-mem/file-context
 */

import { spawn } from 'node:child_process'

/** Upper bound for one injected block; a single file can render tens of kilobytes. */
export const FILE_CONTEXT_LIMIT = 4000

/** How long the hook may take before the injection is abandoned. */
export const FILE_CONTEXT_TIMEOUT_MS = 3000

/** claude-mem's PreToolUse input, reduced to the fields its hook reads. */
export interface PreToolPayload {
  readonly session_id: string
  readonly cwd: string
  readonly hook_event_name: 'PreToolUse'
  readonly tool_name: string
  readonly tool_input: Record<string, unknown>
}

/** The parts of a tool call the translation needs, kept separate so tests need no agent. */
export interface ToolCall {
  readonly sessionId: string
  readonly cwd: string
  readonly name: string
  readonly arguments: unknown
}

/** Anything that can answer one payload with claude-mem-rendered context. */
export interface FileContextSource {
  fetch(payload: PreToolPayload): Promise<string | null>
}

/** DSH tool names to the Claude Code names claude-mem's matcher and parser know. */
export function claudeToolName(name: string): string {
  if (name === 'read') return 'Read'
  if (name === 'ops_bash' || name === 'pwsh' || name === 'bash' || name === 'shell') return 'Bash'
  if (name === 'grep') return 'Grep'
  if (name === 'glob') return 'Glob'
  return name
}

/**
 * Rewrite MSYS drive paths (`/d/repo/x`) into Windows form (`D:/repo/x`).
 *
 * Only a token boundary followed by one drive letter and a slash is rewritten,
 * so ordinary text and URLs are left alone. claude-mem resolves paths with
 * Node's `path` module on Windows, which cannot see the MSYS form.
 */
export function msysToWin(text: string): string {
  return text.replace(/(^|[\s"'(=])\/([A-Za-z])\//g, (_match, lead: string, drive: string) => `${lead}${drive.toUpperCase()}:/`)
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function optionalField(value: unknown, key: string): Record<string, string> {
  const found = stringField(value, key)
  return found === undefined ? {} : { [key]: found }
}

/**
 * Translate one tool call, or answer `null` when the call carries nothing the
 * hook could use. `Bash` keeps its command (MSYS-normalised) and adopts a
 * `workdir` argument as the payload cwd, because claude-mem resolves relative
 * paths against it.
 */
export function preToolPayload(call: ToolCall): PreToolPayload | null {
  const tool = claudeToolName(call.name)
  const args = call.arguments
  let cwd = call.cwd
  let toolInput: Record<string, unknown> | null = null

  if (tool === 'Read') {
    const filePath = stringField(args, 'file_path')
    toolInput = filePath === undefined ? null : { file_path: filePath }
  } else if (tool === 'Bash') {
    const command = stringField(args, 'command')
    toolInput = command === undefined ? null : { command: msysToWin(command) }
    const workdir = stringField(args, 'workdir')
    if (workdir !== undefined) cwd = workdir
  } else if (tool === 'Grep' || tool === 'Glob') {
    const pattern = stringField(args, 'pattern')
    toolInput = pattern === undefined ? null : { pattern, ...optionalField(args, 'path') }
  }

  if (toolInput === null) return null
  return {
    session_id: call.sessionId,
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
  }
}

/** Keep one injected block under the model-facing budget. */
export function capContext(text: string, limit = FILE_CONTEXT_LIMIT): string {
  const body = text.trim()
  if (body.length <= limit) return body
  return `${body.slice(0, limit)}\n… [claude-mem] file context truncated`
}

/** Read the single field claude-mem's hook contract exposes. */
export function parseHookOutput(stdout: string): string | null {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const output = (parsed as { hookSpecificOutput?: unknown }).hookSpecificOutput
  if (output === null || typeof output !== 'object') return null
  const context = (output as { additionalContext?: unknown }).additionalContext
  if (typeof context !== 'string' || context.trim().length === 0) return null
  return capContext(context)
}

/**
 * Run `claude-mem hook claude-code file-context` and answer with its context.
 *
 * Every failure mode — missing launcher, non-zero exit, timeout, malformed
 * JSON, empty context — answers `null`; a file context is never worth breaking
 * a tool call over.
 */

/**
 * True when the prompt the user actually typed names this file.
 *
 * The gate is a token heuristic, so an explicit request outranks it: a full
 * path, the last two path segments, or a file name long enough to be specific
 * all count as "the user asked for this file".
 */
export function promptMentionsFile(prompt: string, filePath: string): boolean {
  const haystack = prompt.replace(/\\/g, "/").toLowerCase()
  if (haystack.trim().length === 0) return false
  const needle = filePath.replace(/\\/g, "/").toLowerCase()
  if (haystack.includes(needle)) return true
  const segments = needle.split("/").filter(part => part.length > 0)
  const base = segments[segments.length - 1] ?? ""
  if (base.length >= 10 && haystack.includes(base)) return true
  const tail = segments.slice(-2).join("/")
  return tail.length > base.length && haystack.includes(tail)
}

/** Files at or above this size are worth gating: a full read dumps them into context. */
export const GATE_MIN_BYTES = 32 * 1024

/** Extensions whose full read is always allowed; upstream skips them too. */
export const GATE_EXCLUDED_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.yaml', '.yml', '.toml']

/**
 * Decide whether a tool call is a full-file read worth gating.
 *
 * Only a plain `read` of one file qualifies: a call that already narrows the
 * range (offset or limit) is what the gate wants the model to do instead, so it
 * always passes. The extension filter mirrors claude-mem's, where prose and
 * configuration are exempt from the gate.
 */
export function gateCandidate(name: string, args: unknown): { filePath: string } | null {
  if (name !== 'read') return null
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  const record = args as Record<string, unknown>
  const filePath = record.file_path
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  const offset = typeof record.offset === 'number' ? record.offset : undefined
  if (offset !== undefined && offset > 1) return null
  if (typeof record.limit === 'number') return null
  const lower = filePath.toLowerCase()
  if (GATE_EXCLUDED_EXTENSIONS.some(ext => lower.endsWith(ext))) return null
  return { filePath }
}

/** Model-facing explanation of the denied full read, in DSH's tool vocabulary. */
export function gateReason(filePath: string, sizeBytes: number): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const kb = Math.round(sizeBytes / 1024)
  return [
    `[claude-mem] Full-file read blocked: ${name} is ${kb} KB and memory already covers it.`,
    '- Read only what you need: call read again with offset and limit around the section you are changing.',
    '- Reuse what is already known: mem_search with a query about this file, or mem_get_observations with the ids from the file context.',
    'Partial reads are always allowed.',
  ].join('\n')
}

export class HookCliFileContext implements FileContextSource {
  constructor(
    private readonly launcher: string,
    private readonly timeoutMs = FILE_CONTEXT_TIMEOUT_MS,
  ) {}

  fetch(payload: PreToolPayload): Promise<string | null> {
    return new Promise<string | null>(resolve => {
      let settled = false
      const finish = (value: string | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      let child: ReturnType<typeof spawn>
      try {
        child = spawn(this.launcher, ['hook', 'claude-code', 'file-context'], {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        })
      } catch {
        finish(null)
        return
      }

      let stdout = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // Already gone: the close handler still settles the promise.
        }
        finish(null)
      }, this.timeoutMs)

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })
      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        finish(code === 0 ? parseHookOutput(stdout) : null)
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify(payload))
    })
  }
}
