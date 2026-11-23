/**
 * Vocabulary and error taxonomy for the claude-mem worker HTTP API. Kept local
 * (no monorepo-only dependencies) so this package installs from a git clone.
 * @module dsh-claude-mem/types
 */

/**
 * A worker error with a stable machine-routable `code` distinct from its
 * human-readable `message`. The plugin replaces the harness seam's
 * `HarnessError` base so the package has no `@deepseek-ai/dsh-llm` dependency.
 */
export class MemError extends Error {
  /** Stable machine-routable failure class; route on this, never by parsing `message`. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = 'MemError'
  }
}

/**
 * One persisted observation returned by a memory query. Mirrors the worker HTTP
 * API's `/api/observations/batch` shape as closely as possible so tool output
 * keeps parity with a direct API call: every field the worker returns is
 * carried through (JSON-encoded array/object fields are decoded on input).
 */
export interface MemObservation {
  readonly id: number
  readonly title: string
  readonly memorySessionId?: string
  readonly type?: string
  readonly project?: string
  readonly subtitle?: string
  readonly text?: string
  readonly narrative?: string
  readonly facts?: readonly string[]
  readonly concepts?: readonly string[]
  readonly filesRead?: readonly string[]
  readonly filesModified?: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly createdAt?: string
  readonly createdAtEpoch?: number
  readonly promptNumber?: number
  readonly discoveryTokens?: number
  readonly contentHash?: string
  readonly generatedByModel?: string
  readonly relevanceCount?: number
  readonly mergedIntoProject?: string
  readonly agentType?: string
  readonly agentId?: string
  readonly syncedAt?: number
  readonly originDeviceId?: string
  readonly originLocalId?: string
  readonly syncRev?: string
}

/** Free-text search query with optional filters. `platformSource` is an optional signal, never an enforced restriction. */
export interface MemSearchRequest {
  readonly query: string
  readonly limit?: number
  readonly project?: string
  readonly platformSource?: string
  readonly type?: string
  readonly obsType?: string
  readonly dateStart?: string
  readonly dateEnd?: string
  readonly offset?: number
  readonly orderBy?: 'date_desc' | 'date_asc'
  readonly deep?: boolean
}

/** Normalized query result: either the worker's own index text or a typed item list. */
export interface MemSearchResult {
  readonly items: readonly MemObservation[]
  readonly content?: string
}

/** One-call dumb search: the worker renders the whole answer as text. */
export interface MemDumbSearchRequest {
  readonly query: string
  readonly project?: string
  readonly limit?: number
  readonly maxDetails?: number
  readonly depthBefore?: number
  readonly depthAfter?: number
}

/**
 * The worker's rendered dumb-search text plus its own failure tag. The tag is
 * carried through untouched: a DSH tool result has no `isError` slot, so the
 * value keeps the field instead of turning a reported failure into a throw.
 */
export interface MemDumbSearchResult {
  readonly content: string
  readonly isError?: true
}

/** One raw tool call from `/api/tool-uses/batch`, bodies included and unparsed. */
export interface MemToolUse {
  readonly id: number
  readonly toolUseId?: string
  readonly toolName?: string
  readonly project?: string
  readonly platformSource?: string
  readonly memorySessionId?: string
  readonly contentSessionId?: string
  readonly sessionDbId?: number
  readonly promptNumber?: number
  readonly createdAt?: string
  readonly createdAtEpoch?: number
  readonly inputBytes?: number
  readonly responseBytes?: number
  readonly toolInput?: string
  readonly toolResponse?: string
}

/** Tool-use ids: numeric ids, opaque `tool_use_id` strings, or a mix. */
export interface MemToolUsesRequest {
  readonly ids: readonly (number | string)[]
  readonly limit?: number
  readonly project?: string
  readonly contentSessionId?: string
}

export interface MemTimelineRequest {
  readonly anchor?: number
  readonly query?: string
  readonly depthBefore?: number
  readonly depthAfter?: number
  readonly project?: string
  readonly platformSource?: string
}

export interface MemGetObservationsRequest {
  readonly ids: readonly number[]
  readonly project?: string
}

export interface MemSaveRequest {
  readonly text: string
  readonly title?: string
  readonly project?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface MemSaveResult {
  readonly success: true
  readonly id: number
  readonly title: string
  readonly project: string
  readonly message: string
}

export interface MemContextRequest {
  readonly projects: string
  readonly platformSource?: string
  readonly full?: boolean
  readonly colors?: boolean
}

export interface MemSessionInitRequest {
  readonly contentSessionId: string
  readonly project?: string
  readonly prompt?: string
  readonly platformSource?: string
  readonly customTitle?: string
}

export interface MemSessionSummarizeRequest {
  readonly contentSessionId: string
  readonly project?: string
  readonly platformSource?: string
}

/**
 * One tool result headed for the worker's own capture pipeline
 * (`POST /api/sessions/observations`).
 *
 * The worker queues generation from this; `queued` and `skipped` both mean it
 * took the call, so a skip is a decision, not a failure.
 */
export interface MemObservationIngest {
  readonly contentSessionId: string
  readonly toolName: string
  readonly toolInput?: unknown
  readonly toolResponse?: unknown
  readonly cwd: string
  readonly platformSource: string
  readonly toolUseId?: string
  readonly agentId?: string
  readonly agentType?: string
  readonly eventOccurredAtEpochMs?: number
}
