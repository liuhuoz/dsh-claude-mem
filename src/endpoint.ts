/**
 * Where the plugin looks for the claude-mem worker.
 *
 * Discovery only: the worker decides where it listens and publishes that in
 * `~/.claude-mem/worker.pid`; this module resolves the address from the most
 * specific available source without ever inventing a preference.
 * @module dsh-claude-mem/endpoint
 */

/** Fallback port for a worker that published nothing and set no environment. */
export const CLAUDE_MEM_DEFAULT_PORT = 37777

/**
 * Port recorded in a `worker.pid` file, or `undefined` when the content is not
 * that shape. Accepts the JSON file claude-mem writes; ignores anything else.
 */
export function parseWorkerPid(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const port = (parsed as { port?: unknown }).port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return port
}

/**
 * Base URL in precedence order: explicit configuration, then `$DSH_MEM_BASE_URL`,
 * then the port the running worker published, then the claude-mem default.
 * Trailing slashes are stripped so callers can always append a path.
 */
export function resolveBaseUrl(
  configured: string,
  envBaseUrl: string | undefined,
  publishedPort: number | undefined,
): string {
  const explicit = configured.trim().length > 0
    ? configured.trim()
    : (envBaseUrl !== undefined && envBaseUrl.trim().length > 0 ? envBaseUrl.trim() : '')
  if (explicit.length > 0) return explicit.replace(/\/+$/, '')
  return `http://127.0.0.1:${publishedPort ?? CLAUDE_MEM_DEFAULT_PORT}`
}
