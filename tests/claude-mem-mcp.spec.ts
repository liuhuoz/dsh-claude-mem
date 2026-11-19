import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeMemMcp, mcpServerBeside, nodeCommand } from '../src/claude-mem-mcp.js'
import type { WorkerClient } from '../src/worker.js'

const FIXTURE = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
rl.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '0' } } })
    return
  }
  if (message.method !== 'tools/call') return
  send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok:' + message.params.name }] } })
})
`

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'cm-mcp-spec-'))
}

/** An installation layout: a worker script with the MCP server beside it. */
function installation(dir: string): string {
  const workerPath = join(dir, 'worker-service.cjs')
  writeFileSync(workerPath, '', 'utf8')
  writeFileSync(join(dir, 'mcp-server.cjs'), FIXTURE, 'utf8')
  return workerPath
}

function fakeWorker(health: { workerPath?: string }): WorkerClient {
  let calls = 0
  const worker = {
    health: async () => {
      calls += 1
      return { status: 'ok', ...health }
    },
    get healthCalls() { return calls },
  }
  return worker as unknown as WorkerClient
}

describe('mcpServerBeside', () => {
  it('finds the server in the worker installation', () => {
    const dir = scratch()
    const workerPath = installation(dir)
    expect(mcpServerBeside(workerPath)).toBe(join(dir, 'mcp-server.cjs'))
  })

  it('answers undefined when the file or the path is missing', () => {
    expect(mcpServerBeside(undefined)).toBeUndefined()
    expect(mcpServerBeside('   ')).toBeUndefined()
    expect(mcpServerBeside(join(scratch(), 'worker-service.cjs'))).toBeUndefined()
  })
})

describe('nodeCommand', () => {
  it('honours the explicit override', () => {
    const result = nodeCommand({} as NodeJS.ProcessVersions, { DSH_MEM_NODE: 'C:/node/node.exe' }, 'C:/app.exe')
    expect(result.command).toBe('C:/node/node.exe')
  })

  it('runs an Electron binary as node', () => {
    const versions = { electron: '36.0.0' } as unknown as NodeJS.ProcessVersions
    const result = nodeCommand(versions, { PATH: '' }, 'C:/app/DSH.exe')
    expect(result.command).toBe('C:/app/DSH.exe')
    expect(result.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('uses the current binary when the host is plain node', () => {
    const result = nodeCommand({} as NodeJS.ProcessVersions, { PATH: '' }, 'C:/node/node.exe')
    expect(result.command).toBe('C:/node/node.exe')
    expect(result.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})

describe('ClaudeMemMcp', () => {
  it('resolves the server from health and calls it', async () => {
    const dir = scratch()
    const workerPath = installation(dir)
    const mcp = new ClaudeMemMcp(fakeWorker({ workerPath }))
    const result = await mcp.call('smart_outline', {}, { cwd: dir, timeoutMs: 10_000 })
    expect(result.text).toBe('ok:smart_outline')
  })

  it('reports a missing server instead of guessing a path', async () => {
    const mcp = new ClaudeMemMcp(fakeWorker({}))
    await expect(mcp.call('smart_outline', {}, { cwd: scratch(), timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: 'MEM_MCP_UNAVAILABLE' })
  })
})
