import assert from 'node:assert/strict'
import { apply } from './index.js'
function context() {
  const handlers = new Map(); let tool
  return {
    logger: { info() {}, warn() {}, debug() {} },
    tools: { register(value) { tool = value; return () => { tool = undefined } } },
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn) },
    state: () => ({ handlers, tool }),
  }
}
const both=context(); apply(both, {}); assert(both.state().handlers.has('agent/turn-stopping')); assert.equal(both.state().tool.name,'write_shared_memory')
const writerOnly=context(); apply(writerOnly,{checkpoint:{enabled:false}}); assert(!writerOnly.state().handlers.has('agent/turn-stopping')); assert.equal(writerOnly.state().tool.name,'write_shared_memory')
const checkOnly=context(); apply(checkOnly,{writer:{enabled:false}}); assert(checkOnly.state().handlers.has('agent/turn-stopping')); assert.equal(checkOnly.state().tool,undefined)
console.log(JSON.stringify({ok:true,both:true,checkpointOnly:true,writerOnly:true}))
