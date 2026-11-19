/**
 * The claude-mem-specific piece of the MCP bridge: finding the server beside
 * the worker that is already running.
 *
 * The worker is the plugin's single source of truth about an installation — its
 * address is configured, and its own health payload names the script it runs
 * from. `mcp-server.cjs` ships in that same directory, so the server is one path
 * join away: no cache scanning, no marketplace registry, no second address.
 *
 * Everything else stays generic: `./mcp.js` speaks plain MCP, and this module
 * hands it a command line and an environment.
 * @module dsh-claude-mem/claude-mem-mcp
 */

import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { McpClient } from './mcp.js'
import type { McpCallOptions, McpToolResult } from './mcp.js'
import type { WorkerClient } from './worker.js'
import { MemError } from './types.js'

/** Server file that ships beside the worker script. */
export const MCP_SERVER_FILENAME = 'mcp-server.cjs'

/** The MCP server next to a worker script, when it is actually there. */
export function mcpServerBeside(workerPath: string | undefined): string | undefined {
  if (workerPath === undefined || workerPath.trim().length === 0) return undefined
  const candidate = join(dirname(workerPath.trim()), MCP_SERVER_FILENAME)
  try {
    return statSync(candidate).isFile() ? candidate : undefined
  } catch {
    return undefined
  }
}

/** How to start a node process under this host. */
export interface NodeCommand {
  readonly command: string
  readonly env: NodeJS.ProcessEnv
}

/**
 * Pick the node binary for the server child.
 *
 * A harness running an Electron main process (the desktop app) reports
 * `process.execPath` as the application binary, which behaves as node only with
 * `ELECTRON_RUN_AS_NODE`. A plain node host needs neither, and `DSH_MEM_NODE`
 * overrides both for an unusual setup.
 */
export function nodeCommand(
  versions: NodeJS.ProcessVersions = process.versions,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): NodeCommand {
  const configured = env.DSH_MEM_NODE?.trim()
  if (configured !== undefined && configured.length > 0) return { command: configured, env }
  if (versions.electron !== undefined) return { command: execPath, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  return { command: execPath, env }
}

export interface ClaudeMemMcpOptions {
  readonly timeoutMs?: number
}

/**
 * Call one claude-mem MCP tool.
 *
 * The server path is resolved once per process from the worker's health payload
 * and reused; a health read that names no server is reported as this tool's own
 * failure rather than a crash.
 */
export class ClaudeMemMcp {
  private serverPath: string | undefined

  constructor(private readonly worker: WorkerClient, private readonly options: ClaudeMemMcpOptions = {}) {}

  async call(toolName: string, args: Readonly<Record<string, unknown>>, options: McpCallOptions): Promise<McpToolResult> {
    const script = await this.script(options.signal)
    const node = nodeCommand()
    const client = new McpClient(
      { command: node.command, args: [script], env: node.env },
      { timeoutMs: this.options.timeoutMs },
    )
    return await client.callTool(toolName, args, options)
  }

  private async script(signal?: AbortSignal): Promise<string> {
    if (this.serverPath !== undefined) return this.serverPath
    const health = await this.worker.health(signal)
    const script = mcpServerBeside(health.workerPath)
    if (script === undefined) {
      throw new MemError(
        'claude-mem reported no MCP server beside its worker; reinstall or repair the installation',
        'MEM_MCP_UNAVAILABLE',
      )
    }
    this.serverPath = script
    return script
  }
}
