import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MysService } from './lib/service.js'

/** Stable cordis plugin name. */
export const name = 'mys-checkin'

/** The HTTP surface lives on the Connection service; timing on the timer service. */
export const inject = ['connection', 'timer']

function bootLog(message) {
  try {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
    const directory = path.join(home, 'mys-checkin')
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, 'boot.log')
    // Keep the diagnostic file bounded; it exists because the host has no other
    // place this plugin can report a mount failure the user can read.
    try {
      if (fs.statSync(file).size > 32 * 1024) fs.writeFileSync(file, '', 'utf8')
    } catch {
      /* first write */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* diagnostics must never break mounting */
  }
}

/**
 * Mount the host half: routes, state store, and the daily timer.
 *
 * @param {object} ctx - cordis host context.
 * @param {object} [config] - config from the cordis entry (lowest precedence).
 */
export function apply(ctx, config = {}) {
  bootLog('apply: enter')
  let service
  try {
    service = new MysService(ctx, config ?? {})
  } catch (error) {
    bootLog(`apply: MysService failed: ${String(error?.stack ?? error)}`)
    throw error
  }
  bootLog('apply: service constructed')
  try {
    ctx.effect(() => () => service.dispose(), 'mys-checkin: host service')
  } catch (error) {
    bootLog(`apply: effect registration failed: ${String(error?.stack ?? error)}`)
    throw error
  }
  bootLog('apply: done')
}
