import { applyProjectMemoryTool } from './project-memory-tool.mjs'
export const name = 'agent-auto-memory-project-writer'
export const inject = ['tools']
export function apply(ctx, config = {}) { return applyProjectMemoryTool(ctx, config) }
