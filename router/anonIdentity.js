/**
 * 匿名身份池 —— 让 /ma 的查询彻底脱离真实账号
 *
 * 背景：util/request.js 的 processCookieObject 里有两处"服务端默认值"会把请求
 * 绑到固定身份上：
 *   1. `deviceId: cookie.deviceId || global.deviceId` —— global.deviceId 是全局唯一的
 *   2. `MUSIC_A: cookie.MUSIC_A || anonymous_token` —— 全局共用一个匿名 token
 * 只要不显式传，每个请求都会带同一个 deviceId + 同一个 MUSIC_A，
 * 一旦请求里再混进 MUSIC_U（前端登录后必然发生），这批评论查询就全部挂到账号名下。
 *
 * 本模块的做法：注册若干个互相独立的匿名身份（每个一条 MUSIC_A），
 * 查询时随机取一个，并配套随机 deviceId / _ntes_nuid / UA / IP。
 * MUSIC_A 与 deviceId 之间没有绑定关系（实测验证），所以 deviceId 可以独立随机。
 *
 * 身份池会落盘到 data/anon-identities.json，重启不重复注册——
 * 反复注册本身就是一种可疑行为，能省则省。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const request = require('../util/request')
const logger = require('../util/logger')
const ipRotator = require('./ipRotator')
const registerAnonimous = require('../module/register_anonimous')
const { generateDeviceId } = require('../util/index')

const DATA_DIR = path.resolve(__dirname, '../data')
const POOL_FILE = path.join(DATA_DIR, 'anon-identities.json')

// 池子大小：注册动作本身有风险，宁少勿多。
// 实测每次注册约 350ms，但短时间大量注册会被网易当成异常行为，
// 所以这里默认只留 6 个，并发 1，且每次之间强制间隔。
const POOL_SIZE =
  Number(process.env.MA_ANON_POOL) > 0 ? Number(process.env.MA_ANON_POOL) : 6
const REGISTER_ATTEMPTS = 2
// 两次注册之间的间隔（毫秒），避免形成连续注册的机器行为
const REGISTER_GAP_MS = 2500
// 单个身份连续失败多少次后判定失效并替换
const FAILURE_THRESHOLD = 3
// 池子建不起来时的重试冷却时间
const RETRY_COOLDOWN_MS = 5 * 60 * 1000

/**
 * 身份画像：UA 必须与模块的加密方式匹配
 * - eapi/api（comment_new、playlist_detail）→ 手机端
 * - weapi（comment_music、song_detail）→ PC 端
 * os / osver / appver / channel 会进 cookie，和 UA 保持同一套画像，
 * 否则"手机 UA + PC 的 osver"这种组合自己就是异常特征。
 */
const MOBILE_PROFILES = [
  {
    os: 'android',
    osver: '14',
    appver: '8.20.20.231215173437',
    channel: 'xiaomi',
    ua: 'NeteaseMusic/9.5.61.260802021928(9005061);Dalvik/2.1.0 (Linux; U; Android 14; PJZ110 Build/UKQ1.230924.001)',
  },
  {
    os: 'android',
    osver: '13',
    appver: '8.20.20.231215173437',
    channel: 'netease',
    ua: 'NeteaseMusic/9.0.90.231215173437(9000090);Dalvik/2.1.0 (Linux; U; Android 13; 2211133C Build/TKQ1.221114.001)',
  },
  {
    os: 'android',
    osver: '12',
    appver: '8.20.20.231215173437',
    channel: 'xiaomi',
    ua: 'NeteaseMusic/8.10.90.2301231234(8010090);Dalvik/2.1.0 (Linux; U; Android 12; HBN-AL00 Build/cd737a2.0)',
  },
  {
    os: 'android',
    osver: '13',
    appver: '8.20.20.231215173437',
    channel: 'netease',
    ua: 'NeteaseMusic/8.20.20.231215173437(8020020);Dalvik/2.1.0 (Linux; U; Android 13; V2219A Build/TP1A.220624.014)',
  },
]

const PC_PROFILES = [
  {
    os: 'pc',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    appver: '3.1.17.204416',
    channel: 'netease',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  },
  {
    os: 'pc',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    appver: '3.1.17.204416',
    channel: 'netease',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  },
  {
    os: 'pc',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    appver: '3.1.17.204416',
    channel: 'netease',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  },
]

/** 池子：[{ musicA, failures }] */
let pool = []
let readyPromise = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pickRandom = (list) => list[Math.floor(Math.random() * list.length)]

function loadPoolFromDisk() {
  try {
    if (!fs.existsSync(POOL_FILE)) return []
    const raw = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw
      .filter((x) => x && typeof x.musicA === 'string' && x.musicA.length > 100)
      .slice(0, POOL_SIZE)
      .map((x) => ({ musicA: x.musicA, failures: 0 }))
  } catch (error) {
    logger.warn('[anonIdentity] 读取身份池失败，将重新注册: ' + error.message)
    return []
  }
}

function savePoolToDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(
      POOL_FILE,
      JSON.stringify(
        pool.map((x) => ({ musicA: x.musicA })),
        null,
        0,
      ),
    )
  } catch (error) {
    logger.warn('[anonIdentity] 保存身份池失败: ' + error.message)
  }
}

/**
 * 注册一个匿名身份，带重试（实测偶发 code 400）
 * 显式传一份干净的 cookie，防止 process.env.NETEASE_COOKIE 被带进注册请求——
 * 那样注册出来的匿名 token 会天然与账号关联，等于白做。
 */
async function registerOne() {
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt++) {
    try {
      const nuid = crypto.randomBytes(16).toString('hex')
      const ans = await registerAnonimous(
        {
          cookie: {
            _ntes_nuid: nuid,
            _ntes_nnid: `${nuid},${Date.now()}`,
            deviceId: generateDeviceId(),
            os: 'android',
          },
        },
        request,
      )
      const cookieStr = (ans.cookie || []).join('; ')
      const matched = cookieStr.match(/MUSIC_A=([^;&]+)/)
      if (ans.body && ans.body.code === 200 && matched) {
        return { musicA: decodeURIComponent(matched[1]), failures: 0 }
      }
    } catch (error) {
      // 网络抖动或风控临时拒绝，等一会儿再试
    }
    await sleep(400 + Math.floor(Math.random() * 600))
  }
  return null
}

async function buildPool() {
  // register_anonimous 内部会把 deviceId 写到 global.deviceId，
  // 结束必须还原，否则会影响服务自身的其他请求
  const savedDeviceId = global.deviceId
  try {
    const existing = loadPoolFromDisk()
    pool = existing

    const need = POOL_SIZE - existing.length
    if (need <= 0) {
      logger.info(
        `[anonIdentity] 身份池已就绪（复用本地 ${existing.length} 个）`,
      )
      return
    }

    // 串行注册，每次之间留间隔：连续注册是最容易被识别为机器的动作
    const created = []
    for (let i = 0; i < need; i++) {
      if (i > 0) await sleep(REGISTER_GAP_MS)
      const identity = await registerOne()
      if (identity) {
        created.push(identity)
        pool = existing.concat(created)
        // 每成功一个就落盘，中途中断也不白费
        savePoolToDisk()
      }
    }

    pool = existing.concat(created)
    if (created.length > 0) {
      logger.info(
        `[anonIdentity] 匿名身份池就绪：新增 ${created.length} 个，共 ${pool.length} 个`,
      )
    }
    if (pool.length === 0) {
      logger.warn(
        '[anonIdentity] 匿名身份注册失败，暂用全局匿名 token（仍与账号无关，但所有请求共用一份）',
      )
    }
  } finally {
    global.deviceId = savedDeviceId
    // 一个都没注册成功时（常见于网络不通 / 临时风控），
    // 冷却一段时间后允许重试，否则网络恢复后必须重启服务才能补池子
    if (pool.length === 0) {
      const timer = setTimeout(() => {
        readyPromise = null
      }, RETRY_COOLDOWN_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }
  }
}

/**
 * 确保身份池已构建；只短暂等待，不阻塞请求。
 * 池子为空时先用降级身份放行，后台继续补——
 * 首次请求不该为了"注册账号"卡上十几秒。
 * @param {number} timeoutMs
 */
function ensureReady(timeoutMs = 1500) {
  if (!readyPromise) readyPromise = buildPool()
  return Promise.race([readyPromise, sleep(timeoutMs)])
}

/**
 * 按需补充身份池（某个 token 失效时后台补一个，不阻塞请求）
 */
/** 避免失效剔除时并发出多个注册请求 */
let replenishing = false

function replenish() {
  if (replenishing || pool.length >= POOL_SIZE) return
  replenishing = true
  registerOne()
    .then((identity) => {
      if (identity && pool.length < POOL_SIZE) {
        pool.push(identity)
        savePoolToDisk()
      }
    })
    .catch(() => {})
    .finally(() => {
      replenishing = false
    })
}

/**
 * 报告某个身份请求失败，连续失败达阈值就剔除并补充
 * @param {string} musicA
 */
function reportFailure(musicA) {
  if (!musicA) return
  const item = pool.find((x) => x.musicA === musicA)
  if (!item) return
  item.failures += 1
  if (item.failures >= FAILURE_THRESHOLD) {
    pool = pool.filter((x) => x.musicA !== musicA)
    savePoolToDisk()
    logger.warn('[anonIdentity] 剔除失效匿名身份，正在补充')
    replenish()
  }
}

/**
 * 生成一套随机身份
 * @param {'mobile'|'pc'} kind 对应加密方式：eapi/api 用 mobile，weapi 用 pc
 * @returns {{ cookie: object, ua: string, ip: string, musicA: string }}
 */
function pickProfile(kind = 'mobile') {
  const base = pickRandom(kind === 'pc' ? PC_PROFILES : MOBILE_PROFILES)
  const identity = pool.length > 0 ? pickRandom(pool) : null

  // _ntes_nuid 每次请求都换：它是客户端指纹 cookie，与服务端下发的 MUSIC_A 无绑定
  const nuid = crypto.randomBytes(16).toString('hex')
  const cookie = {
    _ntes_nuid: nuid,
    _ntes_nnid: `${nuid},${Date.now()}`,
    deviceId: generateDeviceId(),
    os: base.os,
    osver: base.osver,
    appver: base.appver,
    channel: base.channel,
  }
  if (identity) cookie.MUSIC_A = identity.musicA

  return {
    cookie,
    ua: base.ua,
    // IP 取自定时轮换槽位：同一周期内所有子请求共用同一个 IP
    ip: ipRotator.current(),
    musicA: identity ? identity.musicA : '',
  }
}

function stats() {
  return {
    poolSize: pool.length,
    target: POOL_SIZE,
    mode: pool.length > 0 ? '独立匿名身份池' : '全局匿名 token（降级）',
  }
}

module.exports = {
  ensureReady,
  pickProfile,
  reportFailure,
  stats,
  POOL_FILE,
}
