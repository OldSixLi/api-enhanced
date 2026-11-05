const express = require('express')

const request = require('../util/request')
const logger = require('../util/logger')
const commentCache = require('./commentCache')
const anonIdentity = require('./anonIdentity')
const ipRotator = require('./ipRotator')

const _getMusicComment = require('../module/comment_music')
const _getMusicCommentNew = require('../module/comment_new')
const _getPlayListDetail = require('../module/playlist_detail')
const _getSongDetail = require('../module/song_detail')

const router = express.Router()

// 只服务于本路由的控制参数，不转嫁给网易
const CONTROL_PARAMS = [
  'auth',
  'anonRotate',
  'ipRotate',
  'maxCommentScan',
  'cacheTtl',
  'commentOffset',
  'ids',
]

/**
 * 统一构造请求 query
 *
 * 两种模式：
 * 1) 默认（匿名扫描）：剥离调用方的全部身份 cookie（尤其是 MUSIC_U / __csrf），
 *    换上一套随机匿名身份 —— 独立 MUSIC_A + 随机 deviceId + 随机 _ntes_nuid + 随机 UA。
 *    IP 取自 ipRotator 的定时槽位，同一周期内所有子请求共用同一个 IP。
 *    这样这批查询与你的账号之间没有任何共享标识。
 * 2) auth=1（身份透传）：原样使用调用方 cookie，用于私密歌单等需要登录态的场景。
 *    此时不再伪造 IP —— 真实账号配伪造 IP，反而是个更容易被标记的组合。
 *
 * @param {*} req
 * @param {object} extra 附加参数
 * @param {'mobile'|'pc'} kind 与模块加密方式对应：eapi/api 用 mobile，weapi 用 pc
 */
function buildQuery(req, extra, kind = 'mobile') {
  const base = Object.assign({}, req.query, req.body)
  for (const key of CONTROL_PARAMS) delete base[key]

  if (req.maAuth) {
    return Object.assign(
      base,
      { cookie: Object.assign({}, req.cookies) },
      extra,
    )
  }

  const profile = req.maSession
    ? req.maSession[kind]
    : anonIdentity.pickProfile(kind)

  return Object.assign(
    base,
    {
      cookie: Object.assign({}, profile.cookie),
      ua: profile.ua,
      // 默认用定时轮换槽位的 IP；ipRotate=request 时才退化成每子请求一个随机 IP
      realIP: req.maIpMode === 'request' ? ipRotator.randomIp() : profile.ip,
    },
    extra,
  )
}

/**
 * 决定本次请求的身份策略
 * - auth=1                     → 透传调用方 cookie
 * - anonRotate=request（默认） → 每个子请求换一套身份（MUSIC_A / deviceId / UA）
 * - anonRotate=session         → 整次请求共用一套身份
 * - ipRotate=request           → IP 也每子请求换（默认是定时轮换，不推荐）
 * - ipRotate=now               → 本次请求强制轮换一个新 IP
 */
router.use(async (req, _, next) => {
  const authRaw = String(req.query.auth || '').toLowerCase()
  req.maAuth = authRaw === '1' || authRaw === 'true'
  req.maRotate =
    String(req.query.anonRotate || '').toLowerCase() === 'session'
      ? 'session'
      : 'request'

  const ipRaw = String(req.query.ipRotate || '').toLowerCase()
  if (ipRaw === 'request') {
    req.maIpMode = 'request'
  } else {
    req.maIpMode = 'sticky'
    // ipRotate=now：立刻换一个新 IP，本次请求全程使用它
    if (ipRaw === 'now') ipRotator.forceRotate()
  }

  if (!req.maAuth) {
    // 池子为空时会短暂等待最多 1.5 秒，超时即用降级身份放行，后台继续补
    await anonIdentity.ensureReady()
    if (req.maRotate === 'session') {
      req.maSession = {
        mobile: anonIdentity.pickProfile('mobile'),
        pc: anonIdentity.pickProfile('pc'),
      }
    }
  }
  next()
})

/**
 * 匿名身份池与出口 IP 状态
 * GET /ma/anon/status
 */
router.all('/anon/status', (req, res) => {
  res.send({
    identity: anonIdentity.stats(),
    ip: ipRotator.stats(),
  })
})

/**
 * 获取某个歌曲的评论量
 * GET /ma/comment/music?id=xxx
 * @returns {{ total: number }}
 */
router.all('/comment/music', async (req, res) => {
  // comment_music 走 weapi，UA 用 PC 画像
  const query = buildQuery(req, {}, 'pc')
  const musicId = Number(req.query.id)

  // 与歌单详情共用同一个评论数缓存，单曲查询同样支持 cacheTtl=0 跳过缓存
  const ttlMinutes =
    req.query.cacheTtl === undefined || req.query.cacheTtl === ''
      ? 30
      : Number(req.query.cacheTtl)
  const ttlMs =
    Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60 * 1000 : 0

  if (ttlMs > 0 && Number.isFinite(musicId)) {
    const cached = commentCache.getCachedCounts([musicId], ttlMs)
    if (cached.has(musicId)) {
      res.send({ total: cached.get(musicId), cacheHit: true })
      return
    }
  }

  try {
    const ans = await _getMusicComment(query, request)
    // 匿名模式下不回传网易下发的 cookie：那是身份池的凭证，
    // 落到浏览器里既可能覆盖调用方自己的 MUSIC_U，也让身份重新被串起来
    if (req.maAuth && Array.isArray(ans.cookie) && ans.cookie.length > 0) {
      res.append('Set-Cookie', ans.cookie)
    }
    const total = ans.body && ans.body.total
    if (typeof total === 'number' && Number.isFinite(musicId)) {
      try {
        commentCache.saveCounts([[musicId, total]])
      } catch (error) {
        logger.error('[/ma/comment/music] 写入缓存失败: ' + error.message)
      }
    }
    res.status(ans.status || 200).send({ total })
  } catch (error) {
    logger.error('[/ma/comment/music] ' + error.message)
    res.status(500).send({ total: 0 })
  }
})

/**
 * 批量查询歌曲评论量（用于每日推荐这类没有歌单 ID 的曲目列表）
 * GET /ma/songs/comments?ids=1,2,3&maxCommentScan=120&commentOffset=0
 * @returns {{ comments: Record<number, number>, scannedComments, totalTracks, scanOffset, cacheHit }}
 */
router.all('/songs/comments', async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)

  if (ids.length === 0) {
    res.send({
      comments: {},
      scannedComments: 0,
      totalTracks: 0,
      scanOffset: 0,
    })
    return
  }

  const maxCommentScan =
    Number(req.query.maxCommentScan) > 0
      ? Number(req.query.maxCommentScan)
      : ids.length
  const commentOffset = Math.max(0, Number(req.query.commentOffset) || 0)
  const scanIds = ids.slice(commentOffset, commentOffset + maxCommentScan)

  const ttlMinutes =
    req.query.cacheTtl === undefined || req.query.cacheTtl === ''
      ? 30
      : Number(req.query.cacheTtl)
  const ttlMs =
    Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60 * 1000 : 0

  const comments = {}
  let cacheHit = 0

  try {
    // 1) 先查缓存，只请求未命中的曲目
    let toFetch = scanIds
    if (ttlMs > 0 && scanIds.length > 0) {
      const cached = commentCache.getCachedCounts(scanIds, ttlMs)
      cacheHit = cached.size
      for (const [id, count] of cached) comments[id] = count
      toFetch = scanIds.filter((id) => !cached.has(id))
    }

    // 2) 未命中的并发请求并回写缓存（与歌单详情同一套节奏控制）
    if (toFetch.length > 0) {
      const fetched = await getMusicListComment(
        100,
        toFetch.map((id) => ({ id })),
        req,
      )
      const toSave = []
      for (const [id, count] of fetched) {
        if (count >= 0) {
          comments[id] = count
          toSave.push([id, count])
        }
      }
      if (toSave.length > 0) {
        try {
          commentCache.saveCounts(toSave)
        } catch (error) {
          logger.error('[/ma/songs/comments] 写入缓存失败: ' + error.message)
        }
      }
    }
  } catch (error) {
    logger.error('[/ma/songs/comments] ' + error.message)
  }

  res.send({
    comments,
    scannedComments: scanIds.length,
    totalTracks: ids.length,
    scanOffset: commentOffset,
    cacheHit,
  })
})

/**
 * 获取歌单内容，包含每首歌的评论量
 * GET /ma/playlist/detail?id=xxx
 * @returns {{ name, id, musicList: [{ id, name, author, al, commentNum }] }}
 */
router.all('/playlist/detail', async (req, res) => {
  // playlist_detail 走 eapi，UA 用手机端画像
  const query = buildQuery(req, {}, 'mobile')
  try {
    const resResult = await _getPlayListDetail(query, request)
    const result = await handleMusicList(resResult, req)
    res.status(resResult.status || 200).send(result)
  } catch (error) {
    logger.error('[/ma/playlist/detail] ' + error.message)
    res.status(200).send({})
  }
})

/**
 * 处理歌单中歌曲的评论量与详情
 * @param {*} musicListRes
 * @param {*} req
 */
async function handleMusicList(musicListRes, req) {
  const playlist =
    (musicListRes && musicListRes.body && musicListRes.body.playlist) || {}
  const trackIds = playlist.trackIds || []
  const afterMusicListArr = []

  // 评论量逐首请求，全量扫大歌单会很慢且易触发风控。
  // 默认最多扫 500 首（原代码定义了 maxNum 却没用上），可用 maxCommentScan 调整。
  // commentOffset 支持从中间继续扫（配合前端"继续扫描剩余"按钮增量加载）
  const maxCommentScan =
    Number(req.query.maxCommentScan) > 0
      ? Number(req.query.maxCommentScan)
      : 500
  const commentOffset = Math.max(0, Number(req.query.commentOffset) || 0)
  const commentScanList = trackIds.slice(
    commentOffset,
    commentOffset + maxCommentScan,
  )

  // 缓存有效期（分钟），默认 30；cacheTtl=0 强制跳过缓存、重新抓取
  const ttlMinutes =
    req.query.cacheTtl === undefined || req.query.cacheTtl === ''
      ? 30
      : Number(req.query.cacheTtl)
  const ttlMs =
    Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60 * 1000 : 0

  const musicsComment = new Map()
  let musicDetails = new Map()
  let cacheHit = 0
  let fetchedCount = 0

  try {
    // 1) 先查缓存，只对未命中/过期的曲目发请求
    let toFetch = commentScanList
    if (ttlMs > 0 && commentScanList.length > 0) {
      const ids = commentScanList.map((x) => x.id)
      const cached = commentCache.getCachedCounts(ids, ttlMs)
      cacheHit = cached.size
      for (const [id, count] of cached) {
        musicsComment.set(id, count)
      }
      toFetch = commentScanList.filter((x) => !cached.has(x.id))
    }

    // 2) 请求未命中的部分并回写缓存
    if (toFetch.length > 0) {
      const fetched = await getMusicListComment(100, toFetch, req)
      fetchedCount = fetched.size
      const toSave = []
      for (const [id, count] of fetched) {
        if (count >= 0) {
          musicsComment.set(id, count)
          toSave.push([id, count])
        } else {
          // 请求失败：本次按 0 展示，但不写入缓存，避免把错误永久固化
          musicsComment.set(id, 0)
        }
      }
      if (toSave.length > 0) {
        try {
          commentCache.saveCounts(toSave)
        } catch (error) {
          logger.error('[commentCache] 写入失败: ' + error.message)
        }
      }
    }

    // 3) 歌曲详情照常全量取（与评论缓存无关）
    musicDetails = await getMusicListDetails(trackIds, req)
  } catch (error) {
    logger.error('[handleMusicList] ' + error.message)
  }

  for (let index = 0; index < trackIds.length; index++) {
    const x = trackIds[index]
    const musicDetailObj = musicDetails.get(x.id) || {}
    afterMusicListArr.push({
      by: 'OldsixLi',
      id: x.id,
      commentNum: musicsComment.get(x.id) || 0,
      ...musicDetailObj,
    })
  }

  return {
    name: playlist.name,
    // 原实现写的是 playlist.name，会导致 id 字段变成歌单名，这里改为真实 id
    id: playlist.id,
    // 补充：实际扫描了评论量的曲目数，超出部分 commentNum 为 0，不是真的没评论
    scannedComments: commentScanList.length,
    // 歌单总曲目数 / 本次扫描起点（前端用来算"剩余未扫描"并继续增量扫描）
    totalTracks: trackIds.length,
    scanOffset: commentOffset,
    // 本次命中缓存的曲目数 / 实际发起请求的曲目数
    cacheHit,
    fetchedComments: fetchedCount,
    musicList: afterMusicListArr,
  }
}

/**
 * 获取所有歌曲的详情 by ids
 * 说明：ids 一次性拼接在超大歌单下会过长，分批 500 个请求
 */
async function getMusicListDetails(musicIdsArr, req) {
  const musicDetails = new Map()
  const BATCH = 500

  for (let i = 0; i < musicIdsArr.length; i += BATCH) {
    const ids = musicIdsArr.slice(i, i + BATCH).map((x) => x.id)
    // song_detail 走 weapi，UA 用 PC 画像
    const query = buildQuery(req, { ids: ids.join(',') }, 'pc')

    try {
      const res = await _getSongDetail(query, request)
      const data = res.body && res.body.songs
      if (data && data.length > 0) {
        data.forEach((x) => {
          musicDetails.set(x.id, {
            name: x.name,
            author: (x.ar && x.ar[0] && x.ar[0].name) || '',
            al: x.al,
          })
        })
      }
    } catch (error) {
      logger.error('[getMusicListDetails] ' + error.message)
    }
  }

  return musicDetails
}

/**
 * 多条数据分批请求
 * @param {*} num 每批并发数
 * @param {*} musicArr 全部数据
 * @param {*} req
 */
async function getMusicListComment(num, musicArr, req) {
  const musicsCommentMap = new Map()

  for (let index = 0; index < musicArr.length; index += num) {
    if (index > 0) {
      await sleepTime(1000)
    }
    const tasks = []
    for (let i = 0; i < num; i++) {
      const obj = musicArr[index + i]
      if (obj) {
        tasks.push(getComment(obj.id, req))
      }
    }
    try {
      const data = await Promise.all(tasks)
      data.forEach((x) => {
        musicsCommentMap.set(x[0], x[1])
      })
    } catch (error) {
      logger.error('[getMusicListComment] ' + error.message)
    }
  }

  return musicsCommentMap
}

/**
 * 获取某个歌曲的评论量
 * @param {*} musicId 歌曲 ID
 * @param {*} req
 * @returns {Promise<[number, number]>} [musicId, totalCount]
 */
function getComment(musicId, req) {
  // 身份（MUSIC_A / deviceId / UA）默认每个子请求重抽；
  // IP 不跟着抽，用 ipRotator 的定时槽位 —— 200 首歌共用一个 IP 才像正常用户
  const query = buildQuery(
    req,
    {
      id: musicId.toString(),
      limit: '1',
      pageSize: '1',
      sortType: '3',
      type: '0',
    },
    'mobile',
  )

  // 记录本次用的匿名身份，失败时上报以便剔除失效 token
  const usedMusicA = query.cookie && query.cookie.MUSIC_A

  return new Promise((resolve) => {
    const onFail = () => {
      if (!req.maAuth) anonIdentity.reportFailure(usedMusicA)
      resolve([musicId, -1])
    }

    _getMusicCommentNew(query, request)
      .then((ans) => {
        // 新版返回 JSON：{ data: { totalCount } }
        // 拿不到数字时返回 -1（失败），与真实的 0 条评论区分开，
        // 调用方据此决定是否写入缓存。
        const totalCount =
          ans && ans.body && ans.body.data
            ? ans.body.data.totalCount
            : undefined
        if (typeof totalCount === 'number') {
          resolve([musicId, totalCount])
        } else {
          onFail()
        }
      }, onFail)
      .catch(onFail)
  })
}

/**
 * 批量请求间隔，防止触发风控
 * @param {*} ms
 */
function sleepTime(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = router
