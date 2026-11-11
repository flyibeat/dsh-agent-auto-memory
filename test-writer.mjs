import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply as applyWriter, name as writerName } from './writer-entry.js'
import { revisionOf, validateMemoryPath, writeSharedMemory } from './memory-store.mjs'

const root = await mkdtemp(join(tmpdir(), 'amem-writer-'))
await mkdir(join(root, 'topics'))
const nl = String.fromCharCode(10)
assert.equal(writerName, 'agent-auto-memory-writer')
assert.throws(() => validateMemoryPath('../x.md'))
assert.throws(() => validateMemoryPath('topics/a/b.md'))
assert.throws(() => validateMemoryPath('topics/NUL.md'))
assert.throws(() => validateMemoryPath('topics/a:b.md'))
await assert.rejects(writeSharedMemory(root, { path: 'AGENTS.md', content: 'x'.repeat(1024 * 1024 + 1), expectedRevision: 'absent' }), /1 MiB/)
const a = await writeSharedMemory(root, { path: 'AGENTS.md', content: '# root' + nl, expectedRevision: 'absent' })
assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# root' + nl)
await assert.rejects(writeSharedMemory(root, { path: 'AGENTS.md', content: 'lost', expectedRevision: '0'.repeat(64) }), /revision conflict/)
const b = await writeSharedMemory(root, { path: 'AGENTS.md', content: '# next' + nl, expectedRevision: a.revision })
assert.notEqual(a.revision, b.revision)
await writeSharedMemory(root, { path: 'topics/test.md', content: '# topic' + nl, expectedRevision: 'absent' })
const raceRevision = await revisionOf(join(root, 'topics', 'test.md'))
const race = await Promise.allSettled([
  writeSharedMemory(root, { path: 'topics/test.md', content: '# race-a' + nl, expectedRevision: raceRevision }),
  writeSharedMemory(root, { path: 'topics/test.md', content: '# race-b' + nl, expectedRevision: raceRevision }),
])
assert.equal(race.filter(x => x.status === 'fulfilled').length, 1)
assert.equal(race.filter(x => x.status === 'rejected').length, 1)
let symlinkCheck = 'skipped-no-privilege'
try {
  await symlink(join(root, 'AGENTS.md'), join(root, 'topics', 'link.md'))
  await assert.rejects(writeSharedMemory(root, { path: 'topics/link.md', content: 'x', expectedRevision: await revisionOf(join(root, 'topics', 'link.md')) }), /regular file/)
  symlinkCheck = 'rejected'
} catch (error) { if (error?.code !== 'EPERM') throw error }
let definition
const ctx = { tools: { register(value) { definition = value; return () => { definition = undefined } } } }
applyWriter(ctx, { enabled: false })
assert.equal(definition, undefined)
applyWriter(ctx, {})
assert.equal(definition.name, 'write_shared_memory')
assert.equal(definition.parameters.additionalProperties, false)
assert.equal(definition.isConcurrencySafe({}), false)
console.log(JSON.stringify({ ok: true, create: a.operation, update: b.operation, raceWinners: 1, symlinkCheck, tool: definition.name }))
