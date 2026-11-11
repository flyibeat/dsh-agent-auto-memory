import { applyMemoryTool } from './memory-tool.mjs'
export const name = 'agent-auto-memory-writer'
export const inject = ['tools']
export function apply(ctx, config = {}) { return applyMemoryTool(ctx, config) }
