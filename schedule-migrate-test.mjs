// 提醒迁移：已存在的「每日总结」记录不能因为"标题已存在"就永远停在旧时间。
// 运行：node schedule-migrate-test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from './index.js'

const tick = () => new Promise((r) => setTimeout(r, 30))

function makeCtx(tools, schedule, sessionId) {
  return {
    tools: { register: (def) => (tools.set(def.name, def), () => {}) },
    get: (name) => (name === 'schedule' ? schedule : undefined),
    logger: { warn: () => {} },
    inject: () => () => {},
    sessionId,
  }
}

// 1) 已存在但时间是旧的 → 迁移到配置时间，不新建
{
  const updates = []
  const creates = []
  const record = {
    id: 'schedule-old',
    kind: 'daily',
    title: '每日总结',
    prompt: '旧提醒词',
    time: '23:00:00.000',
    timeZone: 'Asia/Shanghai',
  }
  const schedule = {
    async list() {
      return [record]
    },
    async create(sessionId, request) {
      creates.push(request)
      return record
    },
    async update(request) {
      updates.push(request)
      return { record: { ...record, ...request.change, prompt: request.prompt } }
    },
  }
  const tools = new Map()
  const stateFile = path.join(await mkdtemp(path.join(tmpdir(), 'ds-mig-')), 'state.json')
  apply(makeCtx(tools, schedule, 'session-x'), { stateFile })
  await tools.get('daily_summary').execute({}, { agent: { id: 'session-x' } })
  await tick()

  assert.equal(creates.length, 0, '已存在时不应新建')
  assert.equal(updates.length, 1, '旧记录应被迁移一次')
  assert.equal(updates[0].sessionId, 'session-x')
  assert.equal(updates[0].id, 'schedule-old')
  assert.equal(updates[0].expected, record, '要带上当前记录做乐观并发校验')
  assert.equal(updates[0].change.kind, 'daily')
  assert.equal(updates[0].change.daily.time, '00:00:00', '时间要迁到 24:00')
  assert.equal(updates[0].change.daily.time_zone, 'Asia/Shanghai')
  assert.ok(updates[0].prompt.includes('auto=true'), '提醒词也要跟着升级')
}

// 2) 时间和提醒词都已一致 → 不做任何写入
{
  // 先用空列表跑一次，拿到插件实际生成的提醒词与时间（不靠猜）
  const creates = []
  let createdPrompt = ''
  let createdTime = ''
  const emptyStub = {
    async list() {
      return []
    },
    async create(_s, request) {
      creates.push(request)
      createdPrompt = request.prompt
      createdTime = request.daily.time
      return { id: 'schedule-new' }
    },
  }
  const first = new Map()
  apply(makeCtx(first, emptyStub, 's2'), {
    stateFile: path.join(await mkdtemp(path.join(tmpdir(), 'ds-mig2-')), 'state.json'),
  })
  await first.get('daily_summary').execute({}, { agent: { id: 's2' } })
  await tick()
  assert.equal(creates.length, 1, '空列表时应新建')

  // 再跑一次：list 返回一条与刚才完全对齐的记录 → 不应迁移
  const updates = []
  const alignedStub = {
    async list() {
      return [
        {
          id: 'schedule-new',
          kind: 'daily',
          title: '每日总结',
          prompt: createdPrompt,
          time: `${createdTime}.000`,
          timeZone: 'Asia/Shanghai',
        },
      ]
    },
    async create() {
      throw new Error('对齐后不应再新建')
    },
    async update(request) {
      updates.push(request)
      return {}
    },
  }
  const second = new Map()
  apply(makeCtx(second, alignedStub, 's3'), {
    stateFile: path.join(await mkdtemp(path.join(tmpdir(), 'ds-mig3-')), 'state.json'),
  })
  await second.get('daily_summary').execute({}, { agent: { id: 's3' } })
  await tick()
  assert.equal(updates.length, 0, '完全一致时不应触发迁移')
}

// 3) 迁移失败不能影响工具本身
{
  const tools = new Map()
  const schedule = {
    async list() {
      return [{ id: 'x', kind: 'daily', title: '每日总结', prompt: 'p', time: '23:00:00', timeZone: 'Asia/Shanghai' }]
    },
    async create() {
      throw new Error('should not create')
    },
    async update() {
      throw new Error('boom')
    },
  }
  const stateFile = path.join(await mkdtemp(path.join(tmpdir(), 'ds-mig4-')), 'state.json')
  apply(makeCtx(tools, schedule, 's4'), { stateFile })
  const res = await tools.get('daily_summary').execute({}, { agent: { id: 's4' } })
  await tick()
  assert.equal(res.ok, true, '迁移抛错也不能让取数工具失败')
  await readFile(stateFile, 'utf8').catch(() => {})
}

console.log('schedule-migrate-test: all assertions passed')
