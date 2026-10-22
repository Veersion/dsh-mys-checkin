import assert from 'node:assert/strict'
import test from 'node:test'
import { planNext } from '../lib/scheduler.js'
import { dayKey, formatClock, parseClock, resolveTimeZone, zonedToInstant } from '../lib/tz.js'

const SHANGHAI = 'Asia/Shanghai'

function config(overrides = {}) {
  return {
    enabled: true,
    windows: [{ start: '18:00', end: '18:30' }],
    timezone: SHANGHAI,
    runWhenMissed: true,
    ...overrides,
  }
}

test('parseClock accepts valid times and rejects the rest', () => {
  assert.equal(parseClock('18:00'), 1080)
  assert.equal(parseClock('00:05'), 5)
  assert.equal(parseClock('23:59'), 1439)
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('18:60'), null)
  assert.equal(parseClock('1800'), null)
  assert.equal(parseClock(''), null)
  assert.equal(parseClock(undefined), null)
})

test('formatClock round-trips and wraps', () => {
  assert.equal(formatClock(1080), '18:00')
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(1440), '00:00')
  assert.equal(formatClock(-60), '23:00')
})

test('resolveTimeZone falls back instead of throwing', () => {
  assert.equal(resolveTimeZone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.notEqual(resolveTimeZone('Not/AZone'), 'Not/AZone')
  assert.notEqual(resolveTimeZone(''), '')
})

test('zonedToInstant maps wall clock to UTC', () => {
  const instant = zonedToInstant({ year: 2026, month: 10, day: 23, hour: 18, minute: 0 }, SHANGHAI)
  assert.equal(instant.toISOString(), '2026-10-23T10:00:00.000Z')
  assert.equal(dayKey(instant, SHANGHAI), '2026-10-23')
})

test('zonedToInstant honours a DST zone', () => {
  const summer = zonedToInstant({ year: 2026, month: 7, day: 1, hour: 12, minute: 0 }, 'America/New_York')
  const winter = zonedToInstant({ year: 2026, month: 1, day: 1, hour: 12, minute: 0 }, 'America/New_York')
  assert.equal(summer.toISOString(), '2026-07-01T16:00:00.000Z')
  assert.equal(winter.toISOString(), '2026-01-01T17:00:00.000Z')
})

test('planNext schedules inside today window before it starts', () => {
  const now = Date.UTC(2026, 9, 23, 2, 0, 0) // 10:00 local
  const plan = planNext({ config: config(), now, random: () => 0 })
  assert.equal(plan.date, '2026-10-23')
  assert.equal(plan.reason, 'window')
  assert.equal(plan.targetAt.toISOString(), '2026-10-23T10:00:00.000Z')

  const late = planNext({ config: config(), now, random: () => 0.9999 })
  assert.equal(late.targetAt.toISOString(), '2026-10-23T10:29:00.000Z')
})

test('planNext spreads a run that starts inside the window', () => {
  const now = Date.UTC(2026, 9, 23, 10, 10, 0) // 18:10 local
  const plan = planNext({ config: config(), now, random: () => 0 })
  assert.equal(plan.reason, 'inside')
  assert.equal(plan.targetAt.toISOString(), '2026-10-23T10:10:00.000Z')
  assert.ok(plan.targetAt.getTime() <= Date.UTC(2026, 9, 23, 10, 30, 0))
})

test('planNext catches up shortly after a missed window', () => {
  const now = Date.UTC(2026, 9, 23, 11, 0, 0) // 19:00 local
  const plan = planNext({ config: config(), now, random: () => 0 })
  assert.equal(plan.reason, 'missed')
  assert.ok(plan.targetAt.getTime() - now >= 180_000)
  assert.ok(plan.targetAt.getTime() - now <= 600_000)
})

test('planNext waits for tomorrow when catch-up is disabled', () => {
  const now = Date.UTC(2026, 9, 23, 11, 0, 0)
  const plan = planNext({ config: config({ runWhenMissed: false }), now, random: () => 0 })
  assert.equal(plan.reason, 'passed')
  assert.equal(plan.date, '2026-10-24')
  assert.equal(plan.targetAt.toISOString(), '2026-10-24T10:00:00.000Z')
})

test('planNext targets tomorrow once today already ran', () => {
  const now = Date.UTC(2026, 9, 23, 2, 0, 0)
  const plan = planNext({ config: config(), now, lastRunDate: '2026-10-23', random: () => 0 })
  assert.equal(plan.reason, 'done-today')
  assert.equal(plan.date, '2026-10-24')
})

test('planNext stays silent when disabled', () => {
  assert.equal(planNext({ config: config({ enabled: false }), now: Date.now() }), null)
})

test('planNext picks the first window that has not ended', () => {
  const now = Date.UTC(2026, 9, 23, 2, 0, 0) // 10:00 local
  const plan = planNext({
    config: config({ windows: [{ start: '09:00', end: '09:30' }, { start: '18:00', end: '18:30' }] }),
    now,
    random: () => 0,
  })
  assert.equal(plan.window.start, '18:00')
})
