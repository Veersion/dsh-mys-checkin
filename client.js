/**
 * Browser half of the 米游社 check-in plugin.
 *
 * Registers one Settings section ("米游社") and talks to its host half over
 * four owner-only routes. The cookie never crosses this boundary: the page only
 * ever sees "logged in / expired", the schedule, and the last run's results.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mys-checkin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    // DSH's own atoms: reusing them keeps every button and switch identical to
    // the built-in settings pages instead of approximating their look.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    const PrimitiveButton = typeof primitives?.Button === 'function' ? primitives.Button : null
    const PrimitiveSwitch = typeof primitives?.Switch === 'function' ? primitives.Switch : null

    const PLUGIN_ID = '@local/dsh-mys-checkin'
    const NS = 'mys-checkin'

    const CSS = `
.mys-section{max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.mys-head{display:flex;flex-direction:column;gap:4px}
.mys-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.mys-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.mys-card{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.mys-card-head{display:flex;align-items:flex-start;gap:12px}
.mys-card-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.mys-card-title{font-size:14px;font-weight:600;line-height:22px}
.mys-card-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mys-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.mys-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease,border-color .12s ease}
.mys-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:2px}
.mys-btn[disabled]{opacity:.5;cursor:default}
.mys-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm,6px)}
.mys-btn-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}
.mys-btn-outline:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.mys-btn-primary{border:.5px solid transparent;background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
.mys-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,#3f5ae0)}
.mys-btn-ghost{border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-primary)}
.mys-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.mys-danger-text{color:var(--dsw-alias-state-error-primary,#d93026)}
.mys-account{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;line-height:20px;flex:1;min-width:0}
.mys-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#8a919e)}
.mys-dot[data-state=active]{background:#22a06b}
.mys-dot[data-state=expired]{background:#d93026}
.mys-meta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mys-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mys-row-label{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.mys-row-title{font-size:13px;line-height:20px}
.mys-row-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mys-row input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-button-primary-fill,#4d6bfe)}
.mys-switch{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;padding:0;border:none;border-radius:999px;cursor:pointer;background:var(--dsw-alias-bg-layer-3,#d9dde3);transition:background .15s ease}
.mys-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,#4d8dff)}
.mys-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d8dff);outline-offset:2px}
.mys-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s ease}
.mys-switch[aria-checked=true] .mys-knob{transform:translateX(16px)}
.mys-window{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mys-time{box-sizing:border-box;font:inherit;font-size:12px;height:28px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary)}
.mys-time:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:1px}
.mys-banner{box-sizing:border-box;border-radius:10px;padding:10px 12px;font-size:13px;line-height:20px;display:flex;flex-direction:column;gap:6px;border:.5px solid transparent}
.mys-banner[data-tone=error]{background:rgba(217,48,38,.08);border-color:rgba(217,48,38,.35);color:var(--dsw-alias-state-error-primary,#a3231c)}
.mys-banner[data-tone=warn]{background:rgba(214,148,0,.1);border-color:rgba(214,148,0,.35);color:var(--dsw-alias-state-warning-primary,#8a5b00)}
.mys-banner[data-tone=ok]{background:rgba(34,160,107,.1);border-color:rgba(34,160,107,.3);color:#177a50}
.mys-banner-actions{display:flex;gap:8px;flex-wrap:wrap}
.mys-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.mys-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mys-input{box-sizing:border-box;font:inherit;font-size:12px;height:28px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);width:100%}
.mys-input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:1px}
.mys-table{width:100%;border-collapse:collapse;font-size:12px}
.mys-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.mys-table td{padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.mys-tag{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,#eceff3);color:var(--dsw-alias-label-secondary,#4b5563)}
.mys-tag[data-tone=ok]{background:rgba(34,160,107,.15);color:#177a50}
.mys-tag[data-tone=warn]{background:rgba(214,148,0,.15);color:#8a5b00}
.mys-tag[data-tone=error]{background:rgba(217,48,38,.13);color:#a3231c}
.mys-logs{max-height:200px;overflow:auto;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.mys-log{display:flex;gap:8px}
.mys-log-time{color:var(--dsw-alias-label-tertiary);flex:none}
.mys-log[data-level=warn] .mys-log-text{color:#8a5b00}
.mys-log[data-level=error] .mys-log-text{color:#a3231c}
.mys-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mys-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);padding:24px}
.mys-dialog{box-sizing:border-box;width:min(380px,100%);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 60px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary)}
.mys-dialog-title{margin:0;font-size:16px;font-weight:600}
.mys-qr{display:flex;align-items:center;justify-content:center;padding:8px;background:#fff;border-radius:10px;min-height:232px}
.mys-qr img{width:232px;height:232px;display:block;image-rendering:pixelated}
.mys-qr-state{font-size:13px;line-height:20px;text-align:center;color:var(--dsw-alias-label-secondary,#4b5563)}
.mys-dialog-foot{display:flex;gap:8px;justify-content:flex-end}
.mys-details{font-size:13px}
.mys-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#4b5563);font-size:13px;line-height:22px}
.mys-details[open] summary{margin-bottom:8px}
.mys-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mys-list{display:flex;flex-direction:column;gap:8px}
.mys-badge{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:55;display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 32px));box-sizing:border-box;padding:6px 10px;border-radius:999px;font-size:12px;line-height:18px;background:#a3231c;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:auto}
.mys-badge-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mys-badge-close{flex:none;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.8;padding:0 2px}
.mys-badge-close:hover{opacity:1}
`

    const zh = {
      nav: '米游社',
      title: '米游社签到',
      intro: '每天在你设定的时间窗口内随机挑一个时刻，为已绑定的米哈游游戏自动签到。登录凭据只保存在本机。',
      account: '账号',
      accountDesc: '使用米游社 App 扫码登录；登录失效时会在这里提示。',
      login: '扫码登录',
      relogin: '重新扫码',
      refresh: '续期凭据',
      refreshing: '续期中…',
      logout: '退出登录',
      stateAnonymous: '未登录',
      stateActive: '已登录',
      stateExpired: '登录已失效',
      uid: 'UID',
      loginAt: '登录于',
      lastRefresh: '最近续期',
      never: '从未',
      qrTitle: '扫码登录米游社',
      qrHint: '打开米游社 App → 右上角扫一扫 → 确认登录。二维码仅在本机生成，不上传。',
      qrPending: '等待扫码…',
      qrScanned: '已扫码，请在手机上确认',
      qrConfirmed: '登录成功，正在校验…',
      qrExpired: '二维码已过期',
      qrRefresh: '刷新二维码',
      qrCancel: '取消',
      qrChecking: '正在生成二维码…',
      auto: '自动签到',
      autoDesc: '开启后，每天只在时间窗口内执行一次；随机时刻可以避免整点请求特征。',
      enabled: '启用自动签到',
      windows: '时间窗口',
      windowsDesc: '每个窗口内随机选择一个时刻执行。填写本地时间。',
      addWindow: '添加窗口',
      remove: '删除',
      runWhenMissed: '错过窗口后补跑',
      runWhenMissedDesc: '如果 DSH 在窗口结束后才启动，且当天还没签过，则在几分钟内随机补跑一次。',
      nextRun: '下次执行',
      noPlan: '未安排（自动签到未启用）',
      timezone: '时区',
      games: '游戏',
      gamesDesc: '只给勾选的游戏签到；角色信息在首次签到或检测时读取。',
      notQueried: '尚未读取角色',
      noRole: '无角色',
      bound: '已绑定',
      actions: '手动操作',
      actionsDesc: '签到结果会显示在下方，并写入运行日志。',
      runNow: '立即签到',
      running: '签到中…',
      verify: '检测接口与登录',
      verifying: '检测中…',
      result: '最近一次结果',
      resultDesc: '按游戏列出本次签到结果。',
      colTime: '时间',
      colGame: '游戏',
      colResult: '结果',
      colDetail: '说明',
      noResult: '今天还没有运行记录。',
      advanced: '高级设置',
      gap: '游戏间隔（秒）',
      gapMin: '最小',
      gapMax: '最大',
      appVersion: '客户端版本',
      appVersionDesc: '与签名 salt 必须匹配；米哈游更新客户端后可能需要同步修改。',
      salt: '签名 salt',
      retry: '失败重试',
      retryAttempts: '重试次数',
      retryDelay: '重试间隔（秒）',
      qrAge: '二维码有效期（秒）',
      logs: '运行日志',
      logsEmpty: '暂无日志。',
      saveOk: '已保存',
      saveFail: '保存失败',
      saveFailed: '保存失败：{message}',
      loadFailed: '无法连接插件宿主端：{message}',
      hostMissing: '插件宿主端未加载。请重新加载页面；若仍无效，重启 DSH。',
      bannerExpired: '登录状态已失效，自动签到无法继续。',
      bannerCaptcha: '米游社要求人机验证，今日已停止自动签到。',
      bannerRun: '最近一次签到失败。',
      retryRun: '重试签到',
      verifyOk: '接口可用，登录有效（{ms}ms）',
      verifyAnon: '尚未登录，无法检测登录状态。',
      verifyFail: '网络不可达：{message}',
      verifyInvalid: '接口可用，但登录无效：{message}',
      detectorOk: '二维码自检通过（浏览器可识别）',
      detectorFail: '浏览器未能识别该二维码，建议刷新二维码后重试',
      detectorUnavailable: '浏览器未提供二维码自检能力',
      riskTitle: '降低被风控的建议',
      riskList: '1) 每天只签一次，不要频繁手动补签。2) 保持固定的 device_id：本插件首次运行后不再更改，请不要删除状态文件。3) 不要在同一台机器上用同一个 DSH 反复登录多个账号。4) 触发验证码时先在米游社 App 内手动完成，不要连续重试。5) 网络出口尽量稳定，避免频繁更换 IP 或代理。',
      outcomeSigned: '成功',
      outcomeAlready: '今日已签到',
      outcomeNoRole: '无角色',
      outcomeCaptcha: '需验证',
      outcomeExpired: '登录失效',
      outcomeNotBound: '未绑定',
      outcomeError: '失败',
      reasonWindow: '窗口内随机',
      reasonInside: '当前窗口内',
      reasonMissed: '错过窗口，补跑',
      reasonDoneToday: '今日已完成，等待明天',
      reasonPassed: '今日窗口已过',
      enabledOn: '开',
      enabledOff: '关',
      save: '保存',
      saving: '保存中…',
      lastRun: '上次执行',
      gamesCount: '{count} 个游戏',
      badgeExpired: '米游社：登录已失效，签到已停止',
      badgeCaptcha: '米游社：需要人机验证，今日签到已停止',
      badgeRun: '米游社：自动签到失败',
      badgeDismiss: '忽略本次提示',
      badgeOpen: '在「设置 → 米游社」中处理',
    }

    const en = {
      nav: 'miHoYo',
      title: 'miHoYo check-in',
      intro: 'Signs in to your bound miHoYo games once a day at a random moment inside your windows. Credentials stay on this machine.',
      account: 'Account',
      accountDesc: 'Scan the QR code with the miHoYo app. Expiry is reported here.',
      login: 'Scan to sign in',
      relogin: 'Scan again',
      refresh: 'Refresh credentials',
      refreshing: 'Refreshing…',
      logout: 'Sign out',
      stateAnonymous: 'Not signed in',
      stateActive: 'Signed in',
      stateExpired: 'Session expired',
      uid: 'UID',
      loginAt: 'Signed in',
      lastRefresh: 'Last refresh',
      never: 'never',
      qrTitle: 'Sign in to miHoYo',
      qrHint: 'Open the miHoYo app → Scan → Confirm. The QR code is generated locally.',
      qrPending: 'Waiting for scan…',
      qrScanned: 'Scanned — confirm on your phone',
      qrConfirmed: 'Signed in, verifying…',
      qrExpired: 'The QR code expired',
      qrRefresh: 'New QR code',
      qrCancel: 'Cancel',
      qrChecking: 'Generating QR code…',
      auto: 'Automatic check-in',
      autoDesc: 'Runs once a day inside a window; the random moment avoids on-the-hour patterns.',
      enabled: 'Enable automatic check-in',
      windows: 'Time windows',
      windowsDesc: 'One random moment inside each window. Local time.',
      addWindow: 'Add window',
      remove: 'Remove',
      runWhenMissed: 'Catch up when missed',
      runWhenMissedDesc: 'If DSH starts after the window and nothing ran today, run once a few minutes later.',
      nextRun: 'Next run',
      noPlan: 'Not scheduled (automatic check-in is off)',
      timezone: 'Time zone',
      games: 'Games',
      gamesDesc: 'Only checked games are signed. Roles are read on the first run or check.',
      notQueried: 'Roles not read yet',
      noRole: 'No character',
      bound: 'Bound',
      actions: 'Manual actions',
      actionsDesc: 'Results appear below and in the run log.',
      runNow: 'Check in now',
      running: 'Checking in…',
      verify: 'Test connection and session',
      verifying: 'Testing…',
      result: 'Last result',
      resultDesc: 'Per-game outcome of the last run.',
      colTime: 'Time',
      colGame: 'Game',
      colResult: 'Result',
      colDetail: 'Detail',
      noResult: 'Nothing has run today yet.',
      advanced: 'Advanced',
      gap: 'Gap between games (s)',
      gapMin: 'min',
      gapMax: 'max',
      appVersion: 'Client version',
      appVersionDesc: 'Must match the signature salt. Update after a client release.',
      salt: 'Signature salt',
      retry: 'Retry',
      retryAttempts: 'Attempts',
      retryDelay: 'Delay (s)',
      qrAge: 'QR lifetime (s)',
      logs: 'Run log',
      logsEmpty: 'No log entries yet.',
      saveOk: 'Saved',
      saveFail: 'Save failed',
      saveFailed: 'Save failed: {message}',
      loadFailed: 'Cannot reach the plugin host: {message}',
      hostMissing: 'The plugin host is not loaded. Reload the page, and restart DSH if this persists.',
      bannerExpired: 'The session expired; automatic check-in cannot continue.',
      bannerCaptcha: 'miHoYo asked for human verification; today\'s run stopped.',
      bannerRun: 'The last check-in failed.',
      retryRun: 'Retry',
      verifyOk: 'API reachable, session valid ({ms}ms)',
      verifyAnon: 'Not signed in; nothing to verify.',
      verifyFail: 'Network unreachable: {message}',
      verifyInvalid: 'API reachable but the session is invalid: {message}',
      detectorOk: 'QR self-check passed (decoded by the browser)',
      detectorFail: 'The browser could not decode this QR code; refresh it',
      detectorUnavailable: 'This browser offers no QR self-check',
      riskTitle: 'Lowering risk-control flags',
      riskList: '1) One run per day; avoid repeated manual retries. 2) Keep the device id stable: it never changes after first use, so do not delete the state file. 3) Do not sign several accounts in from the same device. 4) When a captcha appears, clear it in the miHoYo app instead of retrying. 5) Keep the network egress stable; avoid hopping IPs or proxies.',
      outcomeSigned: 'Signed',
      outcomeAlready: 'Already signed',
      outcomeNoRole: 'No character',
      outcomeCaptcha: 'Needs verification',
      outcomeExpired: 'Session expired',
      outcomeNotBound: 'Not bound',
      outcomeError: 'Failed',
      reasonWindow: 'random in window',
      reasonInside: 'inside window',
      reasonMissed: 'catch-up run',
      reasonDoneToday: 'done today, waiting for tomorrow',
      reasonPassed: 'window passed',
      enabledOn: 'on',
      enabledOff: 'off',
      save: 'Save',
      saving: 'Saving…',
      lastRun: 'Last run',
      gamesCount: '{count} games',
      badgeExpired: 'miHoYo: session expired — check-in stopped',
      badgeCaptcha: 'miHoYo: human verification required',
      badgeRun: 'miHoYo: automatic check-in failed',
      badgeDismiss: 'Dismiss this notice',
      badgeOpen: 'Resolve it in Settings → miHoYo',
    }

    const OUTCOME_TONE = {
      signed: 'ok',
      already: 'ok',
      'no-role': '',
      captcha: 'warn',
      expired: 'error',
      'not-bound': 'warn',
      error: 'error',
    }

    const OUTCOME_KEY = {
      signed: 'outcomeSigned',
      already: 'outcomeAlready',
      'no-role': 'outcomeNoRole',
      captcha: 'outcomeCaptcha',
      expired: 'outcomeExpired',
      'not-bound': 'outcomeNotBound',
      error: 'outcomeError',
    }

    function apiUrl(path) {
      return new URL(`api/mys/${path}`, document.baseURI).href
    }

    async function requestJson(path, init) {
      const response = await fetch(apiUrl(path), {
        credentials: 'include',
        cache: 'no-store',
        ...init,
      })
      const text = await response.text()
      if (text.trim() === '') {
        if (response.status === 404) throw new Error('host-missing')
        throw new Error(`HTTP ${response.status}`)
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      return body
    }

    async function callJson(path, init) {
      const body = await requestJson(path, init)
      if (body !== null && typeof body === 'object' && body.ok === false) {
        throw new Error(body.error?.message ?? 'request failed')
      }
      return body
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Date(value).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return new Date(value).toISOString()
      }
    }

    function formatTarget(value, timeZone) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          timeZone,
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(value))
      } catch {
        return formatTime(value)
      }
    }

    function shortTime(value) {
      const text = formatTime(value)
      return text.replace(/^\d{4}[/-]/, '')
    }

    /**
     * One action button.
     *
     * `variant` is the plugin's vocabulary (`primary` / `danger` / `outline`);
     * it maps onto DSH's own variants, and the built-in Button renders it.
     * Without the primitives module (older shell) the fallback keeps the same
     * geometry so the row layout does not jump.
     */
    function Button({ variant = 'outline', size = 'md', className, children, ...rest }) {
      const mapped = variant === 'primary' ? 'primary' : variant === 'danger' ? 'ghost' : 'outline'
      const extra = variant === 'danger' ? 'mys-danger-text' : undefined
      const merged = [extra, className].filter(Boolean).join(' ')
      if (PrimitiveButton !== null) {
        return h(PrimitiveButton, {
          variant: mapped,
          size,
          ...(merged === '' ? {} : { className: merged }),
          ...rest,
          children,
        })
      }
      return h('button', {
        type: 'button',
        ...rest,
        className: ['mys-btn', `mys-btn-${mapped}`, size === 'sm' ? 'mys-btn-sm' : '', merged].filter(Boolean).join(' '),
        children,
      })
    }

    /** Fallback switch, used only when the shell has no primitives module. */
    function FallbackSwitch({ checked, onChange, label, disabled }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        disabled: disabled === true,
        className: 'mys-switch',
        onClick: () => onChange(!checked),
      }, h('span', { className: 'mys-knob', 'aria-hidden': true }))
    }

    function Switch(props) {
      if (PrimitiveSwitch !== null) {
        return h(PrimitiveSwitch, {
          checked: props.checked === true,
          label: props.label,
          ...(props.disabled === true ? { disabled: true } : {}),
          onChange: props.onChange,
        })
      }
      return h(FallbackSwitch, props)
    }

    function Card({ title, desc, children }) {
      return h('section', { className: 'mys-card' },
        (title || desc) ? h('div', { className: 'mys-card-head' },
          h('div', { className: 'mys-card-head-text' },
            title ? h('div', { className: 'mys-card-title' }, title) : null,
            desc ? h('div', { className: 'mys-card-desc' }, desc) : null),
          null) : null,
        children)
    }

    function StatusDot({ state }) {
      return h('span', { className: 'mys-dot', 'data-state': state, 'aria-hidden': true })
    }

    function useDetector(src) {
      const [state, setState] = useState('idle')
      useEffect(() => {
        if (!src) return undefined
        if (typeof BarcodeDetector === 'undefined') {
          setState('unavailable')
          return undefined
        }
        let cancelled = false
        const image = new Image()
        image.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const context = canvas.getContext('2d')
          if (context === null) {
            setState('unavailable')
            return
          }
          context.drawImage(image, 0, 0)
          let detector
          try {
            detector = new BarcodeDetector({ formats: ['qr_code'] })
          } catch {
            setState('unavailable')
            return
          }
          detector.detect(canvas)
            .then((codes) => {
              if (!cancelled) setState(codes.length > 0 ? 'ok' : 'fail')
            })
            .catch(() => {
              if (!cancelled) setState('fail')
            })
        }
        image.onerror = () => {
          if (!cancelled) setState('fail')
        }
        image.src = src
        return () => {
          cancelled = true
        }
      }, [src])
      return state
    }

    function QrDialog({ t, session, onRefresh, onClose, detector }) {
      const state = session.state
      const label = state === 'scanned' ? t('qrScanned')
        : state === 'expired' ? t('qrExpired')
        : state === 'confirmed' ? t('qrConfirmed')
        : state === 'error' ? (session.message ?? t('qrExpired'))
        : t('qrPending')
      return h('div', {
        className: 'mys-overlay',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('qrTitle'),
        onClick: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      }, h('div', { className: 'mys-dialog' },
        h('h3', { className: 'mys-dialog-title' }, t('qrTitle')),
        h('div', { className: 'mys-qr' }, h('img', { src: session.src, alt: t('qrTitle') })),
        h('div', { className: 'mys-qr-state' }, label),
        h('div', { className: 'mys-hint' }, t('qrHint')),
        detector === 'ok' ? h('div', { className: 'mys-hint' }, t('detectorOk')) : null,
        detector === 'fail' ? h('div', { className: 'mys-banner', 'data-tone': 'warn' }, t('detectorFail')) : null,
        h('div', { className: 'mys-dialog-foot' },
          state === 'expired' ? h(Button, { variant: 'primary', onClick: onRefresh }, t('qrRefresh')) : null,
          h(Button, { onClick: onClose }, t('qrCancel')))))
    }

    const BADGE_DISMISS_KEY = 'dsh.mys-checkin.dismissed-at'

    /** Frame-wide status pill: shows when the last run failed, until dismissed. */
    function OverlayBadge({ t }) {
      const [lastError, setLastError] = useState(null)
      const [dismissed, setDismissed] = useState(() => {
        try {
          return window.localStorage.getItem(BADGE_DISMISS_KEY)
        } catch {
          return null
        }
      })

      useEffect(() => {
        let stopped = false
        let timer
        const tick = async () => {
          try {
            const body = await requestJson('status')
            if (!stopped) setLastError(body?.lastError ?? null)
          } catch {
            if (!stopped) setLastError(null)
          }
          if (!stopped) timer = setTimeout(tick, 60000)
        }
        timer = setTimeout(tick, 4000)
        return () => {
          stopped = true
          clearTimeout(timer)
        }
      }, [])

      if (lastError === null || lastError === undefined) return null
      const at = String(lastError.at ?? '')
      if (dismissed === at) return null
      const text = lastError.code === 'LOGIN_EXPIRED'
        ? t('badgeExpired')
        : lastError.code === 'CAPTCHA'
          ? t('badgeCaptcha')
          : t('badgeRun')
      return h('div', { className: 'mys-badge', role: 'status', title: t('badgeOpen') },
        h('span', { className: 'mys-badge-text' }, text),
        h('button', {
          type: 'button',
          className: 'mys-badge-close',
          'aria-label': t('badgeDismiss'),
          onClick: () => {
            setDismissed(at)
            try {
              window.localStorage.setItem(BADGE_DISMISS_KEY, at)
            } catch {
              /* private mode */
            }
          },
        }, '×'))
    }

    function Section({ t }) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [draft, setDraft] = useState(null)
      const [qr, setQr] = useState(null)
      const [busy, setBusy] = useState({ login: false, run: false, verify: false, refresh: false })
      const [verifyInfo, setVerifyInfo] = useState(null)
      const detector = useDetector(qr?.src)
      const dirtyRef = useRef(false)
      const saveTimerRef = useRef(null)
      const runningRef = useRef(false)
      const draftRef = useRef(null)

      useEffect(() => {
        runningRef.current = status?.running === true
      }, [status?.running])

      const refresh = useCallback(async () => {
        try {
          const data = await callJson('status')
          setStatus(data)
          setError(null)
          if (!dirtyRef.current && data.config) {
            draftRef.current = data.config
            setDraft(data.config)
          }
        } catch (failure) {
          const message = String(failure?.message ?? failure)
          setError(message === 'host-missing' ? 'host-missing' : message)
        }
      }, [])

      useEffect(() => {
        let stopped = false
        let timer
        const tick = async () => {
          await refresh()
          if (stopped) return
          timer = setTimeout(tick, runningRef.current ? 1500 : 4000)
        }
        void tick()
        return () => {
          stopped = true
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [refresh])

      useEffect(() => () => {
        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
      }, [])

      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 2600)
        return () => clearTimeout(timer)
      }, [notice])

      const scheduleSave = useCallback((next) => {
        dirtyRef.current = true
        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(async () => {
          saveTimerRef.current = null
          try {
            await callJson('config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ config: next }),
            })
            dirtyRef.current = false
            setNotice(t('saveOk'))
            void refresh()
          } catch (failure) {
            setNotice(fill(t('saveFailed'), { message: String(failure?.message ?? failure) }))
          }
        }, 650)
      }, [refresh, t])

      const patchDraft = useCallback((mutate) => {
        if (draftRef.current === null) return
        const next = mutate(structuredClone(draftRef.current))
        draftRef.current = next
        setDraft(next)
        scheduleSave(next)
      }, [scheduleSave])

      const startLogin = useCallback(async () => {
        setBusy((current) => ({ ...current, login: true }))
        try {
          const data = await callJson('login/start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          setQr({ ticket: data.ticket, src: data.qr, state: 'pending' })
        } catch (failure) {
          setNotice(fill(t('saveFailed'), { message: String(failure?.message ?? failure) }))
        } finally {
          setBusy((current) => ({ ...current, login: false }))
        }
      }, [t])

      useEffect(() => {
        if (qr === null) return undefined
        let stopped = false
        let finished = false
        let timer
        const tick = async () => {
          try {
            const body = await requestJson(`login/poll?ticket=${encodeURIComponent(qr.ticket)}`)
            if (stopped) return
            if (body.state === 'confirmed') {
              finished = true
              setQr(null)
              setNotice(t('qrConfirmed'))
              void refresh()
            } else if (body.state === 'expired') {
              finished = true
              setQr((current) => (current === null ? null : { ...current, state: 'expired' }))
            } else if (body.state === 'error') {
              finished = true
              setQr((current) => (current === null ? null : { ...current, state: 'error', message: body.error?.message }))
            } else {
              setQr((current) => (current === null ? null : { ...current, state: body.state }))
            }
          } catch (failure) {
            if (!stopped) {
              finished = true
              setQr((current) => (current === null ? null : { ...current, state: 'error', message: String(failure?.message ?? failure) }))
            }
          } finally {
            if (!stopped && !finished) timer = setTimeout(tick, 2200)
          }
        }
        timer = setTimeout(tick, 900)
        return () => {
          stopped = true
          clearTimeout(timer)
        }
      }, [qr?.ticket])

      const cancelLogin = useCallback(async () => {
        setQr(null)
        try {
          await callJson('login/cancel', { method: 'POST', body: '{}' })
        } catch {
          /* the local dialog is closed either way */
        }
      }, [])

      const logout = useCallback(async () => {
        try {
          await callJson('logout', { method: 'POST', body: '{}' })
          setVerifyInfo(null)
          setNotice(t('logout'))
          void refresh()
        } catch (failure) {
          setNotice(fill(t('saveFailed'), { message: String(failure?.message ?? failure) }))
        }
      }, [refresh, t])

      const runNow = useCallback(async () => {
        setBusy((current) => ({ ...current, run: true }))
        try {
          await callJson('run', { method: 'POST', body: '{}' })
          void refresh()
        } catch (failure) {
          setNotice(fill(t('saveFailed'), { message: String(failure?.message ?? failure) }))
        } finally {
          setBusy((current) => ({ ...current, run: false }))
        }
      }, [refresh, t])

      const refreshCredentials = useCallback(async () => {
        setBusy((current) => ({ ...current, refresh: true }))
        try {
          await callJson('refresh', { method: 'POST', body: '{}' })
          setNotice(t('saveOk'))
          void refresh()
        } catch (failure) {
          setNotice(fill(t('saveFailed'), { message: String(failure?.message ?? failure) }))
        } finally {
          setBusy((current) => ({ ...current, refresh: false }))
        }
      }, [refresh, t])

      const verify = useCallback(async () => {
        setBusy((current) => ({ ...current, verify: true }))
        try {
          const data = await callJson('verify', { method: 'POST', body: '{}' })
          setVerifyInfo(data)
        } catch (failure) {
          setVerifyInfo({ reachable: false, message: String(failure?.message ?? failure) })
        } finally {
          setBusy((current) => ({ ...current, verify: false }))
        }
      }, [t])

      const config = draft
      const games = status?.games ?? []
      const lastResult = status?.lastResult ?? null
      const lastError = status?.lastError ?? null

      if (error === 'host-missing') {
        return h('div', { className: 'mys-section' },
          h('div', { className: 'mys-head' },
            h('h2', { className: 'mys-title' }, t('title')),
            h('p', { className: 'mys-intro' }, t('intro'))),
          h('div', { className: 'mys-banner', 'data-tone': 'error' }, t('hostMissing')))
      }

      const banner = lastError === null ? null : (() => {
        const code = lastError.code
        if (code === 'LOGIN_EXPIRED') {
          return h('div', { className: 'mys-banner', 'data-tone': 'error' },
            h('div', null, t('bannerExpired')),
            h('div', { className: 'mys-hint' }, String(lastError.message ?? '')),
            h('div', { className: 'mys-banner-actions' },
              h(Button, { variant: 'primary', onClick: startLogin, disabled: busy.login }, t('relogin'))))
        }
        if (code === 'CAPTCHA') {
          return h('div', { className: 'mys-banner', 'data-tone': 'warn' },
            h('div', null, t('bannerCaptcha')),
            h('div', { className: 'mys-hint' }, String(lastError.message ?? '')))
        }
        return h('div', { className: 'mys-banner', 'data-tone': 'warn' },
          h('div', null, t('bannerRun')),
          h('div', { className: 'mys-hint' }, String(lastError.message ?? '')),
          h('div', { className: 'mys-banner-actions' },
            h(Button, { onClick: runNow, disabled: busy.run || status?.running }, t('retryRun'))))
      })()

      const login = status?.login ?? { state: 'anonymous' }
      const plan = status?.schedule ?? {}
      const targetText = plan.targetAt === null || plan.targetAt === undefined ? null : formatTarget(plan.targetAt, status?.timezone ?? 'Asia/Shanghai')
      const reasonKey = plan.reason === 'missed' ? 'reasonMissed' : plan.reason === 'inside' ? 'reasonInside' : plan.reason === 'done-today' ? 'reasonDoneToday' : plan.reason === 'passed' ? 'reasonPassed' : 'reasonWindow'

      return h('div', { className: 'mys-section' },
        h('div', { className: 'mys-head' },
          h('h2', { className: 'mys-title' }, t('title')),
          h('p', { className: 'mys-intro' }, t('intro'))),

        error !== null ? h('div', { className: 'mys-banner', 'data-tone': 'error' }, fill(t('loadFailed'), { message: error })) : null,
        banner,
        notice !== null ? h('div', { className: 'mys-banner', 'data-tone': 'ok' }, notice) : null,

        h(Card, { title: t('account'), desc: t('accountDesc') },
          h('div', { className: 'mys-card-head' },
            h('div', { className: 'mys-account' },
              h(StatusDot, { state: login.state }),
              h('span', null, login.state === 'active' ? t('stateActive') : login.state === 'expired' ? t('stateExpired') : t('stateAnonymous')),
              login.accountName ? h('span', { className: 'mys-meta' }, login.accountName) : null,
              login.uid ? h('span', { className: 'mys-meta' }, `${t('uid')} ${login.uid}`) : null),
            h('div', { className: 'mys-actions' },
              login.state === 'active'
                ? h(Button, { onClick: refreshCredentials, disabled: busy.refresh }, busy.refresh ? t('refreshing') : t('refresh'))
                : h(Button, { variant: 'primary', onClick: startLogin, disabled: busy.login }, busy.login ? t('qrChecking') : t('login')),
              login.state === 'active'
                ? h(Button, { variant: 'danger', onClick: logout }, t('logout'))
                : null)),
          login.state !== 'anonymous' ? h('div', { className: 'mys-meta' },
            [login.loginAt ? `${t('loginAt')} ${formatTime(login.loginAt)}` : null,
              `${t('lastRefresh')} ${login.lastRefreshAt ? formatTime(login.lastRefreshAt) : t('never')}`].filter(Boolean).join(' · ')) : null,
          h('div', { className: 'mys-actions' },
            h(Button, { onClick: verify, disabled: busy.verify }, busy.verify ? t('verifying') : t('verify'))),
          verifyInfo === null ? null : h('div', {
            className: 'mys-banner',
            'data-tone': verifyInfo.sessionValid === false || verifyInfo.reachable === false ? 'warn' : 'ok',
          }, verifyInfo.sessionValid === null
            ? t('verifyAnon')
            : verifyInfo.reachable === false
              ? fill(t('verifyFail'), { message: verifyInfo.message })
              : verifyInfo.sessionValid === false
                ? fill(t('verifyInvalid'), { message: verifyInfo.message })
                : fill(t('verifyOk'), { ms: verifyInfo.elapsedMs ?? 0 }))),

        h(Card, { title: t('auto'), desc: t('autoDesc') },
          h('div', { className: 'mys-row' },
            h('div', { className: 'mys-row-label' },
              h('div', { className: 'mys-row-title' }, t('enabled')),
              h('div', { className: 'mys-row-desc' }, t('gamesCount').replace('{count}', String(games.filter((game) => game.enabled).length)))),
            h(Switch, {
              checked: config?.enabled === true,
              label: t('enabled'),
              onChange: (value) => patchDraft((next) => { next.enabled = value; return next }),
            })),

          h('div', { className: 'mys-row' },
            h('div', { className: 'mys-row-label' },
              h('div', { className: 'mys-row-title' }, t('windows')),
              h('div', { className: 'mys-row-desc' }, t('windowsDesc')))),

          h('div', { className: 'mys-list' },
            (config?.windows ?? []).map((window, index) => h('div', { className: 'mys-window', key: `w${index}` },
              h('input', {
                className: 'mys-time',
                type: 'time',
                value: window.start,
                'aria-label': t('windows'),
                onChange: (event) => patchDraft((next) => { next.windows[index].start = event.target.value; return next }),
              }),
              h('span', { className: 'mys-meta' }, '—'),
              h('input', {
                className: 'mys-time',
                type: 'time',
                value: window.end,
                'aria-label': t('windows'),
                onChange: (event) => patchDraft((next) => { next.windows[index].end = event.target.value; return next }),
              }),
              h(Button, {
                variant: 'danger',
                size: 'sm',
                onClick: () => patchDraft((next) => {
                  if (next.windows.length > 1) next.windows.splice(index, 1)
                  return next
                }),
              }, t('remove'))))),

          h('div', { className: 'mys-actions' },
            h(Button, {
              size: 'sm',
              onClick: () => patchDraft((next) => {
                if (next.windows.length >= 4) return next
                const last = next.windows[next.windows.length - 1] ?? { start: '18:00', end: '18:30' }
                next.windows.push({ start: last.start, end: last.end })
                return next
              }),
            }, t('addWindow'))),

          h('div', { className: 'mys-row' },
            h('div', { className: 'mys-row-label' },
              h('div', { className: 'mys-row-title' }, t('runWhenMissed')),
              h('div', { className: 'mys-row-desc' }, t('runWhenMissedDesc'))),
            h(Switch, {
              checked: config?.runWhenMissed === true,
              label: t('runWhenMissed'),
              onChange: (value) => patchDraft((next) => { next.runWhenMissed = value; return next }),
            })),

          h('div', { className: 'mys-meta' },
            `${t('nextRun')}：${targetText === null ? t('noPlan') : `${targetText}（${t(reasonKey)}）`}`)),

        h(Card, { title: t('games'), desc: t('gamesDesc') },
          h('div', { className: 'mys-list' },
            games.map((game) => h('div', { className: 'mys-row', key: game.id },
              h('input', {
                type: 'checkbox',
                checked: game.enabled === true,
                'aria-label': game.label,
                onChange: (event) => patchDraft((next) => {
                  next.games[game.id] = event.target.checked
                  return next
                }),
              }),
              h('div', { className: 'mys-row-label' },
                h('div', { className: 'mys-row-title' }, game.label),
                h('div', { className: 'mys-row-desc' },
                  game.role === null || game.role === undefined
                    ? t('notQueried')
                    : typeof game.role === 'object' && game.role !== null
                      ? `${game.role.nickname ?? ''} ${game.role.uid ?? ''} ${game.role.regionName ?? ''}`.trim()
                      : t('noRole'))))))),

        h(Card, { title: t('actions'), desc: t('actionsDesc') },
          h('div', { className: 'mys-actions' },
            h(Button, {
              variant: 'primary',
              disabled: busy.run || status?.running === true || login.state === 'anonymous',
              onClick: runNow,
            }, status?.running === true || busy.run ? t('running') : t('runNow'))),
          h('div', { className: 'mys-card-head-text' },
            h('div', { className: 'mys-card-title' }, t('result')),
            h('div', { className: 'mys-card-desc' }, t('resultDesc'))),
          lastResult === null
            ? h('div', { className: 'mys-empty' }, t('noResult'))
            : h('table', { className: 'mys-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('colTime')),
                  h('th', null, t('colGame')),
                  h('th', null, t('colResult')),
                  h('th', null, t('colDetail')))),
                h('tbody', null, (lastResult.results ?? []).map((item, index) => h('tr', { key: index },
                  h('td', null, formatTime(lastResult.at)),
                  h('td', null, item.label ?? item.game),
                  h('td', null, h('span', { className: 'mys-tag', 'data-tone': OUTCOME_TONE[item.outcome] ?? '' },
                    t(OUTCOME_KEY[item.outcome] ?? 'outcomeError'))),
                  h('td', null, item.message ?? '')))))),

        h('details', { className: 'mys-details' },
          h('summary', null, t('advanced')),
          h('div', { className: 'mys-grid' },
            h('label', { className: 'mys-field' }, t('timezone'),
              h('input', {
                className: 'mys-input',
                value: draft?.timezone ?? '',
                onChange: (event) => patchDraft((next) => { next.timezone = event.target.value; return next }),
              })),
            h('label', { className: 'mys-field' }, t('appVersion'),
              h('input', {
                className: 'mys-input',
                value: draft?.client?.appVersion ?? '',
                onChange: (event) => patchDraft((next) => { next.client.appVersion = event.target.value; return next }),
              })),
            h('label', { className: 'mys-field' }, t('salt'),
              h('input', {
                className: 'mys-input',
                value: draft?.client?.salt ?? '',
                onChange: (event) => patchDraft((next) => { next.client.salt = event.target.value; return next }),
              })),
            h('label', { className: 'mys-field' }, `${t('gap')} · ${t('gapMin')}`,
              h('input', {
                className: 'mys-input',
                type: 'number',
                min: 1,
                max: 60,
                value: Math.round((draft?.gapMs?.min ?? 2000) / 1000),
                onChange: (event) => patchDraft((next) => { next.gapMs.min = Math.max(1, Number(event.target.value) || 1) * 1000; return next }),
              })),
            h('label', { className: 'mys-field' }, `${t('gap')} · ${t('gapMax')}`,
              h('input', {
                className: 'mys-input',
                type: 'number',
                min: 1,
                max: 120,
                value: Math.round((draft?.gapMs?.max ?? 8000) / 1000),
                onChange: (event) => patchDraft((next) => { next.gapMs.max = Math.max(1, Number(event.target.value) || 1) * 1000; return next }),
              })),
            h('label', { className: 'mys-field' }, `${t('retry')} · ${t('retryAttempts')}`,
              h('input', {
                className: 'mys-input',
                type: 'number',
                min: 0,
                max: 3,
                value: draft?.retry?.attempts ?? 1,
                onChange: (event) => patchDraft((next) => { next.retry.attempts = Number(event.target.value) || 0; return next }),
              })),
            h('label', { className: 'mys-field' }, `${t('retry')} · ${t('retryDelay')}`,
              h('input', {
                className: 'mys-input',
                type: 'number',
                min: 10,
                max: 900,
                value: Math.round((draft?.retry?.delayMs ?? 60000) / 1000),
                onChange: (event) => patchDraft((next) => { next.retry.delayMs = Math.max(10, Number(event.target.value) || 60) * 1000; return next }),
              })),
            h('label', { className: 'mys-field' }, t('qrAge'),
              h('input', {
                className: 'mys-input',
                type: 'number',
                min: 60,
                max: 300,
                value: Math.round((draft?.maxQrAgeMs ?? 180000) / 1000),
                onChange: (event) => patchDraft((next) => { next.maxQrAgeMs = Math.max(60, Number(event.target.value) || 180) * 1000; return next }),
              })),
            h('div', { className: 'mys-hint' }, t('appVersionDesc')))),

        h(Card, { title: t('logs') },
          (status?.logs ?? []).length === 0
            ? h('div', { className: 'mys-empty' }, t('logsEmpty'))
            : h('div', { className: 'mys-logs' }, (status?.logs ?? []).slice().reverse().map((entry, index) => h('div', {
                className: 'mys-log',
                'data-level': entry.level,
                key: `${entry.at}-${index}`,
              },
              h('span', { className: 'mys-log-time' }, shortTime(entry.at)),
              h('span', { className: 'mys-log-text' }, entry.message))))),

        h(Card, { title: t('riskTitle') },
          h('div', { className: 'mys-hint' }, t('riskList'))),

        qr === null ? null : h(QrDialog, {
          t,
          session: qr,
          detector,
          onRefresh: startLogin,
          onClose: cancelLogin,
        }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mys-checkin: dictionaries')

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = PLUGIN_ID
          tag.dataset.pluginCss = `${PLUGIN_ID}/settings.css`
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'mys-checkin: settings styles')

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mys-checkin',
          order: 60,
          label: () => t('nav'),
          locale: NS,
        }, Section))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'mys-checkin-status',
          order: 20,
        }, (props) => h(OverlayBadge, { ...props, t })))
      },
    }
  },
})
