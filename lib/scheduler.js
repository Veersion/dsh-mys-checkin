/**
 * Daily scheduling: one run per day, at a random instant inside a window.
 *
 * The planner is a pure function so the timing rules can be tested without a
 * live timer; the scheduler is a thin loop that re-arms itself and tolerates a
 * suspended machine (a late timer still runs once, never twice).
 */
import { dayKey, minuteOfDay, parseClock, pickInstantInWindow, shiftDayKey, zonedParts, zonedToInstant } from './tz.js'

const MAX_ARM_MS = 6 * 60 * 60 * 1000

/**
 * Decide when the next run should happen.
 *
 * @param {object} input
 * @param {object} input.config - normalized configuration.
 * @param {number} input.now - current epoch milliseconds.
 * @param {string|null} input.lastRunDate - `YYYY-MM-DD` of the last completed run.
 * @param {() => number} [input.random]
 * @returns {{date: string, targetAt: Date, window: {start: string, end: string}|null, reason: string}|null}
 */
export function planNext({ config, now, lastRunDate = null, random = Math.random }) {
  if (config?.enabled !== true) return null
  const timeZone = config.timezone
  const current = new Date(now)
  const today = dayKey(current, timeZone)
  const minute = minuteOfDay(current, timeZone)

  const tomorrowPlan = (reason) => {
    const date = shiftDayKey(today, 1)
    const window = config.windows[0]
    return {
      date,
      targetAt: pickInstantInWindow(date, { start: parseClock(window.start), end: parseClock(window.end) }, timeZone, random),
      window,
      reason,
    }
  }

  if (lastRunDate === today) return tomorrowPlan('done-today')

  for (const window of config.windows) {
    const start = parseClock(window.start)
    const end = parseClock(window.end)
    if (start === null || end === null) continue
    if (end <= minute) continue

    if (start > minute) {
      return {
        date: today,
        targetAt: pickInstantInWindow(today, { start, end }, timeZone, random),
        window,
        reason: 'window',
      }
    }

    // Already inside the window: spread the remaining minutes uniformly.
    const remaining = Math.max(1, end - minute)
    const offset = Math.floor(random() * remaining)
    const parts = zonedParts(current, timeZone)
    const targetMinute = Math.min(1439, minute + offset)
    return {
      date: today,
      targetAt: zonedToInstant(
        { year: parts.year, month: parts.month, day: parts.day, hour: Math.floor(targetMinute / 60), minute: targetMinute % 60 },
        timeZone,
      ),
      window,
      reason: 'inside',
    }
  }

  if (config.runWhenMissed === true) {
    // Every window has passed and today has no run: catch up in a few minutes,
    // still jittered so a restarting app does not fire on a round minute.
    const delayMs = 180_000 + Math.floor(random() * 420_000)
    return { date: today, targetAt: new Date(now + delayMs), window: null, reason: 'missed' }
  }

  return tomorrowPlan('passed')
}

/**
 * Timer loop around {@link planNext}.
 *
 * `setTimer(callback, delayMs)` must return a disposer; the host passes
 * cordis' `ctx.timeout` so a plugin reload clears the pending timer.
 */
export class Scheduler {
  constructor({ getConfig, getLastRunDate, onRun, onPlan, onError, now = () => Date.now(), random = Math.random, setTimer }) {
    this.getConfig = getConfig
    this.getLastRunDate = getLastRunDate
    this.onRun = onRun
    this.onPlan = onPlan
    this.onError = onError ?? (() => {})
    this.now = now
    this.random = random
    this.setTimer = setTimer
    this.timer = null
    this.plan = null
    this.busy = false
    this.stopped = false
  }

  /** Whether a run is currently in flight. */
  get running() {
    return this.busy
  }

  /** Current plan without re-computing it. */
  getPlan() {
    return this.plan
  }

  /** Compute a fresh plan and arm the timer for it. */
  refresh() {
    if (this.stopped) return null
    this.clearTimer()
    const plan = planNext({
      config: this.getConfig(),
      now: this.now(),
      lastRunDate: this.getLastRunDate(),
      random: this.random,
    })
    this.plan = plan
    this.onPlan?.(plan)
    if (plan !== null) this.arm(plan)
    return plan
  }

  arm(plan) {
    const delay = Math.max(1000, plan.targetAt.getTime() - this.now())
    if (delay > MAX_ARM_MS) {
      // Re-check in six hours: a clock change or a long sleep must not skip the day.
      this.timer = this.setTimer(() => {
        this.timer = null
        if (this.stopped) return
        this.refresh()
      }, MAX_ARM_MS)
      return
    }
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.fire()
    }, delay)
  }

  clearTimer() {
    if (this.timer !== null) {
      this.timer()
      this.timer = null
    }
  }

  async fire() {
    if (this.stopped) return
    if (this.busy) return
    const plan = this.plan
    if (plan === null) {
      this.refresh()
      return
    }
    const early = plan.targetAt.getTime() - this.now()
    if (early > 5000) {
      this.arm(plan)
      return
    }
    this.busy = true
    try {
      await this.onRun('schedule')
    } catch (error) {
      this.onError(error)
    } finally {
      this.busy = false
      this.refresh()
    }
  }

  /** Start the loop. */
  start() {
    this.stopped = false
    return this.refresh()
  }

  /** Stop the loop and drop the pending timer. */
  stop() {
    this.stopped = true
    this.clearTimer()
    this.plan = null
  }
}
