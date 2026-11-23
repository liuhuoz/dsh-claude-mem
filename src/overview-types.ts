/**
 * The overview payload's shape, shared by the host aggregator and the browser
 * panel. Pure declarations only: the client bundle cannot import the module
 * that reads files, and the host cannot import React.
 * @module dsh-claude-mem/overview-types
 */

/** The payload the panel renders. Fields are null when their source failed. */
export interface Overview {
  readonly worker: { version?: string; port?: number; uptimeSeconds?: number; activeSessions?: number } | null
  readonly database: { observations?: number; sessions?: number; summaries?: number; sizeBytes?: number; firstObservationAt?: string } | null
  readonly processing: { queueDepth?: number; isProcessing?: boolean; lastSuccessfulStoreAt?: number } | null
  readonly mcp: { enabled?: boolean } | null
  readonly chroma: { status?: string } | null
  readonly projects: { total: number; active: number; excluded: number } | null
  readonly recent: readonly { type: string; title: string; project: string; createdAt: string }[] | null
  readonly sessions: readonly { title: string; project: string; itemCount: number; startedAt: number }[] | null
  readonly injection: { project: string; chars: number; lines: number; head: string } | null
  readonly savings: { day: string; events: number; readTokens: number; savedTokens: number; percent: number } | null
  readonly fetchedAt: number
}

/** What the aggregator needs; injected so tests never touch the network. */
export interface OverviewOptions {
  /** Resolved worker base URL, e.g. http://127.0.0.1:37777. */
  readonly baseUrl: string
  /** Clock override for tests. */
  readonly now?: number
  /** Telemetry file override for tests. */
  readonly telemetryPath?: string
  /** fetch override for tests. */
  readonly fetchImpl?: typeof fetch
  /** Per-request deadline. */
  readonly timeoutMs?: number
}
