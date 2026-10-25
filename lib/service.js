/**
 * Host half of the 米游社 check-in plugin.
 *
 * Owns everything that must not live in the browser: the session cookie, the
 * device fingerprint, the timer, and every outbound request. The browser half
 * reaches it through four owner-only routes under `/api/mys/`, and never sees a
 * credential.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { GAMES, enabledGames, normalizeConfig } from './config.js'
import {
  hasSession,
  credentialCookies,
  sessionStoken,
} from './ds.js'
import { sleep } from './http.js'
import {
  createQrLogin,
  getAccountProfile,
  getRoles,
  getSignInfo,
  isLoginExpired,
  queryQrLogin,
  refreshCredentials,
  signGame,
  verifySession,
} from './mys.js'
import { qrSvgDataUrl } from './qr.js'
import { Scheduler } from './scheduler.js'
import { StateStore, resolveHome } from './store.js'
import { dayKey } from './tz.js'

const ROUTE_PREFIX = '/api/mys'
const MAX_BODY_BYTES = 64 * 1024
const ROUTE_PATHS = {
  status: `${ROUTE_PREFIX}/status`,
  config: `${ROUTE_PREFIX}/config`,
  loginStart: `${ROUTE_PREFIX}/login/start`,
  loginPoll: `${ROUTE_PREFIX}/login/poll`,
  loginCancel: `${ROUTE_PREFIX}/login/cancel`,
  logout: `${ROUTE_PREFIX}/logout`,
  run: `${ROUTE_PREFIX}/run`,
  refresh: `${ROUTE_PREFIX}/refresh`,
  verify: `${ROUTE_PREFIX}/verify`,
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function failure(code, message, extra = {}) {
  return { ok: false, error: { code, message }, ...extra }
}

async function readJsonBody(request) {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('请求体过大')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function nowStamp() {
  return Date.now()
}

export class MysService {
  /**
   * @param {object} ctx - cordis host context with `connection`.
   * @param {object} [entryConfig] - config from the cordis entry.
   */
  constructor(ctx, entryConfig = {}) {
    this.ctx = ctx
    this.logger = typeof ctx.logger === 'function' ? ctx.logger('mys-checkin') : null
    this.store = new StateStore({
      directory: path.join(resolveHome(), 'mys-checkin'),
      entryConfig,
      onWriteError: (message) => this.logger?.warn?.(message),
    })
    this.store.load()

    this.state = this.store.get()
    this.config = this.state.config
    this.ensureDeviceId()

    this.login = null
    this.runPromise = null
    this.disposers = []
    // Only the App channel requests a SToken (`token_types=1`); the web channel
    // is the fallback because a web credential cannot be renewed automatically.
    this.preferWebFlow = false

    const setTimer = typeof ctx.timeout === 'function'
      ? (fn, delay) => ctx.timeout(fn, delay)
      : (fn, delay) => {
          const timer = setTimeout(fn, delay)
          if (typeof timer.unref === 'function') timer.unref()
          return () => clearTimeout(timer)
        }

    this.scheduler = new Scheduler({
      getConfig: () => this.config,
      getLastRunDate: () => this.state.runtime.lastRunDate,
      setTimer,
      onRun: (reason) => this.run(reason),
      onPlan: (plan) => {
        this.store.patchRuntime({
          planDate: plan?.date ?? null,
          plannedAt: plan === null ? null : plan.targetAt.getTime(),
          nextRunAt: plan === null ? null : plan.targetAt.getTime(),
          planReason: plan?.reason ?? null,
        })
      },
      onError: (error) => this.logger?.warn?.(`定时任务失败：${String(error?.message ?? error)}`),
    })

    this.registerRoutes()
    this.scheduler.start()
    this.log('info', '米游社签到插件已启动')
    // Credentials stored before the nickname lookup existed get one background
    // attempt so the account card shows a name instead of a bare UID.
    void this.enrichProfile()
  }

  /** Read the community nickname when the stored session has none. */
  async enrichProfile() {
    const auth = this.state.auth
    if (auth === null) return
    if (typeof auth.accountName === 'string' && auth.accountName !== '') return
    try {
      const profile = await getAccountProfile({
        config: this.config,
        deviceId: this.deviceId,
        cookies: auth.cookies,
        uid: String(auth.stuid ?? auth.aid ?? ''),
      })
      if (profile.ok === true) {
        this.store.setAuth({ ...this.state.auth, accountName: profile.nickname ?? null, avatar: profile.avatar ?? null })
        this.log('info', `已读取米游社昵称：${profile.nickname}`)
      }
    } catch {
      /* cosmetic only */
    }
  }

  /** Generate and persist the device id on first use; never change it afterwards. */
  ensureDeviceId() {
    const existing = this.state.runtime.deviceId
    if (typeof existing === 'string' && /^[0-9a-f-]{36}$/i.test(existing)) return existing
    const created = randomUUID()
    this.store.patchRuntime({ deviceId: created })
    return created
  }

  get deviceId() {
    return this.state.runtime.deviceId
  }

  log(level, message, detail) {
    this.store.log(level, message, detail)
    const sink = this.logger
    if (sink !== null) {
      if (level === 'error') sink.error?.(message)
      else if (level === 'warn') sink.warn?.(message)
      else sink.info?.(message)
    }
  }

  /** Register the four owner-only routes; disposal removes them. */
  registerRoutes() {
    const routes = [
      { path: ROUTE_PATHS.status, methods: ['GET'], handler: (request) => this.routeStatus(request) },
      { path: ROUTE_PATHS.config, methods: ['POST'], handler: (request) => this.routeConfig(request) },
      { path: ROUTE_PATHS.loginStart, methods: ['POST'], handler: (request) => this.routeLoginStart(request) },
      { path: ROUTE_PATHS.loginPoll, methods: ['GET'], handler: (request) => this.routeLoginPoll(request) },
      { path: ROUTE_PATHS.loginCancel, methods: ['POST'], handler: (request) => this.routeLoginCancel(request) },
      { path: ROUTE_PATHS.logout, methods: ['POST'], handler: (request) => this.routeLogout(request) },
      { path: ROUTE_PATHS.run, methods: ['POST'], handler: (request) => this.routeRun(request) },
      { path: ROUTE_PATHS.refresh, methods: ['POST'], handler: (request) => this.routeRefresh(request) },
      { path: ROUTE_PATHS.verify, methods: ['POST'], handler: (request) => this.routeVerify(request) },
    ]
    for (const route of routes) {
      const dispose = this.ctx.connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: (request) => this.guard(route.handler, request),
      })
      this.disposers.push(dispose)
    }
  }

  /** Wrap one handler: JSON errors instead of a broken response. */
  async guard(handler, request) {
    try {
      const result = await handler(request)
      return json(result)
    } catch (error) {
      const message = String(error?.message ?? error)
      this.logger?.warn?.(`接口失败：${message}`)
      return json(failure('internal', message), 200)
    }
  }

  /** Dismiss every route and timer. */
  dispose() {
    this.scheduler.stop()
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    this.store.close()
  }

  // ---------------------------------------------------------------- status

  accountSummary() {
    const auth = this.state.auth
    if (auth === null) {
      return { state: 'anonymous', accountName: null, uid: null, loginAt: null, lastRefreshAt: null, hasStoken: false, avatar: null }
    }
    const expired = this.state.runtime.lastError?.code === 'LOGIN_EXPIRED'
    // `mid` is an opaque account token; the number a user recognizes as their
    // miHoYo UID is `ltuid` / `account_id`.
    const cookies = auth.cookies ?? {}
    const uid = cookies.ltuid_v2 ?? cookies.ltuid ?? cookies.account_id_v2 ?? cookies.account_id ?? auth.stuid ?? auth.aid ?? null
    return {
      state: expired || !hasSession(cookies) ? 'expired' : 'active',
      accountName: auth.accountName ?? this.fallbackNickname(),
      uid: uid === null ? null : String(uid),
      loginAt: auth.loginAt ?? null,
      lastRefreshAt: auth.lastRefreshAt ?? null,
      hasStoken: sessionStoken(cookies) !== null,
      avatar: auth.avatar ?? null,
    }
  }

  /** In-game nickname of the first bound role, used when no community profile is known. */
  fallbackNickname() {
    const roles = this.state.runtime.roles
    if (roles === null || typeof roles !== 'object') return null
    for (const role of Object.values(roles.byGame ?? {})) {
      if (role !== null && typeof role === 'object' && typeof role.nickname === 'string' && role.nickname !== '') return role.nickname
    }
    return null
  }

  roleSummary() {
    const cache = this.state.runtime.roles
    const today = dayKey(new Date(nowStamp()), this.config.timezone)
    if (cache === null || cache?.date !== today) return {}
    return cache.byGame ?? {}
  }

  statusPayload() {
    const runtime = this.state.runtime
    const roles = this.roleSummary()
    const plan = this.scheduler.getPlan()
    return {
      ok: true,
      enabled: this.config.enabled,
      config: this.config,
      timezone: this.config.timezone,
      running: this.runPromise !== null,
      login: this.accountSummary(),
      loginFlow: this.login === null ? null : { ticket: this.login.ticket, status: this.login.status, createdAt: this.login.createdAt },
      schedule: {
        date: plan?.date ?? null,
        targetAt: plan?.targetAt?.getTime() ?? null,
        window: plan?.window ?? null,
        reason: plan?.reason ?? null,
        lastRunDate: runtime.lastRunDate ?? null,
        lastRunAt: runtime.lastRunAt ?? null,
      },
      lastResult: runtime.lastResult ?? null,
      lastError: runtime.lastError ?? null,
      roles,
      games: GAMES.map((game) => ({
        id: game.id,
        label: game.label,
        biz: game.biz,
        enabled: this.config.games[game.id] === true,
        role: roles[game.id] ?? null,
      })),
      logs: (runtime.log ?? []).slice(-60),
    }
  }

  async routeStatus() {
    return this.statusPayload()
  }

  // ------------------------------------------------------------ config

  async routeConfig(request) {
    const body = await readJsonBody(request)
    const patch = body?.config ?? body
    if (patch === null || typeof patch !== 'object') return failure('bad-request', '配置格式不正确')
    const merged = { ...this.config, ...patch }
    this.config = normalizeConfig(merged)
    this.store.setConfig(this.config)
    this.scheduler.refresh()
    this.log('info', `配置已更新：${this.config.windows.map((window) => `${window.start}-${window.end}`).join('、')}`)
    return { ok: true, config: this.config, status: this.statusPayload() }
  }

  // ------------------------------------------------------------- login

  async routeLoginStart(request) {
    await readJsonBody(request).catch(() => undefined)
    const previous = this.login
    if (previous !== null && previous.status === 'pending' && nowStamp() - previous.createdAt < 30_000) {
      return { ok: true, ticket: previous.ticket, qr: previous.qr, expiresAt: previous.createdAt + this.config.maxQrAgeMs }
    }

    // The App channel is the only one that asks the passport for a SToken
    // (`token_types=1`); web is a fallback for when that channel is unavailable.
    const order = this.preferWebFlow ? ['web', 'app'] : ['app', 'web']
    let created = null
    for (const flow of order) {
      created = await createQrLogin({ config: this.config, deviceId: this.deviceId, flow })
      if (created.ok === true) break
      const nextFlow = order[order.indexOf(flow) + 1]
      if (nextFlow !== undefined) {
        this.log('warn', `${flow === 'app' ? 'App' : '网页'}扫码接口失败（${created.retcode} ${created.message}），改用${nextFlow === 'app' ? 'App' : '网页'}接口`)
      }
    }
    if (created?.ok !== true) {
      return failure('qr-create-failed', `创建二维码失败：${created?.message ?? '未知错误'}（${created?.retcode ?? -1}）`)
    }

    const qr = qrSvgDataUrl(created.url)
    this.login = {
      ticket: created.ticket,
      flow: created.flow,
      qr,
      createdAt: nowStamp(),
      status: 'pending',
    }
    this.log('info', `已生成登录二维码（${created.flow === 'app' ? 'App 通道，将获取 SToken' : '网页通道'}），等待扫码`)
    return { ok: true, ticket: created.ticket, qr, expiresAt: this.login.createdAt + this.config.maxQrAgeMs }
  }

  async routeLoginPoll(request) {
    const url = new URL(request.url)
    const ticket = url.searchParams.get('ticket')
    const session = this.login
    if (session === null || ticket === null || ticket !== session.ticket) {
      return { ok: false, state: 'expired', error: { code: 'no-session', message: '二维码会话不存在，请重新生成' } }
    }
    if (nowStamp() - session.createdAt > this.config.maxQrAgeMs) {
      session.status = 'expired'
      this.login = null
      return { ok: true, state: 'expired', message: '二维码已过期，请刷新' }
    }

    const result = await queryQrLogin({
      config: this.config,
      deviceId: this.deviceId,
      ticket: session.ticket,
      flow: session.flow,
    })

    if (result.status === 'pending' || result.status === 'scanned') {
      session.status = result.status
      return { ok: true, state: result.status }
    }
    if (result.status === 'expired') {
      this.login = null
      return { ok: true, state: 'expired', message: result.message }
    }
    if (result.status !== 'confirmed') {
      return { ok: false, state: 'error', error: { code: 'qr-poll-failed', message: result.message } }
    }

    if (!result.hasCookies) {
      this.login = null
      this.preferWebFlow = session.flow === 'app'
      return failure('qr-no-cookie', session.flow === 'app'
        ? 'App 扫码已确认，但未取得登录凭据；已切换为网页扫码通道，请再试一次'
        : '扫码已确认，但未取得登录凭据；请重新扫码')
    }

    let cookies = credentialCookies(result.cookies)
    let renewedAt = null
    // The App channel may return only the SToken; derive the signing cookies
    // (ltoken / cookie_token) before deciding that the login is unusable.
    if (!hasSession(cookies) && sessionStoken(cookies) !== null) {
      const derived = await refreshCredentials({ config: this.config, deviceId: this.deviceId, cookies })
      if (derived.ok === true) {
        cookies = derived.cookies
        renewedAt = nowStamp()
        this.log('info', '已用 App 通道的 SToken 换取 ltoken 与 cookie_token')
      } else {
        this.log('warn', `已取得 SToken，但换取 ltoken 失败：${derived.message}`)
      }
    }
    if (!hasSession(cookies)) {
      this.login = null
      const hasStoken = sessionStoken(cookies) !== null
      if (session.flow === 'app' && hasStoken === false) this.preferWebFlow = true
      let message = '扫码已确认，但缺少 ltoken；请重新扫码'
      if (session.flow === 'app') {
        message = hasStoken
          ? 'App 扫码已确认并取得 SToken，但换取 ltoken 失败；请重试'
          : 'App 扫码已确认，但未取得登录凭据；已切换为网页扫码通道，请再试一次'
      }
      return failure('qr-no-ltoken', message)
    }

    const auth = {
      cookies,
      mid: (typeof cookies.mid === 'string' ? cookies.mid : undefined) ?? cookies.ltmid_v2 ?? result.userInfo?.mid ?? null,
      aid: cookies.account_id_v2 ?? cookies.account_id ?? cookies.ltuid_v2 ?? result.userInfo?.aid ?? null,
      stuid: cookies.stuid ?? cookies.ltuid_v2 ?? result.userInfo?.aid ?? null,
      accountName: result.userInfo?.nickname ?? result.userInfo?.account_name ?? null,
      avatar: null,
      loginAt: nowStamp(),
      lastRefreshAt: renewedAt,
    }
    // The QR confirmation carries no nickname; read the community profile once.
    try {
      const profile = await getAccountProfile({
        config: this.config,
        deviceId: this.deviceId,
        cookies,
        uid: String(auth.stuid ?? ''),
      })
      if (profile.ok === true) {
        auth.accountName = profile.nickname ?? auth.accountName
        auth.avatar = profile.avatar ?? null
      }
    } catch {
      /* nickname is cosmetic; the account card falls back to the role name */
    }
    this.store.setAuth(auth)
    this.store.patchRuntime({ lastError: null, roles: null })
    this.login = null
    this.preferWebFlow = false
    const renewable = sessionStoken(cookies) !== null
    const name = auth.accountName === null || auth.accountName === '' ? '' : `：${auth.accountName}`
    this.log('info', `扫码登录成功${name}${renewable ? '（支持自动续期）' : '（网页凭据，无法自动续期）'}`)
    if (renewable !== true) {
      this.log('warn', '网页扫码未下发 SToken；该凭据到期后需要重新扫码')
    }

    // A scheduled run that was skipped for lack of a session already consumed
    // today; now that a session exists, let the planner offer a catch-up.
    const today = dayKey(new Date(nowStamp()), this.config.timezone)
    const runtime = this.state.runtime
    if (runtime.lastRunDate === today && runtime.lastResult?.date !== today) {
      this.store.patchRuntime({ lastRunDate: null })
      this.log('info', '今日还没有成功签到，登录后重新安排一次补跑')
    }
    this.scheduler.refresh()

    // Confirm the cookie actually works before reporting success.
    try {
      const verified = await verifySession({ config: this.config, deviceId: this.deviceId, cookies })
      if (verified.ok !== true) {
        const message = verified.reason === 'expired' ? '登录成功但凭据校验失败，请重试' : `凭据校验失败：${verified.message}`
        this.store.patchRuntime({ lastError: { code: verified.reason === 'expired' ? 'LOGIN_EXPIRED' : 'VERIFY_FAILED', message, at: nowStamp() } })
        return { ok: true, state: 'confirmed', warning: message, account: this.accountSummary() }
      }
    } catch (error) {
      const message = `凭据校验请求失败（网络原因，不影响已保存的登录）：${String(error?.message ?? error)}`
      this.log('warn', message)
      return { ok: true, state: 'confirmed', warning: message, account: this.accountSummary() }
    }

    return { ok: true, state: 'confirmed', account: this.accountSummary(), status: this.statusPayload() }
  }

  async routeLoginCancel(request) {
    await readJsonBody(request).catch(() => undefined)
    this.login = null
    return { ok: true }
  }

  async routeLogout(request) {
    await readJsonBody(request).catch(() => undefined)
    this.login = null
    this.store.setAuth(null)
    this.store.patchRuntime({ lastError: null, roles: null })
    this.log('info', '已退出登录')
    return { ok: true, status: this.statusPayload() }
  }

  // ------------------------------------------------------------- actions

  async routeRun(request) {
    const body = await readJsonBody(request).catch(() => ({}))
    if (body?.game !== undefined && typeof body.game !== 'string') return failure('bad-request', 'game 参数不正确')
    const started = this.run('manual', typeof body?.game === 'string' ? body.game : null)
    return started
  }

  async routeRefresh(request) {
    await readJsonBody(request).catch(() => undefined)
    const auth = this.state.auth
    if (auth === null) return failure('anonymous', '尚未登录')
    const result = await refreshCredentials({ config: this.config, deviceId: this.deviceId, cookies: auth.cookies })
    if (result.ok !== true) {
      if (result.reason === 'no-stoken') {
        // No stoken is not the same as an expired session: the ltoken may still
        // sign in fine until it expires on its own.
        const message = '当前登录没有 SToken（网页扫码凭据），无法自动续期；请重新扫码，App 通道会获取 SToken'
        this.log('warn', message)
        return failure('no-stoken', message)
      }
      if (result.reason === 'network') {
        const message = '续期请求失败（网络原因），登录状态未改变；请稍后重试'
        this.log('warn', message)
        return failure('refresh-failed', message)
      }
      const message = 'SToken 已失效，无法自动续期；当前 cookie 可能仍可签到，建议重新扫码'
      this.store.patchRuntime({ lastError: { code: 'LOGIN_EXPIRED', message, at: nowStamp() } })
      this.log('error', `凭据续期失败：${result.message}`)
      return failure('refresh-failed', message)
    }
    this.store.setAuth({ ...auth, cookies: result.cookies, lastRefreshAt: nowStamp() })
    this.store.patchRuntime({ lastError: null })
    this.log('info', '凭据已续期')
    return { ok: true, login: this.accountSummary(), status: this.statusPayload() }
  }

  async routeVerify(request) {
    await readJsonBody(request).catch(() => undefined)
    const auth = this.state.auth
    const startedAt = nowStamp()
    if (auth === null) {
      return { ok: true, reachable: null, message: '尚未登录，无法测试接口连通性' }
    }
    try {
      const result = await verifySession({ config: this.config, deviceId: this.deviceId, cookies: auth.cookies })
      if (result.ok === true) void this.enrichProfile()
      return {
        ok: true,
        reachable: true,
        sessionValid: result.ok === true,
        retcode: result.retcode ?? null,
        message: result.ok === true ? '接口可用，登录状态有效' : `接口可用，但登录状态无效：${result.message}`,
        elapsedMs: nowStamp() - startedAt,
      }
    } catch (error) {
      return {
        ok: true,
        reachable: false,
        sessionValid: null,
        message: `网络请求失败：${String(error?.message ?? error)}`,
        elapsedMs: nowStamp() - startedAt,
      }
    }
  }

  // ---------------------------------------------------------------- run

  /**
   * Start one check-in run. Returns immediately; the browser polls status.
   *
   * @param {'manual'|'schedule'} reason
   * @param {string|null} [onlyGame] - restrict a manual run to one game id.
   */
  run(reason, onlyGame = null) {
    const today = dayKey(new Date(nowStamp()), this.config.timezone)
    // A scheduled attempt consumes the day up front, whatever happens next:
    // the planner reads `lastRunDate`, and leaving it unset after a skip would
    // make it schedule a catch-up every few minutes forever.
    if (reason === 'schedule') this.store.patchRuntime({ lastRunDate: today })
    if (this.runPromise !== null) return { ok: false, started: false, error: { code: 'busy', message: '已有签到任务在进行中' } }
    if (this.state.auth === null) {
      if (reason === 'schedule') this.log('warn', '定时签到已跳过：尚未登录')
      return { ok: false, started: false, error: { code: 'anonymous', message: '请先扫码登录' } }
    }

    this.runPromise = this.executeRun(reason, onlyGame)
      .catch((error) => {
        const message = String(error?.message ?? error)
        this.store.patchRuntime({ lastError: { code: 'RUN_FAILED', message, at: nowStamp() } })
        this.log('error', `签到任务异常：${message}`)
      })
      .finally(() => {
        this.runPromise = null
        this.scheduler.refresh()
      })
    return { ok: true, started: true }
  }

  async executeRun(reason, onlyGame) {
    const startedAt = nowStamp()
    const timeZone = this.config.timezone
    const today = dayKey(new Date(startedAt), timeZone)
    const targets = enabledGames(this.config).filter((game) => onlyGame === null || game.id === onlyGame)
    if (targets.length === 0) {
      this.log('warn', '没有启用任何游戏，签到未执行')
      return
    }

    this.log('info', `${reason === 'manual' ? '手动' : '定时'}签到开始，目标：${targets.map((game) => game.label).join('、')}`)
    const results = []
    let fatal = null
    let refreshed = false

    for (const game of targets) {
      const auth = this.state.auth
      if (auth === null) break
      try {
        const resolved = await this.resolveRole(game, auth)
        if (resolved.error !== undefined) {
          if (resolved.error === 'expired') {
            this.store.patchRuntime({
              lastError: { code: 'LOGIN_EXPIRED', message: '登录状态已失效，请重新扫码登录', at: nowStamp() },
            })
            results.push({ game: game.id, label: game.label, outcome: 'expired', message: resolved.message })
            this.log('error', `${game.label}：${resolved.message}`)
            fatal = 'expired'
            break
          }
          results.push({ game: game.id, label: game.label, outcome: 'error', message: resolved.message })
          this.log('error', `${game.label}：${resolved.message}`)
          continue
        }
        const role = resolved.role
        if (role === null) {
          results.push({ game: game.id, label: game.label, outcome: 'no-role', message: '该游戏下没有角色' })
          this.log('info', `${game.label}：账号下没有角色，跳过`)
          continue
        }

        // One cheap state read per game gives the cumulative day count and
        // avoids a redundant sign call when today is already done.
        let info = null
        try {
          info = await getSignInfo({ config: this.config, deviceId: this.deviceId, cookies: auth.cookies, game, role })
        } catch {
          info = null
        }

        let signed
        if (info?.ok === true && info.isSign === true) {
          signed = { outcome: 'already', retcode: 0, message: '今日已签到' }
        } else if (info?.ok === true && info.firstBind === true) {
          signed = { outcome: 'first-bind', retcode: 0, message: '首次绑定需在米游社手动签到一次' }
        } else {
          signed = await this.signWithRetry(auth, game, role)
        }

        // One refresh attempt per run, and only when the server says the session died.
        if (signed.outcome === 'expired' && refreshed !== true) {
          const refreshedAuth = await refreshCredentials({ config: this.config, deviceId: this.deviceId, cookies: auth.cookies })
          if (refreshedAuth.ok === true) {
            this.store.setAuth({ ...auth, cookies: refreshedAuth.cookies, lastRefreshAt: nowStamp() })
            refreshed = true
            this.log('info', '登录凭据已自动续期，重试签到')
            signed = await this.signWithRetry({ ...auth, cookies: refreshedAuth.cookies }, game, role)
          } else if (refreshedAuth.reason === 'no-stoken') {
            this.log('warn', '当前凭据不含 SToken，无法自动续期')
          }
        }

        const totalDays = info?.ok === true && typeof info.totalDays === 'number'
          ? info.totalDays + (signed.outcome === 'signed' ? 1 : 0)
          : null

        results.push({
          game: game.id,
          label: game.label,
          role: role.nickname || role.uid,
          uid: role.uid,
          region: role.region,
          regionName: role.regionName,
          level: role.level,
          outcome: signed.outcome,
          retcode: signed.retcode,
          message: signed.message,
          awards: signed.awards ?? undefined,
          totalDays,
        })

        if (signed.outcome === 'expired') {
          this.store.patchRuntime({
            lastError: {
              code: 'LOGIN_EXPIRED',
              message: '登录状态已失效，签到被拒绝，请重新扫码登录',
              at: nowStamp(),
            },
          })
          this.log('error', `${game.label}：登录已失效（${signed.retcode}），需要重新扫码`)
          fatal = 'expired'
          break
        }
        if (signed.outcome === 'captcha') {
          this.store.patchRuntime({
            lastError: {
              code: 'CAPTCHA',
              message: '米游社要求人机验证。请打开米游社 App → 我的 → 我的角色 完成验证，今日已停止自动签到',
              at: nowStamp(),
            },
          })
          this.log('warn', `${game.label}：触发人机验证，停止今日剩余签到`)
          fatal = 'captcha'
          break
        }
        if (signed.outcome === 'signed') this.log('info', `${game.label}：签到成功`)
        else if (signed.outcome === 'already') this.log('info', `${game.label}：今日已签到`)
        else if (signed.outcome === 'first-bind') this.log('warn', `${game.label}：首次绑定需要在米游社手动签到一次`)
        else if (signed.outcome === 'not-bound') this.log('warn', `${game.label}：角色未绑定（${signed.message}）`)
        else this.log('warn', `${game.label}：签到失败 ${signed.retcode} ${signed.message}`)
      } catch (error) {
        const message = String(error?.message ?? error)
        results.push({ game: game.id, label: game.label, outcome: 'error', message })
        this.log('error', `${game.label}：请求失败 ${message}`)
      }

      // Human-like spacing between games; the last game needs no sleep.
      if (game !== targets[targets.length - 1]) {
        const { min, max } = this.config.gapMs
        await sleep(min + Math.floor(Math.random() * Math.max(1, max - min)))
      }
    }

    const ok = fatal === null && results.every((item) => ['signed', 'already', 'no-role', 'first-bind'].includes(item.outcome))
    const summary = results.map((item) => `${item.label}:${labelOfOutcome(item.outcome)}`).join('、')
    const record = {
      date: today,
      at: startedAt,
      finishedAt: nowStamp(),
      reason,
      ok,
      results,
      summary,
    }

    const patch = {
      lastResult: record,
      lastRunAt: startedAt,
    }
    // A manual run only consumes the day when it actually finished cleanly, so
    // a failed manual attempt leaves the automatic run in place.
    if (ok && onlyGame === null && reason !== 'schedule') patch.lastRunDate = today
    // A clean run retires the previous failure banner; a fatal one keeps it.
    if (ok && fatal === null) patch.lastError = null
    this.store.patchRuntime(patch)
    this.log(ok ? 'info' : 'warn', `签到结束：${summary}`)
  }

  /** Sign one game, retrying transport failures up to the configured budget. */
  async signWithRetry(auth, game, role) {
    const attempts = Math.max(1, this.config.retry.attempts)
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await signGame({
          config: this.config,
          deviceId: this.deviceId,
          cookies: auth.cookies,
          game,
          role,
        })
      } catch (error) {
        lastError = error
        if (attempt < attempts) {
          this.log('warn', `${game.label}：请求失败，${Math.round(this.config.retry.delayMs / 1000)} 秒后重试（${attempt}/${attempts - 1}）`)
          await sleep(this.config.retry.delayMs)
        }
      }
    }
    throw lastError
  }

  /**
   * Resolve one role for a game, caching the binding query for the day.
   * @returns {Promise<{role: object|null, error?: undefined} | {error: 'expired'|'error', message: string}>}
   */
  async resolveRole(game, auth) {
    const today = dayKey(new Date(nowStamp()), this.config.timezone)
    const cache = this.state.runtime.roles
    if (cache !== null && cache?.date === today && cache.byGame?.[game.id] !== undefined) {
      return { role: cache.byGame[game.id] }
    }
    const result = await getRoles({
      config: this.config,
      deviceId: this.deviceId,
      cookies: auth.cookies,
      biz: game.biz,
    })
    if (result.ok !== true) {
      if (isLoginExpired(result.retcode)) {
        return { error: 'expired', message: `登录已失效（${result.retcode} ${result.message}）` }
      }
      return { error: 'error', message: `查询角色失败（${result.retcode} ${result.message}）` }
    }
    const role = result.roles[0] ?? null
    const byGame = { ...(cache?.date === today ? cache.byGame : {}), [game.id]: role }
    this.store.patchRuntime({ roles: { date: today, byGame } })
    return { role }
  }
}

function labelOfOutcome(outcome) {
  switch (outcome) {
    case 'signed':
      return '成功'
    case 'already':
      return '已签到'
    case 'no-role':
      return '无角色'
    case 'captcha':
      return '需验证'
    case 'expired':
      return '登录失效'
    case 'not-bound':
      return '未绑定'
    case 'first-bind':
      return '待手动签到'
    default:
      return '失败'
  }
}
