/**
 * Model-facing memory tools over a `WorkerClient`. Owns schemas, validation,
 * and presentation; execution goes through the worker client.
 * @module dsh-claude-mem/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ownerSessionId, type MemoryMode } from './memory-mode.js'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkerClient } from './worker.js'
import type {
  MemDumbSearchRequest,
  MemGetObservationsRequest,
  MemObservation,
  MemSaveRequest,
  MemSearchRequest,
  MemSearchResult,
  MemTimelineRequest,
  MemToolUse,
  MemToolUsesRequest,
} from './types.js'

export interface ToolsConfig {
  search?: boolean
  timeline?: boolean
  getObservations?: boolean
  save?: boolean
  context?: boolean
  workState?: boolean
  dumbSearch?: boolean
  toolUses?: boolean
  /** Per-session memory mode; a read-only session refuses the two writes below. */
  mode?: MemoryMode
  /** Live agents by session id, so a delegated run resolves its parent's mode. */
  sessions?: ReadonlyMap<string, { session: Session }>
  timeoutMs: number
}

/** One observation's index projection (id/title/type/project/createdAtEpoch/narrative). */
interface IndexItem {
  id: number
  title: string
  type?: string
  project?: string
  createdAtEpoch?: number
  narrative?: string
}

/** Full observation projection — every field the worker returns, for `mem_get_observations`. */
interface FullItem extends IndexItem {
  memorySessionId?: string
  subtitle?: string
  text?: string
  facts?: string[]
  concepts?: string[]
  filesRead?: string[]
  filesModified?: string[]
  metadata?: Record<string, unknown>
  createdAt?: string
  promptNumber?: number
  discoveryTokens?: number
  contentHash?: string
  generatedByModel?: string
  relevanceCount?: number
  mergedIntoProject?: string
  agentType?: string
  agentId?: string
  syncedAt?: number
  originDeviceId?: string
  originLocalId?: string
  syncRev?: string
}

interface QueryOutput {
  content: string
}

interface FullQueryOutput {
  items: FullItem[]
  content?: string
}

/** Project an observation to its full shape, keeping every field the worker returned. */
function projectFullItem(item: MemObservation): FullItem {
  const full: FullItem = {
    id: item.id,
    title: item.title,
  }
  if (item.memorySessionId !== undefined) full.memorySessionId = item.memorySessionId
  if (item.type !== undefined) full.type = item.type
  if (item.project !== undefined) full.project = item.project
  if (item.subtitle !== undefined) full.subtitle = item.subtitle
  if (item.text !== undefined) full.text = item.text
  if (item.narrative !== undefined) full.narrative = item.narrative
  if (item.facts !== undefined) full.facts = [...item.facts]
  if (item.concepts !== undefined) full.concepts = [...item.concepts]
  if (item.filesRead !== undefined) full.filesRead = [...item.filesRead]
  if (item.filesModified !== undefined) full.filesModified = [...item.filesModified]
  if (item.metadata !== undefined) full.metadata = { ...item.metadata }
  if (item.createdAt !== undefined) full.createdAt = item.createdAt
  if (item.createdAtEpoch !== undefined) full.createdAtEpoch = item.createdAtEpoch
  if (item.promptNumber !== undefined) full.promptNumber = item.promptNumber
  if (item.discoveryTokens !== undefined) full.discoveryTokens = item.discoveryTokens
  if (item.contentHash !== undefined) full.contentHash = item.contentHash
  if (item.generatedByModel !== undefined) full.generatedByModel = item.generatedByModel
  if (item.relevanceCount !== undefined) full.relevanceCount = item.relevanceCount
  if (item.mergedIntoProject !== undefined) full.mergedIntoProject = item.mergedIntoProject
  if (item.agentType !== undefined) full.agentType = item.agentType
  if (item.agentId !== undefined) full.agentId = item.agentId
  if (item.syncedAt !== undefined) full.syncedAt = item.syncedAt
  if (item.originDeviceId !== undefined) full.originDeviceId = item.originDeviceId
  if (item.originLocalId !== undefined) full.originLocalId = item.originLocalId
  if (item.syncRev !== undefined) full.syncRev = item.syncRev
  return full
}

/** Pass the worker's rendered text through untouched: it answers with a table, not items. */
function queryText(value: MemSearchResult): QueryOutput {
  return { content: value.content ?? '' }
}

function projectFullResult(value: MemSearchResult): FullQueryOutput {
  const items: FullItem[] = value.items.map(projectFullItem)
  return {
    items,
    ...value.content !== undefined ? { content: value.content } : {},
  }
}

/** Register the enabled memory tools on `ctx.tools`. */
export function applyMemoryTools(ctx: Context, worker: WorkerClient, config: ToolsConfig): void {
  if (config.search !== false) applySearchTool(ctx, worker, config.timeoutMs)
  if (config.timeline !== false) applyTimelineTool(ctx, worker, config.timeoutMs)
  if (config.getObservations !== false) applyGetObservationsTool(ctx, worker, config.timeoutMs)
  if (config.save !== false) applySaveTool(ctx, worker, config.timeoutMs, config.mode, config.sessions)
  if (config.context !== false) applyContextTool(ctx, worker, config.timeoutMs)
  if (config.workState !== false) applyWorkStateTools(ctx, worker, config.timeoutMs, config.mode, config.sessions)
  if (config.dumbSearch !== false) applyDumbSearchTool(ctx, worker, config.timeoutMs)
  if (config.toolUses !== false) applyToolUsesTool(ctx, worker, config.timeoutMs)
}

function applySearchTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_search',
    description: 'Search persistent cross-session memory and return the worker\'s rendered index table (IDs, dates, titles, read cost). Review it, then fetch full details only for the ids you pick.',
    parameters: {
      query: { type: 'string', required: true, description: 'Free-text search query.' },
      limit: { type: 'integer', description: 'Max results (default 20).' },
      project: { type: 'string', description: 'Filter by project name.' },
      platformSource: { type: 'string', description: 'Optional platform filter (e.g. "dsh"); omit to search all memory.' },
      type: { type: 'string', description: "Category: 'observations', 'sessions', or 'prompts'." },
      obsType: { type: 'string', description: 'Comma-separated observation types (e.g. bugfix, feature, decision).' },
      dateStart: { type: 'string', description: 'Start date filter (ISO).' },
      dateEnd: { type: 'string', description: 'End date filter (ISO).' },
      offset: { type: 'integer', description: 'Pagination offset.' },
      orderBy: { type: 'string', description: "'date_desc' or 'date_asc'." },
      deep: { type: 'boolean', description: 'Opt-in local raw-tool search when observations have no matches. Requires CLAUDE_MEM_TOOL_USES_SEARCH_ENABLED on the worker; first page only. Results use T IDs; fetch selected numeric IDs with mem_get_tool_uses.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return queryText(await worker.search(buildSearchRequest(args), exec.signal))
    },
  }))
}

function applyTimelineTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_timeline',
    description: 'Get context around one memory observation (its surrounding observations) by id or query.',
    parameters: {
      anchor: { type: 'integer', description: 'Observation id to center around.' },
      query: { type: 'string', description: 'Find the anchor from this query.' },
      depthBefore: { type: 'integer', description: 'Items before anchor (default 3).' },
      depthAfter: { type: 'integer', description: 'Items after anchor (default 3).' },
      project: { type: 'string', description: 'Filter by project name.' },
      platformSource: { type: 'string', description: 'Optional platform filter; omit to search all memory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input: MemTimelineRequest = {
        ...args.anchor !== undefined ? { anchor: args.anchor } : {},
        ...args.query !== undefined ? { query: args.query } : {},
        ...args.depthBefore !== undefined ? { depthBefore: args.depthBefore } : {},
        ...args.depthAfter !== undefined ? { depthAfter: args.depthAfter } : {},
        ...args.project !== undefined ? { project: args.project } : {},
        ...args.platformSource !== undefined ? { platformSource: args.platformSource } : {},
      }
      return queryText(await worker.timeline(input, exec.signal))
    },
  }))
}

/** The worker's own response budget, and the note it appends when text is cut. */
const TOOL_USE_TEXT_BUDGET = 32 * 1024
const TOOL_USE_TRUNCATION_NOTE = '\n[Response shortened; request fewer selected records for more detail.]'

function applyDumbSearchTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_dumb_search',
    description: 'Dumb search (optional): does not reason about the results — fast, but shallow. One call picks records by title word overlap, adds nearby context, and returns up to maxDetails records. Use mem_search for reliable recall.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query, up to 500 characters.' },
      project: { type: 'string', description: 'Optional project filter.' },
      limit: { type: 'integer', description: 'Index result count (1-20, default 20).' },
      maxDetails: { type: 'integer', description: 'Maximum full details (1-5, default 3).' },
      depthBefore: { type: 'integer', description: 'Context rows before each selected anchor (0-3, default 2).' },
      depthAfter: { type: 'integer', description: 'Context rows after each selected anchor (0-3, default 2).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
          isError: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertRange('limit', args.limit, 1, 20)
      assertRange('maxDetails', args.maxDetails, 1, 5)
      assertRange('depthBefore', args.depthBefore, 0, 3)
      assertRange('depthAfter', args.depthAfter, 0, 3)
      const input: MemDumbSearchRequest = {
        query: args.query,
        ...args.project !== undefined ? { project: args.project } : {},
        ...args.limit !== undefined ? { limit: args.limit } : {},
        ...args.maxDetails !== undefined ? { maxDetails: args.maxDetails } : {},
        ...args.depthBefore !== undefined ? { depthBefore: args.depthBefore } : {},
        ...args.depthAfter !== undefined ? { depthAfter: args.depthAfter } : {},
      }
      return await worker.dumbSearch(input, exec.signal)
    },
  }))
}

function applyToolUsesTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_get_tool_uses',
    description: 'Exceptional follow-up (raw tool I/O, rarely needed): fetch the ORIGINAL tool_input and tool_response for tool calls you already identified. Requires ids — run mem_search with deep: true first and pass only the ids you need; these payloads are large and unsummarized. ids accept numeric tool-use ids or opaque tool_use_id strings. At most 100 ids per call.',
    parameters: {
      ids: { type: 'array', required: true, description: 'Tool-use ids to fetch (at most 100; numeric ids or tool_use_id strings).' },
      limit: { type: 'integer', description: 'Max rows to return (default 100, max 200).' },
      project: { type: 'string', description: 'Filter by project name.' },
      contentSessionId: { type: 'string', description: 'Filter by the content session id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              id: { type: 'number', required: true },
              toolUseId: { type: 'string' },
              toolName: { type: 'string' },
              project: { type: 'string' },
              platformSource: { type: 'string' },
              memorySessionId: { type: 'string' },
              contentSessionId: { type: 'string' },
              sessionDbId: { type: 'number' },
              promptNumber: { type: 'number' },
              createdAt: { type: 'string' },
              createdAtEpoch: { type: 'number' },
              inputBytes: { type: 'number' },
              responseBytes: { type: 'number' },
              toolInput: { type: 'string' },
              toolResponse: { type: 'string' },
            },
          } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatToolUses(value.items) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const ids = args.ids.filter((value): value is number | string => typeof value === 'number' || typeof value === 'string')
      if (ids.length !== args.ids.length) throw new Error('tool-use ids must be numbers or strings')
      if (ids.length === 0) throw new Error('at least one tool-use id is required')
      if (ids.length > 100) throw new Error('at most 100 tool-use ids per call')
      if (args.limit !== undefined && (args.limit < 1 || args.limit > 200)) throw new Error('limit must be between 1 and 200')
      const input: MemToolUsesRequest = {
        ids,
        ...args.limit !== undefined ? { limit: args.limit } : {},
        ...args.project !== undefined ? { project: args.project } : {},
        ...args.contentSessionId !== undefined ? { contentSessionId: args.contentSessionId } : {},
      }
      return { items: [...await worker.toolUses(input, exec.signal)] }
    },
  }))
}

/** One block per raw tool call, capped at the worker's 32 KiB response budget. */
function formatToolUses(items: readonly MemToolUse[]): string {
  if (items.length === 0) return 'No tool uses found for the given ids.'
  const blocks = items.map((item) => {
    const name = item.toolName ?? 'unknown'
    const project = item.project !== undefined ? ` (${item.project})` : ''
    return `#T${item.id} ${name}${project}\n  input: ${item.toolInput ?? ''}\n  response: ${item.toolResponse ?? ''}`
  })
  return truncateText(blocks.join('\n'), TOOL_USE_TEXT_BUDGET, TOOL_USE_TRUNCATION_NOTE)
}

/** Cut on code-point boundaries so the UTF-8 byte budget is never exceeded. */
function truncateText(text: string, budget: number, note: string): string {
  if (Buffer.byteLength(text, 'utf8') <= budget) return text
  const limit = budget - Buffer.byteLength(note, 'utf8')
  let out = ''
  let bytes = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (bytes + size > limit) break
    out += ch
    bytes += size
  }
  return out + note
}

function assertRange(field: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be between ${min} and ${max}`)
}

function applyGetObservationsTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_get_observations',
    description: 'Fetch full details for memory observations by id. Returns every field the worker reports (narrative, facts, concepts, files, metadata and timestamps) for parity with the raw API.',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'integer' }, description: 'Observation ids (required).' },
      project: { type: 'string', description: 'Filter by project name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              id: { type: 'number', required: true },
              title: { type: 'string', required: true },
              memorySessionId: { type: 'string' },
              type: { type: 'string' },
              project: { type: 'string' },
              subtitle: { type: 'string' },
              text: { type: 'string' },
              narrative: { type: 'string' },
              facts: { type: 'array', items: { type: 'string' } },
              concepts: { type: 'array', items: { type: 'string' } },
              filesRead: { type: 'array', items: { type: 'string' } },
              filesModified: { type: 'array', items: { type: 'string' } },
              metadata: { type: 'object', additionalProperties: true },
              createdAt: { type: 'string' },
              createdAtEpoch: { type: 'number' },
              promptNumber: { type: 'number' },
              discoveryTokens: { type: 'number' },
              contentHash: { type: 'string' },
              generatedByModel: { type: 'string' },
              relevanceCount: { type: 'number' },
              mergedIntoProject: { type: 'string' },
              agentType: { type: 'string' },
              agentId: { type: 'string' },
              syncedAt: { type: 'number' },
              originDeviceId: { type: 'string' },
              originLocalId: { type: 'string' },
              syncRev: { type: 'string' },
            },
          } },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatFullOutput(value as unknown as FullQueryOutput) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.ids.length === 0) throw new Error('at least one observation id is required')
      const input: MemGetObservationsRequest = {
        ids: args.ids,
        ...args.project !== undefined ? { project: args.project } : {},
      }
      return projectFullResult(await worker.getObservations(input, exec.signal)) as never
    },
  }))
}

/**
 * Refuse a memory write from a read-only session.
 *
 * A delegated run files under its parent, so the parent's mode decides — the
 * child session itself never carries the event.
 * @param mode - the per-session mode; absent when its services never mounted.
 * @param agent - the calling agent; a call without one is never read-only.
 * @param sessions - live agents by session id, used to reach the parent.
 */
function refuseWhenReadOnly(
  mode: MemoryMode | undefined,
  agent: ToolExecution['agent'],
  sessions?: ReadonlyMap<string, { session: Session }>,
): void {
  const own = agent?.session
  if (own === undefined) return
  const owner = ownerSessionId(own)
  const target = owner === own.id ? own : (sessions?.get(owner)?.session ?? own)
  if (mode?.isReadOnly(target) === true) {
    throw new Error('MemReadOnly: this session writes nothing to memory; run /mem-readonly to record again.')
  }
}

function applyWorkStateTools(
  ctx: Context,
  worker: WorkerClient,
  timeoutMs: number,
  mode?: MemoryMode,
  sessions?: ReadonlyMap<string, { session: Session }>,
): void {
  ctx.tools.register(defineTool({
    name: 'work_state_write',
    description: 'Your canonical to-do list and working state for this project, kept across sessions: whatever is still open is shown at the start of every session. Each call appends one entry to a list. To-do item: fields {"task": "<name>", "status": "todo" | "doing" | "done" | "dropped", ...details}. State on the list itself: any other fields (the latest value of each key wins; null clears a key; "status": "done" closes the list). Returns what is still open in the list. Params: list (required), fields (required).',
    parameters: {
      list: { type: 'string', required: true, description: 'The to-do list or tracked thing this entry belongs to, e.g. "release" or "auth-refactor".' },
      fields: { type: 'object', additionalProperties: true, required: true, description: 'Keys to set. Include "task" to update a to-do item. Values are strings, numbers, booleans, or null to clear a key.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      refuseWhenReadOnly(mode, exec.agent, sessions)
      const cwd = exec.agent?.session.header.cwd
      return await worker.workStateWrite({
        cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(),
        list: args.list,
        fields: args.fields as Record<string, unknown>,
      }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'work_state_read',
    description: "Read this project's to-do lists and working state written with work_state_write: every open item, or one list, with done and dropped items when includeClosed is true. Params: list, includeClosed.",
    parameters: {
      list: { type: 'string', description: 'Read only this list.' },
      includeClosed: { type: 'boolean', description: 'Also show done and dropped items and closed lists.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      return await worker.workState({
        cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(),
        ...args.list !== undefined ? { list: args.list } : {},
        ...args.includeClosed !== undefined ? { includeClosed: args.includeClosed } : {},
      }, exec.signal)
    },
  }))
}

function applySaveTool(
  ctx: Context,
  worker: WorkerClient,
  timeoutMs: number,
  mode?: MemoryMode,
  sessions?: ReadonlyMap<string, { session: Session }>,
): void {
  ctx.tools.register(defineTool({
    name: 'mem_save',
    description: 'Save one manual memory as an observation in persistent memory (no generation job; stores the text as given).',
    parameters: {
      text: { type: 'string', required: true, description: 'Memory text to save.' },
      title: { type: 'string', description: 'Optional title.' },
      project: { type: 'string', description: 'Optional project.' },
      metadata: { type: 'object', additionalProperties: true, description: 'Optional free-form metadata.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          id: { type: 'number', required: true },
          title: { type: 'string', required: true },
          project: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Saved observation #${value.id} (${value.title})` }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      refuseWhenReadOnly(mode, exec.agent, sessions)
      const input: MemSaveRequest = {
        text: args.text.trim(),
        ...args.title !== undefined ? { title: args.title } : {},
        ...args.project !== undefined ? { project: args.project } : {},
        ...args.metadata !== undefined ? { metadata: args.metadata } : {},
      }
      return await worker.save(input, exec.signal)
    },
  }))
}

function applyContextTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_context',
    description: 'Render the worker\'s session-start context text for one or more projects (the same text injected at startup).',
    parameters: {
      projects: { type: 'string', required: true, description: 'Project chain, comma-separated; the last is primary.' },
      platformSource: { type: 'string', description: 'Optional platform filter.' },
      full: { type: 'boolean', description: 'Request full context instead of configured limits.' },
      colors: { type: 'boolean', description: 'Request terminal-color formatting.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.projects.trim().length === 0) throw new Error('at least one project is required')
      return await worker.context({
        projects: args.projects,
        ...args.platformSource !== undefined ? { platformSource: args.platformSource } : {},
        ...args.full !== undefined ? { full: args.full } : {},
        ...args.colors !== undefined ? { colors: args.colors } : {},
      }, exec.signal)
    },
  }))
}

function buildSearchRequest(args: {
  query: string
  limit?: number
  project?: string
  platformSource?: string
  type?: string
  obsType?: string
  dateStart?: string
  dateEnd?: string
  offset?: number
  orderBy?: string
  deep?: boolean
}): MemSearchRequest {
  const orderBy = args.orderBy === 'date_asc' || args.orderBy === 'date_desc' ? args.orderBy : undefined
  return {
    query: args.query.trim(),
    ...args.limit !== undefined ? { limit: args.limit } : {},
    ...args.project !== undefined ? { project: args.project } : {},
    ...args.platformSource !== undefined ? { platformSource: args.platformSource } : {},
    ...args.type !== undefined ? { type: args.type } : {},
    ...args.obsType !== undefined ? { obsType: args.obsType } : {},
    ...args.dateStart !== undefined ? { dateStart: args.dateStart } : {},
    ...args.dateEnd !== undefined ? { dateEnd: args.dateEnd } : {},
    ...args.offset !== undefined ? { offset: args.offset } : {},
    ...orderBy !== undefined ? { orderBy } : {},
    ...args.deep !== undefined ? { deep: args.deep } : {},
  }
}

/** Render full observation details (every field) for `mem_get_observations`. */
export function formatFullOutput(value: FullQueryOutput): string {
  if (value.content !== undefined && value.content.length > 0) return value.content
  if (value.items.length === 0) return 'No results found.'
  return value.items
    .map((item) => {
      const lines: string[] = [`#${item.id} ${item.title}`]
      const meta: string[] = []
      if (item.type !== undefined) meta.push(`type=${item.type}`)
      if (item.project !== undefined) meta.push(`project=${item.project}`)
      if (item.memorySessionId !== undefined) meta.push(`session=${item.memorySessionId}`)
      if (item.createdAt !== undefined) meta.push(`created=${item.createdAt}`)
      if (meta.length > 0) lines.push(`[${meta.join(', ')}]`)
      if (item.subtitle !== undefined) lines.push(`subtitle: ${item.subtitle}`)
      if (item.narrative !== undefined) lines.push(`narrative: ${item.narrative}`)
      if (item.text !== undefined && item.text.length > 0) lines.push(`text: ${item.text}`)
      if (item.facts !== undefined && item.facts.length > 0) lines.push(`facts: ${JSON.stringify(item.facts)}`)
      if (item.concepts !== undefined && item.concepts.length > 0) lines.push(`concepts: ${JSON.stringify(item.concepts)}`)
      if (item.filesRead !== undefined && item.filesRead.length > 0) lines.push(`filesRead: ${JSON.stringify(item.filesRead)}`)
      if (item.filesModified !== undefined && item.filesModified.length > 0) lines.push(`filesModified: ${JSON.stringify(item.filesModified)}`)
      if (item.metadata !== undefined && Object.keys(item.metadata).length > 0) lines.push(`metadata: ${JSON.stringify(item.metadata)}`)
      if (item.contentHash !== undefined) lines.push(`contentHash: ${item.contentHash}`)
      if (item.originDeviceId !== undefined) lines.push(`originDeviceId: ${item.originDeviceId}`)
      if (item.originLocalId !== undefined) lines.push(`originLocalId: ${item.originLocalId}`)
      return lines.join('\n')
    })
    .join('\n\n')
}
