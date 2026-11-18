# 每日总结（Daily Summary）· DSH 插件

当前版本 **1.9.1**（设置页底部显示的就是它）。版本号只有 `package.json` 一处真相，
`index.js` 用 `createRequire` 读回来，不另写一份。

以 [`docs/SKILL.md`](docs/SKILL.md)（终版，QA 10/10 通过）为唯一基准，
把一个「全靠模型自觉遵守规则」的技能草稿，落成带确定性兜底的常驻 DSH 插件。

三个组成部分：

| 部分 | 文件 | 说明 |
|---|---|---|
| Host 工具 | `index.js` | `daily_summary`（取数/定界/降级声明）+ `daily_summary_selfcheck`（成稿自检）+ `daily_summary_settings`（触发设置）+ 定时自动化 |
| Client 界面 | `client.js` | 侧边栏底部（账户入口上方）的「每日总结」横栏 + 设置里的一页 |
| 状态持久化 | `~/.dsh/daily-summary/state.json` | 凌晨「切当天」例外 + 一天只交一份的分支判断依据，自检通过时自动写入 |
| 设置持久化 | `~/.dsh/daily-summary/settings.json` | 触发时间（`scheduleTime`）、固定会话（`targetSessionId`）、日志落盘（`logFile`/`logOverwrite`）与取数可调项（`tuning`），设置页/工具/定时共用 |

### 版本历史

| 版本 | 变更 |
|---|---|
| 1.0.0 | 首个可安装版：两工具、横栏、按日界只交一份、定时提醒 |
| 1.1.0 | 设置里新增「每日总结」页：自定义触发时间、统一所有会话的提醒、指定触发会话 |
| 1.2.0 | 下拉框列出全部工作区的会话并按工作区分组；无标题会话不再进选取界面；设置页显示版本号 |
| 1.2.1 | 修投递目标：命令投递此前完全忽略 `targetSessionId`，在别的会话触发会落到"最近活跃会话"。现在固定会话优先（经 `ctx.agents.get` 拿活 agent），不可达时如实报错而不是改投 |
| 1.2.2 | 固定会话没在运行时用 `agents.resume` 唤醒后投递（不再硬报错）；唤起的 agent 由插件持有，卸载时统一释放 |
| 1.2.3 | 修唤醒时缺模型：`resume` 现在带上会话最后一次 `model/selection`（缺了它 persona 装配时 `{{model}}` 无值，整轮直接失败）。读不到模型就不硬唤醒，改为明确报错 |
| 1.2.4 | 修正跳过语义：`skipped` 只对定时路径（`auto`）生效；手动触发当天再要一份会重新生成，不再需要 `force=true` |
| 1.3.0 | 自检通过后自动写入日志文件（在目标会话目录里探测 `日志.txt` 等），同一天默认不覆盖 |
| 1.3.1 | 修两处实测问题：①触发时间改到晚上后 `auto` 仍固定补昨天 → 整轮 `skipped`、当天没总结；改为按「距预定时刻是否迟到」判定。②`logFile` 填目录时把目录当文件写、报 `EISDIR` 被跳过；现在会退化成"在该目录里找日志文件" |
| 1.3.2 | 引导语与定时提醒词补上「插件会自动写入，别自己动手」：模型不知道这件事时会用 `edit` 再写一遍造成重复。命令投递的引导语还会带出具体目标文件路径 |
| 1.4.0 | 修素材不完整：每类事件原来只取**最后** N 条（默认 8），当天 133 条用户消息只进来 8 条、上午中午全丢；改为**全天均匀抽样**并把默认上限提到 16，同时用 `coverage.raw*` 如实报出抽样前的真实条数 |
| 1.4.1 | 采样上限默认值 16 → 24（五类素材都走全天均匀抽样，只调密度） |
| 1.5.0 | 取数与分界做成可调项：`snippetChars` / `maxEventsPerKind` / `maxSessions` / `cutoverHour` / `autoDelayGraceHours` 都能在设置页、`/daily-summary-settings` 命令和 `daily_summary_settings` 工具里改，持久化到 `settings.json` 的 `tuning` 分区（三级回退：settings > config > 代码默认） |
| 1.5.1 | 侧边栏横栏改为内容自适应宽度，不再撑满整条侧栏 |
| 1.6.0 | 取数改为**全局字符预算**（`charBudget`，默认 40 万字符）：按各会话原始字符量加权分配，每会话保底 40%、单会话封顶 25%；会话内按类别分层截断（用户 800 字、工具错误 400 字、助手 400 字、推理 300 字、工具调用 160 字），工具调用优先保留写/改类操作。`charBudget` 设为 0 退回「每类固定条数」的旧规则 |
| 1.6.1 | 修 `daily_summary_settings` 返回体含 `undefined` 导致 DSH 报「not lossless JSON」：返回前统一清洗（命令路径此前被 `JSON.stringify` 掩盖，所以只有工具调用会失败） |
| 1.7.0 | 新增「包含已归档会话」开关（默认开）：DSH 的归档只写 `workspace.json` 的 `archivedSessionIds`、日志不删，所以默认照样取数；关掉后取数与设置页候选都跳过归档会话。设置页、`archived on/off` 命令、工具 `action=set_archived` 三处同源 |
| 1.8.0 | 第 4 段「今日份思考」不再只写一句：思考素材占比 8% → 15%；新增 `sources.thinkingHints`（按因果/结论密度排序的 3–5 条候选）；规则改为「2 到 3 句、每句一个独立的点」；`daily_summary_selfcheck` 新增 `thinkingAvailable`，素材充足时只写一句会被判不合格 |
| 1.8.1 | 第 4 段改为「每个思考点单独一行」：2–3 行、每行一句、行间不空行，比连成一段更好扫读；自检同步拦住第 4 段用 - 起行 |
| 1.8.2 | 修两处自检与文案的缺陷：①第 4 段行数统计从「数句号」改为「数非空行」，否则三行都不带句号会被误判成 0 行；②采样文案里的配额百分比改为运行时从 `KIND_SHARE` 拼装，不再手写（此前写死「推理 8%」，实际已是 15%） |
| 1.9.0 | 用户消息只收真人输入与压缩摘要：实测某会话 730 条 `user/message` 里真人才 193 条（26%），其余都是 time-feeling / time-context / runtime-context / schedule / plugin:* 等插件注入的模板。改为按 `source.kind` 白名单（`user` + `compact-checkpoint`）过滤，`undefined` 仍放行以兼容老日志 |
| 1.9.1 | 第 4 段规则收敛成单一真相：`FOURTH_SECTION_RULE` + 上下界常量，`sectionRules`、`selfCheckHint`、参数描述、自检提示全从它派生；行数区间也由上下界拼出，改数字只改两行。`docs/SKILL.md` 不做生成，改用测试断言关键片段一致（防止文档漂移） |

## 自动化：定时任务一天只交一份（分支结构）

规则：**定时任务只在目标日还没有总结时产出；手动触发不受这条限制，随时重新生成。**

> 2026-10-24 修正：这条规则原来把手动触发也一起拦了——当天交过一份后再手动调用会
> 返回 `skipped`，必须知道内部参数 `force=true` 才能重做。那不是需求里说的。
> 原话约束的是「自动化任务」不要重复，用户主动再要一份不该被拦。
> 现在 `skipped` 只在 `auto: true`（定时路径）下生效。

- **每天 24:00（即次日 00:00，Asia/Shanghai）**：插件在 `daily_summary` 第一次被调用的会话里，
  通过 `ctx.schedule.create()` 注册一条 daily 提醒。到点框架唤醒该会话的 agent。
  > `24:00` 在 schedule 服务里只能写成 `00:00:00`：时间字段是
  > `/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/`，小时最大 23，`24:00:00` 会被拒。
- **自动路径按「是否迟到」决定目标日（`auto: true`）**：提醒词让模型调 `daily_summary(auto: true)`。
  工具拿当前时间与设置里的**预定触发时刻**比：间隔超过 `AUTO_DELAY_GRACE_MS`（6 小时）就是关机错过后的延迟投递，
  目标日拉回昨天；否则按当前钟点正常算。
  - 23:50 准点触发 → 统计**今天**；
  - 00:00 准点触发 → 落进凌晨分支，统计**昨天**（凌晨补记）；
  - 次日早上才开机补投 → 迟到，统计**刚结束的那一天**。
  > 1.3.0 之前这里是"无条件补昨天"。触发时间从 24:00 改到 23:50 后就出事了：23:50 的"昨天"是前天，
  > 而昨天那份早些时候已经手动交过 → 整轮 `skipped`，当天反而一份都没有。
  > 单看"昨天交没交"不够，得先分清这次投递是准点还是迟到。
- **凌晨边界护栏**：`CUTOVER_MIN_ELAPSED_MS`（1 小时）。新的一天过去不足一小时时，
  凌晨请求仍按补记前一天处理 —— 否则 00:00 那一刻会因「凌晨切当天」例外产出一份
  几乎空白的新一天总结，并把它记成已交付，那一天的真总结再也补不上。
- **分支由工具兜底，不靠提醒词**：`daily_summary` 一进来就先读 `state.deliveredDates`，
  **但只在 `auto: true`（定时路径）时据此跳过**：
  - 定时任务 + 目标日已在名单里 → 返回 `skipped: true, reason: 'delivered-today'`，不取数、不成文；
  - 手动触发 → 不跳过，直接重新取数成文（想再要一份就再点一次）。
  这样即使提醒已经唤醒了模型，它调工具时也会被告知"这天交过了"，不会重复产出。
  （如果把判断写成提醒词里的"先检查一下"，模型最容易做的动作恰恰是直接调用同一条流程的
  第一步 `daily_summary` —— 那本身就是"再产出一份"。）
- **谁来写名单**：`daily_summary_selfcheck` 自检通过时自动写入（不依赖模型记得传参），
  `daily_summary(markDelivered: true)` 也会写。名单保留最近 90 天。
  自检同时接受「昨天的凌晨补记抬头」，否则关机后延迟到早上补发时会被判成抬头不符；
  记录用的是**实际匹配到的**那天，不会把今天误标成已交付。
- **手动重做**：确实想要第二份时调用 `daily_summary(force: true)`。
- **命令侧的分支**：横栏/`/daily-summary` 在拿不到活 agent 时，若定位到的会话正是
  "今天已交付的那个"，直接回"今天已经交付过了，本次跳过"，而不是把请求投进一个死会话。
- 幂等三层：`inFlight`（同步竞态）→ 进程内 `seen`（本进程重复）→ `schedule.list()`（跨重启重复）。
- 可配置：`scheduleTime`（默认 `00:00:00`）、`scheduleTimeZone`（默认 `Asia/Shanghai`）、
  `schedulePrompt`（覆盖提醒词）、`autoSchedule: false` 可整体关闭。
- **改 `scheduleTime` / `schedulePrompt` 会自动迁移已建好的提醒**：幂等判断先按标题找记录，
  找到就比对时间与提醒词，不一致时调 `schedule.update`（带 `expected` 做乐观并发校验）。
  迁移失败只记一条 warn，不影响建提醒本身。
  > 没有这段迁移时踩过一次：默认值从 23:00 改成 23:30，磁盘上那条记录仍每天 23:00 触发，
  > 因为幂等只看标题、看到已存在就直接跳过了。

## 界面

横栏注册在 `sidebar.footer.action`（账户/设置入口那一排旁边，`replaceRisk: none`，
不会盖掉官方账户入口）。

**点击直接生成**：横栏通过 `ctx.remote.commands.execute(sessionId, '/daily-summary')`
在当前会话执行命令，Host 侧 handler 投递一条 V4 合规的用户消息唤醒该会话，
模型随即走「取数 → 成文 → 自检 → 交付」。

**关于 `createUserMessage`**：这个安装包不向 profile 暴露 `@deepseek-ai/dsh-llm`
（宿主包只在 `app.asar` 里），插件里 `import('@deepseek-ai/dsh-llm')` 必然
`ERR_MODULE_NOT_FOUND`。所以消息对象由插件自己构造（`buildUserMessage`：
`id` + `role: 'user'` + `content` + `source.kind: 'user'`，深冻结），与官方
`createUserMessage` 的产物在 V4 日志里同形。**不要改回动态 import。**

**投递目标**：命令 handler 拿不到"当前会话"，只有宿主传入的 `agent` 能直接投递；
没有 `agent` 时按"最近活跃会话"（会话日志 mtime）定位，并优先沿用状态文件里的
`boundSessionId`。定位到的会话没有活 agent 时如实报错，不假装成功。

**界面语言**：横栏文字随浏览器语言切换（`zh*` 中文，其余英文）。

### 设置 → 每日总结（自定义触发时间）

`settings.section` 里新增一页「每日总结」（`replaceRisk: none`，只加一项，不盖官方页面）：

| 控件 | 写到哪里 | 效果 |
|---|---|---|
| 每天自动产出时间 | 设置文件的 `scheduleTime` | 同步改掉**所有会话**那条提醒的时间 |
| 在哪条会话里触发 | 设置文件的 `targetSessionId` | 下拉框列出**所有工作区的全部会话**（按工作区分组、显示标题）；只保留目标会话那条，其余删除；`自动` 则回到"最近活跃会话" |
| 产出后自动写入日志文件 | 设置文件的 `logFile` | 留空则在目标会话目录里自动探测；同一天默认不覆盖 |
| 取数与分界（6 项） | 设置文件的 `tuning` | 字符预算、每类条数、截断长度、会话上限、日界钟点、迟到宽限，见下文「取数可调项」 |
| 包含已归档会话 | 设置文件的 `includeArchived` | 默认开；关掉后取数与候选都跳过归档会话（归档只是界面隐藏，日志不删） |

> 候选清单的坑一：`filterSessions` 的 `created-at` 过滤器要求 `to` 是**数字时间戳**，
> 传 `new Date()` 会抛错并被 catch 吞成空列表——2026-10-23 实测设置页下拉框因此
> 只剩「自动」一项。`settings-test.mjs` 的桩现在会强制这条类型约束来复现它。

> 候选清单的坑二：会话不存在"默认标题"，没被起过标题的会话读出来是 `null`，
> 罗列出来就是一排「（无标题）· session-xxxx」，选起来毫无区分度（实测同一工作区
> 冒出 6 条）。**无标题会话不进下拉框**，但 Host 侧只是标 `titled: false`、不删除，
> 这样"当前固定会话恰好无标题"时仍能查到它的身份并如实显示，而不是变成空白。
> 底部「当前提醒」行带会话标题；目标会话若不在清单里（归档或无标题），下拉框补一项
> 如实显示"固定在哪"，不会静默跳回「自动」。

时间输入是 `<input type="time">`，只能选 00:00–23:59，所以 **24:00 用 00:00 表示**——
两者是同一时刻。落盘时 `24:00` 归一成 `00:00:00`（`LOCAL_CLOCK_TIME` 不接受 24 点），
读回来再显示成 `24:00`。

写回宿主走的是和横栏同一条通道：`ctx.remote.commands.execute(sessionId, '/daily-summary-settings …')`。
一条操作三个调用方共用 Host 侧 `reconcileReminders`：

1. **设置页**（`time HH:MM` / `target <id|auto>` / `log <文件|auto>` / `archived on|off` / `tuning <键> <值>`）
2. **agent 工具** `daily_summary_settings`（`action: get | set_time | set_target | set_log | set_archived | set_tuning | reset_tuning`）
3. **`ensureSchedule`**（每次 `daily_summary` 调用时读设置文件决定时间与归属）

> Client 侧没有独立的 RPC：设置页也要求先选中一个会话（要拿 `agent` 才能执行命令）。
> 没选中时会明确提示，而不是假装保存成功。

> 指定了 `targetSessionId` 之后，`ensureSchedule` 不会在其他会话里再建一条——
> 否则每次换会话说话都会多出一条重复提醒，把时间又改回旧值。

### 手动触发时投到哪（`/daily-summary`、横栏点击）

投递顺序，**设置优先于"当前会话"**：

1. 设了 `targetSessionId` → 投到它。它没在运行（`agents.get` 为 undefined）就直接
   `agents.resume({ resumeSessionId })` 把它唤醒再投，回执会写"已唤醒它并投递"。
2. 未设目标 → 投给当前会话（有 agent 时）。
3. 都没有 → 按会话日志 mtime 找"最近活跃会话"。

> 这条 2026-10-23 出过 bug：投递逻辑只认"当前 agent"或"最近活跃会话"，完全没读
> `targetSessionId`——用户在日志工作区设了目标，在别的会话点横栏，总结仍生成在
> 那个会话里。`command-test.mjs` 现在守着三条：目标优先、唤醒后投递、绝不改投。
>
> 唤起的 agent 归插件所有（`ownedAgents`），插件卸载时统一 `dispose`；本次不主动
> 回收，让它像"打开过"一样常驻，下次触发直接复用。

### 自动写入日志文件（1.3.0）

产出后不用再补一句"帮我写进文件"：`daily_summary_selfcheck` 通过时，插件直接把四段正文写进日志文件。

- **写到哪**：设置里的 `logFile`。可以是**文件**（相对目标会话目录或绝对路径），也可以是**目录**——填目录时会在该目录里找 `日志.txt`、`日志.md`、`daily-log.txt`、`daily-log.md`，找不到就按第一个候选名新建。留空则在目标会话所在目录按同样的候选名探测；探测不到就不写，不会凭空造文件。
- **写成什么样**：沿用现有文件格式 —— `2026.10.27` 单独一行、空行、再四段正文。抬头的「每日总结 · …」会去掉，因为日期已经单独成行了。
- **同一天重复**：默认**不覆盖**已存在的当天块（那里面常混着你手写的碎碎念），返回 `written: false, reason: 'exists'`。确实要整块替换，把 `logOverwrite` 设为 `true`。
- **失败不翻案**：写文件出错只记在 `logFile.reason` 里，成稿本身合格这一结论不变。
- **让模型别重复写**：模型不知道插件会自动写的话，会在自检通过后再用 `edit` 手动写一遍（2026-10-29 就这样重复了一次）。所以命令投递的引导语会带上"自检通过后插件会自动写进 `<路径>`，你不需要再用任何工具写文件，也不要重复写"；定时提醒词也加了同样意思的一句。

> 日期行兼容 `2026.10.27`、`2026-10-22`、`2026年10月27日` 三种写法，判断"当天是否已存在"时按解析后的年月日比较，不会因为格式不同把同一天写成两份。
>
> 目标目录取自 `targetSessionId` 那条会话的 `cwd`；没设目标时用本次交付的会话。两者都读不到 cwd 就跳过写入。
>
> 设置页「实际写入」那一行就是同一个解析结果（只读，不创建文件），可以直接核对。

## 能力

注册三个工具：

| 工具 | 对应 SKILL.md | 职责 |
|---|---|---|
| `daily_summary` | 第一步 + 第二步来源二 + 第四步 | 取一次运行时本地时间，按 **04:00 日界**切出三条互斥分支，算统计日 / 统计区间 / 抬头注记（含凌晨「切当天」例外所需的持久状态）；只读扫描统计区间内各会话日志，给出候选素材清单与覆盖面计数；按阈值生成逐字降级声明。 |
| `daily_summary_selfcheck` | 第三步成文规则 + 输出自检 + 禁止事项 | 对已成文的四段纯文本做确定性检查：抬头逐字、四段标题各 1 次、注记带截至时刻、无「用户」/`@scene`/表格/围栏/加粗/HTML、默认不写来源。返回 `problems` 清单，`ok` 为真才可交付；同时在通过时写入日志文件。 |
| `daily_summary_settings` | 自动化配置 | `action: get / set_time / set_target / set_log / set_archived / set_tuning / reset_tuning`，读改触发时间、固定会话、日志落盘位置、归档开关与取数可调项，与设置页共用同一份设置。 |

分工严格按需求 §7 的**铁律**：时间与区间只能算不能猜（插件算），正文只能写不能拼（模型写）。

## 日界分支（插件算，模型不再自行推断）

| now | 分支 | 统计日 | 区间 | 注记 |
|---|---|---|---|---|
| 04:00–23:59 | `in-progress` | now 当日 | `00:00–24:00` | `（进行中，截至 <HH:MM>）` |
| 00:00–03:59 | `catch-up` | **前一个自然日** | `00:00–24:00` | `（凌晨补记）`（不带截至时刻） |
| 00:00–03:59 且前一日已完整交付过 | `in-progress-cutover` | now 当日 | `00:00–24:00` | `（进行中，截至 <HH:MM>）` |

区间只声明「统计哪一个自然日」，注记声明「实际统计到几点」——这是 QA 收口时确立的职责分离。

## 安装

前提：已装好 DSH（DeepSeek Harness），且能正常打开 Web 界面。

1. clone 本仓库到任意目录；
2. 在 DSH 的对话里让 agent 安装：用 `plugin_manager` 的 `install_bundle`，`target`
   填**仓库根目录的绝对路径**（就是含 `package.json` 的那一层）；
3. **重启 DSH**——插件代码在启动时加载，不重启不生效；
4. 生效后：侧边栏底部出现「每日总结」横栏，设置 → 左侧导航多出一页「每日总结」。

> 包名带 `@local/` 前缀是本地包名，不发布到 npm；安装走目录，不需要联网。
> 想确认装的是哪一版：设置 → 每日总结，右下角显示 `v1.9.1` 这样的版本号。

可选配置有两条路：**优先用设置页**（设置 → 每日总结 → 取数与分界），改动写进
`settings.json` 的 `tuning` 分区并立即生效；`cordis.patch.yml` 的 `config` 是兜底，
settings 里没写的项才取它。

```yaml
- insert:
    - id: daily-summary
      name: '@local/dsh-daily-summary'
      config:
        cutoverHour: 4          # 日界小时：凌晨几点算新一天（0–23）
        charBudget: 400000      # 全局字符预算，按会话体量分配（0 = 关闭，退回按条数）
        maxEventsPerKind: 24    # 关闭预算时每类条数上限；预算模式下作为兜底
        snippetChars: 160       # 关闭预算时的单条截断长度
        maxSessions: 80         # 最多扫描的会话数
        autoDelayGraceHours: 6  # 自动投递迟到宽限（小时）
```

这 6 项都能在设置页直接改，不需要碰这个文件。

状态与设置默认写在 `~/.dsh/daily-summary/`（`state.json` + `settings.json`），
不用手工指定路径。

## 会话读取通道

`daily_summary` 的跨会话素材走 **`ctx.sessionQuery`**（live-preferred 逻辑语料，无装配作用域依赖）：

| 调用 | 用途 |
|---|---|
| `filterSessions({kind:'created-at', to})` | 完整会话清单（live 优先 + 持久化） |
| `readSession(id)` | 单个会话完整原始日志（回放校验过的副本） |
| `readTitleSnapshots(ids)` | 会话标题，让来源名落到会话级而非「会话 N」 |

三条都只读：不改、不删、不移动任何会话记录。标题读不出时 `title` 归一为 `null`，
`sourceName` 依次退化为「当前会话」→ 标题 → 首条用户消息摘要 → `会话 N`。

### 用户消息的来源过滤（1.9.0）

`user/message` 事件按 `data.message.source.kind`（或 `data.source.kind`）做**白名单**过滤，
只保留 `user`（真人输入）与 `compact-checkpoint`（上下文压缩摘要），其余一律丢弃。

2026-11-18 实测某会话 730 条用户消息的来源分布：

| kind | 条数 | 处理 |
|---|---|---|
| `user` | 193 | 保留 |
| `time-feeling` / `time-context` | 362 | 丢弃（时间锚点） |
| `schedule` | 43 | 丢弃（定时提醒模板） |
| `plugin:hindsight` | 40 | 丢弃（记忆注入） |
| `runtime-context` | 31 | 丢弃（运行时快照） |
| `model-selection` / `skill-catalog` / 其他 | ~61 | 丢弃 |

真人只占 26%，不过滤会让总结里混满插件模板。用白名单而非黑名单：新插件随时引入新
`kind`，黑名单永远列不全。`source` 缺失（老日志）时放行。

### 空壳会话不计入覆盖面

当天创建/留有日志、但一条素材都提不出的会话（只发过空消息、空参数 tool/call 之类），
既不计入 `sessionCount`，也不出现在 `sessions` 数组里，只在 `shellSessions` 单独计数并给一句说明。

**为什么连数组一起剔除**：模型读的是整个 `sources`，只改计数而数组里仍留着空壳，
模型数一下 `sessions.length` 就又把覆盖面算虚了。

**为什么必须剔除**：SKILL.md 第四步阈值②是「事件只来自 1 个会话」。空壳会把
1 个会话伪装成 3 个会话，让本该出现的降级声明凭空消失——等于伪造「已汇总全部」，
正是需求 §7 铁律点名禁止的那种失真。QA 报告 §9-B1 与 lessons 裁决 3 记过同类病
（「阈值数 ≠ 文案数是高危信号」），这是它的另一个入口。

`smoke-test.mjs` 有一条专门的回归用例：1 个真实会话 + 3 个空壳，断言 `sessionCount` 仍为 1。

### 一条必须记住的硬约束

框架会把工具返回值 clone 后按 JSON 序列化，**任何 `undefined` 取值都会让整次调用失败**：

```
Error: tool "daily_summary" returned invalid output: value is not lossless JSON
```

这条报错不指向字段，只能二分定位（本次真实耗时约一小时）。根因是
`cwd: header.cwd` 与 `title: Map.get()` 在缺值时会留下 `undefined`。
因此 `collectSources` 的所有字段一律归一成 string/number/boolean/null/数组/纯对象，
`smoke-test.mjs` 里有一条 `assertLossless` 递归断言守着它，**新增字段必须一起过这条断言**。

## 取数可调项（1.5.0 / 1.6.0）

「取数与分界」共 6 项，三种改法等价，最终都写进 `settings.json` 的 `tuning` 分区：

| 键 | 默认 | 范围 | 作用 |
|---|---|---|---|
| `charBudget` | 400000 | 50000–2000000 | 全局字符预算；0 = 关闭预算，退回按条数 |
| `maxEventsPerKind` | 24 | 1–200 | 关闭预算时的每类条数上限（预算模式下作兜底） |
| `snippetChars` | 160 | 20–2000 | 关闭预算时的单条截断长度 |
| `maxSessions` | 80 | 1–5000 | 最多扫描的会话数 |
| `cutoverHour` | 4 | 0–23 | 日界：凌晨几点算新一天 |
| `autoDelayGraceHours` | 6 | 0.5–48 | 自动投递的迟到宽限 |

三种改法：

1. **设置页**：设置 → 每日总结 → 取数与分界（数字输入框，保存即生效）
2. **命令**：`/daily-summary-settings tuning <键> <值>`；`tuning <键> default` 恢复默认
3. **工具**：`daily_summary_settings` 的 `action: set_tuning`（传 `tuning: {键: 值}`）
   或 `reset_tuning`（传 `key: [键]`）

`charBudget > 0` 时走预算模式：先按各会话的原始字符量加权分配（每会话保底 40%、
单会话封顶 25%），会话内按类别切分额度（用户 40% / 助手 25% / 工具调用 15% /
工具错误 12% / 推理 8%），再按类别分级截断（用户 800 字、错误 400、助手 400、
推理 300、工具调用 160）。工具调用优先保留写/改类操作。

另有一项非数值开关 **包含已归档会话**（`includeArchived`，默认 `true`）：

- DSH 的归档只写进 `~/.dsh/storages/workspace.json` 的 `archivedSessionIds`，**日志一个都不删**
  （2026-11-17 实测：32 个归档会话的日志目录全部还在），所以默认把它们也纳入取数；
- 关掉后，取数与设置页的候选下拉框都会跳过这些会话；
- 三种改法同上：设置页勾选框、`/daily-summary-settings archived on|off`、
  `daily_summary_settings` 的 `action: set_archived`（传 `includeArchived: true|false`）；
- 关掉时会在 `sources` 里用 `archivedSkipped` 如实报出被过滤掉的数量。

### 第 4 段「今日份思考」为什么不会再只写一句（1.8.0）

三处一起改，缺一条都可能退回「只写一句」：

1. **素材**：`reasoning` 的预算占比从 8% 提到 15%，模型看到的思考更多；
2. **候选**：`sources.thinkingHints` 给出最多 5 条「可回看的思考点」，
   按是否在讲因果/结论（因为、其实、发现、关键、原来、问题在于……）加长度排序，
   并过滤掉 40 字以下的过程性碎念；
3. **兜底**：规则改成「每个思考点单独一行（2–3 行），每行一句、行间不空行」，
   `daily_summary_selfcheck` 新增 `thinkingAvailable` 与 `minThinkingSentences`——
   **按非空行数**判定，素材充足时只写一行会被 `problems` 拦下；第 4 段用 `-` 起行也会被拦。

`daily_summary` 返回的 `selfCheckHint` 会提醒模型：`thinkingHints` 非空时传
`thinkingAvailable=true`。素材确实不足时仍写「今天没有记录到可以回看的思考」，不会被误判。

## 测试

不依赖任何宿主环境，纯 Node 跑：

```bash
npm test                 # 一次跑完下面九个
node --check index.js && node --check client.js
node boundary-test.mjs   # 三分支、抬头形态、唯一失败退出、自检正反例
node smoke-test.mjs      # 素材扫描、区间外事件排除、降级声明三文案、返回值无损 JSON、空壳不计入覆盖面
node command-test.mjs    # /daily-summary handler：消息自建合规、投递目标与唤醒路径
node branch-test.mjs     # 日界、00:00 边界、关机延迟补发、手动 vs 定时的跳过语义、自检记录日
node schedule-migrate-test.mjs  # 提醒时间/提醒词漂移时的迁移，迁移失败不拖垮建提醒
node settings-test.mjs   # 设置页写入路径：时间归一化、24:00↔00:00、统一改所有会话、指定会话、可调项、工具与页面同源
node log-test.mjs        # 日志落盘：日期归一化、块格式、追加/不覆盖/覆盖、端到端落盘
node budget-test.mjs     # 预算分配：总和 ≤ 预算、保底、上限、分级截断常量
node sampling-test.mjs   # 分层取样：额度换算条数、写操作优先、预算与旧模式、无损 JSON 清洗
```

## 已知限制

1. `maxSessions` 之外的会话只计入 `skippedForLimit`，不再展开素材。
2. `session-*` 之外的无标题会话退化为「会话 N」，因此「按需举证」最好还是问标题在不在。
3. `（凌晨补记）` 的「前一日是否已交付过总结」在 SKILL.md 里只能靠上下文猜（技术债 ②），插件改为持久状态文件判断，判不到时仍按补记走、不追问，方向保守。
4. 输出自检只覆盖可机检项；事件归类、是否编造、是否说教仍由模型自律，插件不替代判断。
5. 升级插件文件后需要重启 Harness 才会加载新的模块代（热更新只对已导出的形态稳定）。
6. 界面渲染已在 DSH Web 界面确认：侧边栏横栏与 设置 → 每日总结 页都能正常渲染。若你的环境里某个插槽被其他插件改动，开 Console 找 `slot entry crashed in 'settings.section'` 或 `'sidebar.footer.action'` 定位。
7. 定时提醒绑定在「第一次调用 `daily_summary` 的会话」上——通常是装好插件后你第一次要总结的那个会话。想让固定会话承担定时任务，就在那个会话里说一次「每日总结」，或在设置页「每日总结」里直接指定会话。
8. **设置页需要先选中一个会话**：`ctx.remote.commands.execute` 要传 `agent`，没有选中会话时设置页会明确提示而不是静默失败。
9. 设置页的会话下拉框**不显示无标题会话**（空壳/探针）。当前固定的那条若恰好无标题，仍会单独列出来，不会被静默改回「自动」。
10. `charBudget` 分到的额度若不足以覆盖某类素材，该类仍至少保留 1 条并截断到分级上限；极端大会话可能因此只剩几十条摘要，这是预算设计的取舍。

## 许可证

[MIT](LICENSE) © 2026 JMX2033

