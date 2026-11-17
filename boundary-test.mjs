// 日界分支测试：注入可控时钟，逐条验证三条互斥分支与抬头形态。
// 运行：node boundary-test.mjs
import assert from 'node:assert/strict'
import { apply } from './index.js'

function toolsAt(iso, extra = {}) {
  const tools = new Map()
  const ctx = {
    tools: { register: (d) => (tools.set(d.name, d), () => {}) },
    // 只测日界分支，不接读取通道，也不接定时服务
    get: () => undefined,
    inject: () => () => {},
  }
  apply(ctx, {
    clock: () => new Date(iso),
    stateFile: `C:/temp/none-${Math.random().toString(36).slice(2)}.json`,
    ...extra,
  })
  return tools
}

async function runAt(iso, args = {}) {
  return toolsAt(iso).get('daily_summary').execute(args, {})
}

// 白天中途：统计当天、区间 00:00–24:00、注记带截至时刻
const noon = await runAt('2026-10-19T13:04:00+08:00')
assert.equal(noon.window.branch, 'in-progress')
assert.equal(
  noon.headline,
  '每日总结 · 2026-10-19（周一，本地时区，统计区间 00:00–24:00（进行中，截至 13:04））',
)

// 23:59 仍属白天分支：不把未过完的一天报成完整
const lateNight = await runAt('2026-10-19T23:59:00+08:00')
assert.equal(lateNight.window.branch, 'in-progress')
assert.ok(lateNight.headline.endsWith('（进行中，截至 23:59））'), '注记与抬头两个右括号都要保留')

// 凌晨默认补记前一个自然日，注记（凌晨补记）且不带截至时刻
const catchUp = await runAt('2026-10-20T00:00:00+08:00')
assert.equal(catchUp.window.branch, 'catch-up')
assert.equal(
  catchUp.headline,
  '每日总结 · 2026-10-19（周一，本地时区，统计区间 00:00–24:00（凌晨补记））',
)

// 03:59 仍在补记窗口，04:00 整点切回白天分支——并集覆盖全天
assert.equal((await runAt('2026-10-20T03:59:00+08:00')).window.branch, 'catch-up')
const cutover = await runAt('2026-10-20T04:00:00+08:00')
assert.equal(cutover.window.branch, 'in-progress')
assert.equal(cutover.window.date, '2026-10-20')

// 时间读不出是唯一失败退出条件
const broken = toolsAt('2026-10-19T13:04:00+08:00', { clock: () => new Date(Number.NaN) })
const failed = await broken.get('daily_summary').execute({}, {})
assert.equal(failed.ok, false)
assert.match(failed.result, /无法确定统计区间/)

// 自检：合法成稿通过，违反禁止事项的成稿被逐条点名
const good = [
  noon.headline,
  '',
  '1.我觉得开心的事',
  '- 把插件写完了。',
  '',
  '2.我觉得充实的事（+ 我觉得有收获的事）',
  '- 充实：一天把设计和实现串通了。',
  '',
  '3.可能需要改进的事',
  '- 今天没有记录到这方面的事',
  '',
  '4.今日份思考',
  '规则能照着走通，才算写完。',
].join('\n')
const pass = await toolsAt('2026-10-19T13:04:00+08:00', { clock: () => new Date('2026-10-19T13:04:00+08:00') })
  .get('daily_summary_selfcheck')
  .execute({ text: good }, {})
assert.equal(pass.ok, true, JSON.stringify(pass.problems))

const bad = good.replace('4.今日份思考', '4.今日份思考 @scene#57:"开发 Skill"').replace('- 充实：', '- 充实：用户')
const fail = await toolsAt('2026-10-19T13:04:00+08:00', { clock: () => new Date('2026-10-19T13:04:00+08:00') })
  .get('daily_summary_selfcheck')
  .execute({ text: bad }, {})
assert.equal(fail.ok, false)
assert.ok(fail.problems.some((p) => p.includes('用户')))
assert.ok(fail.problems.some((p) => p.includes('@scene')))

console.log('boundary-test OK')
console.log('白天:', noon.headline)
console.log('凌晨:', catchUp.headline)
