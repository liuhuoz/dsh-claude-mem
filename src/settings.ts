/**
 * Resolved settings the plugin acts on.
 *
 * Fields the settings page edits are declared `.volatile()` in the schema, so
 * schemastery hands the plugin a cell rather than a value: the host writes that
 * cell in place when the user edits the field, which is what makes an edit take
 * effect without remounting the plugin. Everything below therefore reads the
 * captured config lazily — at the moment a hook or a request needs the value,
 * never once at startup.
 * @module dsh-claude-mem/settings
 */

/** Plain, resolved settings: what the rest of the plugin consumes. */
export interface LiveSettings {
  readonly baseUrl: string
  readonly project: string
  readonly platformSource: string
  readonly hookPath: string
  readonly ingest: boolean
  readonly summarize: boolean
  readonly autoStartWorker: boolean
  readonly toolFilter: { readonly names: readonly string[] }
  readonly timeoutMs: number
  readonly dedupe: boolean
}

/** Defaults mirroring the schema; used when a host hands over an empty config. */
const DEFAULTS = {
  baseUrl: '',
  project: '',
  platformSource: '',
  hookPath: '',
  ingest: true,
  summarize: true,
  autoStartWorker: true,
  timeoutMs: 30_000,
  dedupe: true,
} as const

const DEFAULT_TOOL_NAMES: readonly string[] = ['read', 'write', 'edit', 'bash']

/**
 * Read a possibly-volatile field. A `.volatile()` field arrives as a cell with
 * `get()`; anything else arrives as the value itself. A cell still carrying its
 * default is indistinguishable from a written one, so the default is applied
 * before the cell wrapper and never after.
 */
function read<T>(value: unknown, fallback: T): T {
  let current = value
  if (current !== null && typeof current === 'object' && typeof (current as { get?: unknown }).get === 'function') {
    current = (current as { get(): unknown }).get()
  }
  if (current === undefined || current === null) return fallback
  return current as T
}

function readText(value: unknown, fallback: string): string {
  const text = read<unknown>(value, fallback)
  return typeof text === 'string' ? text : fallback
}

function readFlag(value: unknown, fallback: boolean): boolean {
  const flag = read<unknown>(value, fallback)
  return typeof flag === 'boolean' ? flag : fallback
}

function readToolNames(value: unknown): readonly string[] {
  const filter = read<unknown>(value, undefined)
  if (filter === null || typeof filter !== 'object') return DEFAULT_TOOL_NAMES
  const names = (filter as { names?: unknown }).names
  const list = read<unknown>(names, undefined)
  if (!Array.isArray(list)) return DEFAULT_TOOL_NAMES
  const strings = list.filter((name): name is string => typeof name === 'string')
  return strings.length === 0 ? DEFAULT_TOOL_NAMES : strings
}

/**
 * Project the captured plugin config into plain settings.
 * @param raw - the config cordis resolved for this plugin instance.
 * @returns resolved settings, valid for this call only.
 */
export function resolveSettings(raw: unknown): LiveSettings {
  const source = (raw ?? {}) as Record<string, unknown>
  return {
    baseUrl: readText(source.baseUrl, DEFAULTS.baseUrl),
    project: readText(source.project, DEFAULTS.project),
    platformSource: readText(source.platformSource, DEFAULTS.platformSource),
    hookPath: readText(source.hookPath, DEFAULTS.hookPath),
    ingest: readFlag(source.ingest, DEFAULTS.ingest),
    summarize: readFlag(source.summarize, DEFAULTS.summarize),
    autoStartWorker: readFlag(source.autoStartWorker, DEFAULTS.autoStartWorker),
    toolFilter: { names: readToolNames(source.toolFilter) },
    timeoutMs: read<number>(source.timeoutMs, DEFAULTS.timeoutMs),
    dedupe: readFlag(source.dedupe, DEFAULTS.dedupe),
  }
}
