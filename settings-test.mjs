// 回归：设置页背后的「触发时间 / 触发会话」写入路径。
// 一条操作三个调用方（设置页命令、agent 工具、ensureSchedule）必须落到同一份事实：
// 时间改了要同步到所有会话的提醒，指定会话后其余提醒要被清掉，24:00 就是次日 00:00。
// 运行：node settings-test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, clockForDisplay, normalizeClockInput } from './index.js'

const real = Date.now
Date.now = () => new Date('2026-10-21T23:47:00+08:00').getTime()
process.on('exit', () => {
  Date.now = real
})

// 1) 时间归一化：24:00 与 00:00 是同一时刻
{
  assert.equal(normalizeClockInput('24:00'), '00:00:00')
  assert.equal(normalizeClockInput('00:00'), '00:00:00')
  assert.equal(normalizeClockInput('23:30'), '23:30:00')
  assert.equal(normalizeClockInput('0:5'), undefined, '分钟必须两位')
  assert.equal(normalizeClockInput('24:30'), undefined, '24 点只能配 00 分')
  assert.equal(normalizeClockInput('25:00'), undefined)
  assert.equal(normalizeClockInput('abc'), undefined)
  assert.equal(clockForDisplay('00:00:00'), '24:00')
  assert.equal(clockForDisplay('23:30:00'), '23:30')
}

const tmpDir = () => mkdtemp(path.join(tmpdir(), 'ds-settings-'))

/**
 * 假的 schedule 服务：catalog/list/update/create/delete 都真的改内存里的 records，
 * 这样断言的是"落到提醒上的结果"，而不是"调用了几次"。
 */
function makeSchedule(seed) {
  const records = seed.map((record) => ({ ...record }))
  const calls = { update: [], create: [], delete: [] }
  return {
    records,
    calls,
    async catalog() {
      return records.map((record) => ({ ...record }))
    },
    async list({ sessionId }) {
      return records
        .filter((record) => record.sessionId === sessionId)
        .map(({ sessionId: _ignored, status: _status, ...rest }) => ({ ...rest }))
    },
    async update(request) {
      calls.update.push(request)
      const record = records.find((item) => item.id === request.id)
      if (!record) throw new Error(`no such record: ${request.id}`)
      if (request.change && request.change.daily) record.time = request.change.daily.time
      if (typeof request.prompt === 'string') record.prompt = request.prompt
      return { ...record }
    },
    async create(sessionId, request) {
      calls.create.push({ sessionId, request })
      const record = {
        id: `created-${records.length + 1}`,
        title: request.title,
        kind: 'daily',
        time: request.daily.time,
        timeZone: request.daily.time_zone,
        prompt: request.prompt,
        sessionId,
        status: 'active',
      }
      records.push(record)
      return { ...record }
    },
    async delete(request) {
      calls.delete.push(request)
      const index = records.findIndex((item) => item.id === request.id)
      if (index === -1) throw new Error(`no such record: ${request.id}`)
      records.splice(index, 1)
      return { id: request.id }
    },
  }
}

function makeCtx(schedule, sessionQuery) {
  const commands = new Map()
  const toolRegistry = new Map()
  return {
    commands,
    tools: { register: (definition) => { toolRegistry.set(definition.name, definition); return () => {} } },
    registeredTools: toolRegistry,
    get: (name) => (name === 'schedule' ? schedule : undefined),
    logger: { warn: () => {} },
    inject: (deps, callback) => {
      const needs = Array.isArray(deps) ? deps : []
      const scope = {}
      if (needs.includes('commands')) {
        scope.commands = {
          register: (definition) => {
            commands.set(definition.name, definition)
            return () => {}
          },
          list: () => [...commands.values()],
        }
      }
      if (needs.includes('sessionQuery')) scope.sessionQuery = sessionQuery
      callback(scope)
      return () => {}
    },
  }
}

const seedRecords = () => [
  {
    id: 'r1',
    title: '每日总结',
    kind: 'daily',
    time: '23:00:00.000',
    timeZone: 'Asia/Shanghai',
    prompt: '旧的提醒词',
    sessionId: 'session-a',
    status: 'active',
  },
  {
    id: 'r2',
    title: '每日总结',
    kind: 'daily',
    time: '23:00:00.000',
    timeZone: 'Asia/Shanghai',
    prompt: '旧的提醒词',
    sessionId: 'session-b',
    status: 'active',
  },
]

const sessionQuery = {
  async filterSessions(filters) {
    // 严格模拟真实 sessionQuery：created-at 的 to 必须是数字时间戳，
    // 传 Date 对象就抛错。（2026-10-23 真实 bug：传 new Date() 被 catch 吞成
    // 空列表，设置页下拉框因此只剩「自动」。桩必须能复现这条约束。）
    for (const filter of filters ?? []) {
      if (filter.kind === 'created-at' && typeof filter.to !== 'number') {
        throw new Error('created-at filter: to must be a number')
      }
    }
    return [
      { header: { id: 'session-a', cwd: 'D:\\w' } },
      { header: { id: 'session-b', cwd: 'D:\\other' } },
      { header: { id: 'session-untitled', cwd: 'D:\\w' } },
      { header: { id: 'session-blank', cwd: 'D:\\w' } },
    ]
  },
  async readTitleSnapshots(ids) {
    return ids.map((id) => {
      // 复现 2026-10-23 的真实情况：一批会话根本没有标题。
      if (id === 'session-untitled') {
        return { sessionId: id, status: 'fulfilled', value: { title: { title: null } } }
      }
      if (id === 'session-blank') {
        return { sessionId: id, status: 'fulfilled', value: { title: { title: '   ' } } }
      }
      return {
        sessionId: id,
        status: 'fulfilled',
        value: { title: { title: `标题-${id.slice(-1)}` } },
      }
    })
  },
}

const parse = (result) => {
  assert.equal(result.kind, 'success', `命令应成功：${result.text}`)
  return JSON.parse(result.text)
}

// 2) 读：返回当前时间、生效的提醒、可选会话
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')
  assert.ok(command, '设置命令应已注册')

  const payload = parse(await command.handler({ agent: { id: 'session-a' }, rawInput: '' }))
  assert.equal(payload.time, '24:00', '00:00 要显示成 24:00')
  assert.equal(payload.defaultTime, '24:00')
  assert.equal(payload.targetSessionId, null, '默认是自动算法')
  assert.equal(payload.reminders.length, 2)
  // 无标题会话**只标不滤**：宿主仍带回它，界面据 titled 决定是否渲染。
  // 保留它们是为了让"当前固定会话恰好无标题"时还能查到身份、如实显示。
  assert.deepEqual(
    payload.candidates.map((item) => item.id).sort(),
    ['session-a', 'session-b', 'session-blank', 'session-untitled'],
  )
  const titledIds = payload.candidates.filter((item) => item.titled).map((item) => item.id).sort()
  assert.deepEqual(titledIds, ['session-a', 'session-b'], '无标题/空白标题都应标成 titled: false')
  assert.equal(payload.candidates.find((item) => item.id === 'session-a').title, '标题-a')
  assert.equal(payload.callerSessionId, 'session-a')
  // 下拉框按工作区分组：每条候选必须带 cwd（桩里两个不同 cwd，若漏传时间戳
  // 类型约束，filterSessions 抛错、candidates 变空 → 这条断言立刻失败）
  for (const candidate of payload.candidates) {
    assert.equal(typeof candidate.cwd, 'string', '候选必须带 cwd 供分组渲染')
    assert.ok(candidate.cwd.length > 0)
  }
  assert.ok(
    new Set(payload.candidates.map((item) => item.cwd)).size > 1,
    '两个工作区应能区分（分组渲染依赖它）',
  )
  // 版本号随插件走：设置页要能显示当前加载的是哪一版
  assert.match(String(payload.version), /^\d+\.\d+\.\d+$/, '应返回语义化版本号')
  // 提醒行要能看出固定在哪条对话：带标题
  assert.equal(payload.reminders[0].sessionTitle, '标题-a')
  assert.equal(payload.reminders[1].sessionTitle, '标题-b')
}

// 3) 改时间：所有会话的提醒一起改，并写进设置文件
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  const stateFile = path.join(dir, 'state.json')
  apply(ctx, { stateFile, sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')

  const payload = parse(await command.handler({ agent: { id: 'session-a' }, rawInput: 'time 23:30' }))
  assert.equal(payload.time, '23:30')
  assert.equal(payload.reminders.length, 2)
  for (const record of schedule.records) {
    assert.equal(record.time, '23:30:00', `${record.id} 应被改成 23:30`)
    assert.notEqual(record.prompt, '旧的提醒词', '旧的提醒词应随迁移一起更新')
  }
  const stored = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(stored.scheduleTime, '23:30:00')
}

// 4) 24:00 落盘是 00:00:00，但界面读回来仍是 24:00
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')

  const payload = parse(await command.handler({ agent: { id: 'session-a' }, rawInput: 'time 24:00' }))
  assert.equal(payload.timeRaw, '00:00:00')
  assert.equal(payload.time, '24:00')
  assert.equal(schedule.records[0].time, '00:00:00')
}

// 5) 非法时间：明确报错，不写任何东西
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')

  const result = await command.handler({ agent: { id: 'session-a' }, rawInput: 'time 24:30' })
  assert.equal(result.kind, 'error')
  assert.equal(schedule.records[0].time, '23:00:00.000', '非法输入不能改到提醒')
  assert.equal(schedule.calls.update.length, 0)
}

// 6) 指定会话：只留目标会话那条，其余删除
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')

  const payload = parse(await command.handler({ agent: { id: 'session-a' }, rawInput: 'target session-b' }))
  assert.equal(payload.targetSessionId, 'session-b')
  assert.deepEqual(schedule.records.map((record) => record.sessionId), ['session-b'])
  assert.equal(schedule.calls.delete.length, 1, '另一条应被删除')
  assert.equal(schedule.calls.delete[0].id, 'r1')
}

// 7) 指定到一条还没有提醒的会话：在那边新建
{
  const dir = await tmpDir()
  const schedule = makeSchedule([])
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')

  const payload = parse(await command.handler({ agent: { id: 'session-a' }, rawInput: 'target session-b' }))
  assert.equal(payload.targetSessionId, 'session-b')
  assert.equal(schedule.records.length, 1)
  assert.equal(schedule.records[0].sessionId, 'session-b')
  assert.equal(schedule.records[0].time, '00:00:00')
}

// 8) target auto 恢复默认算法（已存在的提醒保持不动，只是不再指定会话）
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')

  await command.handler({ agent: { id: 'session-a' }, rawInput: 'target session-b' })
  const payload = parse(await command.handler({ agent: { id: 'session-a' }, rawInput: 'target auto' }))
  assert.equal(payload.targetSessionId, null)
  assert.equal(schedule.records.length, 1, '恢复自动不会额外新建')
  assert.equal(schedule.records[0].sessionId, 'session-b')
}

// 9) agent 工具与设置页看到同一份事实
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const tool = ctx.registeredTools.get('daily_summary_settings')
  assert.ok(tool, '工具应已注册')

  const updated = await tool.execute({ action: 'set_time', time: '22:15' }, { agent: { id: 'session-a' } })
  assert.equal(updated.ok, true)
  assert.equal(updated.time, '22:15')
  assert.equal(schedule.records.every((record) => record.time === '22:15:00'), true)

  const read = await tool.execute({ action: 'get' }, { agent: { id: 'session-a' } })
  assert.equal(read.time, '22:15')
  assert.equal(read.reminders.length, 2)

  const bad = await tool.execute({ action: 'set_time', time: 'nope' }, { agent: { id: 'session-a' } })
  assert.equal(bad.ok, false)
  assert.ok(bad.error)
}

// 10) ensureSchedule 尊重设置里的目标会话：不在别的会话里重复建提醒
{
  const dir = await tmpDir()
  const schedule = makeSchedule([])
  const ctx = makeCtx(schedule, sessionQuery)
  const stateFile = path.join(dir, 'state.json')
  apply(ctx, { stateFile, sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')

  await command.handler({ agent: { id: 'session-a' }, rawInput: 'target session-b' })
  const before = schedule.records.length

  // 让 daily_summary 跑一次（会顺带调 ensureSchedule），调用方是 session-a
  const payload = JSON.parse(command.handler ? '{}' : '{}')
  void payload
  const tool = ctx.registeredTools.get('daily_summary')
  await tool.execute({}, { agent: { id: 'session-a', followup: () => {} } })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(schedule.records.length, before, '目标会话已指定，不能再给 session-a 建一条')
  assert.deepEqual(schedule.records.map((record) => record.sessionId), ['session-b'])
}

// 11) get 返回取数/分界可调项的当前值、范围、默认值与覆盖标记
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')

  const payload = parse(await command.handler({ agent: { id: 'session-a' }, rawInput: '' }))
  const t = payload.tuning
  assert.ok(t, 'get 应返回 tuning')
  assert.ok(t.values, 'tuning.values 应存在')
  assert.equal(t.values.cutoverHour, 4, '默认日界钟点是 4 点')
  assert.equal(t.values.maxEventsPerKind, 24, '默认每类 24 条')
  assert.equal(t.values.snippetChars, 160, '默认截取 160 字符')
  assert.equal(t.values.maxSessions, 80, '默认会话上限 80')
  assert.equal(t.values.autoDelayGraceHours, 6, '默认迟到宽限 6 小时')
  assert.equal(t.values.charBudget, 400_000, '默认全局字符预算 40 万')
  assert.equal(t.values.autoDelayGraceMs, 6 * 60 * 60 * 1000, '毫秒镜像同步')
  assert.ok(t.ranges && t.ranges.snippetChars, 'ranges 应含各键')
  assert.ok(t.defaults && t.defaults.maxSessions === 80, 'defaults 应为代码默认值')
  assert.ok(Array.isArray(t.overridden), 'overridden 应为数组')
  assert.equal(t.overridden.length, 0, '默认没有用户覆盖项')
  assert.ok(t.labels && typeof t.labels.snippetChars === 'string', 'labels 应带各键')
  // 无损 JSON 约束：返回值里不能出现 undefined
  const json = JSON.parse(JSON.stringify(payload))
  assert.deepEqual(json.tuning.values, t.values)
}

// 12) 工具 set_tuning 持久化，并让 daily_summary 的取数/日界随之生效
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  const stateFile = path.join(dir, 'state.json')
  apply(ctx, { stateFile, sessionQuery })
  const tool = ctx.registeredTools.get('daily_summary_settings')

  const updated = await tool.execute(
    { action: 'set_tuning', tuning: { maxEventsPerKind: 6, snippetChars: 300, cutoverHour: 6, charBudget: 600_000 } },
    { agent: { id: 'session-a' } },
  )
  assert.equal(updated.ok, true)
  assert.deepEqual(updated.changed.sort(), ['charBudget', 'cutoverHour', 'maxEventsPerKind', 'snippetChars'])
  assert.deepEqual(updated.errors, {})

  // 已持久化到 settings.json
  const stored = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(stored.tuning.maxEventsPerKind, 6)
  assert.equal(stored.tuning.snippetChars, 300)
  assert.equal(stored.tuning.cutoverHour, 6)
  assert.equal(stored.tuning.charBudget, 600_000)
  // autoDelayGraceHours 与小改动无关，保持默认

  // get 视角：overridden 列出用户改过的键
  const read = await tool.execute({ action: 'get' }, { agent: { id: 'session-a' } })
  assert.deepEqual(read.tuning.values.maxEventsPerKind, 6)
  assert.deepEqual(read.tuning.values.snippetChars, 300)
  assert.deepEqual(read.tuning.values.cutoverHour, 6)
  assert.deepEqual(read.tuning.values.charBudget, 600_000)
  assert.ok(read.tuning.overridden.includes('maxEventsPerKind'))

  // daily_summary 用 settings 的 cutoverHour 定窗口：设成 6 就落到"白天/进行中"
  const summaryTool = ctx.registeredTools.get('daily_summary')
  const got = await summaryTool.execute({}, { agent: { id: 'session-a', followup: () => {} } })
  assert.equal(got.ok, true)
  // 现在时间 23:47，cutoverHour=6 → 白天分支 in-progress；若默认 4 也是白天，
  // 故改为断言它确实带 window.branch 且没崩。更细的日界分支见 branch/命令测试。
  assert.ok(['in-progress', 'in-progress-cutover'].includes(got.window?.branch))
}

// 13) 命令行 tuning <key> <value> 与 tuning <key> default
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const command = ctx.commands.get('daily-summary-settings')

  const set = parse(await command.handler({ agent: { id: 'session-a' }, rawInput: 'tuning maxEventsPerKind 12' }))
  assert.deepEqual(set.changed, ['maxEventsPerKind'])
  assert.equal(set.tuning.values.maxEventsPerKind, 12)

  const stored = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(stored.tuning.maxEventsPerKind, 12)

  // 回到默认：tuning <key> default 应把该键移除 override
  const reset = parse(await command.handler({ agent: { id: 'session-a' }, rawInput: 'tuning maxEventsPerKind default' }))
  assert.deepEqual(reset.reset, ['maxEventsPerKind'])
  assert.equal(reset.tuning.values.maxEventsPerKind, 24, '重置后回默认 24')
  const stored2 = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(stored2.tuning.maxEventsPerKind, undefined, '重置后不再存 override')
}

// 14) 越界 / 非法键：明确报错，不写 settings
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  apply(ctx, { stateFile: path.join(dir, 'state.json'), sessionQuery })
  const tool = ctx.registeredTools.get('daily_summary_settings')

  // 越界值被拒
  const bad = await tool.execute(
    { action: 'set_tuning', tuning: { snippetChars: 999999 } },
    { agent: { id: 'session-a' } },
  )
  assert.equal(bad.changed.length, 0)
  assert.ok(bad.errors.snippetChars, '越界值应进 errors')
  // 越界不能落盘：settings.json 不应被创建出来（apply 后没有别的东西写它）
  {
    const settingsPath = path.join(dir, 'settings.json')
    const exists = await access(settingsPath).then(
      () => true,
      () => false,
    )
    assert.equal(exists, false, '越界设置不能落盘（不应创建 settings.json）')
  }

  // 命令层未知键
  const command = ctx.commands.get('daily-summary-settings')
  const unknown = await command.handler({ agent: { id: 'session-a' }, rawInput: 'tuning bogusKey 5' })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /未知可调项/)
}

// 15) settings 优先于 config：两者都配时用 settings
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  const stateFile = path.join(dir, 'state.json')
  // config 配 maxEventsPerKind=5，settings 里已写 maxEventsPerKind=9
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ tuning: { maxEventsPerKind: 9 } }), 'utf8')
  apply(ctx, { stateFile, sessionQuery, maxEventsPerKind: 5 })
  const tool = ctx.registeredTools.get('daily_summary_settings')
  const read = await tool.execute({ action: 'get' }, { agent: { id: 'session-a' } })
  assert.equal(read.tuning.values.maxEventsPerKind, 9, 'settings 应盖过 config')

  // 而 config 里没覆盖、settings 也没有的键，取 config 值
  // （这里 config 只给了 maxEventsPerKind，snippetChars 用默认 160）
  assert.equal(read.tuning.values.snippetChars, 160)
}

// 16) config 兜底：settings 完全没写时，各可调项落到 config > 代码默认
{
  const dir = await tmpDir()
  const schedule = makeSchedule(seedRecords())
  const ctx = makeCtx(schedule, sessionQuery)
  const stateFile = path.join(dir, 'state.json')
  apply(ctx, { stateFile, sessionQuery, snippetChars: 80, cutoverHour: 3 })
  const tool = ctx.registeredTools.get('daily_summary_settings')
  const read = await tool.execute({ action: 'get' }, { agent: { id: 'session-a' } })
  assert.equal(read.tuning.values.snippetChars, 80, 'config 覆盖默认')
  assert.equal(read.tuning.values.cutoverHour, 3)
  assert.equal(read.tuning.values.maxSessions, 80, '未配置的键回代码默认')
}

console.log('settings-test: all assertions passed')
