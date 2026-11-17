import assert from 'node:assert/strict'
import { allocateBudget, CLIP_BY_KIND, DEFAULT_CHAR_BUDGET } from './index.js'

const BUDGET = 400_000
const sum = (map) => [...map.values()].reduce((a, b) => a + b, 0)

// 1) 空/零预算
assert.equal(allocateBudget([], BUDGET).size, 0)
assert.equal(allocateBudget([{ sessionId: 'a', rawChars: 10 }], 0).size, 0)

// 2) 单会话：预算应基本吃满（会话少时不能只给 40%）
const one = allocateBudget([{ sessionId: 'a', rawChars: 1000 }], BUDGET)
assert.equal(one.size, 1)
assert.equal(one.get('a'), BUDGET, '单会话应拿满预算')

// 3) 26 个会话、一个巨无霸：总和 ≤ 预算，人人有份，巨无霸被上限压住
const many = []
for (let i = 0; i < 25; i += 1) many.push({ sessionId: `s${i}`, rawChars: 2000 })
many.push({ sessionId: 'huge', rawChars: 500_000 })
const alloc = allocateBudget(many, BUDGET)
assert.equal(alloc.size, 26)
assert.ok(sum(alloc) <= BUDGET, `分配总和 ${sum(alloc)} 不应超过预算`)
for (const [, v] of alloc) assert.ok(v > 0, '每个会话都应分到额度')
assert.ok(alloc.get('huge') <= BUDGET * 0.25 + 1, '巨无霸不该超过 25%')
assert.ok(alloc.get('huge') > alloc.get('s0'), '大会话应比小会话拿得多')
assert.ok(alloc.get('s0') > 0)

// 4) 每个会话都有保底（即使 rawChars=0）
const zero = allocateBudget(
  [
    { sessionId: 'x', rawChars: 0 },
    { sessionId: 'y', rawChars: 0 },
  ],
  BUDGET,
)
assert.ok(zero.get('x') > 0 && zero.get('y') > 0, '零原始量也应拿到保底')
assert.ok(sum(zero) <= BUDGET)

// 5) 分级截断：用户消息最长，工具调用最短
assert.ok(CLIP_BY_KIND.user > CLIP_BY_KIND.toolCalls)
assert.ok(CLIP_BY_KIND.toolErrors > CLIP_BY_KIND.toolCalls)
assert.equal(DEFAULT_CHAR_BUDGET, 400_000)

console.log('budget-test: all assertions passed')
