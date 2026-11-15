/**
 * The `mem-search` runtime skill: guidance for the model on the three-layer
 * memory search workflow (search → filter → fetch) over the `mem_*` tools.
 * @module dsh-claude-mem/skill
 */

import type {} from '@deepseek-ai/dsh-skill'

const MEM_SEARCH_SKILL_NAME = 'mem-search'
const MEM_SEARCH_SKILL_DESCRIPTION = 'Search persistent cross-session memory. Use when the user asks "did we already solve this?", "how did we do X last time?", or needs work from previous sessions.'

const MEM_SEARCH_SKILL_CONTENT = `# Memory Search

Search past work across all sessions. Follow this workflow: search -> filter -> fetch.

## When to Use

Use when users ask about PREVIOUS sessions (not the current conversation):

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"

## 3-Layer Workflow (ALWAYS Follow)

NEVER fetch full details without filtering first. This saves 10x tokens.

### Step 1: Search — get an index with ids

Use the \`mem_search\` tool with a free-text query. It returns a table of IDs, titles, and dates.
Omit \`platformSource\` to search ALL memory; set it only to restrict to your own platform's memory.

### Step 2: Filter — narrow to the interesting ids

Pick the candidate ids from the index results that look relevant to the question.

### Step 3: Fetch — get full details only for the filtered ids

Use \`mem_get_observations\` with the selected ids. Use \`mem_timeline\` to get context
around a specific observation by id.

### Optional: dumb search

\`mem_dumb_search\` answers in one call: it picks records by title word overlap, adds nearby context, and returns the selected details. It does not reason about the results — fast, but shallow.

### Last resort: raw tool I/O

\`mem_get_tool_uses\` returns the original tool_input / tool_response for tool calls you already identified. It needs tool-use ids, which only \`mem_search\` with \`deep: true\` produces (the worker must have CLAUDE_MEM_TOOL_USES_SEARCH_ENABLED set); those payloads are unsummarized and can be thousands of tokens each.

For the worker's own session-start context text, use \`mem_context\`.
`

/** The runtime skill registration object accepted by \`ctx.skills.register()\`. */
export const memSearchSkill = {
  name: MEM_SEARCH_SKILL_NAME,
  description: MEM_SEARCH_SKILL_DESCRIPTION,
  source: 'bundled',
  content: MEM_SEARCH_SKILL_CONTENT,
} as const
