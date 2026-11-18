import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, chmod, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const REVISION = /^[0-9a-f]{64}$/
export const MAX_CONTENT_BYTES = 1024 * 1024

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function contentRevision(content) {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}

export function validateWriteRequest(request) {
  const expected = request?.expectedRevision
  if (expected !== 'absent' && !REVISION.test(expected)) throw new Error('expectedRevision must be absent or a lowercase SHA-256')
  if (typeof request?.content !== 'string') throw new Error('content must be a UTF-8 string')
  if (Buffer.byteLength(request.content) > MAX_CONTENT_BYTES) throw new Error('content exceeds 1 MiB limit')
  return expected
}

export async function revisionOf(file) {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex')
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }
}

export async function regularOrAbsent(file) {
  try {
    const stat = await lstat(file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('target must be a regular file, not a link')
    return stat
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function assertPhysicalDirectory(directory, label) {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(label + ' must be an existing physical directory')
  const physical = await realpath(directory)
  if (!samePath(physical, directory)) throw new Error(label + ' must not resolve through a link or junction')
  return resolve(physical)
}

export async function ensurePhysicalSubdirectories(root, segments, label) {
  let current = await assertPhysicalDirectory(root, label)
  for (const segment of segments) {
    current = join(current, segment)
    try {
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(label + ' must contain only physical directories')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      try {
        await mkdir(current)
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError
      }
    }
    await assertPhysicalDirectory(current, label)
  }
  return current
}

async function syncFile(file) {
  const handle = await open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

async function replaceAuxiliaryFile(temporary, target) {
  try {
    await rename(temporary, target)
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error
    await unlink(target).catch((unlinkError) => { if (unlinkError?.code !== 'ENOENT') throw unlinkError })
    await rename(temporary, target)
  }
}

export function supportDirectory(root) {
  return join(tmpdir(), 'amem-backup', digest(resolve(root)).slice(0, 16))
}

function safeBase(relativePath) {
  const base = basename(relativePath).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[. ]+|[. ]+$/g, '') || 'memory'
  return base + '.' + digest(relativePath).slice(0, 16)
}

export function backupDescriptor(root, relativePath) {
  const directory = supportDirectory(root)
  const base = safeBase(relativePath)
  return { directory, file: join(directory, base + '.previous'), metadata: join(directory, base + '.json') }
}

export async function atomicWriteAuxiliary(file, content) {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, '.amem-meta-' + randomUUID() + '.tmp')
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await replaceAuxiliaryFile(temporary, file)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}

export async function readJsonIfPresent(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function removeIfPresent(file) {
  await unlink(file).catch((error) => { if (error?.code !== 'ENOENT') throw error })
}

export async function prepareAtomicMemoryWrite(options) {
  const expected = validateWriteRequest(options.request)
  const physicalRoot = await assertPhysicalDirectory(resolve(options.root), options.rootLabel)
  const parent = await ensurePhysicalSubdirectories(physicalRoot, options.parentSegments, options.parentLabel)
  const target = resolve(physicalRoot, options.relativePath)
  if (!samePath(target, options.expectedTarget)) throw new Error('path escaped memory root')
  const targetStat = await regularOrAbsent(target)
  const observed = await revisionOf(target)
  if (observed !== expected) throw new Error('revision conflict: expected ' + expected + ', observed ' + observed)
  const temporary = join(parent, '.amem-' + randomUUID() + '.tmp')
  let handle
  try {
    handle = await open(temporary, 'wx', targetStat?.mode ?? 0o600)
    await handle.writeFile(options.request.content, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    if (targetStat) await chmod(temporary, targetStat.mode)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  return {
    root: physicalRoot,
    rootLabel: options.rootLabel,
    parent,
    parentLabel: options.parentLabel,
    target,
    relativePath: options.relativePath,
    temporary,
    expected,
    observed,
    targetStat,
    content: options.request.content,
    newRevision: contentRevision(options.request.content),
    backup: undefined,
  }
}

export async function assertPreparedCurrent(prepared) {
  await assertPhysicalDirectory(prepared.root, prepared.rootLabel)
  await assertPhysicalDirectory(prepared.parent, prepared.parentLabel)
  const latest = await revisionOf(prepared.target)
  if (latest !== prepared.expected) throw new Error('revision conflict before atomic replace: expected ' + prepared.expected + ', observed ' + latest)
}

export async function backupPrepared(prepared) {
  if (!prepared.targetStat) return undefined
  await assertPreparedCurrent(prepared)
  const descriptor = backupDescriptor(prepared.root, prepared.relativePath)
  await mkdir(descriptor.directory, { recursive: true })
  const temporary = join(descriptor.directory, '.amem-backup-' + randomUUID() + '.tmp')
  try {
    await copyFile(prepared.target, temporary)
    await syncFile(temporary)
    await replaceAuxiliaryFile(temporary, descriptor.file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  const metadata = {
    version: 1,
    root: prepared.root,
    relativePath: prepared.relativePath,
    source: prepared.target,
    revision: prepared.expected,
    backedUpAt: new Date().toISOString(),
  }
  await atomicWriteAuxiliary(descriptor.metadata, Buffer.from(JSON.stringify(metadata, null, 2) + '\n', 'utf8'))
  prepared.backup = descriptor.file
  await assertPreparedCurrent(prepared)
  return descriptor.file
}

export async function commitPrepared(prepared, options = {}) {
  await assertPreparedCurrent(prepared)
  if (options.backup !== false) await backupPrepared(prepared)
  await assertPreparedCurrent(prepared)
  await rename(prepared.temporary, prepared.target)
  prepared.temporary = undefined
  const revision = await revisionOf(prepared.target)
  if (revision !== prepared.newRevision) throw new Error('atomic replace verification failed for ' + prepared.relativePath)
  return {
    path: prepared.relativePath,
    operation: prepared.expected === 'absent' ? 'create' : 'update',
    revision,
    bytes: Buffer.byteLength(prepared.content),
    lineCount: prepared.content.length === 0 ? 0 : prepared.content.split(/\n/).length,
    ...(prepared.backup ? { backup: prepared.backup } : {}),
  }
}

export async function discardPrepared(prepared) {
  if (prepared?.temporary) await unlink(prepared.temporary).catch(() => {})
  if (prepared) prepared.temporary = undefined
}

export function snapshotPrepared(prepared) {
  return {
    target: prepared.target,
    relativePath: prepared.relativePath,
    previousRevision: prepared.expected,
    newRevision: prepared.newRevision,
    backup: prepared.backup,
    mode: prepared.targetStat?.mode,
  }
}

export async function restoreSnapshot(snapshot) {
  const current = await revisionOf(snapshot.target)
  if (current === snapshot.previousRevision) return
  if (current !== snapshot.newRevision) throw new Error('cannot recover transaction: unexpected revision for ' + snapshot.relativePath + ': ' + current)
  if (snapshot.previousRevision === 'absent') {
    await unlink(snapshot.target)
  } else {
    if (!snapshot.backup) throw new Error('cannot recover transaction: missing previous-version backup for ' + snapshot.relativePath)
    const parent = dirname(snapshot.target)
    const temporary = join(parent, '.amem-restore-' + randomUUID() + '.tmp')
    try {
      await copyFile(snapshot.backup, temporary)
      await syncFile(temporary)
      if (snapshot.mode !== undefined) await chmod(temporary, snapshot.mode)
      await rename(temporary, snapshot.target)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
  const restored = await revisionOf(snapshot.target)
  if (restored !== snapshot.previousRevision) throw new Error('transaction recovery verification failed for ' + snapshot.relativePath)
}
