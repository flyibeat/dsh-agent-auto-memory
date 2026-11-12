import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply as applyProjectWriter, name as projectWriterName } from './project-writer-entry.js'
import { findProjectRoot, sessionCwdOf } from './project-memory-tool.mjs'
import { revisionOf, validateProjectPath, writeProjectMemory } from './project-memory-store.mjs'

const nl = String.fromCharCode(10)
assert.equal(projectWriterName, 'agent-auto-memory-project-writer')
assert.throws(() => validateProjectPath('../x.md'))
assert.throws(() => validateProjectPath('topics/x.md'))
assert.throws(() => validateProjectPath('.agents/topics/a/b.md'))
assert.throws(() => validateProjectPath('.agents/topics/NUL.md'))
assert.throws(() => validateProjectPath('.agents/topics/a:b.md'))

const base = await mkdtemp(join(tmpdir(), 'amem-project-'))
const deep = join(base, '撰写', '2026-11-08-选题')
await mkdir(deep, { recursive: true })
await writeFile(join(base, 'AGENTS.md'), '# project' + nl, 'utf8')

assert.equal(sessionCwdOf({}), undefined)
assert.equal(sessionCwdOf({ agent: { session: { header: { cwd: deep } } } }), deep)
assert.equal(findProjectRoot(deep).root, base)
assert.equal(findProjectRoot(deep, ['.agents', 'AGENTS.md'], 0).root, undefined, 'level cap must not find the parent project')

const created = await writeProjectMemory(base, { path: '.agents/topics/试写.md', content: '# t' + nl, expectedRevision: 'absent' })
assert.equal(created.root, base)
assert.equal(created.operation, 'create')
await assert.rejects(writeProjectMemory(base, { path: '.agents/topics/试写.md', content: 'x', expectedRevision: 'absent' }), /revision conflict/)
await assert.rejects(writeProjectMemory(base, { path: '.agents/topics/试写.md', content: 'x'.repeat(1024 * 1024 + 1), expectedRevision: created.revision }), /1 MiB/)
const updated = await writeProjectMemory(base, { path: '.agents/topics/试写.md', content: '# t2' + nl, expectedRevision: created.revision })
assert.equal(updated.operation, 'update')
assert.ok(updated.backup)
assert.equal((await readFile(join(base, '.agents', 'topics', '试写.md'), 'utf8')).trim(), '# t2')

let def
applyProjectWriter({ tools: { register: (d) => { def = d; return () => {} } } }, {})
assert.equal(def.name, 'write_project_memory')
const viaTool = await def.execute({ path: '.agents/topics/工具写.md', content: '# tool' + nl, expectedRevision: 'absent' }, { agent: { session: { header: { cwd: deep } } } })
assert.equal(viaTool.root, base)
await assert.rejects(def.execute({ path: '.agents/topics/工具写.md', content: 'x', expectedRevision: 'absent' }, {}), /project root not found/)
assert.equal(await revisionOf(join(base, '.agents', 'topics', '试写.md')), updated.revision)
console.log('project-writer ok')
