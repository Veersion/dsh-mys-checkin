/**
 * The miHoYo BBS protocol, as far as daily game check-in needs it.
 *
 * Every function takes an explicit `config`/`deviceId` so the same code can be
 * unit-tested against a fake transport, and returns the raw `retcode` alongside
 * a normalized outcome instead of throwing for business failures.
 */
import { request } from './http.js'
import {
  apiHeaders,
  cookieHeader,
  credentialCookies,
  passportHeaders,
  parseSetCookie,
  sessionStoken,
  signDs1,
  signDs2,
} from './ds.js'

const PASSPORT_WEB = 'https://passport-api.miyoushe.com'
const PASSPORT_CN = 'https://passport-api.mihoyo.com'
const API_TAKUMI = 'https://api-takumi.mihoyo.com'

function passportBase(flow) {
  return flow === 'app' ? PASSPORT_CN : PASSPORT_WEB
}

/** Return codes that mean the session is gone and only a re-scan can fix it. */
export const LOGIN_EXPIRED = new Set([-100, -111, 10001, 10010])
/** Return codes that mean risk control wants a human, so the run must stop. */
export const CAPTCHA_REQUIRED = new Set([1034, -999])
/** Return codes that mean the account has no role in that game. */
export const NOT_BOUND = new Set([-1002, 1016])

function asRetcode(json) {
  const value = json?.retcode
  return typeof value === 'number' ? value : -1
}

function asMessage(json) {
  const value = json?.message
  return typeof value === 'string' && value !== '' ? value : `未知返回（retcode=${String(json?.retcode)}）`
}

/** `true` when this retcode means "log in again". */
export function isLoginExpired(retcode) {
  return LOGIN_EXPIRED.has(retcode)
}

/** `true` when this retcode means "today is already signed". */
export function isAlreadySigned(retcode) {
  return retcode === -5003
}

/** `true` when risk control interrupted the request. */
export function isCaptcha(retcode) {
  return CAPTCHA_REQUIRED.has(retcode)
}

/**
 * Create one QR login ticket.
 *
 * The web flow is the documented one; the app flow is a fallback for the case
 * where the web endpoint answers with a protocol error.
 */
export async function createQrLogin({ config, deviceId, timeoutMs = 20000, flow = 'web' }) {
  const url = flow === 'app'
    ? `${passportBase(flow)}/account/ma-cn-passport/app/createQRLogin`
    : `${passportBase(flow)}/account/ma-cn-passport/web/createQRLogin`
  const headers = flow === 'app'
    ? {
        ...passportHeaders({ appVersion: config.client.appVersion, deviceId }),
        'x-rpc-app_id': 'ddxf5dufpuyo',
        'x-rpc-client_type': '3',
        'User-Agent': 'HYPContainer/1.3.3.182',
      }
    : passportHeaders({ appVersion: config.client.appVersion, deviceId })

  const response = await request(url, { method: 'POST', headers, body: '{}', timeoutMs })
  const json = response.json
  if (asRetcode(json) !== 0) {
    return { ok: false, flow, retcode: asRetcode(json), message: asMessage(json) }
  }
  const data = json?.data
  const qrUrl = typeof data?.url === 'string' ? data.url : null
  const ticket = typeof data?.ticket === 'string' ? data.ticket : null
  if (qrUrl === null || ticket === null) {
    return { ok: false, flow, retcode: -1, message: '二维码接口未返回 url/ticket' }
  }
  return { ok: true, flow, url: qrUrl, ticket }
}

/**
 * Store one inline token under the cookie name its value format belongs to.
 *
 * The passport marks the kind with `token_type` (1 stoken, 2 ltoken,
 * 4 cookie_token); the `v2_` prefix then decides whether the V2 cookie name
 * (paired with `mid`) or the legacy V1 name (paired with `stuid`) applies.
 */
function storeToken(cookies, token) {
  if (typeof token?.token !== 'string' || token.token === '') return
  const byName = { stoken: 1, ltoken: 2, cookie_token: 4 }
  const type = typeof token.token_type === 'number' ? token.token_type : byName[token.name]
  if (type !== 1 && type !== 2 && type !== 4) return
  const v2 = token.token.startsWith('v2_')
  const name = type === 1 ? 'stoken' : type === 2 ? 'ltoken' : 'cookie_token'
  cookies[v2 ? `${name}_v2` : name] = token.token
}

/**
 * Poll one QR login ticket.
 *
 * `status` is normalized to `pending | scanned | confirmed | expired`.
 * Confirmed responses carry the credential cookies in `Set-Cookie`. The App
 * channel additionally answers with an inline `tokens` array — that is the
 * only channel that requests a stoken (`token_types=1` in the QR URL).
 */
export async function queryQrLogin({ config, deviceId, ticket, flow = 'web', timeoutMs = 20000 }) {
  const path = flow === 'app' ? '/account/ma-cn-passport/app/queryQRLoginStatus' : '/account/ma-cn-passport/web/queryQRLoginStatus'
  const query = `ticket=${encodeURIComponent(ticket)}`
  const headers = flow === 'app'
    ? {
        ...passportHeaders({ appVersion: config.client.appVersion, deviceId }),
        'x-rpc-app_id': 'ddxf5dufpuyo',
        'x-rpc-client_type': '3',
        'User-Agent': 'HYPContainer/1.3.3.182',
      }
    : passportHeaders({ appVersion: config.client.appVersion, deviceId })

  const response = await request(`${passportBase(flow)}${path}?${query}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ticket }),
    timeoutMs,
  })
  const json = response.json
  const retcode = asRetcode(json)
  const rawStatus = typeof json?.data?.status === 'string' ? json.data.status : ''
  const normalized = rawStatus.toLowerCase()

  let status = 'pending'
  if (retcode === -3501 || normalized === 'expired') status = 'expired'
  else if (normalized === 'scanned' || normalized === 'scannedwaitingconfirmation') status = 'scanned'
  else if (normalized === 'confirmed') status = 'confirmed'
  else if (retcode === -3505) status = 'expired'
  else if (retcode !== 0) status = 'error'

  const userInfo = json?.data?.user_info ?? null

  // Confirmed tokens arrive as cookies; the App channel also inlines them.
  const cookies = credentialCookies(parseSetCookie(response.setCookies))
  const tokens = json?.data?.tokens
  if (Array.isArray(tokens)) {
    for (const token of tokens) storeToken(cookies, token)
  }
  if (typeof userInfo?.mid === 'string' && cookies.ltmid_v2 === undefined) cookies.ltmid_v2 = userInfo.mid
  if (typeof userInfo?.aid === 'string' && cookies.ltuid_v2 === undefined) cookies.ltuid_v2 = userInfo.aid

  return {
    retcode,
    message: asMessage(json),
    status,
    userInfo,
    cookies,
    hasCookies: Object.keys(cookies).length > 0,
  }
}

/**
 * List the account's roles for one game.
 *
 * An empty list is a normal answer meaning "this account has no character in
 * that game", not an error.
 */
export async function getRoles({ config, deviceId, cookies, biz, timeoutMs = 20000 }) {
  const url = `${API_TAKUMI}/binding/api/getUserGameRolesByCookie?game_biz=${encodeURIComponent(biz)}`
  const headers = apiHeaders({
    config,
    deviceId,
    signature: signDs1({ salt: config.client.salt }),
    cookie: cookieHeader(cookies),
  })
  const response = await request(url, { headers, timeoutMs })
  const json = response.json
  const retcode = asRetcode(json)
  if (retcode !== 0) {
    return { ok: false, retcode, message: asMessage(json), roles: [] }
  }
  const list = Array.isArray(json?.data?.list) ? json.data.list : []
  const roles = list.map((item) => ({
    uid: String(item?.game_uid ?? ''),
    region: String(item?.region ?? ''),
    regionName: typeof item?.region_name === 'string' ? item.region_name : '',
    nickname: typeof item?.nickname === 'string' ? item.nickname : '',
    level: typeof item?.level === 'number' ? item.level : null,
    biz: typeof item?.game_biz === 'string' ? item.game_biz : biz,
  }))
  return { ok: true, retcode, message: 'ok', roles }
}

/** DS2 salt used by the BBS app endpoints; stable across client releases. */
const BBS_SALT = 't0qEgfub6cvueAPgR5m9aQWWVciEer7v'

function bbsHeaders({ config, deviceId, cookie, signature }) {
  return {
    'User-Agent': 'okhttp/4.9.3',
    Accept: 'application/json',
    DS: signature,
    'x-rpc-app_version': config.client.appVersion,
    'x-rpc-client_type': '2',
    'x-rpc-device_id': deviceId,
    'x-rpc-device_name': config.device.name,
    'x-rpc-device_model': config.device.model,
    'x-rpc-sys_version': config.device.sysVersion,
    'x-rpc-channel': config.device.channel,
    'x-rpc-verify_key': 'bll8iq97cem8',
    Referer: 'https://app.mihoyo.com',
    ...(cookie === '' ? {} : { Cookie: cookie }),
  }
}

/**
 * Best-effort community profile lookup.
 *
 * The QR confirmation yields the numeric UID but no nickname, so this reads the
 * community profile once after login. Failure is harmless: the account card
 * falls back to the in-game role nickname.
 */
export async function getAccountProfile({ config, deviceId, cookies, uid, timeoutMs = 10000 }) {
  if (typeof uid !== 'string' || uid === '') return { ok: false, nickname: null, avatar: null }
  const query = new URLSearchParams({ uid })
  const headers = bbsHeaders({
    config,
    deviceId,
    cookie: cookieHeader(cookies),
    signature: signDs2({ salt: BBS_SALT, query }),
  })
  const response = await request(`https://bbs-api.miyoushe.com/user/api/getUserFullInfo?${query}`, {
    headers,
    timeoutMs,
  })
  const json = response.json
  if (asRetcode(json) !== 0) return { ok: false, retcode: asRetcode(json), message: asMessage(json), nickname: null, avatar: null }
  const info = json?.data?.user?.user_info ?? json?.data?.user_info ?? null
  const nickname = typeof info?.nickname === 'string' && info.nickname.trim() !== '' ? info.nickname.trim() : null
  const avatar = typeof info?.avatar_url === 'string' && info.avatar_url !== '' ? info.avatar_url : null
  return { ok: nickname !== null, nickname, avatar }
}

/**
 * Read today's check-in state before signing.
 *
 * One cheap call per game provides the cumulative sign-in day shown in the
 * result cards, and avoids re-signing when the account is already done.
 */
export async function getSignInfo({ config, deviceId, cookies, game, role, timeoutMs = 15000 }) {
  const query = new URLSearchParams({
    act_id: game.actId,
    region: role.region,
    uid: role.uid,
    lang: 'zh-cn',
  })
  const headers = apiHeaders({
    config,
    deviceId,
    signature: signDs1({ salt: config.client.salt }),
    cookie: cookieHeader(cookies),
    signgame: game.sendSigngame === true ? game.signgame : undefined,
  })
  const response = await request(`${game.host}/event/luna/${game.signgame}/info?${query}`, { headers, timeoutMs })
  const json = response.json
  const retcode = asRetcode(json)
  if (retcode !== 0) return { ok: false, retcode, message: asMessage(json) }
  const data = json?.data ?? {}
  return {
    ok: true,
    isSign: data.is_sign === true,
    firstBind: data.first_bind === true,
    totalDays: typeof data.total_sign_day === 'number' ? data.total_sign_day : null,
  }
}

/**
 * Sign one game for one role.
 *
 * `outcome` classifies the business result so the caller never has to know the
 * retcode table: `signed | already | captcha | expired | not-bound | error`.
 */
export async function signGame({ config, deviceId, cookies, game, role, timeoutMs = 25000 }) {
  const path = `/event/luna/${game.signgame}/sign`
  const body = JSON.stringify({
    act_id: game.actId,
    region: role.region,
    uid: role.uid,
    lang: 'zh-cn',
  })
  const headers = {
    ...apiHeaders({
      config,
      deviceId,
      signature: signDs1({ salt: config.client.salt }),
      cookie: cookieHeader(cookies),
      signgame: game.sendSigngame === true ? game.signgame : undefined,
    }),
    'Content-Type': 'application/json',
  }
  const response = await request(`${game.host}${path}`, { method: 'POST', headers, body, timeoutMs })
  const json = response.json
  const retcode = asRetcode(json)
  const message = asMessage(json)

  if (retcode === 0) {
    const success = json?.data?.success
    if (success === 1) {
      return {
        outcome: 'captcha',
        retcode,
        message: '触发验证码，需在米游社手动完成',
        captcha: { gt: json?.data?.gt, challenge: json?.data?.challenge },
      }
    }
    return { outcome: 'signed', retcode, message, awards: Array.isArray(json?.data?.awards) ? json.data.awards : [] }
  }
  if (isAlreadySigned(retcode)) return { outcome: 'already', retcode, message }
  if (isLoginExpired(retcode)) return { outcome: 'expired', retcode, message }
  if (isCaptcha(retcode)) return { outcome: 'captcha', retcode, message }
  if (NOT_BOUND.has(retcode)) return { outcome: 'not-bound', retcode, message }
  return { outcome: 'error', retcode, message }
}

/**
 * Exchange the long-lived stoken for a fresh cookie_token (and ltoken).
 *
 * Success updates only the fields that were returned; a failing exchange means
 * the stoken itself is dead and only a new scan can restore the session.
 */
export async function refreshCredentials({ config, deviceId, cookies, timeoutMs = 20000 }) {
  const stoken = sessionStoken(cookies)
  if (stoken === null) {
    return { ok: false, reason: 'no-stoken', cookies, message: '没有可续期的 stoken' }
  }
  const stuid = cookies.stuid ?? cookies.ltuid_v2 ?? cookies.ltuid ?? ''
  const mid = cookies.mid ?? cookies.ltmid_v2 ?? cookies.ltmid ?? ''
  // V2 tokens pair with `mid`, V1 tokens with `stuid`; send whichever exists.
  const parts = []
  if (stuid !== '') parts.push(`stuid=${stuid}`)
  if (mid !== '') parts.push(`mid=${mid}`)
  parts.push(`stoken=${stoken}`)
  const headers = {
    ...passportHeaders({ appVersion: config.client.appVersion, deviceId }),
    Cookie: parts.join('; '),
  }
  // The documented call also takes `stoken` and `uid` as query parameters.
  const query = stuid === '' ? '' : `?stoken=${encodeURIComponent(stoken)}&uid=${encodeURIComponent(stuid)}`

  const next = { ...cookies }
  let changed = false
  let reached = false

  try {
    const cookieResponse = await request(
      `${PASSPORT_CN}/account/auth/api/getCookieAccountInfoBySToken${query}`,
      { headers, timeoutMs },
    )
    reached = true
    if (asRetcode(cookieResponse.json) === 0) {
      const token = cookieResponse.json?.data?.cookie_token
      if (typeof token === 'string' && token !== '') {
        if (token.startsWith('v2_')) next.cookie_token_v2 = token
        else next.cookie_token = token
        changed = true
      }
    }
  } catch {
    /* a transport failure must not invalidate stored credentials */
  }

  try {
    const ltokenResponse = await request(
      `${PASSPORT_CN}/account/auth/api/getLTokenBySToken`,
      { headers, timeoutMs },
    )
    reached = true
    if (asRetcode(ltokenResponse.json) === 0) {
      const token = ltokenResponse.json?.data?.ltoken
      if (typeof token === 'string' && token !== '') {
        if (token.startsWith('v2_')) next.ltoken_v2 = token
        else next.ltoken = token
        changed = true
      }
    }
  } catch {
    /* same */
  }

  if (!changed) {
    if (reached === false) {
      return { ok: false, reason: 'network', cookies, message: '续期请求失败（网络原因）' }
    }
    return { ok: false, reason: 'stoken-invalid', cookies, message: 'stoken 续期失败，登录状态已失效' }
  }
  return { ok: true, cookies: next, message: '凭据已续期' }
}

/** Verify a session with the cheapest authenticated call. */
export async function verifySession({ config, deviceId, cookies, timeoutMs = 20000 }) {
  const result = await getRoles({ config, deviceId, cookies, biz: 'hk4e_cn', timeoutMs })
  if (result.ok) return { ok: true }
  if (isLoginExpired(result.retcode)) return { ok: false, reason: 'expired', ...result }
  return { ok: false, reason: 'error', ...result }
}
