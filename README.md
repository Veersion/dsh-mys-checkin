# 米游社签到（DSH 插件）

[![CI](https://github.com/veer-li9/dsh-mys-checkin/actions/workflows/ci.yml/badge.svg)](https://github.com/veer-li9/dsh-mys-checkin/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 [DSH](https://github.com/deepseek-ai) 的设置里多一栏「米游社」：扫码登录米哈游账号，每天在你设定的时间窗口内**随机挑一个时刻**，为已绑定的米哈游游戏自动签到。登录失效、触发人机验证或签到失败时，设置页和界面顶部都会给出提示。

> A DSH plugin that adds a **米游社 (Miyoushe)** settings section: QR-code login, one randomized daily check-in per game, and in-UI alerts when the session expires or the check-in fails. Zero runtime dependencies — Node built-ins only.

- 支持游戏：原神、崩坏：星穹铁道、绝区零、崩坏3、未定事件簿、崩坏学园2
- 宿主侧完成全部网络请求与定时；浏览器侧只渲染设置页，**Cookie 不会经过浏览器**
- 零运行时依赖（只用 Node 内置模块），不需要 pnpm 安装任何包

## 安装

先克隆到任意目录：

```powershell
git clone https://github.com/veer-li9/dsh-mys-checkin.git
```

安装由 DSH 的 profile 完成（下面以 `desktop` profile 为例），三件事缺一不可：

1. `~/.dsh/profiles/desktop/node_modules/@local/dsh-mys-checkin` 指向克隆出来的目录（符号链接/目录联接）；
2. profile 的 `package.json` 里 `dependencies` 增加 `"@local/dsh-mys-checkin": "link:<克隆目录的绝对路径>"`；
3. 同一文件的 `dsh.profile.bundles` 数组里增加 `"@local/dsh-mys-checkin"`（**只有列进 bundles 才会被启用**）。

> 只写 `dependencies` 不写 `bundles` 是最常见的「装了但没生效」原因。

改完后 DSH 会通过 HMR 重新组合插件树；如果没有自动生效，重启 DSH 即可。

**卸载**：把上面两处条目和链接删掉，重启 DSH；再删除 `~/.dsh/mys-checkin/`（里面有登录凭据）。

## 使用

### 1. 登录

打开 **设置 → 米游社 → 扫码登录**，用米游社 App 右上角「扫一扫」扫描二维码并在手机上确认。

- 二维码只在本机生成，不上传到任何第三方；
- 若浏览器支持 `BarcodeDetector`，对话框会顺带做一次「二维码自检」，识别失败会提示刷新；
- 登录成功后状态变为「已登录」，并显示昵称与 UID。
- 网页扫码通道失败、或扫码确认后拿不到 `ltoken_v2` 时，会自动切换为 App 扫码通道，再扫一次即可。

登录凭据保存在 `~/.dsh/mys-checkin/state.json`（**明文**，仅本机可读）。共享电脑上请注意这一点。

### 2. 自动签到

- **时间窗口**：默认 `18:00–18:30`，可增删（最多 4 个）。每天只执行一次，实际时刻在窗口内均匀随机。
- **错过窗口后补跑**：若 DSH 在窗口结束后才启动、且当天还没签过，会在 3–10 分钟内随机补跑一次。可在设置里关闭。
- **游戏**：只给勾选的游戏签到；没有角色的游戏会自动跳过并记录。

下次执行时间会显示在「下次执行」一行。

### 3. 提示与排错

- 设置页顶部横幅：登录失效 → 提供「重新扫码」；人机验证 → 说明如何处理；其它失败 → 「重试签到」。
- 界面顶部小药丸（`shell.overlay`）：只要存在未清除的失败状态就会显示，可点 × 关闭当次提示。
- 「检测接口与登录」会实际请求一次绑定接口，报告网络是否可达、登录是否有效、耗时多少。
- 「运行日志」保留最近 200 条。

## 防检测设计

「用一段时间就失效」基本都不是签名问题，而是设备指纹与凭据刷新链的问题。插件按下面的原则实现：

| 措施 | 实现 |
| --- | --- |
| 设备 ID 持久化 | 首次运行生成 UUID 并写入状态文件，**之后永不改变**；请勿删除 `state.json`，否则等同换机 |
| 签名与版本一致 | `DS` 与 `x-rpc-app_version`、UA 尾部版本、salt 三者绑定，全部走同一份配置 |
| 每日一次 | 无论定时还是手动，当天成功跑过就不再自动执行；避免「一天多次全量签到」的特征 |
| 随机间隔 | 游戏之间随机 2–8 秒；定时时刻在窗口内均匀随机，不会整点触发 |
| 绑定查询缓存 | `getUserGameRolesByCookie` 每个游戏每天最多一次 |
| 续期克制 | 只有服务端返回 `-100/-111/10001` 时才用 stoken 换一次 cookie_token，并只重试一次；不做定时刷新 |
| 失败即停 | 触发验证码（`1034/-999`）立即停止当日剩余游戏并提示，不反复重试 |
| 真实请求头 | 完整的 `x-rpc-*` 设备头、`Origin/Referer`、移动端 UA，随版本号统一 |

仍无法完全避免风控：米游社的验证码与设备指纹策略会变化。**不要**在同一台机器上用同一个 DSH 频繁登录多个账号，也不要在短时间内反复手动补签。

## 协议实现说明

| 环节 | 接口 |
| --- | --- |
| 扫码创建/轮询 | `POST passport-api.miyoushe.com/account/ma-cn-passport/web/createQRLogin` 与 `/web/queryQRLoginStatus` |
| 凭据续期 | `GET passport-api.mihoyo.com/account/auth/api/getCookieAccountInfoBySToken`、`getLTokenBySToken` |
| 角色列表 | `GET api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=…` |
| 签到 | `POST https://api-takumi.mihoyo.com/event/luna/{game}/sign`（绝区零用 `act-nap-api.mihoyo.com`） |
| 签名 | DS1：`md5("salt=<salt>&t=<t>&r=<6位随机>")` → `"<t>,<r>,<md5>"` |

默认参数：`x-rpc-app_version = 2.109.0`，`salt = d9200c846b10886e8c874fc33c8f308b`。**米哈游更新客户端后这两项可能都要换**，可在「高级设置」里修改，无需改代码。

## 目录结构

```
.
  index.js             宿主插件入口（注册服务）
  client.js            浏览器 bundle（设置分区 + 顶部提示）
  cordis.patch.yml     把插件插入 profile 配置树的 bundle patch
  lib/config.js        配置默认值、游戏表、校验
  lib/store.js         状态文件（原子写、迁移、日志环）
  lib/ds.js            DS 签名、请求头、Cookie 解析
  lib/http.js          带超时与重试的请求封装
  lib/mys.js           米游社协议（扫码/角色/签到/续期）
  lib/qr.js            二维码编码器（字节模式、M 级、版本 1–15）
  lib/scheduler.js     每日随机窗口调度（纯函数 + 定时器）
  lib/service.js       宿主服务：路由、登录态、签到流程
  test/                单元测试与端到端测试（假接口）
  .github/workflows/   CI：Node 22 / 24 上跑全部测试
```

## 测试

无需安装依赖：

```powershell
node test/protocol.test.mjs
node test/schedule.test.mjs
node test/qr.test.mjs
node test/service.test.mjs
```

`qr.test.mjs` 内置一个独立的解码器：读回格式信息、反掩码、反交织、校验每个 Reed–Solomon 块的 syndrome 全为零，并核对数据模块数量与版本容量一致。

## 已知限制

- **无法自动通过验证码**：`1034` 是全域人机验证，只能去米游社 App「我的 → 我的角色」处理。
- **Cookie 明文落盘**：这是本地自动签到的必要代价；如需更强保护，可把 `~/.dsh/mys-checkin` 放在加密卷上。
- **只支持国服**（`*_cn` 的 `game_biz` 与 luna 接口）。
- **一次运行约 1 分钟**：为了避免特征化请求，游戏之间有随机间隔。

## 许可证

[MIT](LICENSE)。本项目仅用于个人账号的自动化，请自行承担使用风险。
