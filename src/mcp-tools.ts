/**
 * Tools that only claude-mem's MCP server can answer: structural code reading
 * through tree-sitter, and the knowledge-corpus lifecycle.
 *
 * Both families ride `ClaudeMemMcp`, which finds the server beside the running
 * worker. The tools stay thin — parameters in, the server's rendered text out —
 * so a change on claude-mem's side surfaces as different text, not as a second
 * implementation here.
 * @module dsh-claude-mem/mcp-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorkerClient } from './worker.js'
import { ClaudeMemMcp } from './claude-mem-mcp.js'

/** One parse may compile a grammar on first use; allow for it. */
const SMART_TIMEOUT_MS = 60_000

/** Listing corpora reads a directory. */
const CORPUS_LIST_TIMEOUT_MS = 30_000

/** Build, prime, query, rebuild and reprime cross the worker — and, for some, a model. */
const CORPUS_ACTION_TIMEOUT_MS = 300_000

export interface McpToolsConfig {
  smart?: boolean
  corpora?: boolean
  timeoutMs: number
}

/** Register the enabled MCP-backed tools on `ctx.tools`. */
export function applyMcpTools(ctx: Context, worker: WorkerClient, config: McpToolsConfig): void {
  if (config.smart === false && config.corpora === false) return
  const mcp = new ClaudeMemMcp(worker, { timeoutMs: config.timeoutMs })
  if (config.smart !== false) applySmartTools(ctx, mcp)
  if (config.corpora !== false) applyCorpusTools(ctx, mcp)
}

/** Working directory of the session that made the call, or this process's. */
function sessionCwd(exec: ToolExecution): string {
  const cwd = exec.agent?.session.header.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/** Forward one call and answer the server's rendered text unchanged. */
async function run(
  mcp: ClaudeMemMcp,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  exec: ToolExecution,
  timeoutMs: number,
): Promise<string> {
  const result = await mcp.call(toolName, args, {
    cwd: sessionCwd(exec),
    timeoutMs,
    signal: exec.signal,
  })
  return result.text
}

function applySmartTools(ctx: Context, mcp: ClaudeMemMcp): void {
  ctx.tools.register(defineTool({
    name: 'mem_smart_search',
    description: 'Search a codebase for symbols with tree-sitter AST parsing: symbols, signatures, line numbers and folded file views with token estimates. Scopes to the session directory unless path is given. Use before reading whole files.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search term; matches symbol names, file names and content.' },
      path: { type: 'string', description: 'Root directory to search (default: the session working directory).' },
      max_results: { type: 'integer', description: 'Maximum results (default 20).' },
      file_pattern: { type: 'string', description: 'Substring filter for file paths, e.g. ".ts" or "src/services".' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: SMART_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await run(mcp, 'smart_search', {
        query: args.query,
        ...args.path !== undefined ? { path: args.path } : {},
        ...args.max_results !== undefined ? { max_results: args.max_results } : {},
        ...args.file_pattern !== undefined ? { file_pattern: args.file_pattern } : {},
      }, exec, SMART_TIMEOUT_MS)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mem_smart_outline',
    description: 'Structural outline of one source file: imports, every symbol with its signature and line range, doc comments, bodies folded. Much cheaper than reading the file.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the source file, relative to the session directory or absolute.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: SMART_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await run(mcp, 'smart_outline', { file_path: args.file_path }, exec, SMART_TIMEOUT_MS)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mem_smart_unfold',
    description: 'Full source of one symbol (function, class, method) from a file, with its doc comment and line range. Use after mem_smart_search or mem_smart_outline to read just that code.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the source file.' },
      symbol_name: { type: 'string', required: true, description: 'Name of the symbol to unfold.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: SMART_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await run(mcp, 'smart_unfold', {
        file_path: args.file_path,
        symbol_name: args.symbol_name,
      }, exec, SMART_TIMEOUT_MS)
    },
  }))
}

function applyCorpusTools(ctx: Context, mcp: ClaudeMemMcp): void {
  ctx.tools.register(defineTool({
    name: 'mem_corpus_list',
    description: 'List the knowledge corpora on this machine with their stats and priming status. A corpus is a saved slice of the observation history that answers questions about one topic.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: CORPUS_LIST_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return await run(mcp, 'list_corpora', {}, exec, CORPUS_LIST_TIMEOUT_MS)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mem_corpus_build',
    description: 'Build a knowledge corpus from filtered observations: it searches the history, collects matching records and saves them as a reusable corpus. The corpus file stays on disk until deleted; there is no delete tool. Prime it before querying.',
    parameters: {
      name: { type: 'string', required: true, description: 'Corpus name; used as the file name. Letters, digits, dots, hyphens and underscores only.' },
      description: { type: 'string', description: 'What this corpus is about.' },
      project: { type: 'string', description: 'Filter by project.' },
      types: { type: 'string', description: 'Comma-separated observation type ids, e.g. "decision,bugfix".' },
      concepts: { type: 'string', description: 'Comma-separated concepts to filter by.' },
      files: { type: 'string', description: 'Comma-separated file paths to filter by.' },
      query: { type: 'string', description: 'Search query used to select observations.' },
      dateStart: { type: 'string', description: 'Start date (ISO).' },
      dateEnd: { type: 'string', description: 'End date (ISO).' },
      limit: { type: 'integer', description: 'Maximum observations (default 500).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: CORPUS_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await run(mcp, 'build_corpus', {
        name: args.name,
        ...args.description !== undefined ? { description: args.description } : {},
        ...args.project !== undefined ? { project: args.project } : {},
        ...args.types !== undefined ? { types: args.types } : {},
        ...args.concepts !== undefined ? { concepts: args.concepts } : {},
        ...args.files !== undefined ? { files: args.files } : {},
        ...args.query !== undefined ? { query: args.query } : {},
        ...args.dateStart !== undefined ? { dateStart: args.dateStart } : {},
        ...args.dateEnd !== undefined ? { dateEnd: args.dateEnd } : {},
        ...args.limit !== undefined ? { limit: args.limit } : {},
      }, exec, CORPUS_ACTION_TIMEOUT_MS)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mem_corpus_prime',
    description: 'Prime a corpus: load its observations into a fresh knowledge agent session. Must run before mem_corpus_query.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the corpus to prime.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: CORPUS_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await run(mcp, 'prime_corpus', { name: args.name }, exec, CORPUS_ACTION_TIMEOUT_MS)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mem_corpus_query',
    description: 'Ask a primed corpus a question and get an answer grounded in its observations. Follow-up questions build on the same agent session; reprime for a clean conversation.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the primed corpus.' },
      question: { type: 'string', required: true, description: 'The question to ask.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: CORPUS_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await run(mcp, 'query_corpus', { name: args.name, question: args.question }, exec, CORPUS_ACTION_TIMEOUT_MS)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mem_corpus_rebuild',
    description: 'Rebuild a corpus from its stored filters to pick up new observations. Does not reprime. Refuses and keeps the existing corpus when the rebuild would drop a large share of observations, unless force is set.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the corpus to rebuild.' },
      force: { type: 'boolean', description: 'Accept a rebuild that shrinks the corpus significantly.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: CORPUS_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await run(mcp, 'rebuild_corpus', {
        name: args.name,
        ...args.force !== undefined ? { force: args.force } : {},
      }, exec, CORPUS_ACTION_TIMEOUT_MS)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mem_corpus_reprime',
    description: 'Start a fresh knowledge agent session for a corpus, clearing prior Q&A context while keeping the corpus knowledge. Use after rebuilding or when the conversation drifted.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the corpus to reprime.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: CORPUS_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await run(mcp, 'reprime_corpus', { name: args.name }, exec, CORPUS_ACTION_TIMEOUT_MS)
    },
  }))
}
