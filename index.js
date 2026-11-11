import { applyCheckpoint } from './checkpoint.mjs'
import { applyMemoryTool } from './memory-tool.mjs'
export const name = 'agent-auto-memory'
export const inject = ['tools']
export function apply(ctx, config = {}) {
  applyCheckpoint(ctx, config.checkpoint || {})
  applyMemoryTool(ctx, config.writer || {})
}
