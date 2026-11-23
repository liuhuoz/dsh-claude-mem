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
import { buildOverview, OVERVIEW_BRIDGE_PATH, type Overview } from './overview.js'

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

/** Minimal shape of the host connection service that admits HTTP requests. */
interface ConnectionAdmission {
  admit?(request: unknown): unknown
  requestRejection?(request: unknown): unknown
}

/**
 * Ask the host connection service whether this request may reach the bridge.
 *
 * This mirrors the admission check the sibling host-bridge plugins use: `admit()`
 * where the host exposes it, `requestRejection()` otherwise. No reachable service
 * leaves the route open, so an older host without the admission API still renders
 * the panel; a service that answers with something unrecognisable fails closed
 * rather than guessing that the request is fine.
 * @param request - the inbound HTTP request, as the server received it.
 * @param connection - the host connection service, when one is reachable.
 * @returns the status to reject with, or undefined to let the request through.
 */
export function admissionRejection(request: unknown, connection: unknown): number | undefined {
  if (connection === null || typeof connection !== 'object') return undefined
  const admission = connection as ConnectionAdmission
  if (typeof admission.admit === 'function') {
    try {
      const answer = admission.admit(request)
      if (answer === null || typeof answer !== 'object') return 503
      if ('rejection' in answer) {
        const rejection = (answer as { rejection?: unknown }).rejection
        return typeof rejection === 'number' ? rejection : 503
      }
      return 'peer' in answer ? undefined : 503
    } catch {
      return 503
    }
  }
  if (typeof admission.requestRejection !== 'function') return 503
  try {
    const rejection = admission.requestRejection(request)
    return typeof rejection === 'number' ? rejection : undefined
  } catch {
    return 503
  }
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

/** How long one aggregated overview is reused before the next request refetches it. */
const OVERVIEW_CACHE_MS = 45_000

/** Last overview, keyed by the worker URL it was built against. */
let overviewCache: { at: number; baseUrl: string; value: Overview } | undefined

/**
 * Register the overview bridge: one same-origin payload for the panel's data pages.
 *
 * The cache exists so a panel that remounts (tab switch, page reload) does not
 * re-run ten worker calls; it is keyed by base URL so a settings change cannot
 * serve numbers from the previous worker.
 * @param ctx - the plugin's host context.
 * @param baseUrl - resolves the worker URL at request time.
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

/**
 * Register the overview route once the host webserver is available.
 * @param ctx - the plugin's host context.
 * @param baseUrl - resolves the worker URL at request time.
 */
export function registerOverviewBridge(ctx: Context, baseUrl: () => string): void {
  ctx.inject(['webServer'], (sctx: Context) => {
    // Admission lives on the connection service: it applies the Host/Origin fence
    // and the browser's authenticated peer. A host without that service keeps the
    // route open rather than losing the panel.
    let connectionContext: Context = sctx
    ctx.inject(['connection'], (actx: Context) => {
      connectionContext = actx
      actx.effect(() => () => {
        if (connectionContext === actx) connectionContext = sctx
      }, 'dsh-claude-mem: overview admission context')
    })
    const connection = (): unknown => {
      try {
        return (connectionContext as unknown as { get(name: string): unknown }).get('connection')
      } catch {
        return undefined
      }
    }
    sctx.effect(() => {
      const route: WebRoute = {
        kind: 'exact',
        path: OVERVIEW_BRIDGE_PATH,
        handler: async (req, res) => {
          const rejection = admissionRejection(req, connection())
          if (rejection !== undefined) {
            writeJson(res, rejection, { ok: false, code: rejection === 503 ? 'admission-unavailable' : 'unauthorized' })
            return
          }
          const target = baseUrl()
          const now = Date.now()
          if (overviewCache !== undefined && overviewCache.baseUrl === target && now - overviewCache.at < OVERVIEW_CACHE_MS) {
            writeJson(res, 200, overviewCache.value)
            return
          }
          try {
            const value = await buildOverview({ baseUrl: target, now })
            overviewCache = { at: now, baseUrl: target, value }
            writeJson(res, 200, value)
          } catch {
            writeJson(res, 500, { ok: false })
          }
        },
      }
      const server = (sctx as unknown as { get(name: string): { register(route: WebRoute): () => void } }).get('webServer')
      return server.register(route)
    })
  })
}
