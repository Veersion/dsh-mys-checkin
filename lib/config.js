/**
 * Plugin configuration: defaults, validation, and normalization.
 *
 * The configuration reaches the host from two places — the cordis entry's
 * `config` and the user's saved section — so every field is normalized here
 * and never trusted as-is.
 */
import { parseClock, resolveTimeZone } from './tz.js'

/** Every game the luna check-in endpoints cover, in display order. */
export const GAMES = [
  {
    id: 'genshin',
    label: '原神',
    biz: 'hk4e_cn',
    actId: 'e202311201442471',
    signgame: 'hk4e',
    sendSigngame: true,
    host: 'https://api-takumi.mihoyo.com',
  },
  {
    id: 'starrail',
    label: '崩坏：星穹铁道',
    biz: 'hkrpg_cn',
    actId: 'e202304121516551',
    signgame: 'hkrpg',
    sendSigngame: true,
    host: 'https://api-takumi.mihoyo.com',
  },
  {
    id: 'zzz',
    label: '绝区零',
    biz: 'nap_cn',
    actId: 'e202406242138391',
    signgame: 'zzz',
    sendSigngame: true,
    host: 'https://act-nap-api.mihoyo.com',
  },
  {
    id: 'honkai3',
    label: '崩坏3',
    biz: 'bh3_cn',
    actId: 'e202306201626331',
    signgame: 'bh3',
    sendSigngame: false,
    host: 'https://api-takumi.mihoyo.com',
  },
  {
    id: 'tears',
    label: '未定事件簿',
    biz: 'nxx_cn',
    actId: 'e202202251749321',
    signgame: 'nxx',
    sendSigngame: false,
    host: 'https://api-takumi.mihoyo.com',
  },
  {
    id: 'bh2',
    label: '崩坏学园2',
    biz: 'bh2_cn',
    actId: 'e202203291431091',
    signgame: 'bh2',
    sendSigngame: false,
    host: 'https://api-takumi.mihoyo.com',
  },
]

export const GAME_INDEX = new Map(GAMES.map((game) => [game.id, game]))

/** Defaults chosen to be conservative: one window, one run per day. */
export function defaultConfig() {
  return {
    enabled: true,
    windows: [{ start: '18:00', end: '18:30' }],
    timezone: '',
    runWhenMissed: true,
    games: {
      genshin: true,
      starrail: true,
      zzz: true,
      honkai3: true,
      tears: false,
      bh2: false,
    },
    gapMs: { min: 2000, max: 8000 },
    retry: { attempts: 1, delayMs: 60000 },
    device: { name: 'Xiaomi MI 6', model: 'Mi 6', sysVersion: '12', channel: 'miyousheluodi' },
    client: { appVersion: '2.109.0', salt: 'd9200c846b10886e8c874fc33c8f308b' },
    maxQrAgeMs: 180000,
  }
}

function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function pickString(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > maxLength) return fallback
  return trimmed
}

function normalizeWindow(raw) {
  if (raw === null || typeof raw !== 'object') return null
  let start = parseClock(raw.start)
  let end = parseClock(raw.end)
  if (start === null || end === null) return null
  // Leave room for a one-minute window at the very end of the day.
  if (start > 1438) start = 1438
  // An end at or before the start is what the user typed mid-edit; snap it to a
  // one-minute window instead of dropping the window.
  if (end <= start) end = Math.min(1439, start + 1)
  if (end - start > 240) end = start + 240
  const pad = (value) => String(value).padStart(2, '0')
  return { start: `${pad(Math.floor(start / 60))}:${pad(start % 60)}`, end: `${pad(Math.floor(end / 60))}:${pad(end % 60)}` }
}

function normalizeWindows(raw) {
  const list = Array.isArray(raw) ? raw : []
  const windows = []
  for (const item of list) {
    const window = normalizeWindow(item)
    if (window === null) continue
    // Duplicate times are allowed: the scheduler fires once per day and picks
    // the first window that has not ended.
    windows.push(window)
    if (windows.length >= 4) break
  }
  if (windows.length === 0) return defaultConfig().windows
  return windows.sort((left, right) => left.start.localeCompare(right.start))
}

function normalizeGames(raw) {
  const games = {}
  for (const game of GAMES) {
    const value = raw !== null && typeof raw === 'object' ? raw[game.id] : undefined
    games[game.id] = typeof value === 'boolean' ? value : defaultConfig().games[game.id]
  }
  return games
}

/** Merge one untrusted configuration object over the defaults. */
export function normalizeConfig(raw) {
  const base = defaultConfig()
  const input = raw !== null && typeof raw === 'object' ? raw : {}

  const gapMin = clampInt(input?.gapMs?.min, base.gapMs.min, 500, 60000)
  const gapMax = clampInt(input?.gapMs?.max, base.gapMs.max, gapMin, 120000)

  const attempts = clampInt(input?.retry?.attempts, base.retry.attempts, 1, 3)
  const delayMs = clampInt(input?.retry?.delayMs, base.retry.delayMs, 10000, 900000)

  const maxQrAgeMs = clampInt(input?.maxQrAgeMs, base.maxQrAgeMs, 60000, 300000)

  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    windows: normalizeWindows(input.windows),
    timezone: resolveTimeZone(pickString(input.timezone, '', 64) || undefined),
    runWhenMissed: typeof input.runWhenMissed === 'boolean' ? input.runWhenMissed : base.runWhenMissed,
    games: normalizeGames(input.games),
    gapMs: { min: gapMin, max: gapMax },
    retry: { attempts, delayMs },
    device: {
      name: pickString(input?.device?.name, base.device.name, 64),
      model: pickString(input?.device?.model, base.device.model, 64),
      sysVersion: pickString(input?.device?.sysVersion, base.device.sysVersion, 16),
      channel: pickString(input?.device?.channel, base.device.channel, 32),
    },
    client: {
      appVersion: pickString(input?.client?.appVersion, base.client.appVersion, 24),
      salt: pickString(input?.client?.salt, base.client.salt, 64),
    },
    maxQrAgeMs,
  }
}

/** Which game ids the current configuration asks to sign. */
export function enabledGames(config) {
  return GAMES.filter((game) => config.games[game.id] === true)
}
