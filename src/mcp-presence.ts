/**
 * Whether the MCP server this plugin launches is actually on disk.
 *
 * The worker's own `mcpReady` describes its in-process MCP and says nothing about
 * the child process a host starts from `mcp-server.cjs`. Both consumers — the
 * settings probe and the panel's overview — ask this module rather than reading a
 * flag out of the health body, so one answer drives every place that reports it.
 * @module dsh-claude-mem/mcp-presence
 */

import { mcpServerBeside } from './claude-mem-mcp.js'
import type { McpClientReading, WorkerHealth } from './probe.js'
import { workerPathFromDoctor } from './worker.js'

/** What the caller supplies beyond the worker's own health body. */
export interface McpPresenceOptions {
  /** The caller's deadline, so a slow doctor cannot outlive the request. */
  readonly signal?: AbortSignal
  /** fetch override for tests. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Whether the plugin's MCP server is where the worker says it runs from.
 *
 * The path comes from the worker itself, and both places it has ever been
 * published are read: the health payload (up to claude-mem 16.0.0) and the
 * supervisor diagnostics (since). The server ships beside the worker script, so
 * one `stat` answers it. A worker that names no script, or names a directory with
 * no server in it, reads as unavailable — which is what the panel and the health
 * card show instead of the worker's own "MCP ready".
 * @param origin - the loopback worker origin being asked about.
 * @param health - the worker's health body, when it parsed.
 * @param options - the caller's deadline and, in tests, its own fetch.
 */
export async function mcpClientReading(
  origin: string,
  health: WorkerHealth | undefined,
  options: McpPresenceOptions = {},
): Promise<McpClientReading> {
  const call = options.fetchImpl ?? fetch
  let workerPath = health?.workerPath
  if (workerPath === undefined) {
    try {
      const response = await call(`${origin}/api/admin/doctor`, {
        ...options.signal === undefined ? {} : { signal: options.signal },
        headers: { accept: 'application/json' },
      })
      if (response.ok) workerPath = workerPathFromDoctor(await response.json())
    } catch {
      // A worker that cannot answer its own diagnostics names no script.
    }
  }
  const serverPath = mcpServerBeside(workerPath)
  return serverPath === undefined ? { available: false } : { available: true, serverPath }
}
