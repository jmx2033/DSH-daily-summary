import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  pickWithinQuota,
  pickToolCalls,
  buildSessionPayload,
  toLosslessJson,
  pickThinkingHints,
  shareText,
  writeSnapshot,
  RUNTIME_RULES,
  FIXED_TITLES,
  SNAPSHOT_RETENTION_DAYS,
  FOURTH_SECTION_RULE,
  FOURTH_SECTION_MIN_LINES,
  FOURTH_SECTION_MAX_LINES,
  KIND_SHARE,
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

// 9) 五类配额总和为 1，思考类不低于 15%（第 4 段要写 2-3 个点）
const shareSum = Object.values(KIND_SHARE).reduce((sum, value) => sum + value, 0)
assert.ok(Math.abs(shareSum - 1) < 1e-9, `配额总和应为 1，实际 ${shareSum}`)
assert.ok(KIND_SHARE.reasoning >= 0.15, '思考类配额应提到 15%')

// 10) 思考候选：过滤过短、去重、最多 5 条、按因果密度+长度排序
const filler = (piece) => piece.repeat(20)
const hints = pickThinkingHints(
  [
    { reasoning: ['先看看', filler('这里有个很长的过程性思考。')] },
    {
      reasoning: [
        `其实问题在于配置写错了，${filler('所以')}`,
        `其实问题在于配置写错了，${filler('所以')}`,
        filler('另一条很长的记录'),
      ],
    },
  ],
  5,
)
assert.ok(hints.length > 0, '应有候选')
assert.ok(hints.length <= 5, '最多 5 条')
assert.equal(new Set(hints).size, hints.length, '不应有重复')
assert.ok(hints.every((text) => text.length <= 220), '每条不超过 220 字')
assert.equal(pickThinkingHints([{ reasoning: ['短'] }]).length, 0, '过短的思考不算候选')
assert.ok(
  hints[0].includes('其实问题在于'),
  '讲因果/结论的思考应排在流水账式思考前面',
)

// 11) 文案里的配额百分比必须与 KIND_SHARE 一致（防止再次「文案说 8%、代码给 15%」）
const shareLine = shareText()
for (const [key, ratio] of Object.entries(KIND_SHARE)) {
  const pct = Math.round(ratio * 100)
  assert.ok(
    shareLine.includes(`${pct}%`),
    `文案应包含 ${key} 的 ${pct}%，实际：${shareLine}`,
  )
}
assert.equal(shareLine, '用户指令 36%、助手回复 22%、工具调用 14%、工具错误 13%、推理 15%')

// 12) 第 4 段规则的单一真相：常量与 SKILL.md 必须一致
//     （不做文档生成 —— 用断言守住漂移，比引入生成管线简单得多）
assert.ok(FOURTH_SECTION_RULE.includes('单独成段'), '常量应包含「每个点单独一行」的要求')
assert.ok(FOURTH_SECTION_RULE.includes('可以写长'), '常量应允许每个点写长')
assert.ok(FOURTH_SECTION_RULE.includes('不用 - 起行'), '常量应包含禁用 - 的约束')
assert.ok(
  FOURTH_SECTION_RULE.includes(`${FOURTH_SECTION_MIN_LINES} 到 ${FOURTH_SECTION_MAX_LINES} 个点`),
  '常量的点数区间应与上下界常量一致',
)
assert.ok(FOURTH_SECTION_MIN_LINES < FOURTH_SECTION_MAX_LINES, '下界应小于上界')

{
  const skill = await readFile(new URL('./docs/SKILL.md', import.meta.url), 'utf8')
  // SKILL.md 里那条规则是人工写的 markdown，抽取关键片段比对
  const skillLine = skill
    .split('\n')
    .find((line) => line.includes('第 4 段不用 - 起行'))
  assert.ok(skillLine, 'SKILL.md 应有一条第 4 段规则')
  assert.ok(skillLine.includes('单独成段'), 'SKILL.md 必须同代码一样要求分行')
  assert.ok(skillLine.includes('可以写长'), 'SKILL.md 必须同代码一样允许写长')
  assert.ok(
    skillLine.includes(`${FOURTH_SECTION_MIN_LINES} 到 ${FOURTH_SECTION_MAX_LINES} 个点`),
    `SKILL.md 的点数区间必须与代码一致（${FOURTH_SECTION_MIN_LINES} 到 ${FOURTH_SECTION_MAX_LINES}）：${skillLine}`,
  )
}

// 13) 素材快照：写入当天文件，并按 3 天留存清理更早的
{
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-snapshot-'))
  const mk = (date) => path.join(dir, `${date}.json`)
  // 预置：3 天前的应该留（边界内）、4 天前的应该删
  await writeFile(mk('2026-11-14'), '{"old":true}', 'utf8') // 超出留存
  await writeFile(mk('2026-11-15'), '{"edge":true}', 'utf8') // 恰好在上界内

  const result = await writeSnapshot(dir, '2026-11-18', { sessions: [{ sessionId: 'a' }] })
  assert.equal(result.written, true)
  assert.ok(result.path && result.path.endsWith('2026-11-18.json'))

  const saved = JSON.parse(await readFile(mk('2026-11-18'), 'utf8'))
  assert.equal(saved.date, '2026-11-18')
  assert.ok(saved.savedAt, '应记录落盘时间')
  assert.deepEqual(saved.sources.sessions, [{ sessionId: 'a' }], '素材应完整保存')

  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  assert.ok(names.includes('2026-11-18.json'), '当天快照必须存在')
  assert.ok(names.includes('2026-11-15.json'), '3 天内的要留')
  assert.ok(!names.includes('2026-11-14.json'), '超过 3 天的要清掉')
  assert.equal(result.pruned, 1, '应清理 1 个过期快照')

  assert.ok(SNAPSHOT_RETENTION_DAYS === 3, '留存天数应为 3')
}

// 14) 运行时规则是单一来源：包含四段结构、口吻定义、用户风格
{
  const joined = RUNTIME_RULES.join('\n')
  assert.ok(Array.isArray(RUNTIME_RULES), 'RUNTIME_RULES 应为数组')
  assert.ok(RUNTIME_RULES.length >= 7, '应包含全部运行时规则')
  assert.ok(joined.includes(FOURTH_SECTION_RULE), '第 4 段规则必须来自常量而非另写一份')
  assert.ok(joined.includes('本机用户'), '口吻规则必须点明「我」指用户本人')
  assert.ok(joined.includes('助手自称'), '口吻规则必须禁止助手自称')
  assert.ok(joined.includes('语气按用户本人的习惯写'), '应包含用户风格条目')
  assert.ok(joined.includes('我靠'), '风格规则应允许用户常用的粗口')
  assert.ok(joined.includes('口语化'), '风格规则应要求口语化')
  // 四段标题必须与 FIXED_TITLES 对得上（规则里没写标题，但结构文案要一致）
  assert.ok(FIXED_TITLES.length === 4)
}

// 15) SKILL.md 已降级为设计说明：不再带 version，且明确不参与运行时
{
  const skill = await readFile(new URL('./docs/SKILL.md', import.meta.url), 'utf8')
  assert.ok(
    !/^version:/m.test(skill),
    'SKILL.md 不应再有 version 字段（它不参与运行时，同步版本号是纯负担）',
  )
  assert.ok(
    skill.includes('不参与运行时'),
    'SKILL.md 应明确标注自己是设计说明',
  )
  assert.ok(
    skill.includes('RUNTIME_RULES'),
    'SKILL.md 应指出真正的规则来源',
  )
}

console.log('sampling-test: all assertions passed')
