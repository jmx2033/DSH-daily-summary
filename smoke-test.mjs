// 冒烟测试：验证日界三分支、抬头形态、sessionQuery 读取通道、自检与降级声明、定时自动化。
// 运行：node smoke-test.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const stateFile = path.join(os.tmpdir(), `daily-summary-state-${process.pid}.json`)
const { apply, sampleEvenly } = await import('./index.js')

const now = Date.now()
const HOUR = 3600_000
const DAY = 24 * HOUR

/** 三个会话。session-shell 是关键回归用例：当天创建、当天还在写日志，
 *  但一条素材都提不出来（空文本）。它必须被挡在 sessionCount 与 sessions 之外，
 *  否则会把「1 个会话」伪装成「3 个会话」，让 SKILL.md 第四步阈值②的降级声明
 *  凭空消失——等于伪造覆盖面（QA 报告 §9-B1 与 lessons 裁决 3 的同类病）。
 *  session-headless 则覆盖另一个线上 bug：无 cwd、无标题时的 undefined 取值。 */
const logs = {
  'session-current': {
    session: { id: 'session-current', createdAt: now - HOUR, cwd: 'D:/work' },
    events: [
      { type: 'user/message', time: now - 1800_000, data: { content: [{ type: 'text', text: '把每日总结做成插件' }] } },
      { type: 'tool/call', time: now - 1700_000, data: { name: 'write', arguments: '{"file_path":"index.js"}' } },
      {
        type: 'tool/result',
        time: now - 1600_000,
        data: { message: { source: { callId: 'c1' } }, error: { code: 'EACCES', reason: 'denied' } },
      },
      {
        type: 'assistant/message',
        time: now - 1500_000,
        data: {
          message: {
            content: [
              { type: 'text', text: '插件已写入并注册两个工具。' },
              { type: 'reasoning', text: '先确认 API 再写代码。' },
            ],
          },
        },
      },
      { type: 'user/message', time: now - 5 * DAY, data: { content: [{ type: 'text', text: '五天前的事' }] } },
    ],
  },
  'session-shell': {
    session: { id: 'session-shell', createdAt: now - 45 * 60 * 1000 },
    events: [
      { type: 'user/message', time: now - 40 * 60 * 1000, data: { content: [{ type: 'text', text: '   ' }] } },
      // 锚点回归：插件注入的时间锚点同样是 user 角色，但过滤后不得算作素材——
      // 若这里被判「有素材」，下方「空壳会话不得出现在 sessions」的断言会失败。
      {
        type: 'user/message',
        time: now - 40 * 60 * 1000,
        data: {
          content: [{ type: 'text', text: '[时间锚点] 本轮对话的开始时刻：2026-11-18T09:00:00+08:00（本地时区）。' }],
          source: { kind: 'time-feeling', form: 'anchor' },
        },
      },
      { type: 'assistant/message', time: now - 39 * 60 * 1000, data: { message: { content: [{ type: 'text', text: '' }] } } },
      { type: 'tool/call', time: now - 38 * 60 * 1000, data: { name: '', arguments: '' } },
      { type: 'assistant/message', time: now - 37 * 60 * 1000, data: { message: { content: [{ type: 'reasoning', text: '\n\t ' }] } } },
    ],
  },
  'session-headless': {
    session: { id: 'session-headless', createdAt: now - 30 * 60 * 1000 },
    events: [{ type: 'user/message', time: now - 1200_000, data: { content: [{ type: 'text', text: '这条没有 cwd 也没有标题' }] } }],
  },
  // 跨工作区用例：完全不同的 cwd，当天也有素材，必须被汇总进来
  // 同时覆盖「真人消息要留、锚点消息要滤」的四种形态：
  //   source.kind === 'user'  → 留（显式真人）
  //   source 缺失             → 留（向后兼容：老日志不写 source）
  //   source.kind === 'time-feeling' / 'runtime-context' → 滤（插件注入）
  'session-other-workspace': {
    session: { id: 'session-other-workspace', createdAt: now - 40 * 60 * 1000, cwd: 'E:/another-workspace' },
    events: [
      {
        type: 'user/message',
        time: now - 35 * 60 * 1000,
        data: {
          content: [{ type: 'text', text: '另一个工作区里做的事' }],
          source: { kind: 'user', form: 'input' },
        },
      },
      {
        type: 'user/message',
        time: now - 34 * 60 * 1000,
        data: { content: [{ type: 'text', text: '老日志里的消息没有 source 字段' }] },
      },
      {
        type: 'user/message',
        time: now - 33 * 60 * 1000,
        data: {
          content: [{ type: 'text', text: '[时间锚点] 本轮对话的开始时刻：2026-11-18T09:00:00+08:00（本地时区）。' }],
          source: { kind: 'time-feeling', form: 'anchor' },
        },
      },
      {
        type: 'user/message',
        time: now - 32 * 60 * 1000,
        data: {
          content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
          source: { kind: 'runtime-context', form: 'inject' },
        },
      },
      {
        type: 'user/message',
        time: now - 31 * 60 * 1000,
        data: {
          content: [{ type: 'text', text: '这是一段上下文压缩摘要，浓缩了当天早些时候的工作。' }],
          source: { kind: 'compact-checkpoint', form: 'inject' },
        },
      },
    ],
  },
  'session-old': {
    session: { id: 'session-old', createdAt: now - 6 * DAY, cwd: 'D:/old' },
    events: [{ type: 'user/message', time: now - 5 * DAY, data: { content: [{ type: 'text', text: '很久以前的事' }] } }],
  },
}

/** 框架对工具返回值做 clone 后再按 JSON 序列化：任何 undefined 取值都会被判
 *  「not lossless JSON」。本测试直接把这条约束断言出来。 */
function assertLossless(value, path = 'root') {
  if (value === undefined) {
    throw new Error(`工具返回值含 undefined 取值（框架会判 not lossless JSON）：${path}`)
  }
  if (value === null || typeof value !== 'object') return
  for (const key of Object.keys(value)) assertLossless(value[key], `${path}.${key}`)
}

const queries = { list: 0, read: 0, title: 0 }
const sessionQuery = {
  async filterSessions(filters) {
    queries.list += 1
    const to = filters?.[0]?.to
    return Object.values(logs)
      .filter((log) => (to === undefined ? true : log.session.createdAt <= to))
      .map((log) => ({ header: log.session, live: false, persisted: true }))
  },
  async readSession(id) {
    queries.read += 1
    const log = logs[id]
    if (!log) throw new Error(`no such session ${id}`)
    return { session: log.session, inheritedEventCount: 0, events: log.events }
  },
  async readTitleSnapshots(ids) {
    queries.title += 1
    // 只给有标题的会话返回标题；headless 会话的 title 缺位，走 null 兜底
    return ids.map((sessionId) => ({
      sessionId,
      status: 'fulfilled',
      value: { session: logs[sessionId].session, title: logs[sessionId].session.id === 'session-current' ? { title: `【${sessionId}】的标题`, eventSeq: 1, updatedAt: now, messageSeqs: [], source: { kind: 'user' } } : undefined },
    }))
  },
}

const tools = new Map()
// 刻意不提供 ctx.sessions / ctx.agents：装配走运行时 ctx.inject，服务由配置注入。
function makeCtx(registry, services = {}, extra = {}) {
  return {
    tools: { register: (def) => (registry.set(def.name, def), () => registry.delete(def.name)) },
    get: (key) => services[key],
    sessionId: extra.sessionId,
    logger: extra.logger,
    inject: (names, callback) => {
      const scoped = {}
      let ok = true
      for (const name of names) {
        if (!(name in services)) ok = false
        scoped[name] = services[name]
      }
      if (!ok) return () => {}
      return callback(scoped) ?? (() => {})
    },
  }
}

apply(makeCtx(tools, { sessionQuery }), { stateFile })

assert.deepEqual(
  [...tools.keys()].sort(),
  ['daily_summary', 'daily_summary_selfcheck', 'daily_summary_settings'].sort(),
)

const res = await tools.get('daily_summary').execute({ deliveredEvents: 4, deliveredSessions: 2 }, {})
assert.equal(res.ok, true)
assertLossless(res, 'res') // 框架的硬约束：任何 undefined 取值都会让整次调用失败
assert.match(res.headline, /^每日总结 · \d{4}-\d{2}-\d{2}（周[一二三四五六日]，本地时区，统计区间 00:00–24:00/)
assert.equal(res.sources.error, undefined, '不得再出现读取错误')
assert.equal(res.sources.sessionCount, 3, '空壳与五天前的必须排除；两个工作区的 3 个有料会话都要在')
// 两个显式工作区 + 一个「未记录工作区」（session-headless 没有 cwd）
assert.equal(res.sources.workspaceCount, 3, '两个显式 cwd 加上一个未记录工作区的分组')
const wsList = res.sources.workspaces.map((w) => w.cwd).sort()
assert.deepEqual(
  wsList,
  ['(未记录工作区)', 'D:/work', 'E:/another-workspace'],
  '跨工作区聚合必须覆盖两个显式 cwd 与未记录分组',
)
assert.ok(
  res.sources.corpusCwdHistogram['E:/another-workspace'] >= 1,
  '语料直方图必须能看到另一个工作区，证明没被工作区限制削掉',
)
assert.equal(res.sources.sessions.length, 3, 'sessions 数组与 sessionCount 必须同源，否则模型数数组又会虚高')
assert.ok(
  !res.sources.sessions.some((s) => s.sessionId === 'session-shell'),
  '空壳会话不得出现在 sessions 数组里',
)
assert.equal(res.sources.shellSessions, 1, '空壳会话单独计数，便于核对为什么少了')
assert.equal(res.sources.sessions[0].sessionId, 'session-current')
assert.equal(res.sources.sessions[0].userMessages.length, 1, '区间外事件必须被排除')

// 插件注入的伪用户消息必须被滤掉，真人消息（含无 source 的老日志）必须保留。
{
  const other = res.sources.sessions.find((s) => s.sessionId === 'session-other-workspace')
  assert.ok(other, '跨工作区会话应在结果里')
  assert.deepEqual(
    other.userMessages,
    ['另一个工作区里做的事', '老日志里的消息没有 source 字段', '这是一段上下文压缩摘要，浓缩了当天早些时候的工作。'],
    'source.kind=user、source 缺失、compact-checkpoint 都要留；其余注入的要滤',
  )
  assert.ok(
    !other.userMessages.some((text) => text.includes('[时间锚点]')),
    '时间锚点不得进入素材',
  )
  assert.ok(
    !other.userMessages.some((text) => text.includes('runtime context')),
    '运行时上下文注入不得进入素材',
  )
}
assert.equal(res.sources.sessions[0].toolErrors.length, 1)
assert.equal(res.sources.sessions[0].eventCount, 5, '失败的工具调用也是素材，计入 eventCount')
assert.equal(res.sources.sessions[0].sourceName, '【session-current】的标题', '来源名落到会话标题')
assert.equal(res.sources.sessions[1].sessionId, 'session-headless')
assert.equal(res.sources.sessions[1].cwd, null, '缺 cwd 的会话必须归一成 null，不能留 undefined')
assert.equal(res.sources.sessions[1].title, null, '无标题事件必须归一成 null，不能留 undefined')
assert.equal(res.sources.sessions[1].sourceName, '这条没有 cwd 也没有标题', '无标题时退化为首条用户消息摘要')
assert.equal(res.rules.notice, null, '5 条事件 / 2 个会话高于阈值，不给声明')
assert.ok(queries.list >= 1 && queries.read >= 1 && queries.title >= 1, '三条读取通道都要走')

// 当前会话标记：执行上下文带 agent 时生效
const withAgent = await tools
  .get('daily_summary')
  .execute({}, { agent: { id: 'session-current' } })
assertLossless(withAgent, 'withAgent')
assert.equal(withAgent.sources.sessions[0].isCurrent, true)
assert.equal(withAgent.sources.sessions[0].sourceName, '当前会话')

const thin = await tools.get('daily_summary').execute({ deliveredEvents: 2, deliveredSessions: 1 }, {})
assert.equal(thin.rules.notice, '说明：今日可回溯内容有限，实际覆盖 1 个会话、2 条事件。')

const empty = await tools.get('daily_summary').execute({ deliveredEvents: 0, deliveredSessions: 0, uncertainMaterial: true }, {})
assert.equal(empty.rules.notice, '说明：未获取到可总结素材。 说明：部分素材时间无法确认，未纳入。')

// 通道缺失时必须如实降级，而不是崩溃或假装有素材
const degradedTools = new Map()
apply(makeCtx(degradedTools), { stateFile })
const degraded = await degradedTools.get('daily_summary').execute({}, {})
assert.equal(degraded.ok, true, '通道缺失不构成失败退出')
assert.match(degraded.sources.error, /读取通道不可用|会话列表读不出/)

// 单个会话读不出时计入 unreadable，其余会话照常返回
const flaky = {
  filterSessions: sessionQuery.filterSessions,
  readTitleSnapshots: sessionQuery.readTitleSnapshots,
  async readSession(id) {
    if (id === 'session-headless') throw new Error('replay validation failed')
    return logs[id]
  },
}
const flakyTools = new Map()
apply(makeCtx(flakyTools, { sessionQuery: flaky }), { stateFile })
const partial = await flakyTools.get('daily_summary').execute({}, {})
assert.equal(partial.ok, true)
assert.equal(partial.sources.unreadable, 1)

// 每条路径都要过这条断言：降级声明、零素材、通道缺失、部分失败都不能漏
for (const value of [withAgent, thin, empty, degraded, partial]) {
  assertLossless(value, 'res')
}

// 关键回归：空壳会话不得让 SKILL.md 第四步阈值②失效。
// 场景：当天只有 1 个会话真正有素材（2 条），外加 3 个空壳。
// 若空壳计入 sessionCount，模型会填 deliveredSessions=4 → 阈值②不命中 →
// 降级声明凭空消失，等于把「只覆盖 1 个会话」伪装成「覆盖 4 个会话」。
const singleWithShells = {
  'session-current': logs['session-current'],
  'session-shell-a': logs['session-shell'],
  'session-shell-b': logs['session-shell'],
  'session-shell-c': logs['session-shell'],
}
const singleQuery = {
  filterSessions: async () => Object.values(singleWithShells).map((l) => ({ header: l.session, live: false, persisted: true })),
  // key 用 log.session.id（插件传进来的就是这个 id），不是 fixture 的键名
  readSession: async (id) => {
    const log = Object.values(singleWithShells).find((l) => l.session.id === id)
    if (!log) throw new Error(`no such session ${id}`)
    return { session: log.session, inheritedEventCount: 0, events: log.events }
  },
  readTitleSnapshots: async (ids) =>
    ids.map((sessionId) => {
      const log = Object.values(singleWithShells).find((l) => l.session.id === sessionId)
      return { sessionId, status: 'fulfilled', value: { session: log.session, title: undefined } }
    }),
}
const singleTools = new Map()
apply(makeCtx(singleTools, { sessionQuery: singleQuery }), { stateFile })
const single = await singleTools.get('daily_summary').execute({}, {})
assertLossless(single, 'single')
assert.equal(single.sources.sessionCount, 1, '3 个空壳不得把 1 个会话虚报成 4 个')
assert.equal(single.sources.shellSessions, 3)
assert.equal(
  single.sources.sessionCount <= 1,
  true,
  '阈值②判据必须是 sessionCount<=1 才会触发「实际覆盖 1 个会话」——空壳不得破坏它',
)

await tools.get('daily_summary').execute({ markDelivered: true }, {})

// 自动化一：定时任务在工具第一次被调用时创建（sessionId 来自 exec.agent.id）。
// 三层幂等：inFlight 挡同步竞态、seen 挡进程内重复、list() 挡跨重启重复。
// 这里每次都是全新 apply（模拟重启），验证 list() 那一层。
const created = []
const tasks = []
const scheduleStub = {
  async list() { return [...tasks] },
  async create(sessionId, request) {
    created.push({ sessionId, request })
    const record = { id: `schedule-${created.length}`, title: request.title, kind: 'daily', ...request }
    tasks.push(record)
    return record
  },
}
for (let i = 0; i < 3; i++) {
  const schedTools = new Map()
  apply(makeCtx(schedTools, { sessionQuery, schedule: scheduleStub }, { sessionId: 'session-current' }), { stateFile })
  // 触发点已改为「工具第一次被调用」，用带 agent 的 exec 调用一次
  await schedTools.get('daily_summary').execute({}, { agent: { id: 'session-current' } })
}
await new Promise((r) => setTimeout(r, 30))
assert.equal(created.length, 1, '同一 Session 跨多次 apply+调用只应创建一条每日提醒')
assert.equal(created[0].request.daily.time, '00:00:00', '默认每天 24:00（次日 00:00）本地时间')
assert.equal(created[0].request.daily.time_zone, 'Asia/Shanghai')
assert.match(created[0].request.prompt, /daily_summary/, '提醒提示词要指引模型走完整流程')

// 已存在同标题任务时不再创建
created.length = 0
const scheduleWithExisting = {
  async list() { return [{ title: '每日总结', id: 'schedule-1', kind: 'daily' }] },
  async create(sessionId, request) { created.push({ sessionId, request }) },
}
const dupTools = new Map()
apply(makeCtx(dupTools, { sessionQuery, schedule: scheduleWithExisting }, { sessionId: 'session-current' }), { stateFile })
await dupTools.get('daily_summary').execute({}, { agent: { id: 'session-current' } })
await new Promise((r) => setTimeout(r, 30))
assert.equal(created.length, 0, '已有同标题任务时不得重复创建')

// 没有 agent 上下文时不建定时（不猜 sessionId）
created.length = 0
const noAgentTools = new Map()
apply(makeCtx(noAgentTools, { sessionQuery, schedule: scheduleStub }, { sessionId: 'session-current' }), { stateFile })
await noAgentTools.get('daily_summary').execute({}, {})
await new Promise((r) => setTimeout(r, 30))
assert.equal(created.length, 0, '拿不到 agent.id 时不得凭空建定时')

// 没有 schedule 服务时不得崩
const noScheduleTools = new Map()
apply(makeCtx(noScheduleTools, { sessionQuery }), { stateFile })
const noScheduleRes = await noScheduleTools.get('daily_summary').execute({}, { agent: { id: 'session-current' } })
assert.equal(noScheduleRes.ok, true, 'schedule 服务缺席不应影响工具')

// 自动化二：自检通过即自动落「已完整交付」，不依赖模型传 markDelivered
const freshState = path.join(os.tmpdir(), `daily-summary-fresh-${process.pid}.json`)
const autoTools = new Map()
apply(makeCtx(autoTools, { sessionQuery }), { stateFile: freshState })
const autoRes = await autoTools.get('daily_summary').execute({}, {})
const autoCheck = await autoTools.get('daily_summary_selfcheck').execute({ text: [
  autoRes.headline,
  '',
  '1.我觉得开心的事',
  '- 自动化跑通了。',
  '',
  '2.我觉得充实的事（+ 我觉得有收获的事）',
  '- 充实：定时与自检都接上了。',
  '',
  '3.可能需要改进的事',
  '- 今天没有记录到这方面的事',
  '',
  '4.今日份思考',
  '能自动的就不该留给模型记。',
].join('\n') }, {})
assert.equal(autoCheck.ok, true, JSON.stringify(autoCheck.problems))
assert.equal(autoCheck.markedDelivered, true, '自检通过应自动标记已交付')
const savedState = JSON.parse(await readFile(freshState, 'utf8'))
assert.equal(savedState.lastCompletedDate, autoRes.window.date, '交付日期应自动写入状态文件')

// 自检不通过时不得标记交付
const badState = path.join(os.tmpdir(), `daily-summary-bad-${process.pid}.json`)
const badTools = new Map()
apply(makeCtx(badTools, { sessionQuery }), { stateFile: badState })
const badCheck = await badTools.get('daily_summary_selfcheck').execute({ text: '空内容' }, {})
assert.equal(badCheck.ok, false)
assert.equal(badCheck.markedDelivered, undefined, '自检不通过不得标记交付')

const good = [
  res.headline,
  '',
  '1.我觉得开心的事',
  '- 把插件写完了，两个工具都注册上了。',
  '',
  '2.我觉得充实的事（+ 我觉得有收获的事）',
  '- 充实：一天里把设计和实现串通了。',
  '',
  '3.可能需要改进的事',
  '- 有一处权限被拒；下一步先看沙箱策略。',
  '',
  '4.今日份思考',
  '规则能照着走通，才算写完。',
].join('\n')
const pass = await tools.get('daily_summary_selfcheck').execute({ text: good }, {})
assert.equal(pass.ok, true, JSON.stringify(pass.problems))

const bad = good.replace('4.今日份思考', '4.今日份思考 @scene#57:"开发 Skill"').replace('- 充实：', '- 充实：用户').replace('规则能照着', '用户说规则能照着')
const fail = await tools.get('daily_summary_selfcheck').execute({ text: bad }, {})
assert.equal(fail.ok, false)
assert.ok(fail.problems.some((p) => p.includes('用户')))
assert.ok(fail.problems.some((p) => p.includes('@scene')))

// 第 4 段句数下界：素材里确实有可回看的思考时（thinkingAvailable），只写一句要拦住。
const oneSentence = good.replace('规则能照着走通，才算写完。', '规则能照着走通。')
const thinCheck = await tools
  .get('daily_summary_selfcheck')
  .execute({ text: oneSentence, thinkingAvailable: true }, {})
assert.equal(thinCheck.ok, false, '只写一句应被判不合格')
assert.ok(
  thinCheck.problems.some((problem) => problem.includes('第 4 段')),
  JSON.stringify(thinCheck.problems),
)

// 两行写法应通过（按行数计，不要求每行带句号）
const twoLines = good.replace(
  '规则能照着走通，才算写完。',
  '规则能照着走通\n自检要能真的拦住问题',
)
const thickCheck = await tools
  .get('daily_summary_selfcheck')
  .execute({ text: twoLines, thinkingAvailable: true }, {})
assert.equal(thickCheck.ok, true, JSON.stringify(thickCheck.problems))

// 同一行写两句不算两个点：规则要的是分行，不是分句
const sameLineTwo = good.replace(
  '规则能照着走通，才算写完。',
  '规则能照着走通。才算写完。',
)
const sameLineCheck = await tools
  .get('daily_summary_selfcheck')
  .execute({ text: sameLineTwo, thinkingAvailable: true }, {})
assert.equal(sameLineCheck.ok, false, '同一行写两句应被判不合格（要求分行）')

// 未开启 thinkingAvailable 时保持旧行为：一句也放行（素材不足时不硬凑）
assert.equal(pass.ok, true, '未开启时不应因句数报错')

// 第 4 段按**非空行数**计，不按句号计：三行都不带句号也必须算 3 个点
const noPeriodLines = good.replace(
  '规则能照着走通，才算写完。',
  '规则能照着走通\n自检要能真的拦住问题\n文案不能和代码说的不一样',
)
const noPeriodCheck = await tools
  .get('daily_summary_selfcheck')
  .execute({ text: noPeriodLines, thinkingAvailable: true }, {})
assert.equal(
  noPeriodCheck.ok,
  true,
  `三行无句号也应算 3 个点：${JSON.stringify(noPeriodCheck.problems)}`,
)

// 单行无句号仍应被判不合格（不能被"有行就算过"蒙过去）
const oneLineNoPeriod = good.replace('规则能照着走通，才算写完。', '规则能照着走通')
const oneLineCheck = await tools
  .get('daily_summary_selfcheck')
  .execute({ text: oneLineNoPeriod, thinkingAvailable: true }, {})
assert.equal(oneLineCheck.ok, false, '单行应被判不合格')
const dashFourth = good.replace('规则能照着走通，才算写完。', '- 规则能照着走通。')
const dashCheck = await tools
  .get('daily_summary_selfcheck')
  .execute({ text: dashFourth }, {})
assert.equal(dashCheck.ok, false, '第 4 段用 - 起行应报错')
assert.ok(
  dashCheck.problems.some((problem) => problem.includes('第 4 段不用 - 起行')),
  JSON.stringify(dashCheck.problems),
)

// 均匀采样：必须覆盖首尾，不能等价于"只取最后 N 条"
// （2026-10-31 实测：某会话当天 133 条用户消息只进来最后 8 条，上午中午全丢）
{
  const list = Array.from({ length: 100 }, (_, i) => `m${i}`)
  const kept = sampleEvenly(list, 4)
  assert.equal(kept.length, 4)
  assert.equal(kept[0], 'm0', '必须包含当天第一条')
  assert.equal(kept[kept.length - 1], 'm99', '必须包含当天最后一条')
  assert.notDeepEqual(kept, list.slice(-4), '不能退化成只取末尾')
  assert.deepEqual(sampleEvenly(['a', 'b'], 4), ['a', 'b'], '不足上限时原样返回')
  assert.deepEqual(sampleEvenly([], 4), [])
}

console.log('smoke-test OK')
console.log('headline:', res.headline)
console.log('source:', res.sources.sessions[0].sourceName, '| sessions:', res.sources.sessionCount)
