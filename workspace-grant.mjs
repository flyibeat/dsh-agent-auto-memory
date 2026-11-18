/**
 * agent-auto-memory-workspace-grant — grant one live Session its owning project root.
 * The grant is file-tool only on Windows, never inherited by subprocesses or other Sessions.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findProjectRoot } from './project-memory-tool.mjs'

export const name = 'agent-auto-memory-workspace-grant'
export const inject = ['sandboxPolicy']

const DEFAULT_MARKERS = ['.agents', 'AGENTS.md']
const DEFAULT_MAX_LEVELS = 3

function pathKey(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(a, b) {
  return pathKey(a) === pathKey(b)
}

function isInside(candidate, root) {
  const here = pathKey(candidate)
  const base = pathKey(root)
  return here === base || here.startsWith(base + path.sep)
}

function isBroadRoot(value) {
  const resolved = path.resolve(value)
  return samePath(resolved, path.parse(resolved).root) || samePath(resolved, os.homedir())
}

function safeDirectory(value) {
  try {
    const stat = fs.lstatSync(value)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function auditLine(line) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const dirPath = path.join(home, 'logs')
    fs.mkdirSync(dirPath, { recursive: true })
    fs.appendFileSync(path.join(dirPath, 'agent-auto-memory-workspace-grant.log'), new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    /* Audit must never affect a Session. */
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const markers = Array.isArray(config.markers) && config.markers.length > 0 ? config.markers : DEFAULT_MARKERS
  const maxLevels = Number.isInteger(config.maxLevels) && config.maxLevels >= 0 ? config.maxLevels : DEFAULT_MAX_LEVELS
  const fixedRoot = typeof config.projectRoot === 'string' && config.projectRoot.trim() ? path.resolve(config.projectRoot.trim()) : undefined
  const allowRoots = Array.isArray(config.projectRoots)
    ? config.projectRoots.filter((item) => typeof item === 'string' && item.trim()).map((item) => path.resolve(item.trim()))
    : []
  const extraRoots = Array.isArray(config.extraRoots)
    ? config.extraRoots.filter((item) => typeof item === 'string' && item.trim()).map((item) => path.resolve(item.trim()))
    : []
  const allowBroadRoots = config.allowBroadRoots === true
  const audit = config.audit !== false
  const granted = new WeakMap()

  const note = (line) => {
    if (audit) auditLine(line)
    try { ctx.logger?.debug?.('[' + name + '] ' + line) } catch {}
  }

  note('loaded; markers=' + JSON.stringify(markers) + ' maxLevels=' + maxLevels +
    ' projectRoot=' + JSON.stringify(fixedRoot) + ' projectRoots=' + JSON.stringify(allowRoots) +
    ' extraRoots=' + JSON.stringify(extraRoots) + ' allowBroadRoots=' + allowBroadRoots)

  const accepted = (target, reason) => {
    if (!allowBroadRoots && isBroadRoot(target)) {
      note('skip broad root ' + target + ' (' + reason + ')')
      return false
    }
    if (!safeDirectory(target)) {
      note('skip unsafe or missing directory ' + target + ' (' + reason + ')')
      return false
    }
    return true
  }

  const grant = (session) => {
    try {
      if (!session || granted.has(session)) return
      const rawCwd = session?.header?.cwd
      if (typeof rawCwd !== 'string' || rawCwd.trim() === '') return
      const cwd = path.resolve(rawCwd.trim())
      const candidates = []

      if (fixedRoot !== undefined) {
        if (isInside(cwd, fixedRoot) && !samePath(cwd, fixedRoot)) candidates.push([fixedRoot, 'projectRoot'])
      } else {
        const located = findProjectRoot(cwd, markers, maxLevels)
        const root = located.root
        if (root !== undefined && !samePath(root, cwd)) {
          if (allowRoots.length === 0 || allowRoots.some((allowed) => samePath(allowed, root))) {
            candidates.push([root, 'marker'])
          } else {
            note('skip discovered root outside projectRoots: ' + root)
          }
        }
      }

      for (const extra of extraRoots) {
        if (isInside(cwd, extra) && !samePath(cwd, extra)) candidates.push([extra, 'extraRoot'])
      }

      const unique = new Map()
      for (const [target, reason] of candidates) {
        const resolved = path.resolve(target)
        if (!unique.has(pathKey(resolved)) && accepted(resolved, reason)) unique.set(pathKey(resolved), resolved)
      }
      if (unique.size === 0) return

      const disposers = []
      for (const target of unique.values()) {
        try {
          const dispose = ctx.sandboxPolicy.registerWritableRoot(session, target)
          if (typeof dispose === 'function') disposers.push(dispose)
          note('granted ' + target + ' for session ' + (session.id ?? '?'))
        } catch (error) {
          note('skip ' + target + ': ' + (error && error.message))
        }
      }
      if (disposers.length > 0) {
        let active = true
        granted.set(session, () => {
          if (!active) return
          active = false
          for (const dispose of disposers) { try { dispose() } catch {} }
          note('revoked roots for session ' + (session.id ?? '?'))
        })
      }
    } catch (error) {
      note('failed: ' + (error && error.message))
    }
  }

  const revoke = (session) => {
    try {
      const dispose = session && granted.get(session)
      if (dispose) dispose()
      if (session) granted.delete(session)
    } catch {
      /* Session teardown must remain contained. */
    }
  }

  ctx.on('session/created', (session) => { grant(session) })
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') grant(session)
  })
  ctx.on('session/disposed', (session) => { revoke(session) })
}
