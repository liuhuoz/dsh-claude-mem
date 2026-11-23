/**
 * Phase-2 file context: ask the worker which observations mention a file, then
 * render, gate and dedupe it here.
 *
 * The worker only answers rows (`GET /api/observations/by-file`); the CLI used
 * to own the rest and cost a process start per read. Everything below is the
 * behaviour that used to live there, kept in sync with it deliberately: the
 * rendered block, the staleness rule and the per-session dedupe all match.
 * @module dsh-claude-mem/file-context
 */

import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { MemObservation } from './types.js'
import type { WorkerClient } from './worker.js'

/** Upper bound for one injected block; a single file can render tens of kilobytes. */
export const FILE_CONTEXT_LIMIT = 4000

/** How long one worker lookup may take before the injection is abandoned. */
export const FILE_CONTEXT_TIMEOUT_MS = 3000

/** How many observation rows one lookup asks for (the newest ones). */
export const FILE_CONTEXT_OBSERVATION_LIMIT = 15

/** Files below this size are too small to be worth a block. */
export const FILE_CONTEXT_MIN_BYTES = 1500

/**
 * How long a lookup may be reused by the gate and the read that follows it.
 *
 * The pair runs milliseconds apart, so this only has to bridge one read; a
 * short window keeps a brand-new observation from staying invisible for long.
 */
export const FILE_CONTEXT_MEMORY_TTL_MS = 5_000

/** At most this many files are taken from one shell command. */
export const FILE_CONTEXT_MAX_CANDIDATES = 3

/** Files at or above this size are worth gating: a full read dumps them into context. */
export const GATE_MIN_BYTES = 32 * 1024

/** Extensions whose full read is always allowed; upstream skips them too. */
export const GATE_EXCLUDED_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.yaml', '.yml', '.toml']

/** The parts of one tool call file context needs, kept separate so tests need no agent. */
export interface FileContextRequest {
  readonly sessionId: string
  readonly cwd: string
  readonly toolName: string
  readonly arguments: unknown
}

/** Anything that can answer one tool call with a rendered context block. */
export interface FileContextSource {
  fetch(request: FileContextRequest): Promise<string | null>
}

/** What one file's memory looks like right now. */
export interface FileMemory {
  readonly observations: readonly MemObservation[]
  readonly mtimeMs: number
  readonly sizeBytes: number
  readonly newestEpochMs: number
}

interface FileStat {
  readonly mtimeMs: number
  readonly sizeBytes: number
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Rewrite MSYS drive paths (`/d/repo/x`) into Windows form (`D:/repo/x`).
 *
 * Shell commands carry those paths on this platform and claude-mem stored the
 * Windows form, so a command has to be normalised before its arguments are
 * looked up. Only a token boundary followed by one drive letter and a slash is
 * rewritten, so ordinary text and URLs are left alone.
 */
export function msysToWin(text: string): string {
  return text.replace(/(^|[\s"'(=])\/([A-Za-z])\//g, (_match, lead: string, drive: string) => `${lead}${drive.toUpperCase()}:/`)
}

/** Stat one file, or answer null when it is missing or not a file. */
export function inspectFile(absolutePath: string): FileStat | null {
  try {
    const stat = statSync(absolutePath)
    if (!stat.isFile()) return null
    return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size }
  } catch {
    return null
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The forms of one path worth asking about.
 *
 * claude-mem matched a file by every spelling it could have been captured
 * under, so the absolute form, the cwd-relative form and the home form all go
 * to the worker; its SQL adds slash and `./` variants on top.
 */
export function fileQueryPaths(cwd: string, absolutePath: string): readonly string[] {
  const variants = new Set<string>()
  const absolute = toPosix(absolutePath)
  variants.add(absolute)
  const relativePath = toPosix(relative(cwd, absolutePath))
  if (relativePath.length > 0 && relativePath !== '..' && !relativePath.startsWith('../') && !isAbsolute(relativePath)) {
    variants.add(relativePath)
  }
  const home = homedir()
  if (home.length > 0) {
    const fromHome = toPosix(relative(home, absolutePath))
    if (fromHome.length > 0 && fromHome !== '..' && !fromHome.startsWith('../') && !isAbsolute(fromHome)) {
      variants.add(`~/${fromHome}`)
    }
  }
  return [...variants]
}

/** Read-only shell commands whose file arguments are worth resolving. */
const READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'sed', 'awk', 'grep', 'rg',
  'wc', 'sort', 'uniq', 'diff', 'xxd', 'strings', 'jq', 'type',
])

/** PowerShell read commands this batch understands. */
const POWERSHELL_READ = /^(get-content|gc|type|select-string)$/i

function tokenize(command: string): string[] {
  return msysToWin(command)
    .split(/[\s;|&<>()]+/)
    .map(token => token.replace(/^["']|["']$/g, ''))
    .filter(token => token.length > 0)
}

/**
 * Files named by a read-only shell command.
 *
 * Deliberately conservative: only a whitelisted command's plain arguments are
 * tried, each one must stat as a file, and at most three are kept. A miss
 * costs one skipped block; a wrong hit would inject unrelated memory.
 */
export function commandFiles(command: string, cwd: string, powershell = false): string[] {
  const words = tokenize(command)
  const first = words[0]
  if (first === undefined) return []
  const commandName = basename(first).replace(/\.(exe|cmd|bat)$/i, '')
  if (powershell ? !POWERSHELL_READ.test(commandName) : !READ_COMMANDS.has(commandName.toLowerCase())) return []
  const files: string[] = []
  for (const token of words.slice(1)) {
    if (token.startsWith('-')) continue
    if (token.includes('=') && !token.includes('/') && !token.includes('\\')) continue
    const candidate = resolve(cwd, token)
    if (inspectFile(candidate) === null) continue
    files.push(candidate)
    if (files.length >= FILE_CONTEXT_MAX_CANDIDATES) break
  }
  return files
}

/** Files one tool call is about, as absolute paths. Empty when nothing qualifies. */
export function pathCandidates(request: FileContextRequest): readonly string[] {
  const name = request.toolName
  if (name === 'read') {
    const filePath = stringField(request.arguments, 'file_path')
    return filePath === undefined ? [] : [resolve(request.cwd, filePath)]
  }
  if (name === 'ops_bash' || name === 'bash' || name === 'shell' || name === 'pwsh') {
    const command = stringField(request.arguments, 'command')
    if (command === undefined) return []
    const workdir = stringField(request.arguments, 'workdir') ?? request.cwd
    return commandFiles(command, workdir, name === 'pwsh')
  }
  return []
}

const TYPE_ICONS: Readonly<Record<string, string>> = {
  decision: '⚖️',
  bugfix: '🔴',
  feature: '🟣',
  refactor: '🔄',
  discovery: '🔵',
  change: '✅',
}

/** `2026-11-23 3:46pm GMT+8`, the header line's clock. */
function nowLabel(now: Date): string {
  const date = now.toLocaleDateString('en-CA')
  const clock = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase()
    .replace(/\s+/g, '')
  const zone = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop() ?? ''
  return `${date} ${clock} ${zone}`.trim()
}

/** `Nov 22, 2026`, the day separator. */
function dayLabel(epochMs: number): string {
  return new Date(epochMs).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** `12:35p`, a row's clock: lowercased, and the meridiem letter alone. */
function clockLabel(epochMs: number): string {
  return new Date(epochMs)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase()
    .replace(/\s+([ap])m\b/g, '$1')
}

function quoted(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/**
 * Render the block claude-mem used to render, line for line.
 *
 * The wording, the day separators, the type glyphs and the row shape all match
 * the CLI's, so an injected block looks the same whichever path produced it.
 */
export function renderFileContext(displayPath: string, observations: readonly MemObservation[], now = new Date()): string {
  const lines = [
    `Current: ${nowLabel(now)}`,
    'This file has prior observations — supplementary context follows. The Read result below is the full requested section.',
    '- **Need details on a past observation?** get_observations([IDs]) — ~300 tokens each.',
    `- **Need a structural map first?** smart_outline("${quoted(displayPath)}") — line numbers only, cheaper than re-reading.`,
  ]
  let day = ''
  const ordered = [...observations].sort((a, b) => (a.createdAtEpoch ?? 0) - (b.createdAtEpoch ?? 0))
  for (const observation of ordered) {
    const epoch = observation.createdAtEpoch ?? 0
    const label = dayLabel(epoch)
    if (label !== day) {
      lines.push(`### ${label}`)
      day = label
    }
    const title = (observation.title || 'Untitled')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)
    const icon = TYPE_ICONS[observation.type ?? ''] ?? '❓'
    lines.push(`${observation.id} ${clockLabel(epoch)} ${icon} ${title}`)
  }
  return lines.join('\n')
}

/** Keep one injected block under the model-facing budget. */
export function capContext(text: string, limit = FILE_CONTEXT_LIMIT): string {
  const body = text.trim()
  if (body.length <= limit) return body
  return `${body.slice(0, limit)}\n… [claude-mem] file context truncated`
}

interface CachedMemory {
  readonly at: number
  readonly mtimeMs: number
  readonly memory: FileMemory | null
}

/**
 * One file's memory, fetched at most once per read.
 *
 * The gate runs before a read and the block after it, so both ask within a few
 * milliseconds; the cache makes that one worker request while still noticing a
 * file that changed in between.
 */
export class FileMemoryLookup {
  private readonly cache = new Map<string, CachedMemory>()

  constructor(
    private readonly worker: WorkerClient,
    private readonly ttlMs = FILE_CONTEXT_MEMORY_TTL_MS,
    private readonly limit = FILE_CONTEXT_OBSERVATION_LIMIT,
  ) {}

  async inspect(
    request: { readonly sessionId: string; readonly cwd: string },
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<FileMemory | null> {
    const stat = inspectFile(absolutePath)
    if (stat === null || stat.sizeBytes < FILE_CONTEXT_MIN_BYTES) return null
    const key = `${request.sessionId}\u0000${absolutePath}`
    const cached = this.cache.get(key)
    const now = Date.now()
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && now - cached.at < this.ttlMs) {
      return cached.memory
    }
    const observations = await this.worker.byFile(fileQueryPaths(request.cwd, absolutePath), { limit: this.limit }, signal)
    const newestEpochMs = observations.reduce((max, row) => Math.max(max, row.createdAtEpoch ?? 0), 0)
    const memory: FileMemory | null = observations.length === 0
      ? null
      : { observations, ...stat, newestEpochMs }
    this.cache.set(key, { at: now, mtimeMs: stat.mtimeMs, memory })
    this.prune()
    return memory
  }

  forget(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }

  private prune(): void {
    if (this.cache.size <= 256) return
    for (const key of [...this.cache.keys()].slice(0, this.cache.size - 256)) this.cache.delete(key)
  }
}

/**
 * Answer one tool call with the memory attached to its file, or null.
 *
 * Every failure mode — no path, missing file, an unreachable worker, a file
 * changed after its newest observation, a block already shown this session —
 * answers null: file context is never worth breaking a tool call over.
 */
export class HttpFileContext implements FileContextSource {
  /** session id → absolute path → the newest observation epoch already shown. */
  private readonly injected = new Map<string, Map<string, number>>()

  constructor(
    private readonly memory: FileMemoryLookup,
    private readonly timeoutMs = FILE_CONTEXT_TIMEOUT_MS,
  ) {}

  async fetch(request: FileContextRequest): Promise<string | null> {
    const candidates = pathCandidates(request)
    if (candidates.length === 0) return null
    const seen = this.seenFor(request.sessionId)
    const blocks: string[] = []
    for (const candidate of candidates) {
      const absolute = realpathOr(candidate)
      let memory: FileMemory | null
      try {
        memory = await this.memory.inspect(request, absolute, AbortSignal.timeout(this.timeoutMs))
      } catch {
        return null
      }
      if (memory === null) continue
      // Stale: the file changed after its newest observation, so the notes
      // describe something the file no longer says.
      if (memory.mtimeMs >= memory.newestEpochMs) continue
      if ((seen.get(absolute) ?? 0) >= memory.newestEpochMs) continue
      seen.set(absolute, memory.newestEpochMs)
      blocks.push(renderFileContext(toPosix(candidate), memory.observations))
    }
    if (blocks.length === 0) return null
    return capContext(blocks.join('\n\n---\n\n'))
  }

  forget(sessionId: string): void {
    this.injected.delete(sessionId)
    this.memory.forget(sessionId)
  }

  private seenFor(sessionId: string): Map<string, number> {
    let seen = this.injected.get(sessionId)
    if (seen === undefined) {
      seen = new Map<string, number>()
      this.injected.set(sessionId, seen)
    }
    return seen
  }
}

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

/**
 * True when the prompt the user actually typed names this file.
 *
 * The gate is a token heuristic, so an explicit request outranks it: a full
 * path, the last two path segments, or a file name long enough to be specific
 * all count as "the user asked for this file".
 */
export function promptMentionsFile(prompt: string, filePath: string): boolean {
  const haystack = prompt.replace(/\\/g, '/').toLowerCase()
  if (haystack.trim().length === 0) return false
  const needle = filePath.replace(/\\/g, '/').toLowerCase()
  if (haystack.includes(needle)) return true
  const segments = needle.split('/').filter(part => part.length > 0)
  const base = segments[segments.length - 1] ?? ''
  if (base.length >= 10 && haystack.includes(base)) return true
  const tail = segments.slice(-2).join('/')
  return tail.length > base.length && haystack.includes(tail)
}
