/**
 * Worker health vocabulary shared by the host plugin and its browser half.
 *
 * Pure module: no Node built-ins, no client packages, no React. Both bundles
 * carry it unchanged, so the settings page and the host agree on what the
 * worker's `/api/health` payload means.
 * @module dsh-claude-mem/probe
 */

/** The `/api/health` fields this plugin reports. Everything else is ignored. */
export interface WorkerHealth {
  readonly status: string
  readonly version?: string
  readonly pid?: number
  readonly initialized?: boolean
  readonly mcpReady?: boolean
  readonly provider?: string
  /** Absolute path of the script the worker runs from; its install directory. */
  readonly workerPath?: string
}

/** How a health reading should read in the settings page. */
export type HealthState = 'done' | 'warning'

/** Semantic outcome, keyed for the caller's own dictionary. */
export type HealthKey = 'connected' | 'notInitialized' | 'mcpUnavailable' | 'unhealthy'

/** A health reading the settings page can render without knowing the wire shape. */
export interface HealthReading {
  readonly state: HealthState
  readonly key: HealthKey
  readonly health: WorkerHealth
}

/**
 * What the host found when it looked for the MCP server this plugin launches.
 *
 * The worker's own `mcpReady` answers for its in-process server; it says nothing
 * about the child process a host starts from `mcp-server.cjs`. Only the host can
 * look, because only it can stat a path, so the reading travels beside the health
 * body instead of being read out of it.
 */
export interface McpClientReading {
  /** True when the server file was found beside the worker script. */
  readonly available: boolean
  /** The server file, when one was found. */
  readonly serverPath?: string
}

/** The health endpoint for a worker base URL. */
export function healthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/health`
}

/**
 * Host route the browser half calls instead of the worker directly.
 *
 * The desktop renderer's page origin is `dsh-app://app`, which claude-mem's
 * origin allowlist rejects with 403 — the browser cannot reach the worker from
 * there. This route runs in the same process as the plugin, so the check keeps
 * working wherever the page is served from.
 */
export const HEALTH_BRIDGE_PATH = '/api/dsh-claude-mem/health'

/**
 * Narrow an untrusted `/api/health` body. Returns `undefined` when the body is
 * not a health payload at all, so a proxy or a foreign service on the same port
 * is reported as "not the worker" instead of "the worker is unhealthy".
 */
export function parseHealth(payload: unknown): WorkerHealth | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.status !== 'string' || record.status.length === 0) return undefined
  const ai = typeof record.ai === 'object' && record.ai !== null ? (record.ai as Record<string, unknown>) : undefined
  return {
    status: record.status,
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(typeof record.pid === 'number' && Number.isFinite(record.pid) ? { pid: record.pid } : {}),
    ...(typeof record.initialized === 'boolean' ? { initialized: record.initialized } : {}),
    ...(typeof record.mcpReady === 'boolean' ? { mcpReady: record.mcpReady } : {}),
    ...(ai !== undefined && typeof ai.provider === 'string' ? { provider: ai.provider } : {}),
    ...(typeof record.workerPath === 'string' && record.workerPath.length > 0 ? { workerPath: record.workerPath } : {}),
  }
}

/**
 * Grade a parsed reading. A worker that answers but is not initialized or has
 * no MCP ready is reachable yet not usable, which is a different fix than an
 * unreachable one, so it reads as `warning` rather than `done`.
 *
 * `mcpClient` is the host's own finding about the server file. It is a second
 * question from `mcpReady`: a worker can report its MCP ready while this host
 * finds nothing to launch, which is exactly the failure that used to stay silent.
 * @param health - the worker's health payload, already narrowed.
 * @param mcpClient - whether the host found the server beside the worker script.
 */
export function readHealth(health: WorkerHealth, mcpClient?: McpClientReading): HealthReading {
  if (health.status !== 'ok') return { state: 'warning', key: 'unhealthy', health }
  if (health.initialized === false) return { state: 'warning', key: 'notInitialized', health }
  if (health.mcpReady === false) return { state: 'warning', key: 'mcpUnavailable', health }
  if (mcpClient?.available === false) return { state: 'warning', key: 'mcpUnavailable', health }
  return { state: 'done', key: 'connected', health }
}
