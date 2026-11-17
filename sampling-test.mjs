import assert from 'node:assert/strict'
import {
  pickWithinQuota,
  pickToolCalls,
  buildSessionPayload,
  toLosslessJson,
  CLIP_BY_KIND,
  DEFAULT_CHAR_BUDGET,
} from './index.js'

const long = (n) => 'x'.repeat(n)

// 1) 额度决定条数：40000 字符额度、单条 800 → 50 条；素材不够就全给
const users = Array.from({ length: 200 }, (_, i) => `u${i}-${long(50)}`)
const picked = pickWithinQuota(users, 40_000, CLIP_BY_KIND.user)
assert.equal(picked.length, 50, `应挑出 50 条，实际 ${picked.length}`)
assert.ok(picked.every((t) => t.length <= CLIP_BY_KIND.user), '每条不超过分级截断长度')
assert.equal(pickWithinQuota(users.slice(0, 3), 40_000, 800).length, 3, '素材不足时全给')

// 2) 额度为 0 时至少留 1 条（有素材就不能空）
assert.equal(pickWithinQuota(users, 0, 800).length, 1)

// 3) 条数硬上限 200
const huge = Array.from({ length: 1000 }, () => long(10))
assert.equal(pickWithinQuota(huge, 10_000_000, 10).length, 200, '不应超过硬上限')

// 4) 写操作优先：混合 read/write 时，变更类应占多数
const calls = []
for (let i = 0; i < 50; i += 1) calls.push(`read_file src/f${i}.js`)
for (let i = 0; i < 10; i += 1) calls.push(`write_file src/out${i}.js`)
const chosen = pickToolCalls(calls, 10 * CLIP_BY_KIND.toolCalls, CLIP_BY_KIND.toolCalls)
const writes = chosen.filter((t) => t.includes('write_file')).length
assert.ok(chosen.length > 0, '应挑出工具调用')
assert.ok(writes >= Math.ceil(chosen.length * 0.4), `变更类应占多数，实际 ${writes}/${chosen.length}`)
assert.ok(chosen.every((t) => t.length <= CLIP_BY_KIND.toolCalls))

// 5) buildSessionPayload：预算模式 vs 旧模式字段一致
const item = {
  sessionId: 's1',
  isCurrent: false,
  cwd: 'D:/w',
  live: true,
  firstAt: '2026-11-16T00:00:00.000Z',
  lastAt: '2026-11-16T10:00:00.000Z',
  rawChars: 100_000,
  buckets: {
    user: Array.from({ length: 100 }, () => long(500)),
    assistant: Array.from({ length: 100 }, () => long(500)),
    toolCalls: Array.from({ length: 100 }, () => `write_file a${long(20)}`),
    toolErrors: [long(300)],
    reasoning: Array.from({ length: 50 }, () => long(200)),
  },
}
const budgetedPayload = buildSessionPayload(item, {
  quota: 50_000,
  maxEventsPerKind: 24,
  snippetChars: 160,
})
assert.ok(budgetedPayload.userMessages.length > 0)
assert.equal(budgetedPayload.coverage.allocatedChars, 50_000)
assert.equal(budgetedPayload.coverage.rawUserMessages, 100)
assert.ok(budgetedPayload.coverage.sampled, '应有抽样标记')
assert.equal(budgetedPayload.coverage.rawToolErrors, 1, '新增的原始错误数应保留')

// 用户消息条数应明显多于旧模式下的一刀切（每条 800 字 > 160 字，但条数由额度定）
assert.ok(
  budgetedPayload.userMessages[0].length > 160,
  '分级截断后用户消息应长于旧的 160 字',
)

// 6) quota=0 → 旧行为：每类 ≤ maxEventsPerKind 条、每条 ≤ snippetChars
const legacy = buildSessionPayload(item, { quota: 0, maxEventsPerKind: 24, snippetChars: 160 })
assert.equal(legacy.coverage.allocatedChars, null)
assert.ok(legacy.userMessages.length <= 24)
assert.ok(legacy.userMessages.every((t) => t.length <= 160))

// 7) 默认预算就是导出的常量
assert.equal(DEFAULT_CHAR_BUDGET, 400_000)

// 8) 工具返回体必须能无损 JSON 化：undefined / 非有限数 都要被清掉
//    （reminders / candidates 来自外部服务，字段里可能带 undefined；
//     命令路径被 JSON.stringify 掩盖，工具路径会直接报 "not lossless JSON"）
const dirty = {
  a: undefined,
  b: NaN,
  c: Infinity,
  d: [1, undefined, { e: undefined, f: 'ok' }],
  g: { h: undefined, i: 3 },
  j: 'text',
}
const clean = toLosslessJson(dirty)
assert.deepEqual(Object.keys(clean).sort(), ['b', 'c', 'd', 'g', 'j'])
assert.equal(clean.b, null, 'NaN 应变成 null')
assert.equal(clean.c, null, 'Infinity 应变成 null')
assert.deepEqual(clean.d, [1, null, { f: 'ok' }])
assert.deepEqual(clean.g, { i: 3 })
assert.equal(clean.j, 'text')
assert.doesNotThrow(() => JSON.stringify(clean))

console.log('sampling-test: all assertions passed')
