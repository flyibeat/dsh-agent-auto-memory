import { basename, join, resolve } from 'node:path'
import {
  atomicWriteAuxiliary, backupPrepared, commitPrepared, discardPrepared,
  prepareAtomicMemoryWrite, readJsonIfPresent, removeIfPresent, restoreSnapshot,
  revisionOf, snapshotPrepared, supportDirectory,
} from './atomic-memory-store.mjs'

const TOPIC = /^topics[\/][^\/]+\.md$/u
const INVALID_WINDOWS_NAME = /[\u0000-\u001f<>:"|?*]/u
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

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

function optionsFor(root, relativePath, request) {
  const physicalRoot = resolve(root)
  const parentSegments = relativePath === 'AGENTS.md' ? [] : ['topics']
  const expectedTarget = relativePath === 'AGENTS.md'
    ? join(physicalRoot, 'AGENTS.md')
    : join(physicalRoot, 'topics', basename(relativePath))
  return {
    root: physicalRoot,
    rootLabel: 'shared memory root',
    parentSegments,
    parentLabel: relativePath === 'AGENTS.md' ? 'shared memory root' : 'topics directory',
    relativePath,
    expectedTarget,
    request,
  }
}

function journalPath(root) {
  return join(supportDirectory(root), 'shared-pair-transaction.json')
}

async function writeJournal(root, journal) {
  await atomicWriteAuxiliary(journalPath(root), Buffer.from(JSON.stringify(journal, null, 2) + '\n', 'utf8'))
}

export async function recoverSharedMemoryPair(root) {
  const file = journalPath(root)
  const journal = await readJsonIfPresent(file)
  if (!journal) return false
  if (journal.version !== 1 || resolve(journal.root) !== resolve(root) || !journal.topic || !journal.index) {
    throw new Error('invalid shared-memory transaction journal: ' + file)
  }
  const topicCurrent = await revisionOf(journal.topic.target)
  const indexCurrent = await revisionOf(journal.index.target)
  const topicNew = topicCurrent === journal.topic.newRevision
  const indexNew = indexCurrent === journal.index.newRevision
  const topicOld = topicCurrent === journal.topic.previousRevision
  const indexOld = indexCurrent === journal.index.previousRevision
  if (topicNew && indexOld) await restoreSnapshot(journal.topic)
  else if (topicOld && indexNew) await restoreSnapshot(journal.index)
  else if (!(topicOld && indexOld) && !(topicNew && indexNew)) {
    throw new Error('cannot recover shared-memory transaction with unexpected revisions')
  }
  await removeIfPresent(file)
  return true
}

export async function writeSharedMemory(root, request) {
  await recoverSharedMemoryPair(resolve(root))
  const relativePath = validateMemoryPath(request.path)
  const prepared = await prepareAtomicMemoryWrite(optionsFor(root, relativePath, request))
  try { return await commitPrepared(prepared) } finally { await discardPrepared(prepared) }
}

export async function writeSharedMemoryPair(root, request) {
  const physicalRoot = resolve(root)
  await recoverSharedMemoryPair(physicalRoot)
  if (!request || typeof request !== 'object') throw new Error('request must contain topic and index writes')
  const topicPath = validateMemoryPath(request.topic?.path)
  if (topicPath === 'AGENTS.md') throw new Error('topic.path must be topics/<single-name>.md')
  if (request.index?.path !== 'AGENTS.md') throw new Error('index.path must be AGENTS.md')
  const topic = await prepareAtomicMemoryWrite(optionsFor(physicalRoot, topicPath, request.topic))
  let index
  try {
    index = await prepareAtomicMemoryWrite(optionsFor(physicalRoot, 'AGENTS.md', request.index))
    await backupPrepared(topic)
    await backupPrepared(index)
    const journal = {
      version: 1,
      root: physicalRoot,
      phase: 'prepared',
      topic: snapshotPrepared(topic),
      index: snapshotPrepared(index),
      createdAt: new Date().toISOString(),
    }
    await writeJournal(physicalRoot, journal)
    const topicResult = await commitPrepared(topic, { backup: false })
    journal.phase = 'topic-committed'
    await writeJournal(physicalRoot, journal)
    try {
      const indexResult = await commitPrepared(index, { backup: false })
      journal.phase = 'index-committed'
      await writeJournal(physicalRoot, journal)
      await removeIfPresent(journalPath(physicalRoot))
      return { operation: 'pair-update', topic: topicResult, index: indexResult }
    } catch (error) {
      await restoreSnapshot(journal.topic)
      await removeIfPresent(journalPath(physicalRoot))
      throw error
    }
  } finally {
    await discardPrepared(topic)
    if (index) await discardPrepared(index)
  }
}

export { revisionOf }
