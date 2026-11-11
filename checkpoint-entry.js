import { applyCheckpoint } from './checkpoint.mjs'
export const name = 'agent-auto-memory-checkpoint'
export function apply(ctx, config = {}) { return applyCheckpoint(ctx, config) }
