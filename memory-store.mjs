import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, chmod, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const REVISION = /^[0-9a-f]{64}$/
const TOPIC = /^topics[\/][^\/]+\.md$/u
const INVALID_WINDOWS_NAME = /[\u0000-\u001f<>:"|?*]/u
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const MAX_CONTENT_BYTES = 1024 * 1024

export function validateMemoryPath(relativePath) {
  if (relativePath === 'AGENTS.md') return relativePath
  if (!TOPIC.test(relativePath) || relativePath.includes('..')) throw new Error('path must be AGENTS.md or topics/<single-name>.md')
  const normalized = relativePath.replaceAll('\\', '/')
  const name = basename(normalized)
  if (name === '.md' || INVALID_WINDOWS_NAME.test(name) || RESERVED_WINDOWS_NAME.test(name) || /[. ]$/u.test(name)) {
    throw new Error('topic filename is not portable or safe on Windows')
  }
  return normalized
}

async function regularOrAbsent(path) {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('target must be a regular file, not a link')
    return stat
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function assertPhysicalDirectory(path, label) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(label + ' must be an existing physical directory')
  const physical = await realpath(path)
  if (resolve(physical) !== resolve(path)) throw new Error(label + ' must not resolve through a link or junction')
}

export async function revisionOf(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }
}

export async function writeSharedMemory(root, request) {
  const relativePath = validateMemoryPath(request.path)
  const expected = request.expectedRevision
  if (expected !== 'absent' && !REVISION.test(expected)) throw new Error('expectedRevision must be absent or a lowercase SHA-256')
  if (typeof request.content !== 'string') throw new Error('content must be a UTF-8 string')
  if (Buffer.byteLength(request.content) > MAX_CONTENT_BYTES) throw new Error('content exceeds 1 MiB limit')
  const physicalRoot = resolve(root)
  await assertPhysicalDirectory(physicalRoot, 'shared memory root')
  const parent = relativePath === 'AGENTS.md' ? physicalRoot : join(physicalRoot, 'topics')
  if (relativePath !== 'AGENTS.md') {
    await mkdir(parent, { recursive: true })
    await assertPhysicalDirectory(parent, 'topics directory')
  }
  const target = resolve(physicalRoot, relativePath)
  if (target !== join(physicalRoot, 'AGENTS.md') && dirname(target) !== join(physicalRoot, 'topics')) throw new Error('path escaped shared memory root')
  const targetStat = await regularOrAbsent(target)
  await assertPhysicalDirectory(physicalRoot, 'shared memory root')
  await assertPhysicalDirectory(parent, relativePath === 'AGENTS.md' ? 'shared memory root' : 'topics directory')
  const observed = await revisionOf(target)
  if (observed !== expected) throw new Error('revision conflict: expected ' + expected + ', observed ' + observed)
  const backupDir = join(tmpdir(), 'amem-backup')
  await mkdir(backupDir, { recursive: true })
  let backup
  if (targetStat) {
    backup = join(backupDir, basename(target) + '.bak-' + Date.now() + '-' + randomUUID())
    await copyFile(target, backup)
  }
  const temporary = join(parent, '.amem-' + randomUUID() + '.tmp')
  const handle = await open(temporary, 'wx', targetStat?.mode ?? 0o600)
  try {
    await handle.writeFile(request.content, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (targetStat) await chmod(temporary, targetStat.mode)
    await assertPhysicalDirectory(physicalRoot, 'shared memory root')
    await assertPhysicalDirectory(parent, relativePath === 'AGENTS.md' ? 'shared memory root' : 'topics directory')
    const latest = await revisionOf(target)
    if (latest !== expected) throw new Error('revision conflict before atomic replace: observed ' + latest)
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  const revision = await revisionOf(target)
  return { path: relativePath, operation: expected === 'absent' ? 'create' : 'update', revision, bytes: Buffer.byteLength(request.content), lineCount: request.content.length === 0 ? 0 : request.content.split(/\n/).length, ...(backup ? { backup } : {}) }
}
