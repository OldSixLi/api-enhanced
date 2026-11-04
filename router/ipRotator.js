/**
 * 定时轮换的伪造出口 IP（落到 X-Real-IP / X-Forwarded-For）
 *
 * 为什么不能"每个请求都换"：
 * 一次歌单扫描会发 200+ 个子请求。如果每个都换 IP，等于同一个 MUSIC_A
 * 在 200 个不同 IP 之间跳变 —— 这比固定 IP 更像攻击，是自曝。
 *
 * 真实用户的 IP 只有两种变化形态：
 *   1. 宽带重拨 / 手机切基站 —— 同城、同 ISP、同一 /24 内变几个末位（绝大多数情况）
 *   2. 换了网络环境 —— /24 整个换掉（很少发生）
 *
 * 所以本模块：
 *   - 每 MA_IP_ROTATE_MS（默认 10 分钟）才换一次 IP
 *   - 换的时候默认只在 /24 内变末位，模拟"重拨"
 *   - 连续 STAY_ROUNDS 次之后才换新的 /24，模拟"换了网络"
 *
 * 轮换是按需检查的（current() 时比对过期时间），不挂定时器：
 * 服务空闲时不该为了换 IP 空转，也没有定时器泄漏的风险。
 */

const logger = require('../util/logger')
const { generateRandomChineseIP } = require('../util/index')

const DEFAULT_ROTATE_MS = 10 * 60 * 1000
// 同一个 /24 连续用几轮才换网段
const STAY_ROUNDS = 6

/**
 * 轮换周期（毫秒）。设 0 表示进程生命周期内固定一个 IP，永不轮换。
 * 环境变量：MA_IP_ROTATE_MS
 */
const rawRotate = Number(process.env.MA_IP_ROTATE_MS)
const ROTATE_MS =
  Number.isFinite(rawRotate) && rawRotate >= 0 ? rawRotate : DEFAULT_ROTATE_MS

/**
 * 屏蔽 generateRandomChineseIP 自带的逐条日志。
 * 它内部硬编码了 logger.info，每次调用都打一行；一次歌单扫描就是 200 行。
 * 只过滤这一条特定文案，其他日志照常。
 */
const rawInfo = logger.info
logger.info = function (msg, ...args) {
  if (typeof msg === 'string' && msg.includes('Generated Random Chinese IP')) {
    return
  }
  return rawInfo.call(logger, msg, ...args)
}

/** 当前 /24 前缀，如 "112.13.85" */
let netPrefix = ''
/** 当前伪造 IP */
let ip = ''
/** 当前 IP 的过期时间戳，0 表示永不轮换 */
let expireAt = 0
/** 当前 /24 已经用了几轮 */
let roundsInPrefix = 0
/** 累计轮换了多少次，仅用于状态展示 */
let rotateCount = 0

const randOctet = () => 2 + Math.floor(Math.random() * 252)

/**
 * 生成下一个 IP：大多数情况只换末位，满 STAY_ROUNDS 轮才换 /24
 */
function nextIp() {
  if (!netPrefix || roundsInPrefix >= STAY_ROUNDS) {
    const base = generateRandomChineseIP() || '116.25.1.1'
    netPrefix = base.split('.').slice(0, 3).join('.')
    roundsInPrefix = 0
  }
  roundsInPrefix += 1
  ip = `${netPrefix}.${randOctet()}`
  rotateCount += 1
  return ip
}

/**
 * 取当前周期的 IP，过期则自动轮换
 * @returns {string}
 */
function current() {
  const now = Date.now()
  if (!ip || (ROTATE_MS > 0 && now >= expireAt)) {
    const changedPrefix = !ip || roundsInPrefix === 0
    nextIp()
    expireAt = ROTATE_MS > 0 ? now + ROTATE_MS : 0
    logger.info(
      `[ipRotator] 出口 IP 轮换为 ${ip}（网段 ${netPrefix}.0/24，${
        changedPrefix ? '已换网段' : '同网段重拨'
      }）`,
    )
  }
  return ip
}

/**
 * 立即轮换一个新 IP（用于调试或强制刷新）
 * @returns {string}
 */
function forceRotate() {
  nextIp()
  expireAt = ROTATE_MS > 0 ? Date.now() + ROTATE_MS : 0
  logger.info(`[ipRotator] 手动轮换出口 IP -> ${ip}`)
  return ip
}

/**
 * 一次性随机 IP，不走轮换槽位。
 * 仅用于显式的 ipRotate=request 模式（每个子请求都换），默认不启用。
 * @returns {string}
 */
function randomIp() {
  return generateRandomChineseIP()
}

function stats() {
  const now = Date.now()
  return {
    ip: ip || current(),
    cidr: netPrefix ? `${netPrefix}.0/24` : '',
    rotateSeconds: Math.round(ROTATE_MS / 1000),
    remainingSeconds:
      ROTATE_MS > 0 && expireAt > 0
        ? Math.max(0, Math.round((expireAt - now) / 1000))
        : null,
    roundsInPrefix,
    stayRounds: STAY_ROUNDS,
    rotateCount,
  }
}

module.exports = {
  current,
  forceRotate,
  randomIp,
  stats,
  ROTATE_MS,
  STAY_ROUNDS,
}
