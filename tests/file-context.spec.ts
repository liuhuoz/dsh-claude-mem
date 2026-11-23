import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  capContext,
  commandFiles,
  FileMemoryLookup,
  gateCandidate,
  gateReason,
  HttpFileContext,
  msysToWin,
  pathCandidates,
  promptMentionsFile,
  renderFileContext,
} from '../src/file-context.js'
import type { MemObservation } from '../src/types.js'
import type { WorkerClient } from '../src/worker.js'

const roots: string[] = []

/** One temp workspace holding the named files. */
function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fc-'))
  roots.push(root)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function observation(id: number, epoch: number, type = 'discovery', title = 'a title'): MemObservation {
  return { id, title, type, createdAtEpoch: epoch }
}

function workerWith(rows: readonly MemObservation[]): WorkerClient & { byFile: ReturnType<typeof vi.fn> } {
  return { byFile: vi.fn(async () => rows) } as unknown as WorkerClient & { byFile: ReturnType<typeof vi.fn> }
}

const BIG = 'x'.repeat(2_000)

describe('msysToWin', () => {
  it('rewrites drive tokens at a boundary', () => {
    expect(msysToWin('cat /d/repo/a.ts')).toBe('cat D:/repo/a.ts')
    expect(msysToWin('"/c/Users/x/y"')).toBe('"C:/Users/x/y"')
  })

  it('leaves ordinary text and urls alone', () => {
    expect(msysToWin('npm run build')).toBe('npm run build')
    expect(msysToWin('https://example.com/d/x')).toBe('https://example.com/d/x')
    expect(msysToWin('/usr/local/bin')).toBe('/usr/local/bin')
  })
})

describe('capContext', () => {
  it('keeps short text and trims long text', () => {
    expect(capContext('  short  ')).toBe('short')
    const capped = capContext('x'.repeat(50), 10)
    expect(capped.startsWith('x'.repeat(10))).toBe(true)
    expect(capped).toContain('truncated')
  })
})

describe('pathCandidates', () => {
  it('resolves the file a read names', () => {
    const root = workspace({ 'a.ts': BIG })
    expect(pathCandidates({ sessionId: 's', cwd: root, toolName: 'read', arguments: { file_path: 'a.ts' } }))
      .toEqual([join(root, 'a.ts')])
  })

  it('answers nothing for a tool it does not read files from', () => {
    expect(pathCandidates({ sessionId: 's', cwd: 'D:/repo', toolName: 'grep', arguments: { pattern: 'x' } })).toEqual([])
    expect(pathCandidates({ sessionId: 's', cwd: 'D:/repo', toolName: 'read', arguments: {} })).toEqual([])
  })

  it('takes the file arguments of a read-only shell command', () => {
    const root = workspace({ 'a.ts': BIG, 'b.ts': BIG })
    expect(commandFiles(`cat a.ts`, root)).toEqual([join(root, 'a.ts')])
    expect(commandFiles(`head -n 20 a.ts b.ts`, root)).toEqual([join(root, 'a.ts'), join(root, 'b.ts')])
  })

  it('ignores commands that are not on the whitelist and arguments that are not files', () => {
    const root = workspace({ 'a.ts': BIG })
    expect(commandFiles('rm a.ts', root)).toEqual([])
    expect(commandFiles('cat missing.ts a.ts', root)).toEqual([join(root, 'a.ts')])
    expect(commandFiles('', root)).toEqual([])
  })

  it('understands the PowerShell read commands it claims to', () => {
    const root = workspace({ 'a.ps1': BIG })
    expect(commandFiles('Get-Content a.ps1', root, true)).toEqual([join(root, 'a.ps1')])
    expect(commandFiles('Remove-Item a.ps1', root, true)).toEqual([])
    expect(pathCandidates({ sessionId: 's', cwd: root, toolName: 'pwsh', arguments: { command: 'Get-Content a.ps1' } }))
      .toEqual([join(root, 'a.ps1')])
  })

  it('adopts a workdir argument over the session cwd', () => {
    const root = workspace({ 'a.ts': BIG })
    expect(pathCandidates({ sessionId: 's', cwd: 'D:/elsewhere', toolName: 'ops_bash', arguments: { command: 'cat a.ts', workdir: root } }))
      .toEqual([join(root, 'a.ts')])
  })
})

describe('renderFileContext', () => {
  const epoch = 1_795_400_000_000

  it('renders the CLI header lines and a day-grouped row', () => {
    const text = renderFileContext('D:/repo/a.ts', [observation(7, epoch, 'bugfix', 'fixed the parse')], new Date(epoch))
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^Current: \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(am|pm) /)
    expect(lines[1]).toBe('This file has prior observations — supplementary context follows. The Read result below is the full requested section.')
    expect(lines[2]).toContain('get_observations([IDs])')
    expect(lines[3]).toBe('- **Need a structural map first?** smart_outline("D:/repo/a.ts") — line numbers only, cheaper than re-reading.')
    expect(lines[4]).toMatch(/^### [A-Z][a-z]{2} \d{1,2}, \d{4}$/)
    expect(lines[5]).toMatch(/^7 \d{1,2}:\d{2}[ap] 🔴 fixed the parse$/)
  })

  it('groups rows by day and keeps them in time order', () => {
    const day = 24 * 60 * 60 * 1000
    const text = renderFileContext('a.ts', [
      observation(2, epoch + day, 'feature', 'later'),
      observation(1, epoch, 'discovery', 'earlier'),
    ], new Date(epoch))
    const rows = text.split('\n').filter(line => /^\d+ /.test(line))
    expect(rows[0]).toMatch(/^1 /)
    expect(rows[1]).toMatch(/^2 /)
    expect(text.split('\n').filter(line => line.startsWith('### '))).toHaveLength(2)
  })

  it('falls back to Untitled and collapses the title to one line', () => {
    const text = renderFileContext('a.ts', [observation(1, epoch, 'unknown', 'line\none\ttwo')])
    const row = text.split('\n').find(line => line.startsWith('1 ')) ?? ''
    expect(row).toContain('❓')
    expect(row).not.toContain('\n')
    expect(row.endsWith('line one two')).toBe(true)
  })

  it('escapes a path that would break the quoted hint', () => {
    const text = renderFileContext('C:\\repo\\a "quoted".ts', [])
    expect(text).toContain('smart_outline("C:\\\\repo\\\\a \\"quoted\\".ts")')
  })
})

describe('FileMemoryLookup', () => {
  const epoch = 1_795_400_000_000

  it('answers null for a missing file and for one below the size floor', async () => {
    const root = workspace({ 'small.ts': 'tiny' })
    const worker = workerWith([observation(1, epoch)])
    const lookup = new FileMemoryLookup(worker)
    await expect(lookup.inspect({ sessionId: 's', cwd: root }, join(root, 'missing.ts'))).resolves.toBeNull()
    await expect(lookup.inspect({ sessionId: 's', cwd: root }, join(root, 'small.ts'))).resolves.toBeNull()
    expect(worker.byFile).not.toHaveBeenCalled()
  })

  it('asks once for a gate and the read that follows it', async () => {
    const root = workspace({ 'a.ts': BIG })
    const file = join(root, 'a.ts')
    const worker = workerWith([observation(1, statSync(file).mtimeMs + 60_000)])
    const lookup = new FileMemoryLookup(worker)
    await lookup.inspect({ sessionId: 's', cwd: root }, file)
    await lookup.inspect({ sessionId: 's', cwd: root }, file)
    expect(worker.byFile).toHaveBeenCalledTimes(1)
    expect(worker.byFile.mock.calls[0]?.[0]).toContain('a.ts')
  })

  it('refetches when the file changed after the cached lookup', async () => {
    const root = workspace({ 'a.ts': BIG })
    const file = join(root, 'a.ts')
    const worker = workerWith([observation(1, 1)])
    const lookup = new FileMemoryLookup(worker)
    await lookup.inspect({ sessionId: 's', cwd: root }, file)
    const later = new Date(Date.now() + 5_000)
    utimesSync(file, later, later)
    await lookup.inspect({ sessionId: 's', cwd: root }, file)
    expect(worker.byFile).toHaveBeenCalledTimes(2)
  })

  it('forgets a session without touching the others', async () => {
    const root = workspace({ 'a.ts': BIG })
    const file = join(root, 'a.ts')
    const worker = workerWith([observation(1, statSync(file).mtimeMs + 60_000)])
    const lookup = new FileMemoryLookup(worker)
    await lookup.inspect({ sessionId: 's1', cwd: root }, file)
    lookup.forget('s1')
    await lookup.inspect({ sessionId: 's1', cwd: root }, file)
    expect(worker.byFile).toHaveBeenCalledTimes(2)
  })
})

describe('HttpFileContext', () => {
  const injected = (root: string, file: string, newest: number) => {
    const worker = workerWith([observation(11, newest, 'discovery', 'the note')])
    return { source: new HttpFileContext(new FileMemoryLookup(worker)), worker }
  }

  it('injects the rendered block when the file is older than its newest observation', async () => {
    const root = workspace({ 'a.ts': BIG })
    const file = join(root, 'a.ts')
    const { source } = injected(root, file, statSync(file).mtimeMs + 60_000)
    const text = await source.fetch({ sessionId: 's', cwd: root, toolName: 'read', arguments: { file_path: 'a.ts' } })
    expect(text).toContain('11 ')
    expect(text).toContain('the note')
    expect(text?.startsWith('Current: ')).toBe(true)
  })

  it('stays silent once the file changed after its newest observation', async () => {
    const root = workspace({ 'a.ts': BIG })
    const file = join(root, 'a.ts')
    const { source } = injected(root, file, statSync(file).mtimeMs - 1)
    await expect(source.fetch({ sessionId: 's', cwd: root, toolName: 'read', arguments: { file_path: 'a.ts' } })).resolves.toBeNull()
  })

  it('injects one file once per session, and again when a newer observation lands', async () => {
    const root = workspace({ 'a.ts': BIG })
    const file = join(root, 'a.ts')
    const newest = statSync(file).mtimeMs + 60_000
    const rows = [observation(11, newest)]
    const byFile = vi.fn(async () => rows)
    // TTL 0: every fetch asks again, which is what a later read sees.
    const source = new HttpFileContext(new FileMemoryLookup({ byFile } as unknown as WorkerClient, 0))
    const request = { sessionId: 's', cwd: root, toolName: 'read', arguments: { file_path: 'a.ts' } } as const
    expect(await source.fetch(request)).not.toBeNull()
    await expect(source.fetch(request)).resolves.toBeNull()
    rows.push(observation(12, newest + 1))
    expect(await source.fetch(request)).not.toBeNull()
  })

  it('forgets the session dedupe on demand', async () => {
    const root = workspace({ 'a.ts': BIG })
    const file = join(root, 'a.ts')
    const { source } = injected(root, file, statSync(file).mtimeMs + 60_000)
    const request = { sessionId: 's', cwd: root, toolName: 'read', arguments: { file_path: 'a.ts' } } as const
    expect(await source.fetch(request)).not.toBeNull()
    source.forget('s')
    expect(await source.fetch(request)).not.toBeNull()
  })

  it('stays silent for a file below the size floor and for a failing worker', async () => {
    const root = workspace({ 'small.ts': 'tiny', 'a.ts': BIG })
    const small = new HttpFileContext(new FileMemoryLookup(workerWith([observation(1, 9e15)])))
    await expect(small.fetch({ sessionId: 's', cwd: root, toolName: 'read', arguments: { file_path: 'small.ts' } })).resolves.toBeNull()
    const broken = { byFile: vi.fn(async () => { throw new Error('down') }) } as unknown as WorkerClient
    const source = new HttpFileContext(new FileMemoryLookup(broken))
    await expect(source.fetch({ sessionId: 's', cwd: root, toolName: 'read', arguments: { file_path: 'a.ts' } })).resolves.toBeNull()
  })
})

describe('gateCandidate', () => {
  it('accepts a plain full read', () => {
    expect(gateCandidate('read', { file_path: 'D:/repo/big.ts' })).toEqual({ filePath: 'D:/repo/big.ts' })
    expect(gateCandidate('read', { file_path: 'D:/repo/big.ts', offset: 1 })).toEqual({ filePath: 'D:/repo/big.ts' })
  })

  it('lets a narrowed read through', () => {
    expect(gateCandidate('read', { file_path: 'D:/repo/big.ts', offset: 40 })).toBeNull()
    expect(gateCandidate('read', { file_path: 'D:/repo/big.ts', limit: 80 })).toBeNull()
  })

  it('exempts prose and configuration, and other tools', () => {
    expect(gateCandidate('read', { file_path: 'D:/repo/README.md' })).toBeNull()
    expect(gateCandidate('read', { file_path: 'D:/repo/x.yaml' })).toBeNull()
    expect(gateCandidate('grep', { file_path: 'D:/repo/big.ts' })).toBeNull()
    expect(gateCandidate('read', {})).toBeNull()
  })
})

describe('gateReason', () => {
  it('names the file, its size and the way forward', () => {
    const reason = gateReason('D:/repo/src/big.ts', 64 * 1024)
    expect(reason).toContain('big.ts')
    expect(reason).toContain('64 KB')
    expect(reason).toContain('offset')
    expect(reason).toContain('mem_search')
  })
})

describe('promptMentionsFile', () => {
  const target = 'C:/Users/me/project/src/worker-service.ts'

  it('matches the full path, the last two segments, and a specific file name', () => {
    expect(promptMentionsFile('please read C:/Users/me/project/src/worker-service.ts fully', target)).toBe(true)
    expect(promptMentionsFile('look at src/worker-service.ts', target)).toBe(true)
    expect(promptMentionsFile('fix worker-service.ts', target)).toBe(true)
  })

  it('ignores unrelated prompts and short generic names', () => {
    expect(promptMentionsFile('run the tests', target)).toBe(false)
    expect(promptMentionsFile('', target)).toBe(false)
    expect(promptMentionsFile('touch index.ts', 'C:/a/index.ts')).toBe(false)
  })

  it('is case-insensitive and slash-agnostic', () => {
    expect(promptMentionsFile('read C:\\Users\\Me\\Project\\src\\worker-service.ts', target)).toBe(true)
  })
})
