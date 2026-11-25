/**
 * Per-session read-only memory mode.
 *
 * A session can read project memory — search, context injection, the read
 * tools — while writing nothing back: no session row, no observations, no turn
 * summary, no delegated-run archive. The mode is session state and the session
 * log is its store: one `claude-mem/read-only` event carries the whole current
 * value, and a projection folds the last one. That keeps the switch durable
 * across a restart, per session by construction, and out of the model
 * transcript.
 *
 * The fold is read through `sessionProjections.snapshot()`, which the 0.2.1 and
 * 0.2.2 host lines expose with the same shape. `register()` returns a different
 * value on each of those lines (a disposer, then a handle promise), so its
 * return value is ignored and nothing depends on it. A projection that cannot
 * be read means read-write: recording must never stop because a switch could
 * not be read.
 * @module dsh-claude-mem/memory-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's memory write mode was switched. Log-only — durable and
     * replayable, never part of the model transcript. The LAST such event is
     * the session's mode; the `memReadOnly` projection folds it.
     */
    'claude-mem/read-only': { enabled: boolean }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The session writes nothing back to memory while this is true. */
    memReadOnly: boolean
  }
}

/** The session event that carries the whole current mode. */
export const READ_ONLY_EVENT = 'claude-mem/read-only'

/** The projection key both halves read the mode from. */
export const READ_ONLY_PROJECTION = 'memReadOnly'

/** The slash command that switches the mode. */
export const READ_ONLY_COMMAND = 'mem-readonly'

/** Bumped when the fold's meaning changes; persisted rows from older units are dropped. */
const STATE_VERSION = 1

/** What every consumer needs from the mode. */
export interface MemoryMode {
  /** True when this session writes nothing back to memory. */
  isReadOnly(session: Session | undefined): boolean
}

/** The mode before the projection service mounts: nothing is read-only. */
export const OPEN_MODE: MemoryMode = { isReadOnly: () => false }

/**
 * Fold one committed event into the mode. Every other event leaves the state
 * alone.
 */
export function foldReadOnly(state: boolean, event: { type: string; data?: unknown }): boolean {
  if (event.type !== READ_ONLY_EVENT) return state
  return (event.data as { enabled?: unknown } | undefined)?.enabled === true
}

/**
 * Parse the command's argument.
 * @param raw - exact text after the command name.
 * @param current - the session's mode now, which an empty argument flips.
 * @returns the mode to write, or undefined when the argument is not understood.
 */
export function parseModeArgument(raw: string, current: boolean): boolean | undefined {
  const value = raw.trim().toLowerCase()
  if (value.length === 0) return !current
  if (value === 'read-only' || value === 'readonly' || value === 'on') return true
  if (value === 'read-write' || value === 'readwrite' || value === 'off') return false
  return undefined
}

let warned = false

/** Read one session's mode; an unreadable projection is read-write. */
export function readOnlyOf(ctx: Context, session: Session | undefined): boolean {
  if (session === undefined) return false
  try {
    const values = ctx.sessionProjections.snapshot(session, [READ_ONLY_PROJECTION]).values
    return values[READ_ONLY_PROJECTION] === true
  } catch (error: unknown) {
    if (!warned) {
      warned = true
      try {
        ctx.logger?.warn?.(`[claude-mem] read-only mode is unreadable: ${String(error)}`)
      } catch {
        // Logging must never change a capture decision.
      }
    }
    return false
  }
}

/** Register the projection; the fiber owns it, so its return value is not kept. */
function registerProjection(ctx: Context): void {
  try {
    const registered: unknown = ctx.sessionProjections.register({
      key: READ_ONLY_PROJECTION,
      stateVersion: STATE_VERSION,
      stateSchema: z.boolean(),
      init: () => false,
      apply: (state, event) => foldReadOnly(state, event),
      wire: {
        viewSchema: z.boolean(),
        view: (state) => state,
        // The mode matters inside its session, never in a list row.
        summary: false,
      },
    })
    // 0.2.2 yields a handle promise; swallowing it keeps an unhandled rejection out of the host.
    if (registered !== null && typeof registered === 'object' && typeof (registered as { then?: unknown }).then === 'function') {
      void Promise.resolve(registered as Promise<unknown>).catch(() => {})
    }
  } catch {
    // Without the unit the mode stays open, which is what a host without the service gets anyway.
  }
}

/** Register the slash command that switches the mode. */
function registerCommand(ctx: Context): void {
  try {
    ctx.commands.register({
      name: READ_ONLY_COMMAND,
      description: 'MemReadOnly — this session reads project memory but writes nothing back: no observations, no summaries, no delegated-run archives. No argument toggles the mode.',
      input: { hint: 'read-only | read-write' },
      handler: ({ agent, rawInput }) => {
        const enabled = parseModeArgument(rawInput, readOnlyOf(ctx, agent.session))
        if (enabled === undefined) {
          return { kind: 'error', text: `usage: /${READ_ONLY_COMMAND} [read-only|read-write]` }
        }
        agent.session.append(READ_ONLY_EVENT, { enabled })
        return {
          kind: 'success',
          text: enabled
            ? 'MemReadOnly on: this session writes nothing to memory.'
            : 'MemReadOnly off: this session records memory again.',
        }
      },
    })
  } catch {
    // No command service: the mode is then only switchable by another writer of the event.
  }
}

/**
 * Attach the mode to a context that serves the projection and command services.
 * @param ctx - a context that reached both services.
 * @returns the reader every capture path consults.
 */
export function attachMemoryMode(ctx: Context): MemoryMode {
  registerProjection(ctx)
  registerCommand(ctx)
  return { isReadOnly: (session) => readOnlyOf(ctx, session) }
}
