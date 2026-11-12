import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeProjectMemory, revisionOf, validateProjectPath } from './project-memory-store.mjs'

export const inject = ['tools']
let queue = Promise.resolve()

const DEFAULT_MARKERS = ['.agents', 'AGENTS.md']
const DEFAULT_MAX_LEVELS = 3

function kindOf(path) {
  try {
    const stat = statSync(path)
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined
  } catch {
    return undefined
  }
}

/** Session workspace from the tool execution, never the host process cwd. */
export function sessionCwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() ? resolve(cwd.trim()) : undefined
}

/**
 * Walk upward from a workspace directory to the nearest ancestor carrying a project marker.
 * Never walks past maxLevels parents; returns every inspected directory for diagnostics.
 */
export function findProjectRoot(cwd, markers = DEFAULT_MARKERS, maxLevels = DEFAULT_MAX_LEVELS) {
  const inspected = []
  let current = resolve(cwd)
  for (let level = 0; level <= maxLevels; level++) {
    inspected.push(current)
    for (const marker of markers) {
      if (kindOf(join(current, marker)) !== undefined) return { root: current, inspected }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { root: undefined, inspected }
}

export function applyProjectMemoryTool(ctx, config = {}) {
  if (config.enabled === false) return
  const markers = Array.isArray(config.markers) && config.markers.length > 0 ? config.markers : DEFAULT_MARKERS
  const maxLevels = Number.isInteger(config.maxLevels) && config.maxLevels >= 0 ? config.maxLevels : DEFAULT_MAX_LEVELS
  const allowList = Array.isArray(config.projectRoots) && config.projectRoots.length > 0
    ? config.projectRoots.map((item) => resolve(item))
    : []
  const fixedRoot = typeof config.projectRoot === 'string' && config.projectRoot.trim() ? resolve(config.projectRoot.trim()) : undefined

  ctx.tools.register({
    name: config.toolName || 'write_project_memory',
    description: 'Create or atomically replace one memory file inside the project that owns the current workspace. Allowed paths are AGENTS.md and .agents/topics/<single-name>.md, resolved against the nearest ancestor directory carrying .agents or AGENTS.md (a few levels up at most). Read the file first, then pass its SHA-256 revision, or pass the literal string "absent" to create it. It cannot delete files, escape the project root, follow links, or create nested directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'AGENTS.md or .agents/topics/<single-name>.md relative to the resolved project root.' },
        content: { type: 'string', description: 'Complete UTF-8 content, at most 1 MiB.' },
        expectedRevision: { type: 'string', description: 'Required. The observed lowercase SHA-256 to replace an existing file, or the literal string "absent" to create a new file. Omission, empty string, and null are all rejected.' },
      },
      required: ['path', 'content', 'expectedRevision'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          operation: { type: 'string' },
          revision: { type: 'string' },
          root: { type: 'string' },
          bytes: { type: 'integer' },
          lineCount: { type: 'integer' },
          backup: { type: 'string' },
        },
        required: ['path', 'operation', 'revision', 'root', 'bytes', 'lineCount'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const run = () => {
        validateProjectPath(args?.path)
        let root = fixedRoot
        let inspected = []
        if (root === undefined) {
          const cwd = sessionCwdOf(exec)
          if (cwd === undefined) throw new Error('project root not found: this execution carries no session workspace; set projectRoot in the project-writer config')
          const located = findProjectRoot(cwd, markers, maxLevels)
          root = located.root
          inspected = located.inspected
        }
        if (root === undefined) {
          throw new Error('project root not found: inspected ' + JSON.stringify(inspected) + ' for markers ' + JSON.stringify(markers) + ' within ' + maxLevels + ' level(s) of the session workspace; set projectRoot in the project-writer config')
        }
        if (allowList.length > 0 && !allowList.some((allowed) => resolve(allowed) === resolve(root))) {
          throw new Error('project root ' + root + ' is not in the configured projectRoots allow-list')
        }
        return writeProjectMemory(root, args)
      }
      const current = queue.then(run, run)
      queue = current.then(() => undefined, () => undefined)
      return current
    },
    isConcurrencySafe: () => false,
  })
}

export { revisionOf }
