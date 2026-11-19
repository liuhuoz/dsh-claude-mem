import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpClient } from '../src/mcp.js'

const FIXTURE = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
rl.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    process.stdout.write('a line that is not JSON\\n')
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '0' } } })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'echo', description: 'Echo arguments back' },
      { name: 'pwd' },
    ] } })
    return
  }
  if (message.method !== 'tools/call') return
  const name = message.params && message.params.name
  const args = (message.params && message.params.arguments) || {}
  if (name === 'slow') return
  if (name === 'fail') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } })
  if (name === 'rpc') return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such tool' } })
  if (name === 'empty') return send({ jsonrpc: '2.0', id: message.id, result: { content: [] } })
  if (name === 'pwd') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: process.cwd() }] } })
  send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + name + ':' + JSON.stringify(args) }] } })
})
`

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-spec-'))
}

/** The caller owns the command line: a fixture server is just node plus a file. */
function fixture(dir: string): McpClient {
  const script = join(dir, 'fixture-server.cjs')
  writeFileSync(script, FIXTURE, 'utf8')
  return new McpClient({ command: process.execPath, args: [script], env: process.env })
}

describe('McpClient', () => {
  it('initializes and answers one tool call, ignoring junk lines', async () => {
    const dir = scratch()
    const result = await fixture(dir).callTool('echo', { query: 'hooks' }, { cwd: dir, timeoutMs: 10_000 })
    expect(result.isError).toBe(false)
    expect(result.text).toBe('echo:echo:{"query":"hooks"}')
  })

  it('runs the server in the requested directory', async () => {
    const dir = scratch()
    const run = scratch()
    const result = await fixture(dir).callTool('pwd', {}, { cwd: run, timeoutMs: 10_000 })
    expect(result.text.toLowerCase()).toBe(run.toLowerCase())
  })

  it('lists the advertised tools', async () => {
    const dir = scratch()
    const tools = await fixture(dir).listTools({ cwd: dir, timeoutMs: 10_000 })
    expect(tools.map(tool => tool.name)).toEqual(['echo', 'pwd'])
    expect(tools[0]?.description).toBe('Echo arguments back')
  })

  it('maps a tool-level failure to MCP_TOOL_ERROR with the text kept', async () => {
    const dir = scratch()
    await expect(fixture(dir).callTool('fail', {}, { cwd: dir, timeoutMs: 10_000 }))
      .rejects.toMatchObject({ code: 'MCP_TOOL_ERROR', message: 'boom' })
  })

  it('maps a JSON-RPC error to MCP_ERROR', async () => {
    const dir = scratch()
    await expect(fixture(dir).callTool('rpc', {}, { cwd: dir, timeoutMs: 10_000 }))
      .rejects.toMatchObject({ code: 'MCP_ERROR' })
  })

  it('refuses an empty answer', async () => {
    const dir = scratch()
    await expect(fixture(dir).callTool('empty', {}, { cwd: dir, timeoutMs: 10_000 }))
      .rejects.toMatchObject({ code: 'MCP_EMPTY' })
  })

  it('times out and kills a server that never answers', async () => {
    const dir = scratch()
    await expect(fixture(dir).callTool('slow', {}, { cwd: dir, timeoutMs: 250 }))
      .rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
  }, 10_000)

  it('reports a server that cannot start', async () => {
    const client = new McpClient({ command: 'definitely-not-a-real-mcp-binary' })
    await expect(client.callTool('echo', {}, { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: 'MCP_UNAVAILABLE' })
  })

  it('rejects a call without a command', async () => {
    const client = new McpClient({ command: '   ' })
    await expect(client.callTool('echo', {}, { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: 'MCP_INVALID_REQUEST' })
  })

  it('honours an already-aborted signal', async () => {
    const dir = scratch()
    const controller = new AbortController()
    controller.abort()
    await expect(fixture(dir).callTool('echo', {}, { cwd: dir, signal: controller.signal, timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: 'MCP_ABORTED' })
  })
})
