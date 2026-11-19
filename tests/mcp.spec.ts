import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  McpClient,
  composeToolchain,
  locateMcpServer,
  withToolchainEnv,
} from '../src/mcp.js'

const FIXTURE = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
rl.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    process.stdout.write('a line that is not JSON\\n')
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '0' } } })
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

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-spec-'))
  dirs.push(dir)
  return dir
}

function fixtureServer(dir: string): string {
  const script = join(dir, 'fixture-server.cjs')
  writeFileSync(script, FIXTURE, 'utf8')
  return script
}

afterEach(() => {
  // Temp fixtures are small; the OS cleans the temp root.
})

describe('locateMcpServer', () => {
  it('prefers an explicit path and then the newest cache version', () => {
    const home = scratch()
    const cache = join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem')
    for (const version of ['15.19.0', '16.0.0']) {
      mkdirSync(join(cache, version, 'scripts'), { recursive: true })
      writeFileSync(join(cache, version, 'scripts', 'mcp-server.cjs'), '', 'utf8')
    }
    const env = { PATH: '' } as NodeJS.ProcessEnv
    expect(locateMcpServer('', { env, home })).toBe(join(cache, '16.0.0', 'scripts', 'mcp-server.cjs'))

    const explicit = join(home, 'elsewhere.cjs')
    writeFileSync(explicit, '', 'utf8')
    expect(locateMcpServer(explicit, { env, home })).toBe(explicit)
  })

  it('answers undefined when nothing is installed', () => {
    const home = scratch()
    expect(locateMcpServer('', { env: { PATH: '' } as NodeJS.ProcessEnv, home })).toBeUndefined()
  })
})

describe('toolchain environment', () => {
  it('composes MSVC and SDK directories', () => {
    const toolchain = composeToolchain('C:/msvc/14.44', 'C:/Kits/10', '10.0.26100.0')
    expect(toolchain.path[0]).toContain('Hostx64')
    expect(toolchain.include[0]).toContain('msvc')
    expect(toolchain.lib[0]).toContain('x64')
  })

  it('prepends and never replaces the host environment', () => {
    const toolchain = composeToolchain('C:/msvc', 'C:/kits', '10.0.1')
    const env = withToolchainEnv({ PATH: 'C:/windows', INCLUDE: 'C:/old', LIB: 'C:/oldlib', HOME: 'x' } as NodeJS.ProcessEnv, toolchain)
    expect(env.PATH?.toLowerCase().startsWith(toolchain.path[0]!.toLowerCase())).toBe(true)
    expect(env.PATH).toContain('C:/windows')
    expect(env.INCLUDE).toContain('C:/old')
    expect(env.LIB).toContain('C:/oldlib')
    expect(env.HOME).toBe('x')
  })
})

describe('McpClient', () => {
  it('initializes and answers one tool call, ignoring junk lines', async () => {
    const dir = scratch()
    const client = new McpClient(fixtureServer(dir), { env: process.env, node: process.execPath })
    const result = await client.callTool('echo', { query: 'hooks' }, { cwd: dir, timeoutMs: 10_000 })
    expect(result.isError).toBe(false)
    expect(result.text).toBe('echo:echo:{"query":"hooks"}')
  })

  it('runs the child in the session directory', async () => {
    const dir = scratch()
    const run = scratch()
    const client = new McpClient(fixtureServer(dir), { env: process.env, node: process.execPath })
    const result = await client.callTool('pwd', {}, { cwd: run, timeoutMs: 10_000 })
    expect(result.text.toLowerCase()).toBe(run.toLowerCase())
  })

  it('maps a tool-level failure to MCP_TOOL_ERROR with the text kept', async () => {
    const dir = scratch()
    const client = new McpClient(fixtureServer(dir), { env: process.env, node: process.execPath })
    await expect(client.callTool('fail', {}, { cwd: dir, timeoutMs: 10_000 }))
      .rejects.toMatchObject({ code: 'MCP_TOOL_ERROR', message: 'boom' })
  })

  it('maps a JSON-RPC error to MCP_ERROR', async () => {
    const dir = scratch()
    const client = new McpClient(fixtureServer(dir), { env: process.env, node: process.execPath })
    await expect(client.callTool('rpc', {}, { cwd: dir, timeoutMs: 10_000 }))
      .rejects.toMatchObject({ code: 'MCP_ERROR' })
  })

  it('refuses an empty answer', async () => {
    const dir = scratch()
    const client = new McpClient(fixtureServer(dir), { env: process.env, node: process.execPath })
    await expect(client.callTool('empty', {}, { cwd: dir, timeoutMs: 10_000 }))
      .rejects.toMatchObject({ code: 'MCP_EMPTY' })
  })

  it('times out and kills a server that never answers', async () => {
    const dir = scratch()
    const client = new McpClient(fixtureServer(dir), { env: process.env, node: process.execPath })
    await expect(client.callTool('slow', {}, { cwd: dir, timeoutMs: 250 }))
      .rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
  }, 10_000)

  it('reports a missing server instead of spawning nothing', async () => {
    const dir = scratch()
    const client = new McpClient(join(dir, 'nope.cjs'), { env: process.env, node: process.execPath })
    await expect(client.callTool('echo', {}, { cwd: dir, timeoutMs: 10_000 }))
      .rejects.toMatchObject({ code: 'MCP_UNAVAILABLE' })
  })

  it('rejects a call without a working directory', async () => {
    const dir = scratch()
    const client = new McpClient(fixtureServer(dir), { env: process.env, node: process.execPath })
    await expect(client.callTool('echo', {}, { cwd: '  ', timeoutMs: 10_000 }))
      .rejects.toMatchObject({ code: 'MCP_INVALID_REQUEST' })
  })
})

describe.skipIf(process.env.DSH_MCP_LIVE !== '1')('live claude-mem server', () => {
  it('lists corpora and outlines this module through the real server', async () => {
    const script = locateMcpServer('')
    expect(script).toBeDefined()
    const client = new McpClient(script as string)
    const cwd = process.cwd()

    const corpora = await client.callTool('list_corpora', {}, { cwd, timeoutMs: 60_000 })
    expect(corpora.text.length).toBeGreaterThan(0)
    expect(corpora.isError).toBe(false)

    const outline = await client.callTool('smart_outline', { file_path: 'src/mcp.ts' }, { cwd, timeoutMs: 120_000 })
    expect(outline.text).toContain('mcp.ts')
    expect(outline.text).toContain('locateMcpServer')
  }, 180_000)
})
