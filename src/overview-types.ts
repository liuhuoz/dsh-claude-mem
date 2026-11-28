/**
 * The overview payload's shape, shared by the host aggregator and the browser
 * panel. Pure declarations only: the client bundle cannot import the module
 * that reads files, and the host cannot import React.
 * @module dsh-claude-mem/overview-types
 */

import type { McpClientReading } from './probe.js'

/** One labelled field of a session summary, e.g. "Request". */
export interface InjectionField {
  /** The label claude-mem writes, e.g. "Next Steps". */
  readonly label: string
  readonly value: string
}

/** One session summary inside claude-mem's recent-context block. */
export interface InjectionSection {
  /** Heading the block gives it, e.g. "Prompt #19". */
  readonly prompt: string
  /** The block's own timestamp for this summary, e.g. "2026/11/24 18:54:11". */
  readonly date: string
  /** That timestamp as epoch milliseconds; 0 when the block had none. */
  readonly at: number
  /** Its request text, used as the card's headline. */
  readonly request: string
  /** Every labelled field the summary carries, in block order. */
  readonly fields: readonly InjectionField[]
}

/** What a project's recent-context block carries, for the sessions tab. */
export interface InjectionView {
  readonly project: string
  /** Start of the newest session this block summarises, in epoch milliseconds. */
  readonly at: number
  /** Size of the whole block, its label lines included. */
  readonly chars: number
  readonly lines: number
  /** The block's memory, with the title and "Showing …" line removed. */
  readonly text: string
  readonly sections: readonly InjectionSection[]
}

/** The payload the panel renders. Fields are null when their source failed. */
export interface Overview {
  readonly worker: { version?: string; port?: number; uptimeSeconds?: number; activeSessions?: number } | null
  readonly database: { observations?: number; sessions?: number; summaries?: number; sizeBytes?: number; firstObservationAt?: string } | null
  readonly processing: { queueDepth?: number; isProcessing?: boolean; lastSuccessfulStoreAt?: number } | null
  readonly mcp: { enabled?: boolean } | null
  /** Whether the server this plugin launches is on disk beside the worker. */
  readonly mcpClient: McpClientReading
  readonly chroma: { status?: string } | null
  readonly projects: { total: number; active: number; excluded: number } | null
  readonly recent: readonly { type: string; title: string; project: string; createdAt: string }[] | null
  readonly sessions: readonly { title: string; project: string; itemCount: number; startedAt: number }[] | null
  readonly injection: InjectionView | null
  readonly savings: { day: string; events: number; readTokens: number; savedTokens: number; percent: number } | null
  readonly distributions: Distributions | null
  readonly fetchedAt: number
}

/** One day of activity, split by type and project for the stacked bars. */
export interface DayBucket {
  readonly day: string
  readonly total: number
  readonly byType: Readonly<Record<string, number>>
  readonly byProject: Readonly<Record<string, number>>
}

/** One day × type × project cell inside the day window, for cross-filtering. */
export interface DistributionCell {
  readonly day: string
  readonly type: string
  readonly project: string
  readonly count: number
}

/** Daily buckets plus all-time type and project totals. */
export interface Distributions {
  readonly source: 'sqlite' | 'api'
  readonly total: number
  readonly days: readonly DayBucket[]
  readonly types: readonly { key: string; count: number }[]
  readonly projects: readonly { key: string; count: number; lastWrite: string }[]
  /** Days × types × projects inside the day window, so a pick can narrow the other dimension. */
  readonly cells: readonly DistributionCell[]
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
