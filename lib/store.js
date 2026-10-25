/**
 * Durable plugin state: configuration, credentials, run history.
 *
 * The file lives under `$DSH_HOME` (default `~/.dsh`). Writes are coalesced and
 * atomic (write-temp + rename), so a crash mid-write cannot leave a truncated
 * JSON file behind. Credentials never leave this process: the HTTP surface only
 * reports whether they exist.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig, normalizeConfig } from './config.js'

const STATE_VERSION = 1
const LOG_LIMIT = 200
const WRITE_DELAY_MS = 250

/** Resolve the DSH home directory the same way the host does. */
export function resolveHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return path.join(os.homedir(), '.dsh')
}

function emptyState() {
  return {
    version: STATE_VERSION,
    config: defaultConfig(),
    auth: null,
    runtime: {
      planDate: null,
      plannedAt: null,
      nextRunAt: null,
      lastRunDate: null,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      roles: null,
      log: [],
    },
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Coerce a loaded document into the current state shape. */
function migrate(raw, entryConfig) {
  const state = emptyState()
  if (isObject(raw)) {
    state.config = normalizeConfig({ ...(isObject(raw.config) ? raw.config : {}) })
    if (isObject(raw.auth)) {
      const cookies = isObject(raw.auth.cookies) ? raw.auth.cookies : {}
      const clean = {}
      for (const [name, value] of Object.entries(cookies)) {
        if (typeof value === 'string' && value !== '') clean[name] = value
      }
      state.auth = {
        cookies: clean,
        mid: typeof raw.auth.mid === 'string' ? raw.auth.mid : null,
        aid: typeof raw.auth.aid === 'string' ? raw.auth.aid : null,
        stuid: typeof raw.auth.stuid === 'string' ? raw.auth.stuid : null,
        accountName: typeof raw.auth.accountName === 'string' ? raw.auth.accountName : null,
        avatar: typeof raw.auth.avatar === 'string' ? raw.auth.avatar : null,
        loginAt: typeof raw.auth.loginAt === 'number' ? raw.auth.loginAt : null,
        lastRefreshAt: typeof raw.auth.lastRefreshAt === 'number' ? raw.auth.lastRefreshAt : null,
      }
    }
    if (isObject(raw.runtime)) {
      const runtime = state.runtime
      for (const key of ['planDate', 'plannedAt', 'nextRunAt', 'lastRunDate', 'lastRunAt', 'lastError', 'deviceId']) {
        if (raw.runtime[key] !== undefined) runtime[key] = raw.runtime[key]
      }
      if (isObject(raw.runtime.lastResult)) runtime.lastResult = raw.runtime.lastResult
      if (isObject(raw.runtime.roles)) runtime.roles = raw.runtime.roles
      if (Array.isArray(raw.runtime.log)) runtime.log = raw.runtime.log.slice(-LOG_LIMIT)
    }
  }
  // The cordis entry's config is a base layer; saved user values win.
  state.config = normalizeConfig({ ...entryConfig, ...state.config })
  return state
}

export class StateStore {
  /**
   * @param {object} options
   * @param {string} options.directory - directory holding `state.json`
   * @param {object} [options.entryConfig] - config from the cordis entry
   * @param {(message: string) => void} [options.onWriteError] - persistence error sink
   */
  constructor({ directory, entryConfig = {}, onWriteError }) {
    this.directory = directory
    this.file = path.join(directory, 'state.json')
    this.entryConfig = entryConfig
    this.onWriteError = onWriteError
    this.timer = null
    this.closed = false
    this.state = emptyState()
  }

  /** Read (or create) the state document. Never throws. */
  load() {
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    } catch {
      /* a read-only home still allows in-memory operation */
    }
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      this.state = migrate(JSON.parse(text), this.entryConfig)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.onWriteError?.(`状态文件读取失败，已使用默认配置：${String(error?.message ?? error)}`)
      this.state = migrate(null, this.entryConfig)
    }
    return this.state
  }

  /** Current in-memory document. */
  get() {
    return this.state
  }

  /** Replace the configuration section (already normalized) and persist. */
  setConfig(config) {
    this.state.config = config
    this.save()
  }

  setAuth(auth) {
    this.state.auth = auth
    this.save()
  }

  /** Merge fields into the runtime section and persist. */
  patchRuntime(patch) {
    this.state.runtime = { ...this.state.runtime, ...patch }
    this.save()
  }

  /** Append one log entry, keeping the ring bounded. */
  log(level, message, extra = undefined) {
    const entry = { at: Date.now(), level, message: String(message) }
    if (extra !== undefined && extra !== null) entry.detail = extra
    const log = this.state.runtime.log ?? []
    log.push(entry)
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
    this.state.runtime.log = log
    this.save()
  }

  /** Persist soon; repeated calls collapse into one write. */
  save() {
    if (this.closed) return
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, WRITE_DELAY_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Write the document atomically right now. */
  flush() {
    if (this.closed) return
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      this.onWriteError?.(`状态文件写入失败：${String(error?.message ?? error)}`)
    }
  }

  /** Flush pending writes and stop accepting new ones. */
  close() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
    this.closed = true
  }
}
