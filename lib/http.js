/**
 * Minimal JSON-over-HTTP client.
 *
 * Node's global `fetch` already handles TLS, proxies from the environment, and
 * decompression; this wrapper adds the three things every miHoYo call needs:
 * a hard timeout, capture of `Set-Cookie`, and one jittered retry for transport
 * failures (never for an HTTP error status — a refusal must not be retried).
 */

export class HttpError extends Error {
  constructor(message, { url, status, body, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'HttpError'
    this.url = url
    this.status = status
    this.body = body
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Perform one request and decode the JSON body when there is one.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method] - HTTP verb, default GET.
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body] - already-serialized request body.
 * @param {number} [options.timeoutMs] - per-attempt timeout.
 * @param {number} [options.retries] - transport-failure retries.
 * @param {() => number} [options.random] - jitter source.
 * @returns {Promise<{status: number, ok: boolean, headers: Headers, setCookies: string[], text: string, json: any}>}
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    retries = 1,
    random = Math.random,
  } = options

  let attempt = 0
  let lastError
  while (attempt <= retries) {
    attempt += 1
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      let json
      try {
        json = text === '' ? undefined : JSON.parse(text)
      } catch {
        json = undefined
      }
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : []
      return { status: response.status, ok: response.ok, headers: response.headers, setCookies, text, json }
    } catch (error) {
      lastError = error
      if (attempt > retries) break
      // Transport jitter keeps repeated attempts from arriving in lockstep.
      await sleep(600 + Math.floor(random() * 900))
    }
  }
  const reason = lastError?.name === 'TimeoutError' ? '请求超时' : String(lastError?.message ?? lastError)
  throw new HttpError(`${reason}（${method} ${url}）`, { url, cause: lastError })
}

/** Sleep helper shared by the pacing code. */
export { sleep }
