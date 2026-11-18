import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply as applyWriter, name as writerName } from './writer-entry.js'
import { recoverSharedMemoryPair, revisionOf, validateMemoryPath, writeSharedMemory, writeSharedMemoryPair } from './memory-store.mjs'
import { atomicWriteAuxiliary, contentRevision, supportDirectory } from './atomic-memory-store.mjs'

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
assert.ok(b.backup)
const c = await writeSharedMemory(root, { path: 'AGENTS.md', content: '# third' + nl, expectedRevision: b.revision })
assert.equal(c.backup, b.backup, 'same target must reuse one previous-version backup path')
assert.equal(await readFile(c.backup, 'utf8'), '# next' + nl)
const metadata = JSON.parse(await readFile(c.backup.replace(/\.previous$/, '.json'), 'utf8'))
assert.equal(metadata.root, root)
assert.equal(metadata.relativePath, 'AGENTS.md')
assert.equal(metadata.source, join(root, 'AGENTS.md'))
assert.equal(metadata.revision, b.revision)

await writeSharedMemory(root, { path: 'topics/test.md', content: '# topic' + nl, expectedRevision: 'absent' })
const raceRevision = await revisionOf(join(root, 'topics', 'test.md'))
const race = await Promise.allSettled([
  writeSharedMemory(root, { path: 'topics/test.md', content: '# race-a' + nl, expectedRevision: raceRevision }),
  writeSharedMemory(root, { path: 'topics/test.md', content: '# race-b' + nl, expectedRevision: raceRevision }),
])
assert.equal(race.filter(x => x.status === 'fulfilled').length, 1)
assert.equal(race.filter(x => x.status === 'rejected').length, 1)

const indexRevision = await revisionOf(join(root, 'AGENTS.md'))
const pair = await writeSharedMemoryPair(root, {
  topic: { path: 'topics/pair.md', content: '# pair' + nl, expectedRevision: 'absent' },
  index: { path: 'AGENTS.md', content: '# indexed' + nl, expectedRevision: indexRevision },
})
assert.equal(pair.operation, 'pair-update')
assert.equal(await readFile(join(root, 'topics', 'pair.md'), 'utf8'), '# pair' + nl)
assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# indexed' + nl)
assert.equal(pair.index.backup, c.backup, 'paired index update must keep the same one-backup slot')
assert.equal(await readFile(pair.index.backup, 'utf8'), '# third' + nl)

const recoverTarget = join(root, 'topics', 'recover.md')
await writeFile(recoverTarget, '# interrupted' + nl, 'utf8')
const recoverTopicRevision = await revisionOf(recoverTarget)
const recoverIndexRevision = await revisionOf(join(root, 'AGENTS.md'))
const recoverJournal = join(supportDirectory(root), 'shared-pair-transaction.json')
await atomicWriteAuxiliary(recoverJournal, Buffer.from(JSON.stringify({
  version: 1,
  root,
  phase: 'topic-committed',
  topic: { target: recoverTarget, relativePath: 'topics/recover.md', previousRevision: 'absent', newRevision: recoverTopicRevision },
  index: { target: join(root, 'AGENTS.md'), relativePath: 'AGENTS.md', previousRevision: recoverIndexRevision, newRevision: contentRevision('# never' + nl) },
}) + nl, 'utf8'))
assert.equal(await recoverSharedMemoryPair(root), true)
assert.equal(await revisionOf(recoverTarget), 'absent', 'journal recovery must roll back topic-only commit')

await assert.rejects(writeSharedMemoryPair(root, {
  topic: { path: 'topics/orphan.md', content: '# orphan' + nl, expectedRevision: 'absent' },
  index: { path: 'AGENTS.md', content: '# stale' + nl, expectedRevision: '0'.repeat(64) },
}), /revision conflict/)
assert.equal(await revisionOf(join(root, 'topics', 'orphan.md')), 'absent', 'failed pair must not leave an orphan topic')
const leftovers = (await readdir(root, { recursive: true })).filter(name => String(name).includes('.amem-'))
assert.deepEqual(leftovers, [], 'temporary files must be cleaned after failures and commits')

let symlinkCheck = 'skipped-no-privilege'
try {
  await symlink(join(root, 'AGENTS.md'), join(root, 'topics', 'link.md'))
  await assert.rejects(writeSharedMemory(root, { path: 'topics/link.md', content: 'x', expectedRevision: await revisionOf(join(root, 'topics', 'link.md')) }), /regular file/)
  symlinkCheck = 'rejected'
} catch (error) { if (error?.code !== 'EPERM') throw error }

const definitions = new Map()
const ctx = { tools: { register(value) { definitions.set(value.name, value); return () => { definitions.delete(value.name) } } } }
applyWriter(ctx, { enabled: false })
assert.equal(definitions.size, 0)
applyWriter(ctx, {})
assert(definitions.has('write_shared_memory'))
assert(definitions.has('write_shared_memory_pair'))
assert.equal(definitions.get('write_shared_memory').parameters.additionalProperties, false)
assert.equal(definitions.get('write_shared_memory_pair').parameters.additionalProperties, false)
assert.equal(definitions.get('write_shared_memory').isConcurrencySafe({}), false)

await rm(root, { recursive: true, force: true })
await rm(supportDirectory(root), { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, create: a.operation, update: b.operation, oneBackup: true, pair: pair.operation, raceWinners: 1, symlinkCheck, tools: [...definitions.keys()] }))
