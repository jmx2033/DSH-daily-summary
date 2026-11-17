// 回归：每日总结自动写入日志文件。
// 目标：产出后不用再手动"帮我写进文件"，且不能破坏用户手写的内容。
// 背景：日志文件是长期累积的（本机已有 1700+ 行、日期块格式不统一，
// 既有 `2026.10.26` 也有 `2026-10-22`），写错就等于毁掉历史。
// 运行：node log-test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildLogBlock, findDayRange, logDateKey, writeDailyLog, apply } from './index.js'

const dir = () => mkdtemp(path.join(tmpdir(), 'ds-log-'))

const SAMPLE = [
  '每日总结 · 2026-10-27（周二，本地时区，统计区间 00:00–24:00（进行中，截至 16:40））',
  '1.我觉得开心的事',
  '- 把日志自动落盘接上了',
  '',
  '2.我觉得充实的事（+ 我觉得有收获的事）',
  '- 充实：写了一个能识别多种日期格式的写入器',
  '',
  '3.可能需要改进的事',
  '- 还没覆盖"文件被别的程序占用"',
  '',
  '4.今日份思考',
  '先把已有格式读准，再动手写。',
].join('\n')

// 1) 日期归一化：点分、横线、中文都能认，且都落到同一天
{
  for (const raw of ['2026.10.27', '2026-10-27', '2026/10/27', '2026年10月27日', ' 2026.10.27 ']) {
    assert.equal(logDateKey(raw), '2026-10-27', `${raw} 应归一成 2026-10-27`)
  }
  assert.equal(logDateKey('这不是日期'), undefined)
  assert.equal(logDateKey('2.我觉得充实的事（+ 我觉得有收获的事）'), undefined, '正文行不能被当成日期')
}

// 2) 块格式：日期行用点分，去掉抬头，空行分隔
{
  const block = buildLogBlock('2026-10-27', SAMPLE)
  assert.equal(block.header, '2026.10.27')
  assert.ok(!block.bodyLines[0].startsWith('每日总结'), '抬头行必须去掉，日期已单独成行')
  assert.equal(block.bodyLines[0], '1.我觉得开心的事')
  assert.ok(block.bodyLines.includes('4.今日份思考'))
}

// 3) zh 文件不存在：新建并写入当天块
{
  const file = path.join(await dir(), '日志.txt')
  const result = await writeDailyLog({ file, date: '2026-10-27', text: SAMPLE })
  assert.equal(result.written, true)
  assert.equal(result.replaced, false)
  const content = await readFile(file, 'utf8')
  assert.ok(content.startsWith('2026.10.27\n\n1.我觉得开心的事'), `开头格式不对：${content.slice(0, 40)}`)
  assert.ok(!content.includes('每日总结 ·'))
  assert.ok(content.endsWith('\n'), '文件应以换行结尾')
}

// 4) 已有历史：追加到末尾，历史内容一字不动
{
  const file = path.join(await dir(), '日志.txt')
  const history = '2026.10.26\n\n1.我觉得开心的事\n- 旧的一天\n\n碎碎念\n手写的东西不能丢\n'
  await writeFile(file, history, 'utf8')
  const result = await writeDailyLog({ file, date: '2026-10-27', text: SAMPLE })
  assert.equal(result.written, true)
  const content = await readFile(file, 'utf8')
  assert.ok(content.startsWith(history.trimEnd()), '历史内容必须原样保留在最前面')
  assert.ok(content.includes('2026.10.27\n\n1.我觉得开心的事'), '新的一天应追加在末尾')
}

// 5) 同一天已存在：默认**不覆盖**（那里面可能有手写的碎碎念）
{
  const file = path.join(await dir(), '日志.txt')
  const original = '2026.10.27\n\n1.我觉得开心的事\n- 上午写的\n\n碎碎念\n这句是手写的\n'
  await writeFile(file, original, 'utf8')
  const result = await writeDailyLog({ file, date: '2026-10-27', text: SAMPLE })
  assert.equal(result.written, false)
  assert.equal(result.reason, 'exists')
  assert.equal(result.replaced, false)
  const content = await readFile(file, 'utf8')
  assert.equal(content, original, '默认不许改动已有内容')
}

// 6) overwrite=true：只替换当天那一块，前后都不动
{
  const file = path.join(await dir(), '日志.txt')
  const before = '2026.10.25\n\n1.我觉得开心的事\n- 前天\n\n'
  const after = '\n2026.10.28\n\n1.我觉得开心的事\n- 明天\n'
  await writeFile(file, `${before}2026.10.27\n\n1.我觉得开心的事\n- 旧版本\n${after}`, 'utf8')

  const result = await writeDailyLog({ file, date: '2026-10-27', text: SAMPLE, overwrite: true })
  assert.equal(result.written, true)
  assert.equal(result.replaced, true)
  const content = await readFile(file, 'utf8')
  assert.ok(content.includes('2026.10.25'), '前一天必须还在')
  assert.ok(content.includes('2026.10.28'), '后一天必须还在')
  assert.ok(!content.includes('- 旧版本'), '当天旧内容应被替换掉')
  assert.ok(content.includes('- 把日志自动落盘接上了'), '当天应是新内容')
  assert.ok(content.indexOf('2026.10.27') < content.indexOf('2026.10.28'), '日期顺序不能乱')
}

// 7) 同一天用另一种写法存在（2026-10-27）：也要认出来，不能写成两份
{
  const file = path.join(await dir(), '日志.txt')
  await writeFile(file, '2026-10-27\n\n1.我觉得开心的事\n- 横线写法\n', 'utf8')
  const result = await writeDailyLog({ file, date: '2026-10-27', text: SAMPLE })
  assert.equal(result.written, false)
  assert.equal(result.reason, 'exists')
}

// 8) findDayRange：块的边界停在下一个日期行，不会吃掉后面的内容
{
  const lines = ['2026.10.26', '', 'a', '', '2026.10.27', '', 'b', '', '2026.10.28', '', 'c']
  const range = findDayRange(lines, '2026-10-27')
  assert.deepEqual(range, { start: 4, end: 8 })
  assert.equal(findDayRange(lines, '2026-10-29'), undefined)
}

// 9) 端到端：selfcheck 通过 → 自动落盘（不靠模型记得写文件）
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'ds-log-ws-'))
  const logPath = path.join(workspace, '日志.txt')
  await writeFile(logPath, '2026.10.26\n\n1.我觉得开心的事\n- 昨天\n', 'utf8')

  const tools = new Map()
  const sessionQuery = {
    async filterSessions() {
      return [{ header: { id: 'session-log-owner', cwd: workspace } }]
    },
    async readSession() {
      return { session: {}, events: [] }
    },
  }
  apply(
    {
      tools: { register: (def) => (tools.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    {
      stateFile: path.join(await dir(), 'state.json'),
      settingsFile: path.join(await dir(), 'settings.json'),
      clock: () => new Date('2026-10-27T16:40:00+08:00'),
      sessionQuery,
    },
  )

  const result = await tools.get('daily_summary_selfcheck').execute(
    { text: SAMPLE },
    { agent: { id: 'session-log-owner' } },
  )
  assert.equal(result.ok, true, `自检应通过：${JSON.stringify(result.problems)}`)
  assert.ok(result.logFile, '应返回落盘结果')
  assert.equal(result.logFile.written, true, `应真的写入：${JSON.stringify(result.logFile)}`)
  assert.equal(result.logFile.path, logPath, '应自动探测到工作区里的 日志.txt')

  const content = await readFile(logPath, 'utf8')
  assert.ok(content.includes('2026.10.26'), '原有内容保留')
  assert.ok(content.includes('2026.10.27'), '新的一天已写入')
  assert.ok(content.includes('- 把日志自动落盘接上了'), '正文内容已写入')
}

// 10) 端到端：同一天再次自检 → 默认不重复写（文件只多一份）
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'ds-log-ws2-'))
  const logPath = path.join(workspace, '日志.txt')
  await writeFile(logPath, '', 'utf8')
  const stateFile = path.join(await dir(), 'state.json')
  const settingsFile = path.join(await dir(), 'settings.json')
  const sessionQuery = {
    async filterSessions() {
      return [{ header: { id: 'session-log-owner', cwd: workspace } }]
    },
    async readSession() {
      return { session: {}, events: [] }
    },
  }
  const tools = new Map()
  apply(
    {
      tools: { register: (def) => (tools.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    {
      stateFile,
      settingsFile,
      clock: () => new Date('2026-10-27T16:40:00+08:00'),
      sessionQuery,
    },
  )

  const tool = tools.get('daily_summary_selfcheck')
  const first = await tool.execute({ text: SAMPLE }, { agent: { id: 'session-log-owner' } })
  assert.equal(first.logFile.written, true)
  const second = await tool.execute({ text: SAMPLE }, { agent: { id: 'session-log-owner' } })
  assert.equal(second.logFile.written, false, '同一天第二次不应重复写入')
  assert.equal(second.logFile.reason, 'exists')
  const content = await readFile(logPath, 'utf8')
  assert.equal(content.split('2026.10.27').length - 1, 1, '文件里只能有一份当天块')
}

// 11) set_log：工具写入设置、能读回，且不碰提醒
{
  const tools = new Map()
  const stateFile = path.join(await dir(), 'state.json')
  const settingsFile = path.join(await dir(), 'settings.json')
  apply(
    {
      tools: { register: (def) => (tools.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    { stateFile, settingsFile },
  )
  const tool = tools.get('daily_summary_settings')

  const set = await tool.execute({ action: 'set_log', logFile: '日志.md' }, {})
  assert.equal(set.ok, true)
  assert.equal(set.logFile, '日志.md', '设置后应能读回文件名')
  assert.equal(set.logOverwrite, false, '默认不覆盖')

  const stored = JSON.parse(await readFile(settingsFile, 'utf8'))
  assert.equal(stored.logFile, '日志.md')
  assert.ok(!stored.reminderCreated, 'set_log 不应触发提醒逻辑')

  const cleared = await tool.execute({ action: 'set_log', logFile: 'auto' }, {})
  assert.equal(cleared.logFile, null, 'auto 表示回到自动探测')
}

// 12) logFile 填的是**目录**：退化成"在该目录里找日志文件"，不能把目录当文件写
//     背景（2026-10-30 实测）：设置里填了 `…\Desktop\日志`，每次写入都报 EISDIR 被跳过。
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'ds-log-dir-'))
  const logPath = path.join(workspace, '日志.txt')
  await writeFile(logPath, '2026.10.26\n\n1.我觉得开心的事\n- 历史\n', 'utf8')

  const stateFile = path.join(await dir(), 'state.json')
  const settingsFile = path.join(await dir(), 'settings.json')
  await writeFile(settingsFile, JSON.stringify({ logFile: workspace }), 'utf8')

  const tools = new Map()
  apply(
    {
      tools: { register: (def) => (tools.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    {
      stateFile,
      settingsFile,
      clock: () => new Date('2026-10-27T16:40:00+08:00'),
      sessionQuery: {
        async filterSessions() {
          return [{ header: { id: 'session-log-owner', cwd: workspace } }]
        },
      },
    },
  )

  const result = await tools
    .get('daily_summary_selfcheck')
    .execute({ text: SAMPLE }, { agent: { id: 'session-log-owner' } })
  assert.equal(result.ok, true)
  assert.equal(result.logFile.written, true, `填目录也该写进去：${JSON.stringify(result.logFile)}`)
  assert.equal(result.logFile.path, logPath, '应解析到目录里的 日志.txt')

  const content = await readFile(logPath, 'utf8')
  assert.ok(content.includes('2026.10.27'), '新的一天已写入')
}

// 13) 填的目录里没有日志文件：用候选名新建，而不是放弃
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'ds-log-dir2-'))
  const stateFile = path.join(await dir(), 'state.json')
  const settingsFile = path.join(await dir(), 'settings.json')
  await writeFile(settingsFile, JSON.stringify({ logFile: workspace }), 'utf8')

  const tools = new Map()
  apply(
    {
      tools: { register: (def) => (tools.set(def.name, def), () => {}) },
      get: () => undefined,
      logger: { warn: () => {} },
      inject: () => () => {},
    },
    {
      stateFile,
      settingsFile,
      clock: () => new Date('2026-10-27T16:40:00+08:00'),
      sessionQuery: {
        async filterSessions() {
          return [{ header: { id: 'session-log-owner', cwd: workspace } }]
        },
      },
    },
  )
  const result = await tools
    .get('daily_summary_selfcheck')
    .execute({ text: SAMPLE }, { agent: { id: 'session-log-owner' } })
  assert.equal(result.logFile.written, true)
  assert.equal(result.logFile.path, path.join(workspace, '日志.txt'))
}

console.log('log-test: all assertions passed')
