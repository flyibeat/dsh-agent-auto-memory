import assert from 'node:assert/strict'
import { apply } from './index.js'

function context() {
  const handlers = new Map()
  const tools = new Map()
  return {
    logger: { info() {}, warn() {}, debug() {} },
    tools: {
      register(value) {
        tools.set(value.name, value)
        return () => { tools.delete(value.name) }
      },
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
    },
    state: () => ({ handlers, tools }),
  }
}

const both = context()
apply(both, {})
assert(both.state().handlers.has('agent/turn-stopping'))
assert(both.state().tools.has('write_shared_memory'))
assert(both.state().tools.has('write_shared_memory_pair'))

const writerOnly = context()
apply(writerOnly, { checkpoint: { enabled: false } })
assert(!writerOnly.state().handlers.has('agent/turn-stopping'))
assert(writerOnly.state().tools.has('write_shared_memory'))
assert(writerOnly.state().tools.has('write_shared_memory_pair'))

const checkOnly = context()
apply(checkOnly, { writer: { enabled: false } })
assert(checkOnly.state().handlers.has('agent/turn-stopping'))
assert.equal(checkOnly.state().tools.size, 0)

console.log(JSON.stringify({ ok: true, both: true, checkpointOnly: true, writerOnly: true, tools: [...both.state().tools.keys()] }))
