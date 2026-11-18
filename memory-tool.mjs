import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { writeSharedMemory, writeSharedMemoryPair } from './memory-store.mjs'

export const inject = ['tools']
let queue = Promise.resolve()

function agentsHome() {
  const configured = process.env.DSH_AGENTS_HOME
  return resolve(configured && configured.trim() ? configured.trim() : resolve(homedir(), '.agents'))
}

function queued(run) {
  const current = queue.then(run, run)
  queue = current.then(() => undefined, () => undefined)
  return current
}

const writeParameters = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
    expectedRevision: { type: 'string' },
  },
  required: ['path', 'content', 'expectedRevision'],
  additionalProperties: false,
}

const writeResult = {
  type: 'object',
  properties: {
    path: { type: 'string' }, operation: { type: 'string' }, revision: { type: 'string' },
    bytes: { type: 'integer' }, lineCount: { type: 'integer' }, backup: { type: 'string' },
  },
  required: ['path', 'operation', 'revision', 'bytes', 'lineCount'],
  additionalProperties: false,
}

export function applyMemoryTool(ctx, config = {}) {
  if (config.enabled === false) return
  const disposers = []
  disposers.push(ctx.tools.register({
    name: config.toolName || 'write_shared_memory',
    description: 'Create or atomically replace one file in the shared agent memory root. Read it first and pass its SHA-256 revision, or pass the literal string absent to create it. Allowed paths are AGENTS.md and topics/<single-name>.md. Updating an existing target retains exactly its immediately previous version with source metadata.',
    parameters: {
      ...writeParameters,
      properties: {
        path: { type: 'string', description: 'AGENTS.md or topics/<single-name>.md relative to the shared memory root.' },
        content: { type: 'string', description: 'Complete UTF-8 content, at most 1 MiB.' },
        expectedRevision: { type: 'string', description: 'Required observed lowercase SHA-256, or the literal string absent for create-only.' },
      },
    },
    output: {
      schema: writeResult,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) { return queued(() => writeSharedMemory(agentsHome(), args)) },
    isConcurrencySafe: () => false,
  }))

  disposers.push(ctx.tools.register({
    name: config.batchToolName || 'write_shared_memory_pair',
    description: 'Atomically coordinate one shared topic write with its AGENTS.md index write. Both complete contents and both observed revisions are required. The tool stages and validates both files before commit, keeps a recovery journal, and rolls back a partial pair.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          ...writeParameters,
          description: 'One topics/<single-name>.md create or update.',
          properties: {
            path: { type: 'string', description: 'topics/<single-name>.md only.' },
            content: { type: 'string', description: 'Complete topic UTF-8 content, at most 1 MiB.' },
            expectedRevision: { type: 'string', description: 'Observed topic revision, or absent for create-only.' },
          },
        },
        index: {
          ...writeParameters,
          description: 'The matching AGENTS.md topic-index update.',
          properties: {
            path: { type: 'string', description: 'Must be AGENTS.md.' },
            content: { type: 'string', description: 'Complete shared-root AGENTS.md UTF-8 content, at most 1 MiB.' },
            expectedRevision: { type: 'string', description: 'Observed AGENTS.md revision.' },
          },
        },
      },
      required: ['topic', 'index'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { operation: { type: 'string' }, topic: writeResult, index: writeResult },
        required: ['operation', 'topic', 'index'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) { return queued(() => writeSharedMemoryPair(agentsHome(), args)) },
    isConcurrencySafe: () => false,
  }))

  return () => { for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} } }
}
