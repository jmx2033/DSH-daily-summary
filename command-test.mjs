// 回归：/daily-summary 命令 handler。
// ① 消息必须自建且合规（不依赖 @deepseek-ai/dsh-llm），裸数组绝不投递；
// ② 没有 agent 时按"最近活跃会话"定位，定位不到就如实报错，不假装成功。
// 背景：2026-10-20 本机 session-667bc3e2 因 handler 把裸内容块数组交给 followup，
// 被 inbox 记成 inserted:[[{...}]]，整个会话读回报 stored log is corrupt。
// 运行：node command-test.mjs
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from './index.js'

let registered
const registry = new Map()

function makeCtx() {
  return {
    tools: { register: () => () => {} },
    get: () => undefined,
    logger: { warn: () => {} },
    inject: (deps, cb) => {
      if (Array.isArray(deps) && deps.includes('commands')) {
        cb({
          commands: {
            // 同一个 inject 回调里注册了多个命令，这里按名字收集，
            // `registered` 仍指向 /daily-summary 那条（其余用例都只关心它）。
            register: (def) => {
              registry.set(def.name, def)
              if (def.name === 'daily-summary') registered = def
              return () => {}
            },
            list: () => [...registry.values()],
          },
        })
      }
      return () => {}
    },
  }
}

const tmp = (name) => path.join(tmpdir(), `ds-cmd-${process.pid}-${name}-${Math.random().toString(36).slice(2)}.json`)

// 1) 有 agent：消息由插件自己构造，形状合规、非数组，且投递到该 agent
{
  const stateFile = tmp('a')
  apply(makeCtx(), { stateFile })
  assert.ok(registered, '命令应已注册到 commands 服务')
  assert.equal(registered.name, 'daily-summary')

  let got
  const result = await registered.handler({
    agent: {
      id: 'session-test',
      followup: (m) => {
        got = m
      },
    },
  })
  assert.equal(result.kind, 'success')
  assert.ok(got && !Array.isArray(got), '绝不能把裸数组交给 followup')
  assert.equal(got.role, 'user')
  assert.equal(got.source.kind, 'user')
  assert.equal(typeof got.id, 'string')
  assert.equal(got.content[0].type, 'text')
  assert.ok(got.content[0].text.includes('每日总结'))
  assert.ok(Object.isFrozen(got), '消息应与官方 createUserMessage 一样被冻结')
}

// 2) 注入的构造函数返回裸数组：必须拦下，followup 一次都不能被调用
{
  apply(makeCtx(), { stateFile: tmp('b'), createUserMessage: () => [{ type: 'text', text: '裸数组' }] })
  let delivered = 0
  const result = await registered.handler({
    agent: {
      id: 's',
      followup: () => (delivered += 1),
    },
  })
  assert.equal(result.kind, 'error', '畸形消息必须被拦下')
  assert.equal(delivered, 0, '畸形消息绝不能进入 inbox')
}

// 3) 没有 agent、sessions 根目录为空：如实报错，不假装成功
{
  const emptyRoot = await mkdtemp(path.join(tmpdir(), 'ds-sessions-empty-'))
  apply(makeCtx(), { stateFile: tmp('c'), sessionsRoot: emptyRoot })
  const result = await registered.handler({ agent: undefined })
  assert.equal(result.kind, 'error', '定位不到会话时必须返回 error')
  assert.ok(result.text.includes('找不到可投递的会话'), `错误文案应说明原因，实际：${result.text}`)
}

// 4) 没有 agent：按日志 mtime 找到"最近活跃会话"，并在无 agent 引用时给出可见失败
{
  const root = await mkdtemp(path.join(tmpdir(), 'ds-sessions-'))
  const group = path.join(root, '--D-work--')
  for (const [name, ageMs] of [
    ['session-older', 60_000],
    ['session-newest', 0],
  ]) {
    const dir = path.join(group, name)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    await writeFile(file, 'x')
    const when = new Date(Date.now() - ageMs)
    await (await import('node:fs/promises')).utimes(file, when, when)
  }
  apply(makeCtx(), { stateFile: tmp('d'), sessionsRoot: root })
  const result = await registered.handler({ agent: undefined })
  assert.equal(result.kind, 'error')
  assert.ok(
    result.text.includes('session-newest'),
    `应定位到 mtime 最新的会话，实际：${result.text}`,
  )
}

// 5) 设置里固定了目标会话：必须投到它，**不能**落到当前会话
//    背景（2026-10-23 实测）：用户在日志工作区设了目标会话，在别的会话点横栏，
//    总结仍然生成在当前会话——投递逻辑完全没读 settings.targetSessionId。
{
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-cmd-pin-'))
  const stateFile = path.join(dir, 'state.json')
  const settingsFile = path.join(dir, 'settings.json')
  await writeFile(settingsFile, JSON.stringify({ targetSessionId: 'session-pinned' }))

  let pinnedGot
  let currentDelivered = 0
  const agents = {
    get: (id) =>
      id === 'session-pinned'
        ? { id, followup: (m) => (pinnedGot = m) }
        : undefined,
  }
  apply(
    {
      ...makeCtx(),
      get: (name) => (name === 'agents' ? agents : undefined),
    },
    { stateFile, settingsFile },
  )

  const result = await registered.handler({
    agent: { id: 'session-current', followup: () => (currentDelivered += 1) },
  })
  assert.equal(result.kind, 'success', `应成功投递到固定会话，实际：${result.text}`)
  assert.ok(pinnedGot, '消息必须投进固定会话')
  assert.equal(pinnedGot.role, 'user')
  assert.equal(currentDelivered, 0, '设置了固定会话后，绝不能落到当前会话')
  assert.ok(result.text.includes('固定的会话'), `回执应说明投到了固定会话，实际：${result.text}`)
}

// 6) 固定会话没有活 agent：用 resume 把它唤醒并投递，不许改投当前会话
//    背景：插件投递需要一个 agent 对象，目标会话没在运行时 `agents.get()` 是 undefined。
{
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-cmd-wake-'))
  const stateFile = path.join(dir, 'state.json')
  const settingsFile = path.join(dir, 'settings.json')
  await writeFile(settingsFile, JSON.stringify({ targetSessionId: 'session-offline' }))
  let currentDelivered = 0
  let wokenGot
  let resumeCalls = 0
  let disposed = 0
  let resumeOptions
  const agents = {
    get: () => undefined,
    resume: async (options) => {
      resumeCalls += 1
      resumeOptions = options
      return {
        agent: { id: options.resumeSessionId, followup: (m) => (wokenGot = m) },
        dispose: async () => {
          disposed += 1
        },
      }
    },
  }
  // resume 必须带上模型：不带就装配不出 persona，整轮失败
  // （prompt variable "{{model}}" has no value）。这里用会话日志里的 model/selection 供它读取。
  const sessionQuery = {
    async readSession(id) {
      return {
        session: { id },
        events: [
          { type: 'turn/start', data: {} },
          { type: 'model/selection', data: { provider: 'acme-gateway', model: 'deepseek-flash' } },
        ],
      }
    },
  }
  apply(
    { ...makeCtx(), get: (name) => (name === 'agents' ? agents : undefined) },
    { stateFile, settingsFile, sessionQuery },
  )
  const result = await registered.handler({
    agent: { id: 'session-current', followup: () => (currentDelivered += 1) },
  })
  assert.equal(result.kind, 'success', `应唤醒并投递成功，实际：${result.text}`)
  assert.equal(resumeCalls, 1, '目标会话没在运行时应调用一次 resume')
  assert.deepEqual(
    resumeOptions?.agentOptions,
    { provider: 'acme-gateway', model: 'deepseek-flash' },
    'resume 必须带上模型选择，否则 {{model}} 装配失败',
  )
  assert.ok(wokenGot, '消息必须投进被唤醒的会话')
  assert.equal(wokenGot.role, 'user')
  assert.equal(currentDelivered, 0, '绝不能改投当前会话')
  assert.ok(result.text.includes('已唤醒'), `回执应说明是唤醒后投递，实际：${result.text}`)
}

// 7) resume 失败：如实报错（点明会话与原因），仍然不许改投
{
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-cmd-wakefail-'))
  const stateFile = path.join(dir, 'state.json')
  const settingsFile = path.join(dir, 'settings.json')
  await writeFile(settingsFile, JSON.stringify({ targetSessionId: 'session-broken' }))
  let currentDelivered = 0
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('session log is corrupt')
    },
  }
  const sessionQuery = {
    async readSession(id) {
      return {
        session: { id },
        events: [
          { type: 'model/selection', data: { provider: 'acme-gateway', model: 'deepseek-flash' } },
        ],
      }
    },
  }
  apply(
    { ...makeCtx(), get: (name) => (name === 'agents' ? agents : undefined) },
    { stateFile, settingsFile, sessionQuery },
  )
  const result = await registered.handler({
    agent: { id: 'session-current', followup: () => (currentDelivered += 1) },
  })
  assert.equal(result.kind, 'error', '唤醒失败必须报错')
  assert.ok(
    result.text.includes('session-broken'.slice(0, 12)),
    `错误文案应点明是哪个会话，实际：${result.text}`,
  )
  assert.ok(result.text.includes('corrupt'), `错误文案应带出原因，实际：${result.text}`)
  assert.equal(currentDelivered, 0, '仍是绝不能改投当前会话')
}

// 8) 配了日志落盘目标时，投递的引导语要说明「插件会自动写、你别再动手」
//    背景（2026-10-29 实测）：模型不知道插件会自动写，自检通过后又用 edit 手动写了一遍。
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'ds-cmd-log-'))
  await writeFile(path.join(workspace, '日志.txt'), '2026.10.26\n\n1.我觉得开心的事\n- 旧\n', 'utf8')
  let deliveredPrompt = ''
  apply(
    {
      ...makeCtx(),
      get: () => undefined,
      inject: (deps, cb) => {
        cb({
          commands: {
            register: (def) => {
              if (def.name === 'daily-summary') registered = def
              return () => {}
            },
            list: () => [],
          },
        })
        return () => {}
      },
    },
    {
      stateFile: path.join(await mkdtemp(path.join(tmpdir(), 'ds-cmd-logst-')), 'state.json'),
      sessionQuery: {
        async filterSessions() {
          return [{ header: { id: 'session-x', cwd: workspace } }]
        },
      },
    },
  )
  const result = await registered.handler({
    agent: { id: 'session-x', followup: (m) => (deliveredPrompt = m.content[0].text) },
  })
  assert.equal(result.kind, 'success')
  assert.ok(
    deliveredPrompt.includes('插件会自动把四段内容写进'),
    `引导语应说明插件会自动写文件，实际：${deliveredPrompt}`,
  )
  assert.ok(deliveredPrompt.includes('日志.txt'), '应带出具体目标文件')
  assert.ok(
    deliveredPrompt.includes('不要重复写'),
    '必须明确让模型不要重复写，否则它会再用 edit 写一遍',
  )
}

// 9) 没配日志目标时：引导语保持原样，不提写文件
{
  let deliveredPrompt = ''
  apply(makeCtx(), { stateFile: tmp('g') })
  const result = await registered.handler({
    agent: { id: 'session-y', followup: (m) => (deliveredPrompt = m.content[0].text) },
  })
  assert.equal(result.kind, 'success')
  assert.ok(deliveredPrompt.includes('请现在产出一份每日总结'))
  assert.ok(!deliveredPrompt.includes('插件会自动'), '没有目标时不该提自动写文件')
}

console.log('command-test: all assertions passed')
