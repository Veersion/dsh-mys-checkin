import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { normalizeConfig, defaultConfig, enabledGames } from '../lib/config.js'
import {
  cookieHeader,
  credentialCookies,
  ensureIdentityCookies,
  hasSession,
  parseSetCookie,
  randomToken,
  sessionStoken,
  signDs1,
  signDs2,
} from '../lib/ds.js'

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex')

test('randomToken uses the allowed alphabet', () => {
  const token = randomToken(() => 0.5)
  assert.equal(token.length, 6)
  assert.match(token, /^[A-Za-z0-9]{6}$/)
})

test('signDs1 follows md5("salt=...&t=...&r=...")', () => {
  const salt = 'd9200c846b10886e8c874fc33c8f308b'
  const now = 1_760_000_000_000
  const value = signDs1({ salt, now, token: 'abc123' })
  const t = Math.floor(now / 1000)
  assert.equal(value, `${t},abc123,${md5(`salt=${salt}&t=${t}&r=abc123`)}`)
  assert.match(value, /^\d{10},abc123,[0-9a-f]{32}$/)
})

test('signDs2 folds body and sorted query into the hash', () => {
  const salt = 't0qEgfub6cvueAPgR5m9aQWWVciEer7v'
  const now = 1_760_000_000_000
  const t = Math.floor(now / 1000)
  const value = signDs2({
    salt,
    now,
    body: '{"gids":"1"}',
    query: new URLSearchParams({ b: '2', a: '1' }),
  })
  const [, , hash] = value.split(',')
  // DS2 uses an integer r in [100001, 200000]; recompute with the emitted r.
  const r = value.split(',')[1]
  assert.equal(hash, md5(`salt=${salt}&t=${t}&r=${r}&b={"gids":"1"}&q=a=1&b=2`))
  assert.ok(Number(r) >= 100001 && Number(r) < 200000)
})

test('parseSetCookie keeps only the leading pairs', () => {
  const cookies = parseSetCookie([
    'ltoken_v2=v2_abc==; Path=/; Domain=.miyoushe.com; Secure',
    'ltuid_v2=12345; Path=/',
    'badline',
    'empty=; Path=/',
  ])
  assert.deepEqual(cookies, { ltoken_v2: 'v2_abc==', ltuid_v2: '12345' })
})

test('credentialCookies drops unknown names', () => {
  const kept = credentialCookies({ ltoken_v2: 'a', cookie_token_v2: 'b', tracking: 'c' })
  assert.deepEqual(kept, { ltoken_v2: 'a', cookie_token_v2: 'b' })
  assert.equal(hasSession(kept), true)
  assert.equal(hasSession({ cookie_token_v2: 'b' }), false)
})

test('cookieHeader joins only present values', () => {
  assert.equal(cookieHeader({ ltoken_v2: 'a', ltoken: '', ltuid_v2: '2' }), 'ltoken_v2=a; ltuid_v2=2')
  assert.equal(cookieHeader(null), '')
})

test('sessionStoken treats a blank value as absent', () => {
  assert.equal(sessionStoken({ stoken_v2: 'v2_x' }), 'v2_x')
  assert.equal(sessionStoken({ stoken: 'v1_x' }), 'v1_x')
  assert.equal(sessionStoken({ stoken_v2: '   ' }), null)
  assert.equal(sessionStoken({ ltoken_v2: 'v2_l' }), null)
  assert.equal(sessionStoken(null), null)
})

test('ensureIdentityCookies fills the V1 and V2 aliases without overwriting', () => {
  const cookies = { ltoken: 'v1_l', ltuid_v2: '111', ltmid_v2: 'mid_a' }
  ensureIdentityCookies(cookies, { aid: '111', mid: 'mid_a' })
  assert.equal(cookies.ltuid, '111')
  assert.equal(cookies.account_id, '111')
  assert.equal(cookies.account_id_v2, '111')
  assert.equal(cookies.stuid, '111')
  assert.equal(cookies.mid, 'mid_a')
  assert.equal(cookies.account_mid_v2, 'mid_a')

  const kept = { ltuid: 'keep', account_id: 'keep2' }
  ensureIdentityCookies(kept, { aid: '999' })
  assert.equal(kept.ltuid, 'keep')
  assert.equal(kept.account_id, 'keep2')
})

test('normalizeConfig repairs broken windows instead of throwing', () => {
  const config = normalizeConfig({ windows: [{ start: '25:00', end: '26:00' }, { start: '18:00', end: '18:30' }] })
  assert.deepEqual(config.windows, [{ start: '18:00', end: '18:30' }])
})

test('normalizeConfig snaps an inverted window to one minute', () => {
  const config = normalizeConfig({ windows: [{ start: '19:00', end: '18:00' }] })
  assert.deepEqual(config.windows, [{ start: '19:00', end: '19:01' }])
})

test('normalizeConfig keeps duplicate windows', () => {
  const config = normalizeConfig({ windows: [{ start: '18:00', end: '18:30' }, { start: '18:00', end: '18:30' }] })
  assert.equal(config.windows.length, 2)
  assert.deepEqual(config.windows[0], { start: '18:00', end: '18:30' })
})

test('normalizeConfig clamps an over-long window instead of dropping it', () => {
  const config = normalizeConfig({ windows: [{ start: '10:00', end: '20:00' }] })
  assert.deepEqual(config.windows, [{ start: '10:00', end: '14:00' }])
})

test('normalizeConfig clamps numeric ranges', () => {
  const config = normalizeConfig({ gapMs: { min: 10, max: 10 }, retry: { attempts: 99, delayMs: 1 }, maxQrAgeMs: 5 })
  assert.equal(config.gapMs.min, 500)
  assert.ok(config.gapMs.max >= config.gapMs.min)
  assert.equal(config.retry.attempts, 3)
  assert.equal(config.retry.delayMs, 10000)
  assert.equal(config.maxQrAgeMs, 60000)
})

test('normalizeConfig keeps unknown game ids off', () => {
  const config = normalizeConfig({ games: { genshin: false, starrail: true, nope: true } })
  assert.equal(config.games.genshin, false)
  assert.equal(config.games.starrail, true)
  assert.equal(config.games.nope, undefined)
})

test('enabledGames respects the toggles', () => {
  const ids = enabledGames(defaultConfig()).map((game) => game.id)
  assert.deepEqual(ids, ['genshin', 'starrail', 'zzz', 'honkai3'])
})

/** Run one refresh against a scripted pair of mint answers. */
async function refreshWith(answers) {
  const { refreshCredentials } = await import('../lib/mys.js')
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    seen.push(url)
    const key = url.includes('/getCookieAccountInfoBySToken') ? 'cookie_token' : 'ltoken'
    return new Response(JSON.stringify(answers[key]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await refreshCredentials({
      config: defaultConfig(),
      deviceId: 'device-1',
      cookies: { stoken_v2: 'v2_s', mid: 'mid_1', stuid: '100200300', ltoken: 'v1_l' },
    })
    return { result, seen }
  } finally {
    globalThis.fetch = original
  }
}

test('refreshCredentials reports a retired mint route instead of a dead stoken', async () => {
  const { result, seen } = await refreshWith({
    cookie_token: { retcode: -464, message: '请使用最新版本产品/链接以获得更佳体验。', data: null },
    ltoken: { retcode: 1002, message: '系统请求失败，请返回重试', data: null },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unsupported')
  assert.match(result.message, /停用/)
  assert.match(result.message, /-464/)
  // Both routes are tried, and the stored cookies come back untouched.
  assert.equal(seen.length, 2)
  assert.equal(result.cookies.stoken_v2, 'v2_s')
  assert.equal(result.cookies.ltoken, 'v1_l')
})

test('refreshCredentials still calls a rejected token invalid', async () => {
  const { result } = await refreshWith({
    cookie_token: { retcode: -100, message: '登录状态失效，请重新登录', data: null },
    ltoken: { retcode: -100, message: '登录状态失效，请重新登录', data: null },
  })
  assert.equal(result.reason, 'invalid')
})

test('refreshCredentials keeps the V1 id aliases when the ltoken comes back V1', async () => {
  const { result } = await refreshWith({
    cookie_token: { retcode: 0, message: 'ok', data: { cookie_token: 'v1_cookie' } },
    ltoken: { retcode: 0, message: 'ok', data: { ltoken: 'v1_ltoken' } },
  })
  assert.equal(result.ok, true)
  assert.equal(result.cookies.ltoken, 'v1_ltoken')
  assert.equal(result.cookies.cookie_token, 'v1_cookie')
  assert.equal(result.cookies.ltuid, '100200300')
  assert.equal(result.cookies.account_id, '100200300')
})
