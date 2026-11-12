import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { writeSharedMemory } from './memory-store.mjs'

export const inject = ['tools']
let queue = Promise.resolve()

function agentsHome() {
  const configured = process.env.DSH_AGENTS_HOME
  return resolve(configured && configured.trim() ? configured.trim() : resolve(homedir(), '.agents'))
}

export function applyMemoryTool(ctx, config = {}) {
  if (config.enabled === false) return
  ctx.tools.register({
    name: config.toolName || 'write_shared_memory',
    description: 'Create or atomically replace one file in the shared agent memory root only. Read it first, then pass its SHA-256 revision, or pass the literal string "absent" to create a new file (omitting the parameter is rejected). Allowed paths are AGENTS.md and topics/<single-name>.md. This tool cannot delete files or write configuration, skills, sessions, credentials, nested directories, or symbolic links.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'AGENTS.md or topics/<single-name>.md relative to the shared memory root.' },
        content: { type: 'string', description: 'Complete UTF-8 content, at most 1 MiB.' },
        expectedRevision: { type: 'string', description: 'Required. The observed lowercase SHA-256 to replace an existing file, or the literal string "absent" to create a new file. Omission, empty string, and null are all rejected.' },
      },
      required: ['path', 'content', 'expectedRevision'], additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' }, operation: { type: 'string' }, revision: { type: 'string' },
          bytes: { type: 'integer' }, lineCount: { type: 'integer' }, backup: { type: 'string' },
        },
        required: ['path', 'operation', 'revision', 'bytes', 'lineCount'], additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const run = () => writeSharedMemory(agentsHome(), args)
      const current = queue.then(run, run)
      queue = current.then(() => undefined, () => undefined)
      return current
    },
    isConcurrencySafe: () => false,
  })
}
