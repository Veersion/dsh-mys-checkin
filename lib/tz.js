/**
 * Time-zone aware helpers for the daily schedule.
 *
 * The schedule is expressed in the user's local wall clock ("18:00"–"18:30"),
 * but the host runs in whatever zone the operating system reports. Everything
 * here converts between wall-clock minutes and absolute instants, so DST and
 * travel cannot silently shift a window by an hour.
 */

const FORMATTERS = new Map()

function formatter(timeZone) {
  let value = FORMATTERS.get(timeZone)
  if (value === undefined) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    FORMATTERS.set(timeZone, value)
  }
  return value
}

/** Resolve a usable IANA zone name, falling back to the host zone. */
export function resolveTimeZone(candidate) {
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    try {
      formatter(candidate.trim())
      return candidate.trim()
    } catch {
      /* fall through to the host zone */
    }
  }
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone !== '') {
      formatter(zone)
      return zone
    }
  } catch {
    /* fall through */
  }
  return 'Asia/Shanghai'
}

/** Wall-clock fields of one instant in the given zone. */
export function zonedParts(date, timeZone) {
  const parts = formatter(timeZone).formatToParts(date)
  const field = (type) => {
    const found = parts.find((part) => part.type === type)
    return found === undefined ? 0 : Number(found.value)
  }
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  }
}

/** Offset of the zone at one instant, in milliseconds east of UTC. */
function offsetAt(date, timeZone) {
  const parts = zonedParts(date, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  // Drop sub-second noise so the offset lands on a whole second.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * Convert wall-clock fields in `timeZone` to the instant they name.
 * Two passes let the result settle across a DST boundary.
 */
export function zonedToInstant(fields, timeZone) {
  const { year, month, day, hour, minute, second = 0 } = fields
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  let offset = offsetAt(new Date(guess), timeZone)
  let instant = guess - offset
  offset = offsetAt(new Date(instant), timeZone)
  instant = guess - offset
  return new Date(instant)
}

/** Calendar day key (`YYYY-MM-DD`) of an instant in the given zone. */
export function dayKey(date, timeZone) {
  const parts = zonedParts(date, timeZone)
  const pad = (value) => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

/** Minutes since local midnight for an instant. */
export function minuteOfDay(date, timeZone) {
  const parts = zonedParts(date, timeZone)
  return parts.hour * 60 + parts.minute
}

/** Parse `"HH:MM"` into minutes since midnight, or `null` when invalid. */
export function parseClock(text) {
  if (typeof text !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** Format minutes since midnight back to `"HH:MM"`. */
export function formatClock(minutes) {
  const bounded = ((Math.round(minutes) % 1440) + 1440) % 1440
  const hour = Math.floor(bounded / 60)
  const minute = bounded % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Add whole days to a `YYYY-MM-DD` key without any zone arithmetic. */
export function shiftDayKey(key, days) {
  const [year, month, day] = key.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + days))
  const pad = (value) => String(value).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

/**
 * Pick one instant inside a window on a given local day.
 *
 * `window` is `{ start, end }` in local minutes; a zero-length window becomes
 * exactly its start. `random()` must return [0, 1).
 */
export function pickInstantInWindow(dayKeyValue, window, timeZone, random) {
  const start = Math.min(window.start, window.end)
  const end = Math.max(window.start, window.end)
  const span = Math.max(0, end - start)
  // Half-open window: the last possible moment is one minute before `end`.
  const offset = span === 0 ? 0 : Math.floor(random() * span)
  const minutes = Math.min(1439, start + offset)
  const [year, month, day] = dayKeyValue.split('-').map(Number)
  return zonedToInstant(
    { year, month, day, hour: Math.floor(minutes / 60), minute: minutes % 60 },
    timeZone,
  )
}

/** Human description of a window, for logs and status payloads. */
export function describeWindow(window) {
  return `${formatClock(window.start)}–${formatClock(window.end)}`
}
