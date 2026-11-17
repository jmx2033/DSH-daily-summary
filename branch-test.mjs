// 分支结构的回归：一天内已交付 → 同一天再触发就跳过；未交付 → 照常产出。
// 运行：node branch-test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from './index.js'

const tools = new Map()
const ctx = {
  tools: { register: (def) => (tools.set(def.name, def), () => {}) },
  get: () => undefined,
  logger: { warn: () => {} },
  inject: () => () => {},
}

const NOON = new Date('2026-10-20T13:00:00+08:00')
const EVENING = new Date('2026-10-20T23:30:00+08:00')
const stateFile = path.join(await mkdtemp(path.join(tmpdir(), 'ds-branch-')), 'state.json')

let clock = NOON
apply(ctx, {
  stateFile,
  clock: () => clock,
  sessionQuery: undefined,
})

const daily = tools.get('daily_summary')
const selfcheck = tools.get('daily_summary_selfcheck')
assert.ok(daily && selfcheck, '两个工具都应注册')

const TODAY = '2026-10-20'

// 1) 当天还没交付：工具正常产出（skip 不出现）
{
  const first = await daily.execute({}, {})
  assert.equal(first.ok, true)
  assert.notEqual(first.skipped, true, '当天未交付时不应跳过')
  assert.ok(first.headline.includes(TODAY), '抬头应指向今天')
}

// 2) 自检通过 = 记成"今天已交付"（自动化路径不传 markDelivered，靠这一步兜底）
{
  const text = (
    '每日总结 · 2026-10-20（周二，本地时区，统计区间 00:00–24:00（进行中，截至 13:00））\n\n' +
    '1.我觉得开心的事\n' +
    '- 把每日总结的分支逻辑理顺了。\n\n' +
    '2.我觉得充实的事（+ 我觉得有收获的事）\n' +
    '收获：同一天只交一份这件事要在工具里兜住，不能只靠提醒词。\n\n' +
    '3.可能需要改进的事\n' +
    '- 今天没有记录到这方面的事\n\n' +
    '4.今日份思考\n' +
    '真正稳的自动化是让状态可查，而不是让模型记得。'
  )
  const result = await selfcheck.execute({ text }, { agent: { id: 'session-branch' } })
  assert.equal(result.ok, true, `自检应通过，problems=${JSON.stringify(result.problems)}`)
  assert.equal(result.markedDelivered, true)

  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.ok(Array.isArray(saved.deliveredDates), '状态文件应记录 deliveredDates 名单')
  assert.ok(saved.deliveredDates.includes(TODAY), '今天应在已交付名单里')
  assert.equal(saved.deliveredTodaySessionId, 'session-branch', '应记下交付发生的会话')
  assert.equal(saved.deliveredTodayDate, TODAY)
}

// 3) 同一天**手动**再触发：不再跳过，直接重新取数成文
//    （2026-10-24 修正：跳过只该约束定时任务，手动是用户主动要，不该被 force 卡住）
{
  clock = EVENING
  const second = await daily.execute({}, { agent: { id: 'session-branch' } })
  assert.equal(second.ok, true)
  assert.notEqual(second.skipped, true, '手动重复触发应重新生成，不再跳过')
  assert.ok(Array.isArray(second.sections), '手动重做要返回成文素材')
  assert.equal(second.window.date, TODAY)
}

// 3b) 自动路径（auto）永远是"补昨天"，不会因为今天已交付就停：
//     它只看***目标日***有没有交过。昨天没交过 → 照常产出。（昨天已交的跳过见 7/11）
{
  const autoYesterday = await daily.execute({ auto: true }, { agent: { id: 'session-branch' } })
  assert.equal(autoYesterday.window.date, '2026-10-19', 'auto 的目标日必须是昨天')
  assert.notEqual(autoYesterday.skipped, true, '昨天没交过，自动任务应补上')
}

// 4) force=true：自动路径也允许重做（手动本来就不需要它）
{
  const forced = await daily.execute({ force: true, auto: true }, { agent: { id: 'session-branch' } })
  assert.notEqual(forced.skipped, true, 'force=true 应允许重做')
  assert.ok(Array.isArray(forced.sections))
}

// 5) 次日又回到产出分支
{
  clock = new Date('2026-10-21T10:00:00+08:00')
  const nextDay = await daily.execute({}, {})
  assert.notEqual(nextDay.skipped, true, '换了一天应该照常产出')
  assert.ok(nextDay.headline.includes('2026-10-21'))
}

// 6) 状态文件里没有 deliveredDates 的旧格式：视为"今天没交过"，不误跳过
{
  const legacy = path.join(await mkdtemp(path.join(tmpdir(), 'ds-branch-legacy-')), 'state.json')
  await writeFile(legacy, JSON.stringify({ lastCompletedDate: '2026-10-19', lastCompletedAt: '2026-10-19T04:00:00.000Z' }))
  const legacyTools = new Map()
  apply(
    {
      tools: { register: (def) => (legacyTools.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    { stateFile: legacy, clock: () => NOON },
  )
  const res = await legacyTools.get('daily_summary').execute({}, {})
  assert.notEqual(res.skipped, true, '旧格式状态不应导致误跳过')
}

// 7) 24:00 边界（次日 00:00）：昨天已交付 → 静默跳过，绝不产出一份空白的新一天总结
//    这是最危险的路径：若把边界误判成"切当天"，会写一份几乎空白的次日总结并记成已交付，
//    那一整天的真总结就再也补不上了。
{
  const state = path.join(await mkdtemp(path.join(tmpdir(), 'ds-midnight-')), 'state.json')
  // 昨天（10-20）已交付：lastCompletedAt 落在 10-20 中午
  await writeFile(
    state,
    JSON.stringify({
      lastCompletedDate: '2026-10-20',
      lastCompletedAt: '2026-10-20T04:00:00.000Z',
      deliveredDates: ['2026-10-20'],
    }),
  )
  const tools2 = new Map()
  apply(
    {
      tools: { register: (def) => (tools2.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    { stateFile: state, clock: () => new Date('2026-10-21T00:00:02+08:00') },
  )
  // 24:00 到点跑的是**定时任务**，所以这条用例带 auto（手动触发不跳过，
  // 那是用户主动要——见用例 3）
  const res = await tools2.get('daily_summary').execute({ auto: true }, {})
  assert.equal(res.skipped, true, '昨天已交付时，24:00 触发的自动任务必须跳过')
  assert.equal(res.date, '2026-10-20', '跳过的应是"刚结束的那一天"，不是新的一天')
  assert.equal(res.branch, 'catch-up', '00:00 应走凌晨补记分支，不能切当天')
  assert.ok(!res.headline.includes('2026-10-21'), '抬头不应指向刚开始的新一天')
  const after = JSON.parse(await readFile(state, 'utf8'))
  assert.deepEqual(after.deliveredDates, ['2026-10-20'], '不得把新的一天记成已交付')
}

// 8) 24:00 边界 + 昨天未交付：补记昨天（而不是产出空白的新一天）
{
  const state = path.join(await mkdtemp(path.join(tmpdir(), 'ds-midnight2-')), 'state.json')
  await writeFile(
    state,
    JSON.stringify({
      lastCompletedDate: '2026-10-19',
      lastCompletedAt: '2026-10-19T04:00:00.000Z',
      deliveredDates: ['2026-10-19'],
    }),
  )
  const tools3 = new Map()
  apply(
    {
      tools: { register: (def) => (tools3.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    { stateFile: state, clock: () => new Date('2026-10-21T00:00:02+08:00') },
  )
  const res = await tools3.get('daily_summary').execute({}, {})
  assert.notEqual(res.skipped, true, '昨天没交过就该补记')
  assert.equal(res.window.branch, 'catch-up')
  // 补记分支没有"截至时刻"。这里必须验「返回值里没有 undefined」：
  // 框架要求工具返回值是无损 JSON，一个 undefined 就让整次调用失败
  // （2026-10-22 00:00 的定时任务正是撞在这，daily_summary 报 value is not lossless JSON）。
  const walk = (value, at) => {
    if (value === undefined) throw new Error(`${at} 是 undefined`)
    if (value === null || typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value)) walk(inner, `${at}.${key}`)
  }
  walk(res, 'res')
  assert.equal(res.window.cutoff, null, '补记的 cutoff 应为 null 而不是缺省/undefined')
  assert.ok(res.headline.includes('2026-10-20'), '应统计刚结束的 2026-10-20')
  assert.ok(res.headline.includes('凌晨补记'), '补记注记不能带截至时刻')
}

// 9) 凌晨 1 小时后（01:30）仍保留「切当天」例外：这是给人手动问"今天"用的
{
  const state = path.join(await mkdtemp(path.join(tmpdir(), 'ds-cutover-')), 'state.json')
  await writeFile(
    state,
    JSON.stringify({
      lastCompletedDate: '2026-10-20',
      lastCompletedAt: '2026-10-20T04:00:00.000Z',
      deliveredDates: ['2026-10-20'],
    }),
  )
  const tools4 = new Map()
  apply(
    {
      tools: { register: (def) => (tools4.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    { stateFile: state, clock: () => new Date('2026-10-21T01:30:00+08:00') },
  )
  const res = await tools4.get('daily_summary').execute({}, {})
  assert.equal(res.window.branch, 'in-progress-cutover', '01:30 应保留「凌晨切当天」例外')
  assert.ok(res.headline.includes('2026-10-21'), '切当天后抬头指向新的一天')
}

// 10) 自动路径 + 关机延迟补发：次日早上 09:00 才投递，仍要补"昨天"，不能统计成新的一天
{
  const state = path.join(await mkdtemp(path.join(tmpdir(), 'ds-auto-')), 'state.json')
  await writeFile(
    state,
    JSON.stringify({
      lastCompletedDate: '2026-10-19',
      lastCompletedAt: '2026-10-19T04:00:00.000Z',
      deliveredDates: ['2026-10-19'],
    }),
  )
  const t = new Map()
  apply(
    {
      tools: { register: (def) => (t.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    { stateFile: state, clock: () => new Date('2026-10-21T09:00:00+08:00') },
  )
  const res = await t.get('daily_summary').execute({ auto: true }, {})
  assert.notEqual(res.skipped, true, '昨天没交过，自动任务应补上')
  assert.equal(res.window.branch, 'catch-up')
  assert.ok(res.headline.includes('2026-10-20'), '应补 2026-10-20，而不是统计成 2026-10-21')
  assert.ok(res.headline.includes('凌晨补记'))
}

// 11) 自动路径：昨天已交付 → 跳过，且不得把今天记成已交付
{
  const state = path.join(await mkdtemp(path.join(tmpdir(), 'ds-auto2-')), 'state.json')
  await writeFile(
    state,
    JSON.stringify({
      lastCompletedDate: '2026-10-20',
      lastCompletedAt: '2026-10-20T04:00:00.000Z',
      deliveredDates: ['2026-10-20'],
    }),
  )
  const t = new Map()
  apply(
    {
      tools: { register: (def) => (t.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    { stateFile: state, clock: () => new Date('2026-10-21T09:00:00+08:00') },
  )
  const res = await t.get('daily_summary').execute({ auto: true }, {})
  assert.equal(res.skipped, true, '昨天已有总结时自动任务应跳过')
  assert.equal(res.date, '2026-10-20')
  const after = JSON.parse(await readFile(state, 'utf8'))
  assert.deepEqual(after.deliveredDates, ['2026-10-20'], '不得把 10-21 记成已交付')
}

// 12) 自动路径全流程：早上补发昨天的成稿，自检要认这个抬头，并记在**昨天**
{
  const state = path.join(await mkdtemp(path.join(tmpdir(), 'ds-auto3-')), 'state.json')
  await writeFile(
    state,
    JSON.stringify({
      lastCompletedDate: '2026-10-19',
      lastCompletedAt: '2026-10-19T04:00:00.000Z',
      deliveredDates: ['2026-10-19'],
    }),
  )
  const t = new Map()
  apply(
    {
      tools: { register: (def) => (t.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    { stateFile: state, clock: () => new Date('2026-10-21T09:00:00+08:00') },
  )
  const text = (
    '每日总结 · 2026-10-20（周二，本地时区，统计区间 00:00–24:00（凌晨补记））\n\n' +
    '1.我觉得开心的事\n' +
    '- 把每日总结的补发路径理顺了。\n\n' +
    '2.我觉得充实的事（+ 我觉得有收获的事）\n' +
    '收获：目标日要看"哪一天还没交"，不能看当时几点。\n\n' +
    '3.可能需要改进的事\n' +
    '- 今天没有记录到这方面的事\n\n' +
    '4.今日份思考\n' +
    '把时间写死在判断里，换个启动时刻就会失效。'
  )
  const result = await t.get('daily_summary_selfcheck').execute({ text }, { agent: { id: 's-auto' } })
  assert.equal(result.ok, true, `早上补发昨天的抬头应被自检接受，problems=${JSON.stringify(result.problems)}`)
  assert.equal(result.deliveredDate, '2026-10-20', '要记在昨天')
  const after = JSON.parse(await readFile(state, 'utf8'))
  assert.ok(after.deliveredDates.includes('2026-10-20'))
  assert.ok(!after.deliveredDates.includes('2026-10-21'), '绝不能把今天记成已交付')
}

// 11b) 触发时间改到晚上（23:50）**准点**投递：目标是今天，不是"昨天"
//      背景（2026-10-30 实测）：auto 一律补昨天，23:50 触发时昨天已交过 →
//      整轮 skipped，当天反而一份总结都没有。
{
  const state = path.join(await mkdtemp(path.join(tmpdir(), 'ds-auto2350-')), 'state.json')
  await writeFile(
    state,
    JSON.stringify({
      lastCompletedDate: '2026-10-20',
      lastCompletedAt: '2026-10-20T04:00:00.000Z',
      deliveredDates: ['2026-10-20'],
    }),
  )
  const t = new Map()
  apply(
    {
      tools: { register: (def) => (t.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    {
      stateFile: state,
      clock: () => new Date('2026-10-21T23:50:05+08:00'),
      scheduleTime: '23:50:00',
    },
  )
  const res = await t.get('daily_summary').execute({ auto: true }, {})
  assert.notEqual(res.skipped, true, '晚上准点触发不能跳过')
  assert.equal(res.window.date, '2026-10-21', '23:50 触发应统计今天，而不是昨天')
  assert.equal(res.window.branch, 'in-progress', '23:50 属于白天/晚上分支')
}

// 11c) 同一设置下关机延迟到次日早上才投递：仍要补昨天，不能统计成新的一天
{
  const state = path.join(await mkdtemp(path.join(tmpdir(), 'ds-auto2350late-')), 'state.json')
  await writeFile(
    state,
    JSON.stringify({
      lastCompletedDate: '2026-10-19',
      lastCompletedAt: '2026-10-19T04:00:00.000Z',
      deliveredDates: ['2026-10-19'],
    }),
  )
  const t = new Map()
  apply(
    {
      tools: { register: (def) => (t.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    {
      stateFile: state,
      clock: () => new Date('2026-10-21T09:00:00+08:00'),
      scheduleTime: '23:50:00',
    },
  )
  const res = await t.get('daily_summary').execute({ auto: true }, {})
  assert.notEqual(res.skipped, true)
  assert.equal(res.window.date, '2026-10-20', '迟到投递应补「刚结束的那一天」')
  assert.equal(res.window.branch, 'catch-up')
}

console.log('branch-test: all assertions passed')
