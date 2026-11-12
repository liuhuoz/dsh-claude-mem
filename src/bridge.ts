/**
 * Host-side health bridge.
 *
 * The page cannot call the worker itself: the desktop renderer's origin is
 * `dsh-app://app`, and claude-mem answers non-loopback origins with 403. This
 * route runs in the plugin's host process, asks the worker, and hands the page a
 * same-origin answer.
 *
 * The target is caller-supplied because the page tests its unsaved draft, so the
 * route only ever reaches loopback: an arbitrary URL here would be an SSRF hole
 * into anything the host can reach.
 * @module dsh-claude-mem/bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { HEALTH_BRIDGE_PATH, healthUrl } from './probe.js'

/** Probe deadline; longer than a healthy round trip, short enough to feel live. */
const PROBE_TIMEOUT_MS = 4_000

/** Minimal shape of the host HTTP response the route writes to. */
interface BridgeResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

/** Minimal shape of the host HTTP request the route reads. */
interface BridgeRequest {
  url?: string
}

/** A route as `webServer.register` accepts it. */
export interface WebRoute {
  kind: 'exact'
  path: string
  handler: (req: BridgeRequest, res: BridgeResponse) => Promise<void>
}

/** What the page receives: the worker's answer, or why there is none. */
type ProbeOutcome =
  | { ok: true; body: unknown }
  | { ok: false; code: 'http'; status: number }
  | { ok: false; code: 'unreachable'; message: string }

/**
 * Accept only the loopback worker addresses this plugin can legitimately own.
 * @param raw - the caller's `baseUrl` parameter.
 * @returns the normalized origin, or `undefined` when it is not loopback HTTP.
 */
export function allowedProbeOrigin(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const host = url.hostname
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  return loopback ? url.origin : undefined
}

function writeJson(res: BridgeResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

async function probe(origin: string): Promise<ProbeOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(healthUrl(origin), { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return { ok: false, code: 'http', status: response.status }
    return { ok: true, body: await response.json() }
  } catch (error: unknown) {
    return { ok: false, code: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Register the bridge once the host webserver is available. Optional injection:
 * without a webserver the plugin still works, the page just cannot probe.
 * @param ctx - the plugin's host context.
 */
export function registerHealthBridge(ctx: Context): void {
  ctx.inject(['webServer'], (sctx: Context) => {
    sctx.effect(() => {
      const route: WebRoute = {
        kind: 'exact',
        path: HEALTH_BRIDGE_PATH,
        handler: async (req, res) => {
          const target = new URL(req.url ?? '', 'http://placeholder')
          const origin = allowedProbeOrigin(target.searchParams.get('baseUrl'))
          if (origin === undefined) {
            writeJson(res, 400, { ok: false, code: 'bad-request' })
            return
          }
          writeJson(res, 200, await probe(origin))
        },
      }
      const server = (sctx as unknown as { get(name: string): { register(route: WebRoute): () => void } }).get('webServer')
      return server.register(route)
    })
  })
}
