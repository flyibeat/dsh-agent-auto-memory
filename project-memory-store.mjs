import { basename, join, resolve } from 'node:path'
import { commitPrepared, discardPrepared, prepareAtomicMemoryWrite, revisionOf } from './atomic-memory-store.mjs'

const TOPIC = /^\.agents[\/]topics[\/][^\/]+\.md$/u
const INVALID_WINDOWS_NAME = /[\u0000-\u001f<>:"|?*]/u
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

export function validateProjectPath(relativePath) {
  if (relativePath === 'AGENTS.md') return relativePath
  if (!TOPIC.test(relativePath) || relativePath.includes('..')) throw new Error('path must be AGENTS.md or .agents/topics/<single-name>.md')
  const normalized = relativePath.replaceAll('\\', '/')
  const name = basename(normalized)
  if (name === '.md' || INVALID_WINDOWS_NAME.test(name) || RESERVED_WINDOWS_NAME.test(name) || /[. ]$/u.test(name)) {
    throw new Error('topic filename is not portable or safe on Windows')
  }
  return normalized
}

export async function writeProjectMemory(root, request) {
  const relativePath = validateProjectPath(request.path)
  const physicalRoot = resolve(root)
  const parentSegments = relativePath === 'AGENTS.md' ? [] : ['.agents', 'topics']
  const expectedTarget = relativePath === 'AGENTS.md'
    ? join(physicalRoot, 'AGENTS.md')
    : join(physicalRoot, '.agents', 'topics', basename(relativePath))
  const prepared = await prepareAtomicMemoryWrite({
    root: physicalRoot,
    rootLabel: 'project root',
    parentSegments,
    parentLabel: relativePath === 'AGENTS.md' ? 'project root' : 'topics directory',
    relativePath,
    expectedTarget,
    request,
  })
  try {
    const result = await commitPrepared(prepared)
    return { ...result, root: physicalRoot }
  } finally {
    await discardPrepared(prepared)
  }
}

export { revisionOf }
