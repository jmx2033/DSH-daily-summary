/**
 * 每日总结（daily-summary）—— DSH Host 插件
 *
 * 以 docs/SKILL.md（终版，QA 10/10 通过）为唯一基准实现，职责分工：
 *
 *   - 确定性部分交给代码（插件）：
 *       取一次运行时本地时间 now、按 04:00 日界切分三条互斥分支、
 *       算出统计日/统计区间/抬头注记（含凌晨「切当天」例外所需的持久状态）、
 *       扫描当日各会话日志给出素材清单与覆盖面计数、对成稿做输出自检。
 *   - 生成部分交给模型：抽事件、四段归类、去重、第一人称改写、成文措辞。
 *
 * 与 SKILL.md 的对应关系：
 *   `daily_summary`      -> 第一步 + 第二步来源二 + 第四步计数
 *   `daily_summary_selfcheck` -> 第三步成文规则 + 输出自检 + 禁止事项
 *
 * 设计约束（照抄 SKILL.md 的禁止事项）：
 *   - 检索只读：绝不改写、删除、移动任何会话记录或素材文件。
 *   - 不联网、不上传、不落文件、不替代日程。
 *   - 产物只在对话里以纯文本出现，可直接复制。
 *
 * 文件 IO 只用 node:fs（只读），不依赖任何按宿主路径 rebase 的包。
 *
 * 关于「工具返回值必须无损可序列化」——踩过的坑（2026-10-19，本机 desktop profile）：
 *   框架会把工具返回值做 clone 后按 JSON 序列化。任何 `undefined` 取值
 *   （如 `cwd: header.cwd`、`Map.get()` 未命中、`title` 缺失）都会让 clone 后的
 *   值与 JSON 字符串不一致，框架随即判定
 *   `tool ... returned invalid output: value is not lossless JSON`，
 *   而且**报错信息不指向具体字段**，只能靠二分定位。
 *   因此本文件所有返回给框架的字段一律先归一化成 string/number/boolean/null/数组/纯对象；
 *   `smoke-test.mjs` 里有一条专门的回归用例守着这一点。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'daily-summary'

/**
 * 插件版本：从同目录 package.json 读，读不到就退回 '0.0.0'。
 *
 * 为什么不在代码里写死：写死会和 package.json 分成两处，迟早对不上；
 * 这里只有一份真相，设置页显示的版本就是实际安装的版本。
 */
const PLUGIN_VERSION = (() => {
  try {
    const manifest = createRequire(import.meta.url)('./package.json')
    return typeof manifest?.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 只依赖工具注册表；不声明任何会话读取服务，插件在任何 profile 都能激活。 */
export const inject = ['tools']

/** SKILL.md 第一步第 10 条：04:00 是明文常数，改值只改这一处。 */
const DEFAULT_CUTOVER_HOUR = 4

/**
 * 「凌晨切当天」的最小已过时间：新的一天过去不足这么久，就把凌晨请求仍当补记前一天。
 *
 * 为什么必须有这个门槛：自动产出定在 24:00（即次日 00:00），那一刻**新的一天刚刚开始**。
 * 若不设门槛，而前一天已经交过总结，resolveWindow 会因 reuseException 切到"当天"，
 * 于是产出一份几乎空白的新一天总结，且把它记成已交付 —— 那一整天的真总结就再也补不上了。
 * 一小时后才把凌晨请求理解为"新的一天"。
 */
const CUTOVER_MIN_ELAPSED_MS = 60 * 60 * 1000

/**
 * 第二步来源二：单个会话里每类事件最多返回多少条（**旧模式/关闭预算时的规则**）。
 *
 * 2026-11-17 起默认走 `charBudget` 的预算分配（见 allocateBudget），
 * 本常量只在 charBudget = 0 时生效，用来和旧行为保持一致，便于回退对照。
 */
const DEFAULT_MAX_EVENTS_PER_KIND = 24
const DEFAULT_SNIPPET_CHARS = 160
const DEFAULT_MAX_SESSIONS = 80

/**
 * 一次总结给**所有会话**的总字符预算。
 *
 * 2026-11-16 实测：一天 26 个会话、日志 24 MB（压缩后），最大的单会话 7.5 MB。
 * 而每类只取 24 条 × 160 字，等于几万条消息里只留千分之几，上午做的项目在总结里
 * 直接消失。单纯调大条数是线性放大（26 会话 × 每类 300 条 ≈ 200 万字符），
 * 所以改成「先定总预算，再按会话体量分配」（见 allocateBudget）。
 */
const DEFAULT_CHAR_BUDGET = 400_000

/**
 * 按事件类别分级的截断长度。
 *
 * 一刀切 160 字的后果：用户的长指令只剩开头、工具报错看不到关键行，
 * 而工具调用的长输出（日志、diff）反而占地方。所以按信息密度分级。
 */
const CLIP_BY_KIND = {
  user: 800,
  assistant: 400,
  toolCalls: 160,
  toolErrors: 400,
  reasoning: 300,
}

/** 「凌晨切当天」例外需要持久状态：只在 SKILL.md 里记为技术债，插件里补上。 */
const DEFAULT_STATE_FILE = path.join(homedir(), '.dsh', 'daily-summary', 'state.json')

/** 会话日志根目录（`~/.dsh/sessions`）。命令 handler 找不到 agent 时用它定位会话。 */
const DEFAULT_SESSIONS_ROOT = path.join(homedir(), '.dsh', 'sessions')

/**
 * 归档状态存在 workspace 存储里（`global.archivedSessionIds`）。
 *
 * 2026-11-17 实测：归档只影响界面可见性，32 个归档会话的日志目录一个都没删。
 * 所以取数默认把它们一起纳入——归档掉的对话，当天做的事不该在总结里消失。
 */
const DEFAULT_STORAGE_FILE = path.join(homedir(), '.dsh', 'storages', 'workspace.json')

/** 默认包含已归档会话（保持历史行为）。 */
const DEFAULT_INCLUDE_ARCHIVED = true

/**
 * 读归档会话 ID 集合。
 *
 * 读不出（文件缺失、格式变化、权限）就返回空集合 —— 退化为「全部纳入」，
 * 宁可多读也不要因为读不到归档状态而漏掉一整天的素材。
 */
async function readArchivedSessionIds(file = DEFAULT_STORAGE_FILE) {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    const ids = parsed?.global?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids : [])
  } catch {
    return new Set()
  }
}

/**
 * 定时自动化默认值：每天 24:00（即次日 00:00）本地时间。
 *
 * 写成 `00:00:00` 而不是 `24:00:00`：schedule 服务只接受
 * `/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/`，小时最大 23，`24:00:00` 会被拒。
 * 00:00 落进凌晨分支，正好统计"刚刚结束的那一天"（catch-up，注记「凌晨补记」）。
 */
const DEFAULT_SCHEDULE_TIME = '00:00:00'
const DEFAULT_SCHEDULE_TZ = 'Asia/Shanghai'
/**
 * 自动路径判定"这次投递是不是迟到"的宽限。
 *
 * 提醒可能因为关机而延迟到下次开机才投递。超过这个间隔就认为目标是"昨天"，
 * 否则按当前钟点正常算。6 小时足够覆盖"23:50 触发、次日 5:50 前补投"，
 * 又能把"第二天早上才开机"识别成延迟。
 */
const AUTO_DELAY_GRACE_MS = 6 * 60 * 60 * 1000

/* ------------------------------------------------------------------ *
 * 可调项：取数与分界相关的 5 个常量。
 *
 * 原本写死在上面的顶层常量，现在做成「settings（用户设置）优先、config（插件配置）
 * 次之、代码默认值兜底」的三级回退，读取统一收敛到 `resolveTuning`。
 * 设置页 / `daily_summary_settings` 工具都能改，改动持久化到 settings.json。
 *
 * 单位约定：用户能直接理解的单位（小时、字符、条、会话、个）与代码内部单位
 * （毫秒）分开——`autoDelayGraceHours` 是给用户看的，换算成 `autoDelayGraceMs`
 * 给自动路径的迟到判定用。
 * ------------------------------------------------------------------ */

/** 5 个可调项的代码默认值（与顶部同名常量一致，是单一真相）。 */
const DEFAULT_TUNING = {
  /** 日界小时：凌晨几点算「新一天」。整数 0–23。 */
  cutoverHour: DEFAULT_CUTOVER_HOUR,
  /** 每类事件全天均匀抽样的上限条数。正整数。 */
  maxEventsPerKind: DEFAULT_MAX_EVENTS_PER_KIND,
  /** 一次总结给所有会话的总字符预算。0 = 关闭预算模式，退回「每类固定条数」。 */
  charBudget: DEFAULT_CHAR_BUDGET,
  /** 每条消息/事件摘录的字符上限。正整数。 */
  snippetChars: DEFAULT_SNIPPET_CHARS,
  /** 最多扫描的会话数。正整数。 */
  maxSessions: DEFAULT_MAX_SESSIONS,
  /** 自动投递「是否迟到」的宽限，单位小时，内部换算成毫秒。正数，允许小数。 */
  autoDelayGraceHours: AUTO_DELAY_GRACE_MS / (60 * 60 * 1000),
}

/** 可调项在设置文件里的分区名。 */
const TUNING_KEY = 'tuning'

/** 可调项分区里保存的内部毫秒字段名（与用户可读的小时字段区分）。 */
const TUNING_MS_KEY = 'autoDelayGraceMs'

/** 可调项合法取值范围（给设置页与工具做提示/校验用）。 */
const TUNING_RANGES = {
  cutoverHour: { min: 0, max: 23, step: 1 },
  maxEventsPerKind: { min: 1, max: 200, step: 1 },
  charBudget: { min: 50000, max: 2000000, step: 10000 },
  snippetChars: { min: 20, max: 2000, step: 10 },
  maxSessions: { min: 1, max: 5000, step: 1 },
  autoDelayGraceHours: { min: 0.5, max: 48, step: 0.5 },
}

/** 可调项的展示标签，中英文配对。显示时经 `labelFor` 按运行时语言选，
 *  不能在模块顶层直接调 `T(...)`——它依赖的 `ZH`/`T` 定义在本块之后（TDZ）。 */
const TUNING_LABELS = {
  cutoverHour: { zh: '日界钟点（凌晨几点算新一天）', en: 'Day-cutover hour (what time starts a new day)' },
  maxEventsPerKind: { zh: '每类事件采样条数上限', en: 'Max events per kind' },
  charBudget: { zh: '全局字符预算（0 表示关闭）', en: 'Total char budget (0 disables)' },
  snippetChars: { zh: '单条消息截取字符数', en: 'Snippet characters' },
  maxSessions: { zh: '最多扫描的会话数', en: 'Max sessions scanned' },
  autoDelayGraceHours: { zh: '自动投递迟到宽限（小时）', en: 'Late-delivery grace (hours)' },
}

/** 取某个可调项当前语言的标签。 */
function tuningLabel(key) {
  const pair = TUNING_LABELS[key]
  if (!pair) return key
  return ZH ? pair.zh : pair.en
}

/**
 * 把某个可调项的值归一化：不合法/越界就丢弃，返回合法值或 undefined。
 * `step` 为整数则取整，否则保留两位小数。
 */
function sanitizeTuningField(name, value) {
  const range = TUNING_RANGES[name]
  if (!range) return undefined
  const num = Number(value)
  if (!Number.isFinite(num) || Number.isNaN(num)) return undefined
  const rounded = Number.isInteger(range.step) ? Math.round(num) : Math.round(num * 100) / 100
  if (rounded < range.min || rounded > range.max) return undefined
  return rounded
}

/**
 * 从「config + settings 的 tuning 分区」收敛出最终 5 个可调值。
 * 优先级：settings.tuning > config 同名项 > 代码默认 (DEFAULT_TUNING)。
 * 任何一层缺了某项都静默回退到下一层，绝不抛错。
 * 返回体同时带用户友好的小时字段与代码用毫秒字段。
 */
function resolveTuning(config = {}, tuning = {}) {
  const base = {}
  for (const [key, def] of Object.entries(DEFAULT_TUNING)) {
    // 每项的取值来源（优先级 settings.tuning > config > 代码默认）。
    let candidate
    if (key === 'autoDelayGraceHours') {
      // 用户可能存的是小时（autoDelayGraceHours）或毫秒（autoDelayGraceMs）。
      // 两者都缺才落到 config。
      candidate =
        tuning.autoDelayGraceHours ??
        (typeof tuning.autoDelayGraceMs === 'number'
          ? tuning.autoDelayGraceMs / (60 * 60 * 1000)
          : undefined) ??
        (typeof config.autoDelayGraceMs === 'number'
          ? config.autoDelayGraceMs / (60 * 60 * 1000)
          : config.autoDelayGraceHours)
    } else {
      candidate = tuning[key] ?? config[key]
    }
    const sanitized = sanitizeTuningField(key, candidate ?? def)
    base[key] = sanitized === undefined ? def : sanitized
  }
  return {
    ...base,
    autoDelayGraceMs: Math.round(base.autoDelayGraceHours * 60 * 60 * 1000),
  }
}

/**
 * 把用户想改的可调项归一化成「只含合法字段的 partial tuning 对象」。
 * 返回 { tuning, errors }：tuning 是合并了合法的新的 adjustment，errors 列出被拒的项。
 */
function buildTuningAdjustment(input, ranges = TUNING_RANGES) {
  const tuning = {}
  const errors = {}
  for (const key of Object.keys(ranges)) {
    if (!(key in input) || input[key] === undefined || input[key] === null) continue
    const sanitized = sanitizeTuningField(key, input[key])
    if (sanitized === undefined) {
      errors[key] = `值越界或不合法：${String(input[key])}（合法范围 ${ranges[key].min}–${ranges[key].max}）`
    } else {
      tuning[key] = sanitized
    }
  }
  return { tuning, errors }
}

const SCHEDULE_TITLE = '每日总结'
/**
 * 界面与命令返回文案的分流：浏览器/运行时语言以 zh 开头用中文，其余用英文。
 * 只影响提示文字与投递给模型的提示语，不影响日界计算与取数逻辑。
 */
const ZH =
  typeof navigator === 'object' && navigator !== null ? /^zh/i.test(navigator.language || '') : false
function T(zh, en) {
  return ZH ? zh : en
}

/**
 * 定时提醒：默认文案写死中文（不受 T() 影响），因为提醒到点时浏览器语言
 * 拿不到，而且它是给模型看的稳定指令，不该随语言晃动。
 * 需要英文版时显式传 schedulePrompt 覆盖。
 */
function schedulePromptByLang() {
  if (typeof process.env.DSH_LOCALE === 'string' && /^en/i.test(process.env.DSH_LOCALE)) {
    return (
      'It is time for the daily summary. Call daily_summary with auto=true (this run is started by the scheduler), ' +
      'write it following the rules it returns, run daily_summary_selfcheck until ok is true, ' +
      'and deliver the four plain-text sections directly. ' +
      'If daily_summary_selfcheck returns logFile.written true, the plugin already wrote the file — ' +
      'do not write or edit any log file yourself. ' +
      'If it reports that the day was already delivered, say so in one line and stop — do not produce a second summary.'
    )
  }
  return (
    '现在是每日总结时间。调用 daily_summary 时传 auto=true（这是定时任务代调用），按其 rules 成文，' +
    '再用 daily_summary_selfcheck 自检到 ok 为真，把四段纯文本直接交付给我。' +
    '自检返回的 logFile.written 为真时，说明插件已经把内容写进日志文件了，你不要再自己写或改任何文件。' +
    '如果它说这一天已经交付过，就一句话说明并停下，不要再产出第二份。'
  )
}

/** 统计日已交付标记最多保留多少天。 */
const DELIVERED_KEEP_DAYS = 90

/**
 * 记下"某个统计日已交付过"。`deliveredDates` 是**自动路径**分支判断的唯一依据：
 * 定时任务只在当天还没交过时才产出；手动触发不受它限制（用户主动要就重新生成）。
 *
 * 与 `lastCompletedDate` 并存不是冗余：后者是 SKILL.md 凌晨「切当天」例外
 * 需要的"上次完整交付在哪个统计日"，前者是"哪些天已经交过"的名单。
 */
function recordDelivered(state, date, dayStart, sessionId) {
  const previous = Array.isArray(state.deliveredDates) ? state.deliveredDates.filter((d) => typeof d === 'string') : []
  const merged = [date, ...previous.filter((d) => d !== date)]
    .sort()
    .reverse()
    .slice(0, DELIVERED_KEEP_DAYS)
  return {
    ...state,
    deliveredDates: merged,
    lastCompletedDate: date,
    lastCompletedAt: new Date(dayStart.getTime() + 12 * 3600 * 1000).toISOString(),
    // 哪一天、在哪个会话里交付的：命令 handler 拿不到 agent 时据此走"今天已交过"分支。
    ...(typeof sessionId === 'string' && sessionId
      ? { deliveredTodaySessionId: sessionId, deliveredTodayDate: date }
      : {}),
  }
}

/** 两个统计日之间的整日差（左闭右开，用于"清单里最早那天是否够老"的判断）。 */
function dayGap(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`)
  const b = Date.parse(`${toDate}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/** 统计日已交付过 → 本次触发应跳过。 */
function alreadyDelivered(state, date) {
  return Array.isArray(state.deliveredDates) && state.deliveredDates.includes(date)
}

/**
 * 斜杠命令名。必须是 ASCII：框架校验 /^[a-z][a-z0-9_-]*$/u，
 * 中文名会在 register 处抛 TypeError，客户端也解析不出来。
 */
const COMMAND_NAME = 'daily-summary'

/**
 * 定时提醒里**刻意不写工具名**：一写工具名，模型就会调它，而工具一被调用
 * 就是"再产出一份"。要求模型去调一个只读的判定工具看今天该不该继续，
 * 而那个工具恰好是同一条流程的第一步 —— 比它调不到更糟，所以不这么设计。
 * 判定由工具自己兜底（daily_summary.execute 里读 state.deliveredDates）。
 */
const SCHEDULE_PROMPT = schedulePromptByLang()

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const FIXED_TITLES = [
  '1.我觉得开心的事',
  '2.我觉得充实的事（+ 我觉得有收获的事）',
  '3.可能需要改进的事',
  '4.今日份思考',
]

const EMPTY_LINE = '- 今天没有记录到这方面的事'
const EMPTY_THOUGHT = '今天没有记录到可以回看的思考。'
const NOTICE_THIN_PREFIX = '说明：今日可回溯内容有限，实际覆盖 '
const NOTICE_EMPTY = '说明：未获取到可总结素材。'
const NOTICE_UNCERTAIN = '说明：部分素材时间无法确认，未纳入。'

const pad = (n) => String(n).padStart(2, '0')

function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatClock(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}

function endOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0)
}

function addDays(d, days) {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
  next.setDate(next.getDate() + days)
  return next
}

function weekdayLabel(d) {
  return `周${WEEKDAYS[d.getDay()]}`
}

/**
 * 第一步 取当前时间与日界。
 * 三条分支互斥且覆盖全天；区间只声明统计哪一个自然日，注记声明实际统计到几点。
 *
 * @param {Date} now 只取一次的本地时间
 * @param {Date | undefined} previousCompleted 最近一次已交付的、非补记且未跨午夜的总结的统计日
 */
function resolveWindow(now, previousCompleted, cutoverHour = DEFAULT_CUTOVER_HOUR) {
  const hour = now.getHours()
  const isNight = hour < cutoverHour
  const hourName = pad(cutoverHour)

  if (!isNight) {
    const dayStart = startOfDay(now)
    return {
      branch: 'in-progress',
      dayStart,
      dayEnd: endOfDay(now),
      date: formatDate(dayStart),
      weekday: weekdayLabel(dayStart),
      interval: '00:00–24:00',
      note: `（进行中，截至 ${formatClock(now)}）`,
      cutoff: formatClock(now),
    }
  }

  const yesterdayStart = addDays(now, -1)
  const yesterdayDate = formatDate(yesterdayStart)
  // 门槛见 CUTOVER_MIN_ELAPSED_MS：24:00 的自动产出落在 00:00，此时不能切当天。
  const elapsedToday = now.getTime() - startOfDay(now).getTime()
  const reuseException =
    elapsedToday >= CUTOVER_MIN_ELAPSED_MS &&
    previousCompleted instanceof Date &&
    formatDate(previousCompleted) === yesterdayDate

  if (reuseException) {
    return {
      branch: 'in-progress-cutover',
      dayStart: startOfDay(now),
      dayEnd: endOfDay(now),
      date: formatDate(now),
      weekday: weekdayLabel(now),
      interval: '00:00–24:00',
      note: `（进行中，截至 ${formatClock(now)}）`,
      cutoff: formatClock(now),
    }
  }

  return catchUpWindow(yesterdayStart)
}

/**
 * 「凌晨补记」形态的统计窗口：统计 dayStart 那个自然日，不带截至时刻。
 *
 * 抽出来是因为它有两个调用方：resolveWindow（按当前时间判断）与自动产出
 * （显式指名要补的是刚结束的那一天，与当前几点无关）。
 */
function catchUpWindow(dayStart) {
  return {
    branch: 'catch-up',
    dayStart,
    dayEnd: endOfDay(dayStart),
    date: formatDate(dayStart),
    weekday: weekdayLabel(dayStart),
    interval: '00:00–24:00',
    note: '（凌晨补记）',
    // 不设 cutoff 键：补记分支没有"截至时刻"，留一个 undefined 会污染工具返回值。
  }
}

function formatHeadline(window) {
  return `每日总结 · ${window.date}（${window.weekday}，本地时区，统计区间 ${window.interval}${window.note}）`
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

/**
 * 全天均匀抽样：首尾必取，中间等距。
 *
 * 为什么不用 `slice(-N)`：素材是按时间顺序收集的，取最后 N 条等于只统计"当天最后那段时间"。
 * 2026-10-31 实测：某会话当天 133 条用户消息、238 条助手消息，只进来最后 8 条，
 * 上午和中午的内容全丢，总结看起来"不完整"。
 */
function sampleEvenly(list, limit) {
  if (!Array.isArray(list) || limit <= 0) return []
  if (list.length <= limit) return [...list]
  if (limit === 1) return [list[0]]
  const out = []
  const step = (list.length - 1) / (limit - 1)
  for (let index = 0; index < limit; index += 1) out.push(list[Math.round(index * step)])
  return out
}

/**
 * 按会话体量把总字符预算分给各个会话。
 *
 * 为什么需要它：每个会话固定「每类 24 条」的结果是——7.5 MB 的大会话和 200 KB 的
 * 小会话待遇一样，小项目直接沉底；而想整体调大，总量又会随会话数线性膨胀。
 * 改成固定总预算后，规则变成三条：
 *   1. **保底**：预算的 40% 平均分给所有会话，再小的会话也能被看到；
 *   2. **上限**：单个会话最多拿预算的 25%，防止超大会话独占；
 *   3. **加权**：剩下 60% 按各会话的原始字符量加权。
 *
 * 返回 Map<sessionId, 字符数>；总和不会超过 budget（宁少不多）。
 *
 * @param {{ sessionId: string, rawChars: number }[]} sessions
 * @param {number} budget 总字符预算
 */
function allocateBudget(sessions, budget) {
  const list = Array.isArray(sessions) ? sessions.filter((item) => item && item.sessionId) : []
  if (list.length === 0) return new Map()
  const total = Math.max(0, Number(budget) || 0)
  if (total === 0) return new Map()
  const count = list.length
  const eachFloor = (total * 0.4) / count
  // 上限三层取最大：不能低于保底、也不能低于平均份额（否则会话少时预算白空着），
  // 同时把「单会话不得独占超过 25%」用在会话够多的时候。
  const cap = Math.max(eachFloor, total * 0.25, total / count)
  const rawSum = list.reduce((sum, item) => sum + Math.max(0, Number(item.rawChars) || 0), 0)
  const restTotal = total - eachFloor * count

  const out = new Map()
  const leftovers = []
  for (const item of list) {
    const raw = Math.max(0, Number(item.rawChars) || 0)
    const weight = rawSum > 0 ? raw / rawSum : 1 / count
    const ideal = eachFloor + restTotal * weight
    const share = Math.min(ideal, cap)
    if (ideal > cap) leftovers.push({ item, unused: ideal - cap })
    out.set(item.sessionId, Math.max(0, Math.floor(share)))
  }

  // 被上限截掉的额度按权重再分一轮，避免预算白空着；仍受 cap 约束。
  if (leftovers.length > 0) {
    const unusedTotal = leftovers.reduce((sum, entry) => sum + entry.unused, 0)
    const leftoverRaw = leftovers.reduce(
      (sum, entry) => sum + Math.max(0, Number(entry.item.rawChars) || 0),
      0,
    )
    for (const entry of leftovers) {
      const raw = Math.max(0, Number(entry.item.rawChars) || 0)
      const weight = leftoverRaw > 0 ? raw / leftoverRaw : 1 / leftovers.length
      const current = out.get(entry.item.sessionId) || 0
      const extra = Math.min(current + unusedTotal * weight, cap) - current
      if (extra > 0) out.set(entry.item.sessionId, Math.floor(current + extra))
    }
  }
  return out
}

/** 抽样前各类素材的总条数，用来判断"这次是不是抽样过"。 */
const bucketTotals = (buckets) =>
  buckets.user.length +
  buckets.toolCalls.length +
  buckets.toolErrors.length +
  buckets.assistant.length +
  buckets.reasoning.length

/** 各类素材的字符总量，作为预算分配的权重。 */
const bucketCharTotal = (buckets) =>
  buckets.user.reduce((sum, text) => sum + text.length, 0) +
  buckets.toolCalls.reduce((sum, text) => sum + text.length, 0) +
  buckets.toolErrors.reduce((sum, text) => sum + text.length, 0) +
  buckets.assistant.reduce((sum, text) => sum + text.length, 0) +
  buckets.reasoning.reduce((sum, text) => sum + text.length, 0)

/** 会话额度里每类素材各占的比例：用户指令最值钱，推理过程最省。 */
const KIND_SHARE = {
  user: 0.4,
  assistant: 0.25,
  toolCalls: 0.15,
  toolErrors: 0.12,
  reasoning: 0.08,
}

/** 单类素材条数的硬上限，防止预算大时把整个会话倒进提示词。 */
const MAX_EVENTS_HARD_CAP = 200

/**
 * 在给定字符额度内挑出某一类素材。
 *
 * 条数 = 额度 ÷ 单条截断长度；有素材就至少留 1 条，最多 MAX_EVENTS_HARD_CAP 条。
 * 这一层是「分层」的第二半：额度决定数量，CLIP_BY_KIND 决定每条给多长。
 */
function pickWithinQuota(list, quotaChars, clipLen, cap = MAX_EVENTS_HARD_CAP) {
  if (!Array.isArray(list) || list.length === 0) return []
  const maxCount = Math.max(1, Math.min(list.length, cap))
  const fit = quotaChars > 0 ? Math.floor(quotaChars / Math.max(1, clipLen)) : 1
  const count = Math.max(1, Math.min(fit, maxCount))
  return sampleEvenly(list, count).map((text) => clip(text, clipLen))
}

/** 工具调用里出现这些词，说明它"改动了东西"，比只读命令更值得留。 */
const WRITE_HINT = /(write|edit|apply_patch|patch|mkdir|rmdir|git |npm |node |bash|powershell)/i

/**
 * 工具调用的取样：先挑变更类（写/改/提交），再用其余命令补齐。
 *
 * 为什么单独处理：均匀抽样会把「改了哪个文件」这类关键动作随机丢掉，
 * 而它恰恰是「我今天做了什么」最硬的证据。
 */
function pickToolCalls(list, quotaChars, clipLen, cap = MAX_EVENTS_HARD_CAP) {
  if (!Array.isArray(list) || list.length === 0) return []
  const maxCount = Math.max(1, Math.min(list.length, cap))
  const fit = quotaChars > 0 ? Math.floor(quotaChars / Math.max(1, clipLen)) : 1
  const count = Math.max(1, Math.min(fit, maxCount))
  if (count >= list.length) return list.map((text) => clip(text, clipLen))

  const preferred = []
  const rest = []
  for (const [index, text] of list.entries()) {
    const target = WRITE_HINT.test(String(text).slice(0, 80)) ? preferred : rest
    target.push(index)
  }
  const preferredQuota = Math.min(preferred.length, Math.ceil(count * 0.6))
  const chosen = new Set(sampleEvenly(preferred, preferredQuota))
  for (const index of sampleEvenly(rest, count - chosen.size)) chosen.add(index)
  return [...chosen].sort((a, b) => a - b).map((index) => clip(list[index], clipLen))
}

/**
 * 把一个会话的原始桶按分配到的额度做成 payload。
 *
 * 两种模式：
 *   - 有额度（charBudget > 0）：按 KIND_SHARE 切分，逐类分级截断；
 *   - 无额度（charBudget = 0）：退回旧行为，每类 maxEventsPerKind 条、统一 snippetChars。
 */
function buildSessionPayload(item, { quota, maxEventsPerKind, snippetChars }) {
  const buckets = item.buckets
  const budgeted = quota > 0
  const pick = (list, kind) => {
    if (!Array.isArray(list) || list.length === 0) return []
    if (!budgeted) {
      return sampleEvenly(list, Math.max(1, maxEventsPerKind)).map((text) => clip(text, snippetChars))
    }
    const share = KIND_SHARE[kind] ?? 0.1
    const clipLen = CLIP_BY_KIND[kind] ?? snippetChars
    const quotaChars = quota * share
    return kind === 'toolCalls'
      ? pickToolCalls(list, quotaChars, clipLen)
      : pickWithinQuota(list, quotaChars, clipLen)
  }

  const payload = {
    sessionId: item.sessionId,
    isCurrent: item.isCurrent,
    cwd: item.cwd,
    live: item.live,
    firstAt: item.firstAt,
    lastAt: item.lastAt,
    userMessages: pick(buckets.user, 'user'),
    assistantSummaries: pick(buckets.assistant, 'assistant'),
    toolCalls: pick(buckets.toolCalls, 'toolCalls'),
    toolErrors: pick(buckets.toolErrors, 'toolErrors'),
    reasoning: pick(buckets.reasoning, 'reasoning'),
  }
  // 失败的工具调用也是素材（「可能需要改进的事」常来自它），计入 eventCount。
  payload.eventCount =
    payload.userMessages.length +
    payload.assistantSummaries.length +
    payload.toolCalls.length +
    payload.toolErrors.length +
    payload.reasoning.length
  // 抽样前的真实规模：只报抽样条数会让"40 条"看起来挺多，
  // 实际上一个 1900+ 事件的会话只进来了 40 条摘要。模型据此决定要不要声明"内容有限"。
  payload.coverage = {
    rawUserMessages: buckets.user.length,
    rawAssistantMessages: buckets.assistant.length,
    rawToolCalls: buckets.toolCalls.length,
    rawToolErrors: buckets.toolErrors.length,
    rawReasoning: buckets.reasoning.length,
    rawChars: item.rawChars,
    allocatedChars: budgeted ? Math.round(quota) : null,
    keptPerKind: maxEventsPerKind,
    sampled: bucketTotals(buckets) > payload.eventCount,
  }
  return payload
}

/**
 * 递归去掉 undefined / 函数 / Symbol 这类不可 JSON 化的值。
 *
 * 为什么需要：`reminders`（来自 schedule.catalog）和 `candidates`（来自 sessionQuery）
 * 是外部服务原样返回的对象，字段里可能带 undefined。命令路径用 JSON.stringify 返回，
 * undefined 会被静默丢掉，所以一直没暴露；工具路径直接返回对象，DSH 会判定
 * "value is not lossless JSON" 而整个调用失败。
 */
function toLosslessJson(value, depth = 0) {
  if (depth > 12) return null // 防循环引用把工具调用撑爆
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => toLosslessJson(item, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = toLosslessJson(item, depth + 1)
    }
    return out
  }
  return null
}

function readBlocks(message) {
  if (!message) return []
  const blocks = Array.isArray(message.content) ? message.content : []
  const out = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
  }
  return out
}

/**
 * 第二步 来源二：按统计区间只读扫描各会话日志。
 *
 * 读取通道刻意**不经过 `ctx.sessions`**：那个存储服务要求在 agent 装配作用域里访问
 * （inject 的是 `sessions` 指向的 agent），在工具执行作用域里读会抛
 * `cannot get property "agent" without inject`。改用 `ctx.sessionQuery`：
 *   - filterSessions({created-at}) 完整逻辑语料（live 优先 + 持久化），无作用域依赖
 *   - readTitleSnapshots(ids)      会话标题，让「按需举证」能落到会话级
 *   - readSession(id)              完整原始日志（回放校验过的副本）
 * 全部只读，不改、不删、不移动任何会话记录。
 */
async function collectSources(query, window, options, selfSessionId) {
  const { maxEventsPerKind, snippetChars, maxSessions } = options
  // 全局字符预算（0 = 关闭，退回"每类固定条数"的旧行为）。
  const charBudget = Math.max(0, Number(options.charBudget) || 0)
  const from = window.dayStart.getTime()
  const to = window.dayEnd.getTime()

  const all = []
  const pending = []
  let scanned = 0
  let skipped = 0
  let unreadable = 0
  const unreadableDetails = []
  let records = []

  try {
    records = await query.filterSessions([{ kind: 'created-at', to }])
  } catch (error) {
    return {
      error: `会话列表读不出：${error instanceof Error ? error.message : String(error)}`,
      sessions: [],
      sessionCount: 0,
      shellSessions: 0,
      scanned: 0,
      skippedForLimit: 0,
      unreadable: 0,
    }
  }

  // 归档策略：默认包含归档会话；关掉时按 workspace 存储里的 archivedSessionIds 过滤。
  // 过滤只影响"读哪些会话"，不删除任何日志；被过滤掉的数量见下方的 archivedSkipped。
  let archivedSkipped = 0
  if (options.includeArchived === false) {
    const archived = await readArchivedSessionIds(options.archiveStateFile)
    if (archived.size > 0) {
      const before = records.length
      records = records.filter((record) => !archived.has(record?.header?.id))
      archivedSkipped = before - records.length
    }
  }

  // 跨工作区诊断：语料里到底有几个工作区、各自多少会话。
  // 需求要的是「不同工作区的多个对话汇总」，这一步用来证明覆盖面没有被我自己的过滤削掉。
  const cwdHistogram = {}
  for (const record of records) {
    const cwd = typeof record.header?.cwd === 'string' ? record.header.cwd : '(none)'
    cwdHistogram[cwd] = (cwdHistogram[cwd] ?? 0) + 1
  }

  for (const record of records) {
    if (scanned >= maxSessions) {
      skipped += 1
      continue
    }

    let snapshot
    try {
      snapshot = await query.readSession(record.header.id)
    } catch (error) {
      // 读不出不等于没内容：记下 id 与原因，让模型能在总结里如实说明某段素材缺失，
      // 而不是默默少算一个会话（那会让覆盖面看起来比实际更好）。
      unreadable += 1
      unreadableDetails.push({
        sessionId: record.header.id,
        cwd: typeof record.header.cwd === 'string' ? record.header.cwd : null,
        reason: String(error instanceof Error ? error.message : error).slice(0, 200),
      })
      continue
    }

    const header = snapshot.session ?? record.header
    const created = Number(header.createdAt ?? 0)
    const events = Array.isArray(snapshot.events) ? snapshot.events : []

    let firstInWindow = Infinity
    let lastInWindow = -Infinity
    for (const event of events) {
      if (event.time >= from && event.time < to) {
        if (event.time < firstInWindow) firstInWindow = event.time
        if (event.time > lastInWindow) lastInWindow = event.time
      }
    }
    // 统计区间内没有任何事件的会话：跳过。只看有没有事件，不看 createdAt ——
    // createdAt 只说明会话何时创建，不能说明它当天有没有内容（空壳会话的 createdAt
    // 也常常落在统计区间内，靠它筛选就会把空壳算进覆盖面）。
    if (firstInWindow === Infinity) continue

    const buckets = {
      user: [],
      toolCalls: [],
      toolErrors: [],
      assistant: [],
      reasoning: [],
    }

    for (const event of events) {
      if (event.time < from || event.time >= to) continue
      const data = event.data ?? {}
      switch (event.type) {
        case 'user/message': {
          const text = readBlocks(data).join('\n')
          if (text.trim()) buckets.user.push(text)
          break
        }
        case 'tool/call': {
          // 与其他三类同一把尺子：拼不出内容就不算素材。
          // 否则一个空壳会话（只有空文本消息 + 一次空参数 tool/call）会被判成「有素材」，
          // 重新混进 sessionCount 把覆盖面算虚。
          const label = `${data.name ?? ''} ${data.arguments ?? ''}`.trim()
          if (label) buckets.toolCalls.push(label)
          break
        }
        case 'tool/result': {
          if (data.error) {
            const label = `${data.message?.source?.callId ?? ''} ${data.error.code ?? ''} ${data.error.reason ?? ''}`.trim()
            if (label) buckets.toolErrors.push(label)
          }
          break
        }
        case 'assistant/message': {
          const text = readBlocks(data.message).join('\n')
          if (text.trim()) buckets.assistant.push(text)
          for (const block of Array.isArray(data.message?.content) ? data.message.content : []) {
            if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
              buckets.reasoning.push(block.text)
            }
          }
          break
        }
        default:
          break
      }
    }

    scanned += 1
    // 采样策略（2026-11-01 改）：原来 `slice(-N)` 只取**最后** N 条，
    // 一个当天有 133 条用户消息的会话，模型只看到末尾 8 条 —— 上午和中午全丢，
    // 总结自然"不完整"。改成**全天均匀抽样**：首尾必取，中间等距取。
    // 先攒着不生成 payload：预算要等所有会话的真实体量都到手才能分配
    // （见 allocateBudget）。提前抽样会把大会话和小会话的体量差抹平。
    pending.push({
      sessionId: header.id,
      isCurrent: header.id === selfSessionId,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      live: record.live === true,
      firstAt: new Date(firstInWindow === Infinity ? created : firstInWindow).toISOString(),
      lastAt: new Date(lastInWindow === -Infinity ? created : lastInWindow).toISOString(),
      buckets,
      rawChars: bucketCharTotal(buckets),
    })
  }

  // 第二阶段：按会话体量分配总字符预算，再逐会话取样。
  // charBudget <= 0 时退回旧行为（每类 maxEventsPerKind 条、统一 snippetChars 截断）。
  const quotaBySession =
    charBudget > 0
      ? allocateBudget(
          pending.map((item) => ({ sessionId: item.sessionId, rawChars: item.rawChars })),
          charBudget,
        )
      : new Map()
  for (const item of pending) {
    all.push(
      buildSessionPayload(item, {
        quota: quotaBySession.get(item.sessionId) ?? 0,
        maxEventsPerKind,
        snippetChars,
      }),
    )
  }

  // 空壳会话（当天创建/有日志但提取不出任何素材）不计入覆盖面。
  //
  // 为什么必须连 sessions 数组一起剔除：模型读的是整个 sources，只改 sessionCount
  // 而数组里仍留着空壳，模型数一下 sessions.length 就又把覆盖面算虚了。
  // 更要紧的是 SKILL.md 第四步阈值②「事件只来自 1 个会话」——空壳会把 1 个会话
  // 伪装成 3 个会话，让本该出现的降级声明消失，等于伪造「已汇总全部」。
  // 上游的 firstInWindow 过滤已经把「当天零事件」的会话挡在循环外，这里再兜一层
  // 「有事件但一条素材都提不出来」的（例如全文都是空文本）。
  const entries = all.filter((entry) => entry.eventCount > 0)
  const shellSessions = all.length - entries.length

  // 会话标题：日志里有标题事件时用它，让来源能落到会话级
  if (entries.length > 0) {
    try {
      const titles = await query.readTitleSnapshots(entries.map((entry) => entry.sessionId))
      const byId = new Map()
      for (const result of titles) {
        if (result.status === 'fulfilled' && result.value?.title?.title) {
          byId.set(result.sessionId, result.value.title.title)
        }
      }
      for (const entry of entries) entry.title = byId.get(entry.sessionId) ?? null
    } catch {
      // 标题读不出不是失败：退化为下面的素材级出处
    }
  }

  // 当前会话优先
  entries.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))

  entries.forEach((entry, index) => {
    if (entry.isCurrent) entry.sourceName = '当前会话'
    else if (entry.title) entry.sourceName = clip(entry.title, 40)
    else if (entry.userMessages.length > 0) entry.sourceName = clip(entry.userMessages[0], 40)
    else entry.sourceName = `会话 ${index + 1}`
  })

  // 按工作区聚合，供模型写出「跨工作区」的统一总结。
  const workspaceMap = new Map()
  for (const entry of entries) {
    const cwd = typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : '(未记录工作区)'
    const bucket = workspaceMap.get(cwd) ?? { cwd, sessions: [], eventCount: 0 }
    bucket.sessions.push({ sessionId: entry.sessionId, sourceName: entry.sourceName, title: entry.title })
    bucket.eventCount += entry.eventCount
    workspaceMap.set(cwd, bucket)
  }
  const workspaces = [...workspaceMap.values()].sort((a, b) => b.eventCount - a.eventCount)

  return {
    range: {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      localDate: window.date,
      localInterval: window.interval,
    },
    // 覆盖面：只数当天真正有素材的会话；空壳单独计数，便于核对「为什么少了几个」
    sessionCount: entries.length,
    // 跨工作区覆盖面：workspaceCount 是当天有素材的不同工作区数，
    // 模型写总结时按这个维度合并，而不是只看当前工作区。
    workspaceCount: workspaces.length,
    workspaces,
    shellSessions,
    scanned,
    skippedForLimit: skipped,
    archivedSkipped,
    unreadable,
    // 读不出的会话明细：模型据此在总结里如实声明「某段素材缺失」，不假装完整。
    unreadableDetails,
    // 诊断：语料里各工作区的会话总量（未按当天素材过滤），用来证明没被工作区限制削掉。
    corpusCwdHistogram: cwdHistogram,
    corpusSessionCount: records.length,
    channels: {
      list: 'sessionQuery.filterSessions({kind:"created-at"})',
      log: 'sessionQuery.readSession(id)',
      title: 'sessionQuery.readTitleSnapshots(ids)',
    },
    sessions: entries,
    caveat: {
      currentSessionZeroReturn:
        '当前会话的内容以本会话上下文为准；这里的清单只是辅助核对，检索结果对当前会话可能为空或与上下文重复，属已知现象，不是故障。',
      crossWorkspace:
        '素材按工作区聚合：sessionQuery 读的是全部会话（live + 持久化），不限当前工作区；workspaces 列出当天有素材的每个工作区及其会话。',
      unreadableSessions:
        unreadable > 0
          ? `有 ${unreadable} 个会话日志读取失败（见 unreadableDetails），其内容未纳入本次汇总；如涉及当天重要工作，应在总结中如实说明素材缺失，不要把缺失当成没有发生。`
          : null,
      shellSessionsExcluded:
        shellSessions > 0
          ? `另有 ${shellSessions} 个会话当天创建或留有日志，但提取不出任何素材，已从 sessionCount 与 sessions 中剔除，不计入覆盖面。`
          : null,
      emptyIsNotProof:
        '清单为空不等于当天什么都没发生，只说明读出的会话日志里没有可回溯片段；时间在统计区间外的素材一律不纳入。',
      timeUncertain:
        '时间落在统计区间之外的素材一律不纳入；若部分素材时间无法确认，按 SKILL.md 第四步文案三声明。',
    },
  }
}

async function readState(stateFile) {
  try {
    const raw = await readFile(stateFile, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeState(stateFile, state) {
  try {
    await mkdir(path.dirname(stateFile), { recursive: true })
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return true
  } catch {
    // 状态写不进去不是失败：退化为 SKILL.md 第一步第 7 条（拿不到就补记、不追问）
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 自动写入日志文件
 *
 * 用户在某个工作区里放一个日志文件（如 `日志.txt`），每日总结产出后直接追加进去，
 * 不用每次再说一遍"帮我写进文件"。
 *
 * 写入点在 `daily_summary_selfcheck` 通过之后：那里拿到的是**完整成稿**，
 * 而且已经记了交付日，是最不容易漏的时机。不依赖模型记得写。
 * ------------------------------------------------------------------ */

/** 目标会话目录下按顺序探测的默认文件名。 */
const LOG_FILE_CANDIDATES = ['日志.txt', '日志.md', 'daily-log.txt', 'daily-log.md']

/** 把 `2026.10.27` / `2026-10-27` / `2026年10月27日` 归一成 `YYYY-MM-DD`。 */
function logDateKey(value) {
  const match = /^(\d{4})\s*[.\-/年]\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?$/.exec(
    String(value ?? '').trim(),
  )
  if (!match) return undefined
  return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`
}

/**
 * 一天的内容块：日期行 + 空行 + 四段正文。
 * 抬头行要去掉——日志文件里日期已经单独占一行，再写一遍「每日总结 · …」就重复了。
 */
function buildLogBlock(date, text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const body = lines.length > 0 && lines[0].trim().startsWith('每日总结') ? lines.slice(1) : lines
  const trimmed = body.join('\n').trim()
  return {
    header: date.replace(/-/g, '.'),
    bodyLines: trimmed.length > 0 ? trimmed.split('\n') : [],
  }
}

/** 找某一天在文件里的行范围 [start, end)，end 指向下一个日期行。 */
function findDayRange(lines, date) {
  const start = lines.findIndex((line) => logDateKey(line) === date)
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (logDateKey(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

const trimTrailingEmpty = (lines) => {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * 把成稿写进日志文件。
 *
 * - 当天已有块：默认**不覆盖**（那里面可能有你手写的碎碎念），返回 reason='exists'；
 *   打开 `logOverwrite` 才整块替换。
 * - 没有：追加到文件末尾，沿用现有格式（日期行 + 空行 + 四段）。
 */
async function writeDailyLog({ file, date, text, overwrite }) {
  // 防御：路径指向目录时明确拒绝，而不是让 readFile 抛 EISDIR 出去。
  // （上游 resolveLogTarget 已会把目录退化成具体文件，这里是最后一道。）
  try {
    const info = await stat(file)
    if (info.isDirectory()) {
      return { path: file, written: false, reason: 'is-directory', replaced: false }
    }
  } catch {
    // 不存在 = 待新建，继续
  }

  let current = ''
  try {
    current = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const lines = current.replace(/\r\n/g, '\n').split('\n')
  const block = buildLogBlock(date, text)
  if (block.bodyLines.length === 0) {
    return { path: file, written: false, reason: 'empty', replaced: false }
  }

  const range = findDayRange(lines, date)
  let out
  let replaced = false
  if (range) {
    if (!overwrite) return { path: file, written: false, reason: 'exists', replaced: false }
    out = [...lines.slice(0, range.start), block.header, '', ...block.bodyLines, '', ...lines.slice(range.end)]
    replaced = true
  } else {
    out = [...trimTrailingEmpty(lines), '', block.header, '', ...block.bodyLines, '']
    // 文件原本是空的：开头别留空行
    if (current.trim().length === 0) out = [block.header, '', ...block.bodyLines, '']
  }

  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${trimTrailingEmpty(out).join('\n')}\n`, 'utf8')
  return { path: file, written: true, replaced }
}

/**
 * 决定写到哪：设置的 `logFile` 优先（绝对路径直接用，相对路径相对目标会话目录），
 * 没设置就在目标会话目录下按 LOG_FILE_CANDIDATES 探测。
 */
async function resolveLogTarget({ ctx, settingsFile, query, sessionId }) {
  const settings = await readSettings(settingsFile)
  const configured = typeof settings.logFile === 'string' ? settings.logFile.trim() : ''

  let baseDir
  const lookup = async (id) => {
    if (!id || !query || typeof query.filterSessions !== 'function') return undefined
    try {
      const records = await query.filterSessions([{ kind: 'created-at', to: Date.now() }])
      const hit = (Array.isArray(records) ? records : []).find((record) => record.header?.id === id)
      return typeof hit?.header?.cwd === 'string' ? hit.header.cwd : undefined
    } catch {
      return undefined
    }
  }

  // 目标会话优先，其次本次交付的会话
  baseDir = (await lookup(settings.targetSessionId)) ?? (await lookup(sessionId))
  if (!baseDir) return undefined

  /** 在一个目录里按候选名找已存在的文件。 */
  const probeIn = async (directory) => {
    for (const name of LOG_FILE_CANDIDATES) {
      const candidate = path.join(directory, name)
      try {
        const info = await stat(candidate)
        if (info.isFile()) return candidate
      } catch {
        // 不存在就试下一个
      }
    }
    return undefined
  }

  if (configured) {
    const target = path.isAbsolute(configured) ? configured : path.join(baseDir, configured)
    let info
    try {
      info = await stat(target)
    } catch {
      info = undefined
    }
    // **用户很可能填的是目录**（2026-10-30 实测：logFile 填了 `…\Desktop\日志`，
    // 于是每次写都拿目录当文件、报 EISDIR 被跳过）。目录就退化成"在这个目录里找日志文件"，
    // 找不到就用候选名新建一个，而不是把整条写入判成失败。
    if (info?.isDirectory()) {
      return (await probeIn(target)) ?? path.join(target, LOG_FILE_CANDIDATES[0])
    }
    if (info) return target
    // 路径还不存在：以分隔符结尾按目录处理，否则按文件（允许新建）
    return /[\\/]$/.test(configured) ? path.join(target, LOG_FILE_CANDIDATES[0]) : target
  }

  return probeIn(baseDir)
}

function latestCompletedDate(state) {
  if (!state || typeof state.lastCompletedAt !== 'string') return undefined
  const parsed = new Date(state.lastCompletedAt)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/** 第四步 降级声明：三条文案互斥完备，叠加时合为一行、以 ； 分隔。 */
function buildNotice({ eventCount, sessionCount: coveredSessions, hasUncertain }) {
  if (eventCount === 0) {
    return hasUncertain ? `${NOTICE_EMPTY} ${NOTICE_UNCERTAIN}` : NOTICE_EMPTY
  }
  const parts = []
  if (eventCount < 3 || coveredSessions <= 1) {
    parts.push(`${NOTICE_THIN_PREFIX}${coveredSessions} 个会话、${eventCount} 条事件。`)
  }
  if (hasUncertain) parts.push(NOTICE_UNCERTAIN)
  if (parts.length === 0) return undefined
  return parts.join('；')
}

/**
 * 输出自检：把 SKILL.md「输出自检」6 条与「禁止事项」里可机检的部分做成确定性检查。
 * 只报告，不改稿；由模型按结果自行修订。
 */
function selfCheck(text, window, alternates = []) {
  const problems = []
  const lines = text.split(/\r?\n/)
  const candidates = [window, ...alternates]
  const firstLine = (lines[0] || '').trim()
  const matched = candidates.find((w) => formatHeadline(w) === firstLine) ?? window
  const headline = formatHeadline(window)

  if (!candidates.some((w) => formatHeadline(w) === firstLine)) {
    problems.push(`抬头第一行必须是：${headline}`)
  }

  for (const title of FIXED_TITLES) {
    const hits = lines.filter((line) => line.trim() === title).length
    if (hits !== 1) problems.push(`四段标题「${title}」应恰好出现 1 次，实际 ${hits} 次`)
  }

  if (text.includes('（进行中）')) problems.push('出现旧口径「（进行中）」，必须写成（进行中，截至 <HH:MM>）')

  // 抬头本身逐字比对时，若上一次取数与本轮取了不同的截至时刻，按「同轮一致」放行。
  // 注记规则跟着**实际匹配到的**那份窗口走：自动补记昨天时是「（凌晨补记）」形态。
  const atCutoff = /（进行中，截至 \d{2}:\d{2}）/.test(text)
  if (matched.note && matched.note !== '（凌晨补记）' && !atCutoff) {
    problems.push(`统计日尚未过完，注记必须带截至时刻：（进行中，截至 ${matched.cutoff}）`)
  }
  if (matched.note === '（凌晨补记）' && atCutoff) {
    problems.push('凌晨补记版不带截至时刻：注记只写（凌晨补记）')
  }

  if (text.includes('用户')) problems.push('全文不得出现「用户」二字')

  if (/(^|\n)\s*\|/.test(text)) problems.push('不得出现竖线表格行')
  if (text.includes('```')) problems.push('不得出现三个反引号围栏')
  if (/\*\*|__/.test(text)) problems.push('不得出现加粗或斜体强调')
  if (/(^|\n)\s*#\s/.test(text)) problems.push('不得出现 # 标题')
  if (/<\/?[a-zA-Z][^>]*>/.test(text)) problems.push('不得出现 HTML 标签')
  if (/@scene/i.test(text) || /(^|\n)\s*@/.test(text)) problems.push('正文不得出现 @scene 或场景标记')
  if (/（来源：/.test(text)) problems.push('默认全文不写（来源：…）；仅在对方质疑某条之后，才给被质疑的那一条补来源')

  const numbered = lines.filter((line) => /^\d+\./.test(line.trim()) && !FIXED_TITLES.includes(line.trim()))
  if (numbered.length > 0) problems.push('四段之外不出现额外编号块')

  return {
    ok: problems.length === 0,
    problems,
    headline,
    fixedTitles: FIXED_TITLES,
    // 实际匹配到的那份窗口：调用方据此记录"交付的是哪一天"，不能用 now 重算。
    matchedWindow: matched,
  }
}

/* ------------------------------------------------------------------ *
 * 设置：自定义触发时间 + 指定在哪条会话里触发
 *
 * 一条操作，三个调用方（设置页、斜杠命令、agent 工具）都走
 * `reconcileReminders`，避免 UI 与工具各写一套。
 * ------------------------------------------------------------------ */

/** 设置命令名。必须是 ASCII（框架校验 /^[a-z][a-z0-9_-]*$/u）。 */
const SETTINGS_COMMAND_NAME = 'daily-summary-settings'

/**
 * 把用户输入归一成 schedule 接受的 `HH:mm:ss`。
 * `24:00` 是用户语言里的"当天结束"，落到次日 00:00 —— 即 `00:00:00`。
 */
function normalizeClockInput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(text)
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = match[3] ? Number(match[3]) : 0
  if (hour === 24) return minute === 0 && second === 0 ? '00:00:00' : undefined
  if (hour > 23) return undefined
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

/** 展示用：`00:00:00` 显示成 `24:00`，其余显示 `HH:MM`。 */
function clockForDisplay(time) {
  const normalized = normalizeClock(time)
  if (!normalized) return typeof time === 'string' ? time : ''
  return normalized === '00:00:00' ? '24:00' : normalized.slice(0, 5)
}

/** 读设置文件：两项都可缺省，缺省即回到默认算法。 */
async function readSettings(settingsFile) {
  const raw = await readState(settingsFile)
  const time = normalizeClock(raw.scheduleTime)
  const target =
    typeof raw.targetSessionId === 'string' && raw.targetSessionId ? raw.targetSessionId : undefined
  // 日志落盘：空字符串 = 让插件在目标会话目录下自动探测
  const logFile = typeof raw.logFile === 'string' && raw.logFile.trim() ? raw.logFile.trim() : undefined
  const logOverwrite = raw.logOverwrite === true
  // 可调项分区：读原始对象，交由 resolveTuning 做归一化与三级回退。
  const tuningRaw = raw[TUNING_KEY]
  const tuning =
    typeof tuningRaw === 'object' && tuningRaw !== null && !Array.isArray(tuningRaw) ? tuningRaw : {}
  const ms = typeof tuningRaw?.[TUNING_MS_KEY] === 'number' ? tuningRaw[TUNING_MS_KEY] : undefined
  // 归档开关：只有显式写过布尔值才返回，否则交给三级回退（config / 默认 true）。
  const includeArchived = typeof raw.includeArchived === 'boolean' ? raw.includeArchived : undefined
  return {
    scheduleTime: time,
    targetSessionId: target,
    logFile,
    logOverwrite,
    includeArchived,
    tuning: { ...tuning, ...(ms !== undefined ? { autoDelayGraceMs: ms } : {}) },
  }
}

/** 只改日志落盘这两项，其余设置原样保留。`''` 表示回到自动探测。 */
async function applyLogSetting(settingsFile, logFile, overwrite) {
  const current = await readState(settingsFile)
  const next = { ...current, logFile: logFile && logFile.trim() ? logFile.trim() : null }
  if (typeof overwrite === 'boolean') next.logOverwrite = overwrite
  return writeState(settingsFile, next)
}

/**
 * 只改「是否包含已归档会话」这一项，其余设置原样保留。
 *
 * 默认（`true`）保持历史行为：归档只是界面隐藏，日志没删，当天做的事仍应进总结。
 * 关掉（`false`）时取数与设置页候选都会跳过 `archivedSessionIds` 里的会话。
 */
async function applyArchivedSetting(settingsFile, includeArchived) {
  const current = await readState(settingsFile)
  return writeState(settingsFile, {
    ...current,
    includeArchived: includeArchived === true,
  })
}

/**
 * 写可调项：只改传入的合法项，其余设置原样保留；不传 `undefined` 的项都照写。
 * 返回 { saved, tuning, errors }：
 *   - saved：是否有任一合法项真正被写入（true/false）
 *   - tuning 存的是**用户改过的**那些（合并进 settings.tuning 分区）
 *   - errors：{ 键: 错误文案 }，列出越界/非法的项
 */
async function applyTuningSetting(settingsFile, adjustment) {
  const current = await readState(settingsFile)
  const prevTuning = current[TUNING_KEY]
  const merged = {
    ...(typeof prevTuning === 'object' && prevTuning !== null && !Array.isArray(prevTuning) ? prevTuning : {}),
    ...adjustment,
  }
  // 若 autoDelayGraceHours 被改过，同步更新毫秒字段；用户偏好小时，毫秒只是内部镜像。
  const saved = Object.keys(adjustment).length > 0
  if (saved) {
    const next = { ...current, [TUNING_KEY]: merged }
    await writeState(settingsFile, next)
  }
  return { saved, tuning: merged }
}

/**
 * 可选会话清单（给设置页的下拉框）。只读：列表 + 标题，不读日志正文。
 * 读不出就返回空数组，由调用方如实降级。
 */
async function listSessionCandidates(query, limit = 100, options = {}) {
  if (!query || typeof query.filterSessions !== 'function') return []
  try {
    // `to` 必须是**数字时间戳**：filterSessions 的 created-at 过滤按 number 校验，
    // 传 Date 对象会让它抛错、被下面的 catch 吞成空列表
    // （2026-10-23 实测：设置页下拉框因此只剩「自动」一项）。
    const records = await query.filterSessions([{ kind: 'created-at', to: Date.now() }])
    let pool = Array.isArray(records) ? records : []
    // 归档会话默认也列出来（它们照样能取到素材）；关掉开关时按归档标记过滤。
    if (options.includeArchived === false) {
      const archived = await readArchivedSessionIds(options.archiveStateFile)
      if (archived.size > 0) pool = pool.filter((record) => !archived.has(record?.header?.id))
    }
    const picked = pool.slice(-limit).reverse()
    const ids = picked.map((record) => record.header?.id).filter((id) => typeof id === 'string')
    const byId = new Map()
    if (ids.length > 0 && typeof query.readTitleSnapshots === 'function') {
      try {
        const titles = await query.readTitleSnapshots(ids)
        for (const result of titles) {
          if (result.status === 'fulfilled' && result.value?.title?.title) {
            byId.set(result.sessionId, result.value.title.title)
          }
        }
      } catch {
        // 标题读不出只是少一列文字，不影响选择
      }
    }
    return picked
      .map((record) => ({
        id: record.header?.id,
        title: byId.get(record.header?.id) ?? null,
        cwd: typeof record.header?.cwd === 'string' ? record.header.cwd : '(unknown)',
      }))
      .filter((entry) => typeof entry.id === 'string' && entry.id.length > 0)
      // 无标题会话（空壳、探针、一次性的壳）不进选取界面：一排「（无标题）· session-xxxx」
      // 选起来毫无信息量，2026-10-23 实测同一工作区冒出 6 条。
      // **只标不滤**：宿主仍返回它们，界面据此过滤；保留条目是为了让
      // "当前固定会话恰好无标题"时还能查到它的身份、如实显示，而不是变成空白。
      .map((entry) => ({
        ...entry,
        titled: typeof entry.title === 'string' && entry.title.trim().length > 0,
      }))
      // 设置页要能"自己选发布在哪个对话"：同工作区的挨在一起、组内按标题排，
      // 界面按 cwd 分组成 optgroup 渲染。
      .sort(
        (a, b) =>
          String(a.cwd).localeCompare(String(b.cwd)) ||
          String(a.title ?? '').localeCompare(String(b.title ?? '')),
      )
  } catch {
    return []
  }
}

const describeError = (error) => (error instanceof Error ? error.message : String(error))

/**
 * 取某会话最后一次的模型选择。resume **必须**带上它——
 * 不带的话装配 persona 时 `{{model}}` 取不到值，整轮直接失败：
 *   prompt variable "{{model}}" has no value for this assembly
 *   (section "deployment:persona-prefix")
 * 这正是 2026-10-24 第一次做"自动唤醒"时踩的坑。
 */
async function readModelSelection(query, sessionId) {
  if (!sessionId || !query || typeof query.readSession !== 'function') return undefined
  try {
    const snapshot = await query.readSession(sessionId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (!event || event.type !== 'model/selection') continue
      const data = event.data || {}
      if (typeof data.provider === 'string' && typeof data.model === 'string') {
        return { provider: data.provider, model: data.model }
      }
    }
  } catch {
    // 读不出就返回 undefined，由调用方决定怎么报错
  }
  return undefined
}

/**
 * 取"能接收消息的 agent"：活着的直接用，没活着就 resume 把它唤醒。
 *
 * 为什么要这一步：插件投递一条消息需要一个 agent 对象（`followup`），而 agent
 * 只存在于宿主内存里。目标会话没在运行，`agents.get()` 就是 undefined。
 * 定时任务不受影响（框架自己投递）；手动触发要落到固定会话，就只能由插件把它拉起来。
 *
 * 唤起的 agent 归插件所有，记进 `ownedAgents`，由调用方在卸载时统一释放。
 */
async function acquireTargetAgent(ctx, ownedAgents, sessionId, options = {}) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') {
    return { error: T('agents 服务不可用', 'the agents service is unavailable') }
  }
  let live
  try {
    live = agents.get(sessionId)
  } catch {
    live = undefined
  }
  if (live && typeof live.followup === 'function') return { agent: live, resumed: false }

  if (typeof agents.resume !== 'function') {
    return { error: T('宿主不支持 resume', 'this host cannot resume sessions') }
  }

  // 模型选择：先看目标会话自己的最后一次选择，没有就沿用触发会话的。
  // 两个都拿不到就不硬唤醒——否则只会得到一个看不懂的 prompt 装配错误。
  const selection =
    (await readModelSelection(options.query, sessionId)) ??
    (await readModelSelection(options.query, options.fallbackSessionId))
  if (!selection) {
    return {
      error: T(
        '读不到这条会话用过的模型，无法唤醒它。请先打开那条会话发一条消息，或等定时任务自动执行',
        "cannot read this session's model selection, so it cannot be woken; open that session once or wait for the scheduled run",
      ),
    }
  }

  try {
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
    })
    if (handle && handle.agent && typeof handle.agent.followup === 'function') {
      ownedAgents.set(sessionId, handle)
      return { agent: handle.agent, resumed: true }
    }
    return { error: T('resume 没有返回可用的 agent', 'resume returned no usable agent') }
  } catch (error) {
    return { error: describeError(error) }
  }
}

/**
 * 把「想要的设置」落到磁盘和真实提醒上。
 *
 * - 指定了目标会话：只保留目标会话那条（其余删除），目标上没有就新建。
 * - 没指定（默认算法）：把已存在的每条都改成新时间；一条都没有就在当前会话建一条。
 *
 * 每步独立 try/catch：删不掉一条不该让其余步骤全废，错误如实收集进报告。
 */
async function reconcileReminders(ctx, config, settingsFile, intent, callerId) {
  const schedule = ctx.get('schedule')
  if (!schedule || typeof schedule.catalog !== 'function') {
    return {
      ok: false,
      error: T(
        '定时服务不可用（schedule 未就绪），请重启 DSH 后再试',
        'the schedule service is unavailable; restart DSH and retry',
      ),
    }
  }

  const current = await readSettings(settingsFile)
  const requested = intent.scheduleTime ?? current.scheduleTime ?? config.scheduleTime ?? DEFAULT_SCHEDULE_TIME
  const time = normalizeClock(requested) ?? DEFAULT_SCHEDULE_TIME
  const zone = typeof config.scheduleTimeZone === 'string' ? config.scheduleTimeZone : DEFAULT_SCHEDULE_TZ
  const target =
    intent.targetSessionId === undefined ? current.targetSessionId : intent.targetSessionId || undefined

  // **必须合并旧设置**：这里只负责时间与目标会话，若直接写一个只有这两项的对象，
  // 会把 logFile / logOverwrite 冲掉（改了触发时间，日志落盘就悄悄失效）。
  const next = {
    ...(await readState(settingsFile)),
    scheduleTime: time,
    targetSessionId: target ?? null,
  }
  const persisted = await writeState(settingsFile, next)

  const report = { ok: true, persisted, time, timeDisplay: clockForDisplay(time), targetSessionId: target ?? null, updated: [], created: [], deleted: [], errors: [] }

  let catalog
  try {
    catalog = await schedule.catalog()
  } catch (error) {
    report.errors.push(`读取提醒清单失败：${describeError(error)}`)
    return report
  }
  const mine = (Array.isArray(catalog) ? catalog : []).filter((entry) => entry && entry.title === SCHEDULE_TITLE)

  const upsert = async (entry) => {
    // catalog 行带 status/deliveryHistory 等额外字段；用该会话的 list() 取一份干净记录当 expected。
    let expected = entry
    try {
      const list = await schedule.list({ sessionId: entry.sessionId })
      const hit = Array.isArray(list) ? list.find((record) => record && record.id === entry.id) : undefined
      if (hit) expected = hit
    } catch {
      // 拿不到干净记录就用 catalog 行试一次
    }
    const drift = reminderDrift(expected, time, zone, SCHEDULE_PROMPT)
    if (!drift) return
    await schedule.update({ sessionId: entry.sessionId, id: entry.id, expected, ...drift })
    report.updated.push(entry.id)
  }

  if (target) {
    for (const entry of mine.filter((candidate) => candidate.sessionId !== target)) {
      try {
        await schedule.delete({ sessionId: entry.sessionId, id: entry.id })
        report.deleted.push(entry.id)
      } catch (error) {
        report.errors.push(`删除 ${entry.id} 失败：${describeError(error)}`)
      }
    }
    const onTarget = mine.find((entry) => entry.sessionId === target)
    if (onTarget) {
      try {
        await upsert(onTarget)
      } catch (error) {
        report.errors.push(`更新 ${onTarget.id} 失败：${describeError(error)}`)
      }
    } else {
      try {
        const record = await schedule.create(target, {
          title: SCHEDULE_TITLE,
          prompt: SCHEDULE_PROMPT,
          daily: { time, time_zone: zone },
        })
        report.created.push(record?.id ?? target)
      } catch (error) {
        report.errors.push(`在 ${target} 建提醒失败：${describeError(error)}`)
      }
    }
  } else if (mine.length === 0) {
    if (callerId) {
      try {
        const record = await schedule.create(callerId, {
          title: SCHEDULE_TITLE,
          prompt: SCHEDULE_PROMPT,
          daily: { time, time_zone: zone },
        })
        report.created.push(record?.id ?? callerId)
      } catch (error) {
        report.errors.push(`建提醒失败：${describeError(error)}`)
      }
    }
  } else {
    for (const entry of mine) {
      try {
        await upsert(entry)
      } catch (error) {
        report.errors.push(`更新 ${entry.id} 失败：${describeError(error)}`)
      }
    }
  }

  report.reminderCount = (await schedule.catalog().then(
    (rows) => (Array.isArray(rows) ? rows.filter((row) => row && row.title === SCHEDULE_TITLE).length : 0),
    () => 0,
  ))
  return report
}

// 纯函数导出，供回归测试直接断言时间归一化规则（24:00 ↔ 00:00）、采样与日志落盘规则。
export {
  clockForDisplay,
  normalizeClockInput,
  buildLogBlock,
  findDayRange,
  logDateKey,
  writeDailyLog,
  sampleEvenly,
  allocateBudget,
  CLIP_BY_KIND,
  DEFAULT_CHAR_BUDGET,
  pickWithinQuota,
  pickToolCalls,
  buildSessionPayload,
  toLosslessJson,
}

export function apply(ctx, config = {}) {
  // config.clock 只供本地测试注入可控时钟；正常工作永远读运行时本地时间。
  const readClock = typeof config.clock === 'function' ? config.clock : () => new Date()
  const stateFile = config.stateFile || DEFAULT_STATE_FILE
  // 设置文件与状态文件分开：state 是"交付过哪些天"，settings 是"用户选了什么"。
  const settingsFile = config.settingsFile || path.join(path.dirname(config.stateFile || DEFAULT_STATE_FILE), 'settings.json')

  // 插件代为唤醒的 agent（目标会话当时没在运行）。卸载时统一 dispose，
  // 否则这些 agent 会随着插件实例一直留在宿主内存里。
  const ownedAgents = new Map()
  try {
    ctx.effect?.(() => () => {
      for (const handle of ownedAgents.values()) {
        try {
          const done = handle?.dispose?.()
          if (done && typeof done.catch === 'function') done.catch(() => {})
        } catch {
          // 释放失败不阻塞卸载
        }
      }
      ownedAgents.clear()
    })
  } catch {
    // 没有 effect 能力的上下文里退化为不主动释放
  }

  // 本进程已建过定时提醒的 sessionId；重启后靠 schedule.list() 查重兜底。
  //
  // sessionId 的来源：工具执行上下文 exec.agent.id。**不要用 ctx.sessionId** ——
  // 它和 ctx.sessions / ctx.sessionQuery 一样要求在 agent 装配作用域里访问，
  // 在插件 apply 阶段读会抛 cannot get property "sessionId" without inject。
  const scheduledSessions = new Set()
  let boundSessionId

  // 可选的会话读取通道。用运行时 ctx.inject 按需接入：服务缺席时插件照常工作，
  // 只是素材清单降级为「读不出」。config.sessionQuery 供本地测试注入。
  //
  // 注意：绝不要把服务对象（或任何 ctx 上的东西）放进工具返回值 ——
  // 它带着运行时内部字段，会让框架把整个结果判成「不是无损 JSON」。
  let injectedQuery
  const resolveQuery = () =>
    typeof config.sessionQuery === 'object' && config.sessionQuery ? config.sessionQuery : injectedQuery
  ctx.inject(['sessionQuery'], (scoped) => {
    injectedQuery = scoped.sessionQuery
    return () => {
      injectedQuery = undefined
    }
  })

  /**
   * 设置页与 agent 工具共同的返回体。两个调用方看到的必须是同一份事实，
   * 否则界面显示的和 agent 说的会对不上。
   */
  const describeSettings = async (callerId) => {
    const settings = await readSettings(settingsFile)
    const schedule = ctx.get('schedule')
    let reminders = []
    try {
      const catalog = schedule && typeof schedule.catalog === 'function' ? await schedule.catalog() : []
      reminders = (Array.isArray(catalog) ? catalog : [])
        .filter((row) => row && row.title === SCHEDULE_TITLE)
        .map((row) => ({
          id: row.id,
          sessionId: row.sessionId,
          status: row.status,
          time: clockForDisplay(row.time),
          timeZone: row.timeZone,
        }))
    } catch {
      reminders = []
    }
    // 归档开关：settings 优先、config 次之、默认包含（归档只是界面隐藏，日志不删）。
    const includeArchived =
      settings.includeArchived ?? config.includeArchived ?? DEFAULT_INCLUDE_ARCHIVED
    const candidates = await listSessionCandidates(resolveQuery(), 100, {
      includeArchived,
      archiveStateFile: config.archiveStateFile,
    })
    // 实际会写到哪个文件（只读解析，不创建/不写入）。
    // 界面要能直接看到它，否则"填了目录却没写进去"这种问题只能靠猜。
    let logResolved
    try {
      logResolved = await resolveLogTarget({
        ctx,
        settingsFile,
        query: resolveQuery(),
        sessionId: callerId,
      })
    } catch {
      logResolved = undefined
    }
    // 提醒行原来只显示 `session-ea71` 这种截断 id，用户看不出固定在哪条对话。
    // 标题与候选清单同源，界面直接拿来渲染。
    const titleById = new Map(candidates.map((entry) => [entry.id, entry]))
    for (const reminder of reminders) {
      const known = titleById.get(reminder.sessionId)
      reminder.sessionTitle = known?.title ?? null
      reminder.sessionCwd = known?.cwd ?? null
    }
    return toLosslessJson({
      ok: true,
      version: PLUGIN_VERSION,
      time: clockForDisplay(settings.scheduleTime ?? config.scheduleTime ?? DEFAULT_SCHEDULE_TIME),
      timeRaw: settings.scheduleTime ?? normalizeClock(config.scheduleTime) ?? DEFAULT_SCHEDULE_TIME,
      targetSessionId: settings.targetSessionId ?? null,
      targetTitle: settings.targetSessionId
        ? titleById.get(settings.targetSessionId)?.title ?? null
        : null,
      defaultTime: clockForDisplay(DEFAULT_SCHEDULE_TIME),
      // 日志落盘：null 表示"在目标会话目录下自动探测"，不是"关闭"
      logFile: settings.logFile ?? null,
      logOverwrite: settings.logOverwrite === true,
      includeArchived,
      logCandidates: LOG_FILE_CANDIDATES,
      logResolved: logResolved ?? null,
      callerSessionId: callerId ?? null,
      reminders,
      candidates,
      // 取数与分界的可调项：当前生效值（settings 优先）+ 合法范围 + 代码默认值。
      // settings 里没存的就是代码默认值（DEFAULT_TUNING），settingsTuning 只列用户改过的。
      tuning: {
        values: resolveTuning(config, settings.tuning),
        ranges: TUNING_RANGES,
        defaults: { ...DEFAULT_TUNING, autoDelayGraceMs: Math.round(DEFAULT_TUNING.autoDelayGraceHours * 60 * 60 * 1000) },
        labels: Object.fromEntries(Object.keys(TUNING_RANGES).map((k) => [k, tuningLabel(k)])),
        overridden: Object.keys(settings.tuning ?? {}).filter(
          (k) => k !== TUNING_MS_KEY && TUNING_RANGES[k],
        ),
      },
    })
  }

  ctx.tools.register({
    name: 'daily_summary',
    description:
      '每日总结的第一步与取数口：按运行时本地时间定出统计日、统计区间与抬头注记（04:00 日界，凌晨补记），' +
      '并只读扫描统计区间内各会话日志，返回候选素材清单与覆盖面计数。' +
      '当对方说「每日总结」「帮我每日总结一下」「来个每日总结」「今日总结」「每日回顾」「每日小结」等，' +
      '要现在就出一份今天的总结时，先调用本工具，再按返回的 rules 成文；' +
      '若只是在讨论这个功能的格式、开发或命名，不要调用。全程不索要日期。',
    parameters: {
      type: 'object',
      properties: {
        deliveredEvents: {
          type: 'integer',
          minimum: 0,
          description: '合并去重后可确认属于统计日的事件条数（模型成文前填）。不填时只返回判定结果，不生成声明文案。',
        },
        deliveredSessions: {
          type: 'integer',
          minimum: 0,
          description: '这些事件覆盖的会话个数。',
        },
        uncertainMaterial: {
          type: 'boolean',
          description: '是否有素材存在但其时间无法确认属于统计日；为真时按文案三声明「未纳入」。',
        },
        markDelivered: {
          type: 'boolean',
          description: '交付完成后置为真，记录本次统计日为「已完整交付」，供次日凌晨「切当天」例外与同日二次触发跳过判断使用。',
        },
        force: {
          type: 'boolean',
          description:
            '只在自动路径用得着：定时任务当天已交付过、又确实要重做时置为真。' +
            '手动触发本来就会重新生成，不需要它。默认 false。',
        },
        auto: {
          type: 'boolean',
          description:
            '由定时任务代调用时置为真：只补「刚结束的那一天」（昨天）的总结，昨天已交过就跳过，' +
            '绝不产出新一天的空白总结。手动触发不要传。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}

      // 唯一失败退出条件：运行时时间读不出。
      const now = readClock()
      if (Number.isNaN(now.getTime())) {
        return {
          ok: false,
          result: '无法确定统计区间：运行时时间读不出。时间只能算不能猜，因此不产出四段。',
        }
      }

      // 工具一被调用就说明这个会话在用每日总结：顺手把定时提醒建上（幂等）。
      // sessionId 只从 exec.agent 取——ctx 上读不到（见 scheduledSessions 注释）。
      const callerId = typeof exec === 'object' && exec && exec.agent ? exec.agent.id : undefined
      if (callerId && !boundSessionId) {
        boundSessionId = callerId
        ensureSchedule(ctx, config, callerId, scheduledSessions, settingsFile)
      }

      let state = await readState(stateFile)
      // 把本会话记成"每日总结的目标会话"：命令 handler 拿不到当前会话时，
      // 用它避免 "刚点了横栏，最新日志反而是自己" 的抖动。
      if (callerId && state.boundSessionId !== callerId) {
        state = { ...state, boundSessionId: callerId }
        await writeState(stateFile, state)
      }
      // 取数与分界的可调项：settings 优先、config 次之、代码默认兜底。
      // 每次执行都重读一次，保证设置页刚改的值立即生效，不必重启插件。
      let tuning = resolveTuning(config)
      // 归档开关：settings 优先、config 次之、默认包含。只影响读哪些会话。
      let includeArchived = config.includeArchived ?? DEFAULT_INCLUDE_ARCHIVED
      try {
        const settingsForTuning = await readSettings(settingsFile)
        tuning = resolveTuning(config, settingsForTuning.tuning)
        if (typeof settingsForTuning.includeArchived === 'boolean') {
          includeArchived = settingsForTuning.includeArchived
        }
      } catch {
        // 读不出设置就退回 config/默认值，不妨碍取数
      }
      const previous = latestCompletedDate(state)
      // 自动路径的目标日（2026-10-30 修正）：
      //
      // 「补昨天」原本是为了**关机错过、第二天开机才投递**这种情况，
      // 但它假设提醒总在 24:00 附近触发。用户把触发时间改到 23:50 之后，
      // 23:50 触发时的"昨天"是前天，而昨天（当天早些时候手动交过的那份）
      // 已在交付名单里 → 整轮 skipped，当天反而一份都没有。
      //
      // 判据改成「这次投递是不是迟到」：拿设置里的触发时刻和 now 比，
      // 超过 6 小时就是延迟投递（关机错过），目标日拉回昨天；
      // 否则按当前钟点正常算（23:50 → 今天；凌晨 → 补记）。
      // 延迟判定比"昨天交没交"更准：它区分得出"准点触发该总结今天"和
      // "迟到触发该补昨天"，而后者即使昨天已交付也不该产出今天的一份空摘要。
      const autoRun = input.auto === true
      let window
      if (autoRun) {
        const settingsForWindow = await readSettings(settingsFile)
        const clockText = normalizeClock(settingsForWindow.scheduleTime) ?? normalizeClock(config.scheduleTime) ?? DEFAULT_SCHEDULE_TIME
        const [hour, minute] = clockText.split(':').map(Number)
        const scheduled = new Date(now.getTime())
        scheduled.setHours(hour, minute, 0, 0)
        let deltaMs = now.getTime() - scheduled.getTime()
        if (deltaMs < 0) deltaMs += 24 * 60 * 60 * 1000
        const delayed = deltaMs > tuning.autoDelayGraceMs
        window = delayed ? catchUpWindow(addDays(now, -1)) : resolveWindow(now, previous, tuning.cutoverHour)
      } else {
        window = resolveWindow(now, previous, tuning.cutoverHour)
      }
      const headline = formatHeadline(window)

      // 分支判断（2026-10-24 修正）：
      //   **只有自动路径（定时任务）** 在当天已交付时跳过——它要避免的是"定时任务
      //   重复打扰"。手动触发是用户主动要的，永远重新取数成文，不该被 force 卡住。
      //   判定放在工具里而不是提醒词里：提醒到点时模型最容易做的动作就是"调工具"，
      //   让工具自己回答"已经交过了"，这个分支才不会被绕过。
      if (autoRun && alreadyDelivered(state, window.date) && input.force !== true) {
        return {
          ok: true,
          ready: true,
          skipped: true,
          reason: 'delivered-today',
          date: window.date,
          branch: window.branch,
          headline,
          message: T(
            `${window.date} 的每日总结已经交付过了（定时任务要补的就是这一天），本次不重复产出。`,
            `${window.date} already has a daily summary (the day the scheduler would fill in); nothing more to produce.`,
          ),
        }
      }

      let sources = null
      try {
        // 只认运行时 ctx.inject 接进来的通道；config 注入仅用于本地测试。
        const activeQuery = resolveQuery()
        if (!activeQuery) {
          sources = {
            error: '会话读取通道不可用（sessionQuery 未接入）：请改用上下文与历史检索取数，并如实降级。',
            sessions: [],
            sessionCount: 0,
          }
        } else {
          const callerId = typeof exec === 'object' && exec && exec.agent ? exec.agent.id : undefined
          sources = await collectSources(activeQuery, window, { ...tuning, includeArchived, archiveStateFile: config.archiveStateFile }, callerId)
        }
      } catch (error) {
        sources = { error: `取数失败：${error instanceof Error ? error.message : String(error)}`, sessions: [], sessionCount: 0 }
      }

      const eventCount = Number.isInteger(input.deliveredEvents) ? Math.max(0, input.deliveredEvents) : undefined
      const coveredSessions = Number.isInteger(input.deliveredSessions) ? Math.max(0, input.deliveredSessions) : 0
      const notice =
        eventCount === undefined
          ? undefined
          : buildNotice({
              eventCount,
              sessionCount: coveredSessions,
              hasUncertain: input.uncertainMaterial === true,
            })

      if (input.markDelivered === true) {
        state = recordDelivered(state, window.date, window.dayStart, callerId)
        await writeState(stateFile, state)
      }

      return {
        ok: true,
        ready: true,
        headline,
        nowLocal: `${formatDate(now)} ${formatClock(now)}`,
        window: {
          branch: window.branch,
          date: window.date,
          weekday: window.weekday,
          interval: window.interval,
          note: window.note,
          // 补记分支没有截至时刻。**不能写 `window.cutoff` 本身**：它会是 undefined，
          // 而框架要求工具返回值是无损 JSON —— 一个 undefined 就让整次调用失败
          // （2026-10-22 00:00 的定时任务就撞在这里：daily_summary 直接报
          // "value is not lossless JSON"，用户什么都没拿到）。
          cutoff: window.cutoff ?? null,
          fromIso: new Date(window.dayStart.getTime()).toISOString(),
          toIso: new Date(window.dayEnd.getTime()).toISOString(),
        },
        rules: {
          headline: '抬头第一行逐字照抄 headline；日期只在抬头出现一次，区间只写时刻；注记非空时末尾保留两个右括号。',
          branches:
            'branch=in-progress（白天，04:00–23:59）与 branch=in-progress-cutover（凌晨切当天）都写（进行中，截至 <cutoff>）；' +
            'branch=catch-up（凌晨补记）统计前一个自然日，只写（凌晨补记），不带截至时刻，这是正确形态。',
          notice: notice ?? null,
          noticeRule:
            notice === undefined
              ? '未提供 deliveredEvents，不生成声明；成文前用 deliveredEvents / deliveredSessions / uncertainMaterial 再调一次以获得逐字声明。阈值以上不给声明。'
              : '把 notice 逐字放在抬头下一行、独立一行、顶格、不加编号、不加 -，其后空一行再进第 1 段。',
          failure: '唯一失败退出条件：运行时时间读不出。检索为空、召回很少、来源名缺失、素材时间无法确认都不是失败，按降级声明处理。',
          sampling:
            '每个会话的素材由**全局字符预算**分配：charBudget（当前 ' +
            tuning.charBudget +
            ' 字符，0 表示关闭）先按各会话的原始字符量加权分给每个会话，' +
            '会话内再按类别切分额度（用户指令 40%、助手回复 25%、工具调用 15%、工具错误 12%、推理 8%），' +
            '并按类别做不同长度的截断（用户 ' +
            CLIP_BY_KIND.user +
            ' 字、工具调用 ' +
            CLIP_BY_KIND.toolCalls +
            ' 字、工具错误 ' +
            CLIP_BY_KIND.toolErrors +
            ' 字）；工具调用优先保留写/改类操作。' +
            'charBudget 为 0 时退回「每类最多 ' +
            tuning.maxEventsPerKind +
            ' 条」的旧规则。' +
            'sources.sessions[].coverage 里 raw* 是抽样前的真实条数、allocatedChars 是该会话分到的字符额度。' +
            'raw 远大于实际条数时，说明你只看到了一部分：照实写已看到的，不要在正文里声称覆盖了全天全部内容。' +
            'sources.archivedSkipped 大于 0 表示按设置排除了归档会话，属用户明确选择，正文不必解释。',
          noDateAsking: '不索要日期，不问今天是几号；日期只能来自 now。',
        },
        sources,
        sections: FIXED_TITLES,
        sectionRules: [
          '第 1、2、3 段每条以 - 起行，一事一条，每段真实事件 0 到 5 条；语料里没有这一方面时写 - 今天没有记录到这方面的事，那不是条目、不计条数、也不算空段。',
          '第 2 段两类都在时「充实：」「收获：」前缀都出现；只有一类时只出现对应的那一个前缀，不新开段。',
          '第 4 段不用 - 起行，直接写 1 到 3 句；没有可回看的思考时写 今天没有记录到可以回看的思考。',
          '段与段之间空一行；段标题顶格，标题行后不留空行直接接第一条。',
          '全文固定第一人称视角；正文任何一行都不出现 @、场景编号、引号包裹的主题词。',
          '语料默认不附出处；仅当对方明确指出某条与事实不符、或质疑某条不实、或要求核对出处时，才对被质疑的那一条附出处，其余条目不增不改；找不到依据就直说依据不足并建议删掉，禁止现造出处。',
          '只用纯文本：不带表格、围栏、强调符号、标题符号与 HTML。',
        ],
        selfCheckHint: '成文后调用 daily_summary_selfcheck，把成稿全文传进去，按 problems 逐条改到 ok 为真。',
      }
    },
  })

  ctx.tools.register({
    name: 'daily_summary_selfcheck',
    description:
      '每日总结的交付前自检：把已写好的四段纯文本成稿传进来，按 SKILL.md 的输出自检与禁止事项做确定性检查' +
      '（抬头与注记、四段标题逐字、禁用符号、来源标注、第一人称等），返回问题清单。只在成文后调用。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '完整的四段纯净文本成稿（含抬头与可能的说明行）。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const text = typeof input.text === 'string' ? input.text : ''
      const now = readClock()
      const state = await readState(stateFile)
      const previousCompleted = latestCompletedDate(state)
      // 自检的日界判定与取数一致：也走 settings 优先的三级回退。
      let selfTuning = resolveTuning(config)
      try {
        selfTuning = resolveTuning(config, (await readSettings(settingsFile)).tuning)
      } catch {
        // 读不出设置就退回 config/默认值
      }
      const window = resolveWindow(now, previousCompleted, selfTuning.cutoverHour)
      if (!text.trim()) {
        return { ok: false, problems: ['成稿为空'] }
      }
      // 自动产出补的是「刚结束的那一天」，而自检是几秒后单独调用的、只拿到 now。
      // 所以除了按 now 算出的窗口，也接受「昨天的凌晨补记形态」，
      // 否则关机后延迟到早上补发时，成稿会被自检判成抬头不符而卡死。
      const alternate = catchUpWindow(addDays(now, -1))
      const result = selfCheck(text, window, [alternate])
      const deliveredBy = typeof exec === 'object' && exec && exec.agent ? exec.agent.id : undefined
      // 记录时用**实际匹配到的**那份窗口，不能用 now 重算：
      // 早上补发昨天的总结，若按 now 记成今天，今天的自动产出就会被误跳过。
      const recorded = result.matchedWindow ?? window
      delete result.matchedWindow

      // 自检通过就记一次「已完整交付」：供次日凌晨「切当天」例外判断使用，
      // 同时把这一天写进 deliveredDates —— 定时任务据此不再重复产出；
      // 手动触发不看这个标记，想再要一份就直接重新生成。
      // 不依赖模型记得传 markDelivered —— 自动化路径下它不会传。
      if (result.ok) {
        await writeState(stateFile, recordDelivered(state, recorded.date, recorded.dayStart, deliveredBy))
        result.markedDelivered = true
        result.deliveredDate = recorded.date

        // 自动写进日志文件。写失败不能把自检结论翻成失败——
        // 成稿本身是合格的，只是落盘这一步没成，原因如实带回给调用方。
        try {
          const target = await resolveLogTarget({
            ctx,
            settingsFile,
            query: resolveQuery(),
            sessionId: deliveredBy,
          })
          if (target) {
            const settings = await readSettings(settingsFile)
            result.logFile = await writeDailyLog({
              file: target,
              date: recorded.date,
              text,
              overwrite: settings.logOverwrite === true,
            })
          } else {
            result.logFile = null
          }
        } catch (error) {
          result.logFile = { path: null, written: false, replaced: false, reason: describeError(error) }
        }
      }
      return result
    },
  })

  // 设置项也暴露成工具：和设置页走同一条 reconcileReminders，
  // 这样 agent 改的和用户在界面上改的是同一件事，不会出现两套逻辑各说各话。
  ctx.tools.register({
    name: 'daily_summary_settings',
    description:
      '每日总结的自动触发与取数设置：查看或修改「每天几点自动产出」「在哪条会话里触发」「产出后写进哪个日志文件」' +
      '以及取数/分界的可调参数。' +
      'action=get 返回当前设置（含 tuning 当前值、范围与默认值）、已存在的提醒和可选会话；' +
      'action=set_time 需要 time（HH:MM，写 24:00 表示次日 00:00）；' +
      'action=set_target 需要 targetSessionId（传 "auto" 恢复默认算法：在最近活跃的会话里触发）；' +
      'action=set_log 需要 logFile（相对目标会话目录的文件名或绝对路径；传 "auto" 回到自动探测）；' +
      'action=set_archived 传 includeArchived（true/false：是否把已归档会话纳入取数，默认 true）；' +
      'action=reset_tuning 传要被重置的可调键，把该键改回代码默认值（如 key=["snippetChars"]）。' +
      '取数/分界的可调项直接以对象参数传入（set_tuning）：snippetChars（单条截取字符数 20–2000）、' +
      'maxEventsPerKind（每类事件采样条数 1–200）、charBudget（全局字符预算 50000–2000000，0 关闭）、maxSessions（扫描会话数 1–5000）、' +
      'cutoverHour（日界钟点 0–23）、autoDelayGraceHours（迟到宽限小时 0.5–48）。' +
      '只改传入的项，缺省项保持原值。改时间会同步到所有会话的提醒，不会留下旧时间的重复提醒。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set_time', 'set_target', 'set_log', 'set_archived', 'set_tuning', 'reset_tuning'],
          description: '要做什么。',
        },
        tuning: {
          type: 'object',
          description:
            '仅 set_tuning 用：要调整的可调项对象。可用键：snippetChars / maxEventsPerKind / charBudget / maxSessions / cutoverHour / autoDelayGraceHours，' +
            '值为对方口语或数值，插件按范围校验（见 description）。只改传入的项。',
          additionalProperties: false,
        },
        key: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 reset_tuning 用：要恢复默认的可调键（数组）。',
        },
        includeArchived: {
          type: 'boolean',
          description:
            '仅 set_archived 用：是否把已归档会话纳入取数（true = 包含，false = 跳过）。默认 true。',
        },
        time: {
          type: 'string',
          description: 'HH:MM，例如 23:30；写 24:00 表示次日 00:00。',
        },
        targetSessionId: {
          type: 'string',
          description: '目标会话 id；传 "auto" 或空字符串表示恢复默认算法。',
        },
        logFile: {
          type: 'string',
          description:
            '自动写入的日志文件：相对目标会话目录的路径（如 日志.txt）或绝对路径；传 "auto" 表示自动探测。',
        },
        logOverwrite: {
          type: 'boolean',
          description:
            '同一天已有内容时是否整块替换。默认 false（保护手写内容）；手动重做并希望覆盖时置为 true。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const callerId = typeof exec === 'object' && exec && exec.agent ? exec.agent.id : undefined
      const action = typeof input.action === 'string' ? input.action : 'get'

      if (action === 'get') return describeSettings(callerId)

      const intent = {}
      if (action === 'set_time') {
        const normalized = normalizeClockInput(input.time)
        if (!normalized) {
          return { ok: false, error: `无法识别的时间：${String(input.time ?? '(空)')}。用 HH:MM，例如 23:30，或 24:00 表示次日 00:00` }
        }
        intent.scheduleTime = normalized
      } else if (action === 'set_target') {
        const value = typeof input.targetSessionId === 'string' ? input.targetSessionId.trim() : ''
        intent.targetSessionId = !value || value === 'auto' ? '' : value
      }

      // set_log 只动日志落盘，不碰提醒：没有时间/会话意图时不要走 reconcileReminders，
      // 否则一次"改文件名"可能顺带触发提醒的创建或迁移。
      if (action === 'set_log') {
        const value = typeof input.logFile === 'string' ? input.logFile.trim() : ''
        const overwrite = typeof input.logOverwrite === 'boolean' ? input.logOverwrite : undefined
        const saved = await applyLogSetting(settingsFile, !value || value === 'auto' ? '' : value, overwrite)
        const onlyLog = await describeSettings(callerId)
        return { ...onlyLog, ok: onlyLog.ok && saved !== false }
      }

      // set_archived：只动「是否包含已归档会话」这一项，不碰提醒。
      if (action === 'set_archived') {
        const saved = await applyArchivedSetting(settingsFile, input.includeArchived === true)
        const onlyArchived = await describeSettings(callerId)
        return { ...onlyArchived, ok: onlyArchived.ok && saved !== false }
      }

      // set_tuning：只动取数/分界可调项，不碰提醒。传入的为对象 { 键: 值 }。
      // 校验通过的合并进 settings.tuning，越界/非法的列进 errors。
      if (action === 'set_tuning') {
        const rawTuning = typeof input.tuning === 'object' && input.tuning !== null && !Array.isArray(input.tuning) ? input.tuning : {}
        const { tuning: adjustment, errors } = buildTuningAdjustment(rawTuning, TUNING_RANGES)
        await applyTuningSetting(settingsFile, adjustment)
        const payload = await describeSettings(callerId)
        const changedKeys = Object.keys(adjustment)
        return {
          ...payload,
          ok: payload.ok,
          changed: changedKeys,
          errors,
          message:
            changedKeys.length === 0
              ? T(
                  '没有可用的可调项被改动（检查传入的键名与取值范围）。',
                  'No tunable value was changed — check the keys and ranges.',
                )
              : T(`已更新：${changedKeys.join(', ')}。`, `Updated: ${changedKeys.join(', ')}.`),
        }
      }

      // reset_tuning：把指定的键恢复成代码默认值（从 settings.tuning 分区里移除）。
      if (action === 'reset_tuning') {
        const keys = Array.isArray(input.key) ? input.key.filter((k) => typeof k === 'string') : []
        const validKeys = keys.filter((k) => TUNING_RANGES[k])
        let removed = []
        if (validKeys.length > 0) {
          const current = await readState(settingsFile)
          const prevTuning = current[TUNING_KEY]
          const base =
            typeof prevTuning === 'object' && prevTuning !== null && !Array.isArray(prevTuning) ? prevTuning : {}
          const next = { ...base }
          for (const k of validKeys) {
            if (k in next) {
              delete next[k]
              removed.push(k)
            }
          }
          // autoDelayGraceHours 与 autoDelayGraceMs 联动：重置小时键兼清毫秒镜像。
          if (validKeys.includes('autoDelayGraceHours') && TUNING_MS_KEY in next) {
            delete next[TUNING_MS_KEY]
            if (!removed.includes('autoDelayGraceHours')) removed.push('autoDelayGraceHours')
          }
          await writeState(settingsFile, { ...current, [TUNING_KEY]: next })
        }
        const payload = await describeSettings(callerId)
        const unknown = keys.filter((k) => !TUNING_RANGES[k])
        return {
          ...payload,
          ok: payload.ok,
          reset: removed,
          ignored: unknown,
          message:
            removed.length === 0
              ? T(
                  '没有可用的项被重置（键名无效，或在设置里本就用的是默认值）。',
                  'Nothing was reset — invalid keys, or those values were already at defaults.',
                )
              : T(`已恢复默认：${removed.join(', ')}。`, `Reset to default: ${removed.join(', ')}.`),
        }
      }

      const report = await reconcileReminders(ctx, config, settingsFile, intent, callerId)
      const payload = await describeSettings(callerId)
      return { ...payload, ok: payload.ok && report.ok !== false, report }
    },
  })

  // 定时提醒不在这里建：apply 阶段拿不到 sessionId（ctx.sessionId 要求 agent
  // 装配作用域）。改为在 daily_summary 第一次被调用时，从 exec.agent.id 取到再建。

  // 侧边栏横栏的点击落到这条命令上：Client 没有「发消息」的 API，
  // 但可以先 `ctx.remote.commands.execute(sessionId, '/daily-summary')`，由这里的
  // handler 在 Host 侧唤醒该会话的 agent。这就是官方 user-actions 推荐的
  // 「一个操作，两个调用方」：UI 与 agent 各自走同一条命令。
  //
  // 命令名必须是 ASCII：框架的 COMMAND_NAME 是 /^[a-z][a-z0-9_-]*$/u，
  // 用中文名会在 register 处抛 TypeError（且解析器也认不出 /每日总结）。
  ctx.inject(['commands'], (commandCtx) => {
    try {
      commandCtx.commands.register({
        name: COMMAND_NAME,
        description: T(
          '生成今天的每日总结（四段式纯文本，取数→成文→自检一次走完）',
          'Generate today’s daily summary (collect → write → self-check in one pass)',
        ),
        handler: async ({ agent }) => {
          // 有日志落盘目标时，把"插件会自己写"写进引导语。
          // 不写的话模型不知道这件事，10-29 就手动用 edit 又写了一遍文件。
          let logHint = ''
          try {
            const target = await resolveLogTarget({
              ctx,
              settingsFile,
              query: resolveQuery(),
              sessionId: typeof agent?.id === 'string' ? agent.id : undefined,
            })
            if (target) {
              logHint = T(
                ` 自检通过后插件会自动把四段内容写进 ${target}，你不需要再用任何工具写文件，也不要重复写。`,
                ` After the self-check passes the plugin writes the four sections into ${target} automatically — do not write or edit any file yourself.`,
              )
            }
          } catch {
            // 解析不出目标就不提这件事，不影响出总结
          }
          const prompt =
            T(
              '请现在产出一份每日总结：先调用 daily_summary 取数定界，' +
                '再按它返回的 rules 成文，然后用 daily_summary_selfcheck 自检到 ok，' +
                '最后把四段纯文本直接交付给我。',
              'Produce today’s daily summary now: call daily_summary first to collect and bound the data, ' +
                'then write it following the rules it returns, run daily_summary_selfcheck until it is ok, ' +
                'and finally hand me the four plain-text sections directly.',
            ) + logHint
          try {
            // agent.followup(message) 只接受**一条完整消息对象**，不是内容块数组。
            // 传 [{type:'text',...}] 会一路被原样记录：inbox.splice 把一个裸内容块数组
            // 当作「一条消息」压进队列，随后日志里落成
            //   agent/inbox/spliced ... "inserted":[[{...}]]
            // （多包了一层数组）。读回时 V4 校验 `agent/inbox/spliced requires
            // message objects` 失败，整个会话变成 `stored log is corrupt` —— 2026-10-20
            // 本机 session-667bc3e2 就是这么坏掉的，只能逐帧改写日志才救回来。
            // 所以这里必须**先验形再投递**，绝不能把裸数组交给 agent。

            // 2026-10-20 第二次踩坑：这个安装包**不向 profile 暴露 @deepseek-ai/dsh-llm**
            // （asar 里只有宿主自用的副本），插件里 `import('@deepseek-ai/dsh-llm')`
            // 必然 ERR_MODULE_NOT_FOUND，createUserMessage 永远拿不到。所以改为
            // **自己构造** V4 合规的消息对象（见 buildUserMessage），不再依赖任何宿主包。
            const message = buildUserMessage(prompt, config.createUserMessage)
            if (!isDeliverableUserMessage(message)) {
              ctx.logger?.warn?.('daily-summary: 命令无法投递：消息形状不合格')
              return {
                kind: 'error',
                text: T(
                  '无法构造会话消息（形状不合格），请直接在对话里说「每日总结」',
                  'Could not build a valid session message; say “daily summary” in the conversation instead.',
                ),
              }
            }

            // 投递目标：命令 handler 拿不到"当前会话"（没有文档化的全局会话定位入口），
            // 只有宿主传进来的 agent 能直接投递。拿不到就按"最近活跃会话"定位。
            //
            // **设置里的目标会话优先**（2026-10-23 修）：之前这里只看 agent 和
            // "最近活跃会话"，把用户在设置页选定的 targetSessionId 当不存在——
            // 于是在别的会话点横栏，总结就落在那个"最近的"会话里，设置形同虚设。
            //
            // 目标会话没在运行时的处理（2026-10-24 改）：不再直接报错，改为用
            // `agents.resume` 把它唤醒——插件代为"打开"这条会话、投递、并在卸载时释放。
            // 不能沉默地改投当前会话，那正是用户抱怨的行为。
            const settings = await readSettings(settingsFile)
            const pinnedId = settings.targetSessionId
            const recovered = Boolean(agent && typeof agent.followup === 'function')
            const targets = []
            let resumedPinned = false
            if (pinnedId) {
              const acquired = await acquireTargetAgent(ctx, ownedAgents, pinnedId, {
                query: resolveQuery(),
                // 目标会话读不到模型时，退而用当前触发会话的模型
                fallbackSessionId: typeof agent?.id === 'string' ? agent.id : undefined,
              })
              if (acquired.agent && typeof acquired.agent.followup === 'function') {
                targets.push(acquired.agent)
                resumedPinned = acquired.resumed
              } else {
                return {
                  kind: 'error',
                  text: acquired.error
                    ? T(
                        `每日总结固定在会话 ${pinnedId.slice(0, 12)}，但没能唤醒它：${acquired.error}`,
                        `The daily summary is pinned to session ${pinnedId.slice(0, 12)}, but waking it failed: ${acquired.error}`,
                      )
                    : T(
                        `每日总结固定在会话 ${pinnedId.slice(0, 12)}，但拿不到可投递的句柄。请打开那条会话再触发，或等定时任务自动执行。`,
                        `The daily summary is pinned to session ${pinnedId.slice(0, 12)}, but no deliverable handle was available. Open that session and trigger again, or wait for the scheduled run.`,
                      ),
                }
              }
            } else if (recovered) {
              targets.push(agent)
            }
            if (targets.length === 0) {
              const located = await locateRecentSession({ stateFile, root: config.sessionsRoot })
              if (!located) {
                return {
                  kind: 'error',
                  text: T(
                    '找不到可投递的会话：请先在任意会话里发一条消息，或直接在对话里说「每日总结」。',
                    'No session to deliver to: send one message in any session, or say “daily summary” in the conversation.',
                  ),
                }
              }
              targets.push(located)
            }

            // 分支：如果定位到的会话已经是"今天交过总结的那个"，而它又没有活 agent，
            // 就不能投过去（投过去也是失败），直接告诉对方今天已经交过了。
            const target = targets[0]
            // "重新投递到指定会话"时不算 recovered：目标不是当前会话，
            // 也不能顺手把当前会话绑定成目标。
            const deliveredToPinned = Boolean(pinnedId)
            if (!recovered && !deliveredToPinned && target.deliveredToday) {
              return {
                kind: 'success',
                text: T(
                  `今天（${target.date}）的每日总结已经交付过了，本次触发直接跳过。`,
                  `Today's (${target.date}) daily summary was already delivered — skipping this trigger.`,
                ),
              }
            }

            target.followup(message)
            // 走到这里说明真的投递出去了。如果是兜底定位、且之前没有绑定会话，
            // 就把这个会话记成目标会话：本进程里第一次从宿主拿到 agent 的调用，
            // 就是最真实的"当前会话"。
            if (!recovered && target.upgraded) {
              try {
                const latest = await readState(stateFile)
                if (!latest.boundSessionId) {
                  await writeState(stateFile, { ...latest, boundSessionId: target.id })
                }
              } catch {
                // 绑定失败只影响下次定位的先后顺序，不影响这次已投递的请求
              }
            }
            return {
              kind: 'success',
              text: resumedPinned
                ? T(
                    `固定的会话 ${target.id.slice(0, 12)} 当时没在运行，已唤醒它并投递，正在那里生成…`,
                    `The pinned session ${target.id.slice(0, 12)} was not running — woke it and delivered; generating there…`,
                  )
                : deliveredToPinned
                  ? T(
                      `已送进固定的会话 ${target.id.slice(0, 12)}，正在那里生成…`,
                      `Sent to the pinned session ${target.id.slice(0, 12)} — generating there…`,
                    )
                  : recovered
                    ? T(
                        '已在本会话里生成每日总结…',
                        'Generating the daily summary in this session…',
                      )
                    : T(
                        `已唤醒最近的会话 ${target.id}，正在那里生成…`,
                        `Woke the most recent session (${target.id}) — generating there…`,
                      ),
            }
          } catch (error) {
            return { kind: 'error', text: T('唤醒会话失败：', 'Could not wake the session: ') + String(error?.message ?? error) }
          }
        },
      })

      // 设置页 / agent 共用的读写入口。rawInput 为空表示"读取"，否则是 `time HH:MM`
      // 或 `target <sessionId|auto>`。返回 JSON 字符串：设置页负责渲染，命令本身不管文案。
      commandCtx.commands.register({
        name: SETTINGS_COMMAND_NAME,
        description: T(
          '读取或修改每日总结的触发时间与触发会话（供设置页与 agent 调用）',
          'Read or change the daily summary schedule: trigger time and target session',
        ),
        handler: async ({ agent, rawInput }) => {
          const callerId = agent && typeof agent.id === 'string' ? agent.id : undefined
          const line = typeof rawInput === 'string' ? rawInput.trim() : ''
          const intent = {}
          let mutation = false
          let logIntent
          let archivedIntent

          if (line) {
            const space = line.search(/\s/)
            const verb = space === -1 ? line : line.slice(0, space)
            const value = space === -1 ? '' : line.slice(space + 1).trim()
            if (verb === 'time') {
              const normalized = normalizeClockInput(value)
              if (!normalized) {
                return {
                  kind: 'error',
                  text: `无法识别的时间：${value || '(空)'}。用 HH:MM，例如 23:30，或 24:00 表示次日 00:00`,
                }
              }
              intent.scheduleTime = normalized
              mutation = true
            } else if (verb === 'target') {
              intent.targetSessionId = !value || value === 'auto' ? '' : value
              mutation = true
            } else if (verb === 'log') {
              // `log 日志.txt` 指定文件名（相对目标会话目录，或绝对路径）；
              // `log auto` / 空值 = 回到自动探测
              logIntent = !value || value === 'auto' ? '' : value
              mutation = true
            } else if (verb === 'archived') {
              // `archived on|off`：是否把已归档会话纳入取数（默认 on）
              archivedIntent = !(value === 'off' || value === 'false' || value === '0')
              mutation = true
            } else if (verb === 'tuning') {
              // `tuning <key> <value>` 设置单个可调项；`tuning <key> default` 恢复默认；
              // `tuning`（无子参数）不写，仅返回当前值。
              const valueSpace = value.search(/\s/)
              const key = valueSpace === -1 ? value : value.slice(0, valueSpace)
              const valArg = valueSpace === -1 ? '' : value.slice(valueSpace + 1).trim()
              if (!key) {
                return { kind: 'success', text: JSON.stringify(await describeSettings(callerId)) }
              }
              if (!TUNING_RANGES[key]) {
                return {
                  kind: 'error',
                  text: `未知可调项：${key}（支持 ${Object.keys(TUNING_RANGES).join(' / ')}）`,
                }
              }
              if (!valArg || valArg === 'default') {
                // 恢复默认：把该键从 settings.tuning 分区里移除
                const current = await readState(settingsFile)
                const prevTuning = current[TUNING_KEY]
                const base = typeof prevTuning === 'object' && prevTuning !== null && !Array.isArray(prevTuning) ? prevTuning : {}
                const next = { ...base }
                delete next[key]
                if (key === 'autoDelayGraceHours') delete next[TUNING_MS_KEY]
                await writeState(settingsFile, { ...current, [TUNING_KEY]: next })
                const payload = await describeSettings(callerId)
                return { kind: 'success', text: JSON.stringify({ ...payload, ok: payload.ok, reset: [key] }) }
              }
              const sanitized = sanitizeTuningField(key, valArg)
              if (sanitized === undefined) {
                const r = TUNING_RANGES[key]
                return {
                  kind: 'error',
                  text: `${key} 的值越界或不合法：${valArg}（合法范围 ${r.min}–${r.max}）`,
                }
              }
              await applyTuningSetting(settingsFile, { [key]: sanitized })
              const payload = await describeSettings(callerId)
              return {
                kind: 'success',
                text: JSON.stringify({ ...payload, ok: payload.ok, changed: [key] }),
              }
            } else {
              return { kind: 'error', text: `未知指令：${verb}（支持 time / target / log / archived / tuning）` }
            }
          }

          // 只改日志文件时不要走 reconcileReminders：那会顺带创建/迁移提醒。
          const hasReminderIntent = Object.keys(intent).length > 0
          const report = hasReminderIntent
            ? await reconcileReminders(ctx, config, settingsFile, intent, callerId)
            : { ok: true }
          if (logIntent !== undefined) await applyLogSetting(settingsFile, logIntent)
          if (archivedIntent !== undefined) await applyArchivedSetting(settingsFile, archivedIntent)
          const payload = await describeSettings(callerId)
          return {
            kind: 'success',
            text: JSON.stringify({ ...payload, ok: payload.ok && report.ok !== false, report }),
          }
        },
      })

      // 注册后立即自检：注册失败时 inject 回调里的异常会被框架吞掉，
      // 只有主动回查目录才能发现「命令其实没生效」。
      try {
        const listed = commandCtx.commands.list?.(commandCtx.agent ?? null)
        if (Array.isArray(listed)) {
          const found = listed.some((c) => c && c.name === COMMAND_NAME)
          if (!found) ctx.logger?.warn?.(`daily-summary: 命令 ${COMMAND_NAME} 注册后不可见`)
        }
      } catch {
        // list 需要 agent，拿不到时跳过自检（不影响注册本身）
      }
    } catch (error) {
      // 注册失败不能让插件静默失效：把原因写进日志，便于排查
      ctx.logger?.warn?.(`daily-summary: 命令注册失败：${error?.message ?? error}`)
    }
  })
}

/**
 * 构造一条合规的 UserMessage —— **完全自建，不依赖任何 @deepseek-ai 包**。
 *
 * 为什么自己写而不是用 `@deepseek-ai/dsh-llm` 的 `createUserMessage`：
 *   这个安装包把 dsh-llm 只放在 asar 里给宿主自己用，profile 的 node_modules
 *   里**没有** @deepseek-ai/dsh-llm，插件里的 `import('@deepseek-ai/dsh-llm')`
 *   必然 ERR_MODULE_NOT_FOUND（2026-10-20 实测），createUserMessage 永远拿不到。
 *
 * 也不需要那个包：`createUserMessage` 本身只做两件事——补 `role: "user"`、
 * 补一个随机 `id`，再做一次 structuredClone + 深冻结。这三步这里等价实现，
 * 因此产物与用官方函数构造的消息在 V4 日志里完全同形。
 *
 * `agent.followup(message)` 接受的是**完整消息对象**，不是内容块数组。传错形状
 * 不会当场报错：inbox 会把它当成一条消息照收，最后写成畸形的
 * `agent/inbox/spliced`（inserted 多包一层数组，且消息缺 source），把整条会话
 * 读坏——2026-10-20 本机 session-667bc3e2 就是这么坏掉的。
 *
 * config.createUserMessage 仅供本地测试注入。
 */
function buildUserMessage(text, injected) {
  if (typeof injected === 'function') {
    try {
      return injected({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    } catch {
      return undefined
    }
  }
  if (typeof text !== 'string' || text.length === 0) return undefined
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    // V4 会话格式要求每条消息都带生产者声明的 source.kind（'user' 即人类输入）。
    source: { kind: 'user' },
  }
  // 与官方 createUserMessage 一致：脱离调用方的引用并冻结，避免投递后被改写。
  return deepFreeze(JSON.parse(JSON.stringify(message)))
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 按「最近活跃会话」定位投递目标（命令 handler 拿不到"当前会话"时用）。
 *
 * 依据：会话日志落在 `<sessionsRoot>/<cwd 编码>--/session-<uuid>/session.v4.jsonl.zstd`，
 * 日志的 mtime 就是该会话最后一次写入的时间。
 *
 * 选择优先级（分支结构的关键）：
 *   1. 状态文件里的 `boundSessionId` —— 每日总结所在的那个会话，仍活着就首选；
 *   2. `deliveredTodaySessionId` —— 今天已经交付的那份总结所在的会话。它没有活 agent
 *      时不能投递，但调用方要据此走"今天已交过，跳过"分支；
 *   3. 日志 mtime 最新的会话。它没有活 agent 时**顺手升级为绑定会话**（本进程里
 *      第一次从宿主拿到 agent 的那次调用，就是最真实的"当前会话"），下次不走这条兜底。
 *
 * 只读：不创建、不改写任何会话文件。schema 变了就返回 undefined，由调用方如实报错。
 */
async function locateRecentSession({ stateFile, root }) {
  const sessionsRoot = typeof root === 'string' && root ? root : DEFAULT_SESSIONS_ROOT
  const state = await readState(stateFile)
  const bound = typeof state.boundSessionId === 'string' ? state.boundSessionId : undefined
  const deliveredTodayId = typeof state.deliveredTodaySessionId === 'string' ? state.deliveredTodaySessionId : undefined
  const deliveredTodayDate = typeof state.deliveredTodayDate === 'string' ? state.deliveredTodayDate : undefined

  const groups = await listSessionGroups(sessionsRoot)
  if (groups.length === 0) return undefined

  const makeTarget = (chosen, extra) => ({
    id: chosen.id,
    date: deliveredTodayDate,
    deliveredToday: extra.deliveredToday === true,
    // 没有宿主 agent 引用就无法唤醒：如实抛错，让 handler 返回可见的失败原因。
    followup: () => {
      if (extra.deliveredToday) {
        throw new Error(
          T(
            `今天已经交付过每日总结（会话 ${chosen.id}），跳过`,
            `Today's summary was already delivered (session ${chosen.id}); skipping`,
          ),
        )
      }
      if (extra.upgraded) {
        throw new Error(
          T(
            `已把 ${chosen.id} 记为目标会话，但它当前没有可唤醒的 agent。请在这个会话里打开后重试。`,
            `Bound ${chosen.id} as the target session, but it has no live agent right now. Open it and retry.`,
          ),
        )
      }
      throw new Error(
        T(
          `最近活跃的会话 ${chosen.id} 没有可唤醒的 agent（它没有在界面里打开），请在那个会话里说「每日总结」`,
          `the most recent session ${chosen.id} has no live agent (it is not open in the UI); say "daily summary" in that session instead`,
        ),
      )
    },
    // 调用方用它判断"要不要顺手绑定"
    upgraded: extra.upgraded === true,
  })

  if (bound) {
    const hit = groups.find((g) => g.id === bound)
    if (hit) return makeTarget(hit, {})
  }

  if (deliveredTodayId) {
    const hit = groups.find((g) => g.id === deliveredTodayId)
    if (hit) return makeTarget(hit, { deliveredToday: true })
  }

  groups.sort((a, b) => b.mtime - a.mtime)
  const newest = groups[0]
  return makeTarget(newest, { upgraded: !bound })
}

/** 列出会话日志目录，按日志 mtime 给会话排序（`sessionsRoot/<组>/session-<id>/session.v4.jsonl.zstd`）。 */
async function listSessionGroups(sessionsRoot) {
  const found = []
  let dirs
  try {
    dirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const groupDir = path.join(sessionsRoot, dir.name)
    let sessions
    try {
      sessions = await readdir(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue
      try {
        const info = await stat(path.join(groupDir, session.name, 'session.v4.jsonl.zstd'))
        found.push({ id: session.name, mtime: info.mtimeMs })
      } catch {
        continue
      }
    }
  }
  return found
}

/**
 * 投递前的最后一道形状校验：必须是**对象**、role 为 'user'、
 * content 是内容块数组、source.kind 是非空字符串。
 *
 * 数组（哪怕里面是合法的内容块）也直接判否 —— 这是把畸形消息挡在
 * inbox 外面、避免再写坏一条会话日志的唯一关口。
 */
function isDeliverableUserMessage(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false
  if (message.role !== 'user') return false
  if (!Array.isArray(message.content) || message.content.length === 0) return false
  const source = message.source
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return false
  return typeof source.kind === 'string' && source.kind.length > 0
}

/**
 * 定时自动化：到点自动唤醒当前会话，让模型自己走一遍取数 → 成文 → 自检。
 *
 * 用 `ctx.schedule.create()` 而不是插件自己的 timer：定时任务由框架托管，到点会
 * 唤醒 Session 的 agent（`agent.inject()` 不会唤醒，只能等下一次输入），且跨重启有效。
 *
 * 幂等三层：
 *   1. inFlight——挡住「上一次 create 还没完成就又来一次」的同步竞态；
 *   2. seen——挡住同一进程内已发起过创建的重复；
 *   3. schedule.list()——挡住跨重启后的重复。
 * 只靠 list() 有竞态：连续调用时上一次的 create 尚未落盘。
 *
 * @param sessionId 调用方会话。只从 exec.agent.id 取——ctx.sessionId 在插件
 *   apply 阶段读不到（要求 agent 装配作用域）。
 */
function ensureSchedule(ctx, config, sessionId, seen, settingsFile) {
  if (config.autoSchedule === false) return
  if (!sessionId) return
  const schedule = ctx.get('schedule')
  if (!schedule || typeof schedule.create !== 'function') return

  const fallbackTime = typeof config.scheduleTime === 'string' ? config.scheduleTime : DEFAULT_SCHEDULE_TIME
  const zone = typeof config.scheduleTimeZone === 'string' ? config.scheduleTimeZone : DEFAULT_SCHEDULE_TZ
  const title = SCHEDULE_TITLE
  if (seen.has(sessionId) || inFlight.has(sessionId)) return
  inFlight.add(sessionId)

  const done = () => {
    inFlight.delete(sessionId)
    seen.add(sessionId)
  }

  // 设置文件优先于 config 默认值：用户在设置页选的时间/会话才是他真正要的。
  Promise.resolve(settingsFile ? readSettings(settingsFile) : {})
    .catch(() => ({}))
    .then((settings) => {
      const time = normalizeClock(settings.scheduleTime) ?? fallbackTime
      const target = settings.targetSessionId
      // 指定了别的会话：提醒归那条会话，这里**不能再建一条**，
      // 否则每次换会话对话都会多出一条重复提醒。
      if (target && target !== sessionId) {
        done()
        return undefined
      }
      return Promise.resolve(schedule.list({ sessionId }))
        .then((existing) => {
          const current = Array.isArray(existing) ? existing.find((r) => r && r.title === title) : undefined
          if (current) {
            // 已存在就**不重建**，但要让它可以被迁移：
            // 幂等判断只认标题，若不显式迁移，改了 scheduleTime 之后老记录会永远停在旧时间
            // （2026-10-21 就踩了这个坑：默认值改了，磁盘上那条仍然每天 23:00 触发）。
            const drift = reminderDrift(current, time, zone, SCHEDULE_PROMPT)
            if (!drift || typeof schedule.update !== 'function') return undefined
            return Promise.resolve()
              .then(() => schedule.update({ sessionId, id: current.id, expected: current, ...drift }))
              .catch((error) => {
                ctx.logger?.warn?.(`daily-summary: 提醒迁移失败（保持原记录）：${error?.message ?? error}`)
              })
          }
          return schedule
            .create(sessionId, { title, prompt: SCHEDULE_PROMPT, daily: { time, time_zone: zone } })
            .catch((error) => {
              ctx.logger?.warn?.(`daily-summary: schedule 创建失败：${error?.message ?? error}`)
            })
        })
        .finally(done)
    })
    .catch((error) => {
      done()
      ctx.logger?.warn?.(`daily-summary: schedule 查询失败：${error?.message ?? error}`)
    })
}

/** 把 `23:00`、`23:00:00`、`23:00:00.000` 归一成 `HH:mm:ss`，避免格式差异被当成漂移。 */
function normalizeClock(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?$/.exec(text)
  if (!match) return undefined
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}:${match[3] ?? '00'}`
}

/**
 * 已有提醒与配置之间的差异：只列出真正要改的字段，没有差异返回 undefined。
 * 提醒词变了也要迁移 —— 否则安了新代码、磁盘上仍是旧指令。
 */
function reminderDrift(record, time, zone, prompt) {
  const drift = {}
  const sameClock = record.kind === 'daily' && normalizeClock(record.time) === normalizeClock(time)
  if (!sameClock || record.timeZone !== zone) {
    drift.change = { kind: 'daily', daily: { time, time_zone: zone } }
  }
  if (typeof prompt === 'string' && record.prompt !== prompt) drift.prompt = prompt
  return Object.keys(drift).length > 0 ? drift : undefined
}

/** 正在创建定时提醒的 sessionId，防止同步连续 apply 时的竞态。 */
const inFlight = new Set()
