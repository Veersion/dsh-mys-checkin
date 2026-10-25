/**
 * Request signing and the header set every miHoYo endpoint expects.
 *
 * Two signatures exist and the endpoint decides which one applies:
 *   - DS1 (`x-rpc-client_type: 5`) guards the luna check-in endpoints and the
 *     binding query: `md5("salt=<salt>&t=<t>&r=<6 random chars>")`.
 *   - DS2 (`x-rpc-client_type: 2`) guards the BBS app endpoints and folds the
 *     raw body and the sorted query string into the hash.
 *
 * The salt is tied to the advertised app version; both travel in the config so
 * a future client release can be adopted without touching this file.
 */
import { createHash, randomInt } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** Six-character random token used by DS1. */
export function randomToken(random = Math.random) {
  let out = ''
  for (let index = 0; index < 6; index += 1) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length]
  }
  return out
}

function md5(text) {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

/** Build one DS1 header value: `<t>,<r>,<md5>`. */
export function signDs1({ salt, now = Date.now(), random = Math.random, token }) {
  const t = Math.floor(now / 1000)
  const r = token ?? randomToken(random)
  const hash = md5(`salt=${salt}&t=${t}&r=${r}`)
  return `${t},${r},${hash}`
}

/** Build one DS2 header value: `<t>,<r>,<md5>` over body and sorted query. */
export function signDs2({ salt, body = '', query = '', now = Date.now(), random = Math.random }) {
  const t = Math.floor(now / 1000)
  const r = randomInt(100001, 200000)
  const sortedQuery = query instanceof URLSearchParams ? [...query.entries()].sort(([a], [b]) => a.localeCompare(b)) : query
  const queryText = Array.isArray(sortedQuery)
    ? sortedQuery.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
    : String(sortedQuery)
  const hash = md5(`salt=${salt}&t=${t}&r=${r}&b=${body}&q=${queryText}`)
  return `${t},${r},${hash}`
}

/** The mobile-app user agent matching the advertised client version. */
export function appUserAgent(appVersion) {
  return `Mozilla/5.0 (Linux; Android 12; Unspecified Device) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/103.0.5060.129 Mobile Safari/537.36 miHoYoBBS/${appVersion}`
}

/**
 * Headers for a takumi/act API call.
 *
 * `signgame` is only sent for the games that require it; the others reject an
 * unknown value far more often than a missing one.
 */
export function apiHeaders({ config, deviceId, signature, cookie, signgame, deviceFp }) {
  const { appVersion } = config.client
  const { name, model, sysVersion, channel } = config.device
  const headers = {
    'User-Agent': appUserAgent(appVersion),
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    DS: signature,
    'x-rpc-app_version': appVersion,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': deviceId,
    'x-rpc-device_name': name,
    'x-rpc-device_model': model,
    'x-rpc-sys_version': sysVersion,
    'x-rpc-channel': channel,
    'x-rpc-platform': 'android',
    Origin: 'https://act.mihoyo.com',
    Referer: 'https://act.mihoyo.com/',
    'X-Requested-With': 'com.mihoyo.hyperion',
  }
  if (typeof signgame === 'string' && signgame !== '') headers['x-rpc-signgame'] = signgame
  if (typeof deviceFp === 'string' && deviceFp !== '') headers['x-rpc-device_fp'] = deviceFp
  if (typeof cookie === 'string' && cookie !== '') headers.Cookie = cookie
  return headers
}

/** Headers for the passport web QR-login flow. */
export function passportHeaders({ appVersion, deviceId, cookie }) {
  const headers = {
    'User-Agent': appUserAgent(appVersion),
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Content-Type': 'application/json',
    'x-rpc-app_id': 'bll8iq97cem8',
    'x-rpc-client_type': '4',
    'x-rpc-device_id': deviceId,
    'x-rpc-app_version': appVersion,
    'x-rpc-channel': 'miyousheluodi',
    'x-rpc-sys_version': '12',
  }
  if (typeof cookie === 'string' && cookie !== '') headers.Cookie = cookie
  return headers
}

/** Serialize a cookie map into a `Cookie` header value. */
export function cookieHeader(cookies) {
  if (cookies === null || typeof cookies !== 'object') return ''
  return Object.entries(cookies)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/**
 * Parse `Set-Cookie` lines into a name/value map.
 *
 * The attribute tail is dropped; values may legally contain `=`, so only the
 * first separator splits each line.
 */
export function parseSetCookie(lines) {
  const cookies = {}
  for (const line of lines ?? []) {
    if (typeof line !== 'string') continue
    const head = line.split(';', 1)[0]
    const index = head.indexOf('=')
    if (index <= 0) continue
    const name = head.slice(0, index).trim()
    const value = head.slice(index + 1).trim()
    if (name === '' || value === '') continue
    cookies[name] = value
  }
  return cookies
}

/** The subset of cookie names that carry session credentials. */
export const CREDENTIAL_COOKIES = [
  'ltoken_v2',
  'ltoken',
  'ltuid_v2',
  'ltuid',
  'ltmid_v2',
  'ltmid',
  'stoken_v2',
  'stoken',
  'stuid',
  'mid',
  'cookie_token_v2',
  'cookie_token',
  'account_id_v2',
  'account_mid_v2',
  'account_id',
  'login_ticket',
  'login_uid',
]

/** Keep only credential cookies, so unrelated tracking cookies stay out of the file. */
export function credentialCookies(cookies) {
  const kept = {}
  for (const name of CREDENTIAL_COOKIES) {
    const value = cookies?.[name]
    if (typeof value === 'string' && value !== '') kept[name] = value
  }
  return kept
}

/** `true` when the cookie map still carries a usable session token. */
export function hasSession(cookies) {
  if (cookies === null || typeof cookies !== 'object') return false
  const ltoken = cookies.ltoken_v2 ?? cookies.ltoken
  return typeof ltoken === 'string' && ltoken !== ''
}

/**
 * The long-lived stoken carried by the cookie map, or `null` when absent.
 *
 * A blank value counts as absent: an empty string would otherwise make the UI
 * claim the session can be renewed while every refresh call fails with -100.
 */
export function sessionStoken(cookies) {
  if (cookies === null || typeof cookies !== 'object') return null
  const stoken = cookies.stoken_v2 ?? cookies.stoken
  return typeof stoken === 'string' && stoken.trim() !== '' ? stoken : null
}

/**
 * Keep every ID cookie the token families can pair with.
 *
 * V1 tokens (`ltoken`, `cookie_token`) authenticate with `ltuid` / `account_id`;
 * V2 tokens pair with `ltmid_v2` / `account_mid_v2`. The passport returns only
 * part of that set (the App QR flow returns the V2 ids plus a V1 ltoken derived
 * from the stoken), which makes luna endpoints answer -100. Mirroring the known
 * account id into the missing aliases keeps both families usable.
 */
export function ensureIdentityCookies(cookies, { aid, mid } = {}) {
  if (cookies === null || typeof cookies !== 'object') return cookies
  const uid = typeof aid === 'string' && aid !== '' ? aid : null
  const accountMid = typeof mid === 'string' && mid !== '' ? mid : null
  if (uid !== null) {
    for (const name of ['ltuid', 'ltuid_v2', 'account_id', 'account_id_v2', 'stuid']) {
      if (cookies[name] === undefined) cookies[name] = uid
    }
  }
  if (accountMid !== null) {
    for (const name of ['mid', 'ltmid_v2', 'account_mid_v2']) {
      if (cookies[name] === undefined) cookies[name] = accountMid
    }
  }
  return cookies
}
