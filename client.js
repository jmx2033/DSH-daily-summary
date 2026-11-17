/**
 * Client half：侧边栏底部（用户状态栏上方）的每日总结横栏。
 *
 * 注册在 `sidebar.footer.action`——它位于 Settings / 账户入口那一排旁边，
 * 正是「用户状态栏上方」的位置，且 replaceRisk: none（不会盖掉官方账户入口）。
 *
 * 边界（重要）：Client 侧没有「向会话发消息」的能力——消息提交归 Conversation 层。
 * 所以横栏只做它确实能做的事：切到对话面板 + 展示今日状态提示。
 * 真正的总结由两条路径触发：
 *   1. 定时任务到点自动唤醒会话（Host 侧 ensureSchedule 建的那条 daily 提醒）
 *   2. 你在对话里说「每日总结」
 *
 * 主题一律用 --dsw-alias-* 令牌，保证深浅色与宿主一致。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-daily-summary',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 文案分流：浏览器语言以 zh 开头的用中文，其余一律英文（与 locale/en.json 对齐）。
    // 只影响界面文字，不影响命令行为。
    const ZH =
      typeof navigator === 'object' && navigator !== null
        ? /^zh/i.test(navigator.language || '')
        : false
    const T = (zh, en) => (ZH ? zh : en)

    // 与 Host 侧 SETTINGS_COMMAND_NAME 必须一致。
    const SETTINGS_COMMAND = 'daily-summary-settings'

    const STYLE = {
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        margin: '0 8px 6px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.28))',
        background: 'var(--dsw-alias-surface-raised, transparent)',
        color: 'var(--dsw-alias-text-primary, inherit)',
        fontSize: 12,
        lineHeight: 1.4,
        cursor: 'pointer',
        // 只占内容宽度（贴着左侧），不再撑满整条侧边栏；
        // maxWidth 兜住超长副标题，避免顶到容器边缘。
        width: 'fit-content',
        maxWidth: 'calc(100% - 16px)',
        alignSelf: 'flex-start',
        textAlign: 'left',
        font: 'inherit',
      },
      icon: { flex: '0 0 auto', display: 'block' },
      // 内容宽度自适应：不再用 flex-grow 把按钮撑开，
      // 限一个合理上限，副标题超长时按省略号截断（与原行为一致）。
      body: { flex: '0 1 auto', minWidth: 0, maxWidth: 160 },
      title: {
        fontWeight: 600,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      hint: {
        color: 'var(--dsw-alias-text-tertiary, inherit)',
        fontSize: 11,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
    }

    function SummaryIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 64 64', 'aria-hidden': true, style: STYLE.icon },
        h('rect', { x: 4, y: 4, width: 56, height: 56, rx: 14, fill: '#1f6feb' }),
        h('path', {
          d: 'M20 22h24M20 32h24M20 42h14',
          stroke: '#ffffff',
          strokeWidth: 4,
          strokeLinecap: 'round',
          fill: 'none',
        }),
        h('circle', { cx: 46, cy: 42, r: 7, fill: '#ffd166', stroke: '#1f6feb', strokeWidth: 2 }),
      )
    }

    // 点击动作由 apply 装进来。**不能用 props 传**：如果注册的是
    // `() => h(Component, {...})`，每次渲染都会产出一个新的组件类型，
    // React 会卸载重挂、useState 被重置，点击反馈立刻就没了。
    // 所以这里用模块级变量 + 稳定的组件引用（见 apply 里的 register）。
    let activateAction = () => '还没准备好，请重启 DSH 后再试'

    function DailySummaryBar() {
      const [hint, setHint] = React.useState(
        T(
          '每天 24:00（次日 00:00）自动产出；点击立即生成',
          'Auto-runs at 24:00 (00:00 next day) · click to generate now',
        ),
      )

      const onClick = () => {
        const settle = (value) => {
          if (typeof value === 'string' && value) setHint(value)
        }
        // 先给即时反馈：命令是异步的，不先置状态用户会以为没反应。
        setHint(T('正在触发生成…', 'Starting…'))
        try {
          const next = activateAction()
          if (next && typeof next.then === 'function') {
            next.then(settle, (error) =>
              setHint(T('失败：', 'Failed: ') + (error && error.message ? error.message : error)),
            )
          } else {
            settle(next)
          }
        } catch (error) {
          setHint(T('点击出错：', 'Click error: ') + (error && error.message ? error.message : error))
        }
      }

      return h('button', { type: 'button', style: STYLE.row, onClick, title: hint }, [
        h(SummaryIcon, { key: 'icon' }),
        h('span', { key: 'body', style: STYLE.body }, [
          h('div', { key: 'title', style: STYLE.title }, T('每日总结', 'Daily Summary')),
          h('div', { key: 'hint', style: STYLE.hint }, hint),
        ]),
      ])
    }

    // 设置页的动作由 apply 装进来（原因同上面的 activateAction：
    // 组件必须是稳定引用，不能靠 props 传新函数）。
    let settingsActions = null

    const FIELD = {
      label: {
        display: 'block',
        fontWeight: 600,
        fontSize: 13,
        marginBottom: 6,
        color: 'var(--dsw-alias-text-primary, inherit)',
      },
      hint: {
        marginTop: 6,
        fontSize: 11,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-text-tertiary, inherit)',
      },
      control: {
        font: 'inherit',
        fontSize: 13,
        padding: '5px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.28))',
        background: 'var(--dsw-alias-surface-raised, transparent)',
        color: 'var(--dsw-alias-text-primary, inherit)',
        minWidth: 160,
        colorScheme: 'light dark',
      },
      primary: {
        font: 'inherit',
        fontSize: 13,
        padding: '5px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.28))',
        background: 'var(--dsw-alias-accent, #1f6feb)',
        color: '#ffffff',
        cursor: 'pointer',
      },
    }

    const describeReminder = (reminder) => {
      // 原来只有 `24:00 · session-ea71 · active`：看不出固定在哪条对话。
      const who = reminder.sessionTitle || String(reminder.sessionId || '?').slice(0, 12)
      return `${clockOf(reminder)} · ${who}`
    }
    const clockOf = (reminder) => `${reminder.time}（${reminder.timeZone || ''}）`

    function DailySummarySettings() {
      const [payload, setPayload] = React.useState(null)
      const [failure, setFailure] = React.useState('')
      const [time, setTime] = React.useState('00:00')
      const [target, setTarget] = React.useState('')
      const [logFile, setLogFile] = React.useState('')
      const [includeArchived, setIncludeArchived] = React.useState(true)
      const [tuning, setTuning] = React.useState({})
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const adopt = (next) => {
        setPayload(next)
        setTime(typeof next.timeRaw === 'string' ? next.timeRaw.slice(0, 5) : '00:00')
        setTarget(next.targetSessionId || '')
        setLogFile(next.logFile || '')
        // 归档开关默认开启：Host 只在显式写过布尔值时才返回该字段。
        setIncludeArchived(next.includeArchived !== false)
        // 可调项：以 Host 侧当前生效值为种子，另存默认值与「是否被覆盖」，
        // 供保存时判断该发 `tuning <key> <value>` 还是 `<key> default`。
        const t = next.tuning || {}
        const values = t.values || {}
        const defaults = t.defaults || {}
        const overriddenSet = new Set(Array.isArray(t.overridden) ? t.overridden : [])
        const init = {}
        for (const key of Object.keys(values)) {
          init[key] = {
            value: values[key],
            defaultValue: defaults[key],
            currentValue: values[key],
            overridden: overriddenSet.has(key),
          }
        }
        setTuning(init)
      }

      React.useEffect(() => {
        let alive = true
        if (!settingsActions) {
          setFailure(
            T('还没有准备好，请重启 DSH 后再试', 'Not ready yet — restart DSH and try again'),
          )
          return undefined
        }
        settingsActions.load().then(
          (next) => {
            if (alive) adopt(next)
          },
          (error) => {
            if (alive) setFailure(String((error && error.message) || error))
          },
        )
        return () => {
          alive = false
        }
      }, [])

      const onSave = () => {
        if (!settingsActions || busy) return
        setBusy(true)
        setStatus(T('保存中…', 'Saving…'))
        settingsActions.save({ time, target, log: logFile, tuning, includeArchived }).then(
          (next) => {
            adopt(next)
            setStatus(T('已保存，立即生效', 'Saved — active now'))
            setBusy(false)
          },
          (error) => {
            setStatus(T('保存失败：', 'Save failed: ') + String((error && error.message) || error))
            setBusy(false)
          },
        )
      }

      if (failure) {
        return h('div', { style: FIELD.hint }, failure)
      }
      if (!payload) {
        return h('div', { style: FIELD.hint }, T('读取设置中…', 'Loading…'))
      }

      const allCandidates = Array.isArray(payload.candidates) ? payload.candidates : []
      // 只把**有标题**的会话放进下拉框：无标题的都是空壳/探针，一排「（无标题）」
      // 没有任何区分度。Host 侧仍带回它们，只用于解析"当前固定在哪"的身份。
      const candidates = allCandidates.filter(
        (candidate) => candidate.titled !== false && candidate.title && String(candidate.title).trim(),
      )
      const untitledCount = allCandidates.length - candidates.length
      const reminders = Array.isArray(payload.reminders) ? payload.reminders : []
      const midnight = payload.timeRaw === '00:00:00'

      // 按工作区分组渲染 optgroup；Host 侧已按 cwd 排好序，这里只做相邻聚合。
      const groups = []
      for (const candidate of candidates) {
        const cwd = candidate.cwd || '(unknown)'
        const last = groups[groups.length - 1]
        if (last && last.cwd === cwd) last.items.push(candidate)
        else groups.push({ cwd, items: [candidate] })
      }
      const shortCwd = (cwd) => {
        const parts = String(cwd).split(/[\\/]/).filter(Boolean)
        return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(cwd)
      }
      const optionLabel = (candidate) =>
        `${candidate.title || T('（无标题）', '(untitled)')} · ${String(candidate.id).slice(0, 12)}`

      // 当前固定会话可能已归档或本身无标题（被上面的过滤挡掉），
      // 补一项如实显示"现在固定在哪"，而不是静默显示成「自动」。
      const targetKnown =
        !!payload.targetSessionId &&
        candidates.some((candidate) => candidate.id === payload.targetSessionId)
      const targetIsUntitled =
        !!payload.targetSessionId &&
        allCandidates.some(
          (candidate) => candidate.id === payload.targetSessionId && candidate.titled === false,
        )
      const targetExtra = payload.targetSessionId && !targetKnown
        ? [
            h(
              'option',
              { key: 'pinned', value: payload.targetSessionId },
              `${
                payload.targetTitle ||
                (targetIsUntitled
                  ? T('（无标题会话）', '(untitled session)')
                  : T('（不在活跃清单里的会话）', '(session not in the active list)'))
              } · ${String(payload.targetSessionId).slice(0, 12)}`,
            ),
          ]
        : []

      // 取数与分界可调区：固定顺序展示 5 项，值来自 tuning state，
      // 取值范围/默认值来自 Host 的 payload.tuning.ranges / .defaults。
      const tuningInfo = payload.tuning || {}
      const tuningRanges = tuningInfo.ranges || {}
      const tuningLabels = tuningInfo.labels || {}
      const tuningDefaults = tuningInfo.defaults || {}
      const TUNING_ORDER = [
        'snippetChars',
        'maxEventsPerKind',
        'charBudget',
        'maxSessions',
        'cutoverHour',
        'autoDelayGraceHours',
      ]
      const tuningField = (key) => {
        const spec = tuning[key] || {}
        // 旧版 Host 不会返回新参数的 ranges/labels：这时不要拿 0–1000 冒充真实范围，
        // 直接提示「重启后生效」，否则界面看起来像一个坏掉的输入框。
        const known = !!tuningRanges[key]
        const range = tuningRanges[key] || { min: 0, max: 1000, step: 1 }
        const suffix =
          key === 'snippetChars' || key === 'charBudget'
            ? T(' 字符', ' chars')
            : key === 'maxEventsPerKind'
              ? T(' 条/类', ' /kind')
              : key === 'maxSessions'
                ? T(' 个会话', ' sessions')
                : key === 'cutoverHour'
                  ? T(' 点', " o'clock")
                  : T(' 小时', ' hours')
        return h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 } }, [
          h('label', { key: 'label', style: FIELD.label }, tuningLabels[key] || key),
          h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('input', {
              key: 'input',
              type: 'number',
              min: range.min,
              max: range.max,
              step: range.step,
              value: spec.value === undefined ? '' : spec.value,
              style: { ...FIELD.control, width: 96 },
              onChange: (event) => {
                const next = Number(event.target.value)
                const nextVal = Number.isFinite(next) ? next : ''
                setTuning((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), value: nextVal } }))
                setStatus('')
              },
            }),
            h(
              'span',
              { key: 'suffix', style: FIELD.hint },
              suffix +
                (spec.defaultValue !== undefined
                  ? ` · ${T('默认', 'default')} ${key === 'autoDelayGraceHours' ? tuningDefaults.autoDelayGraceHours : spec.defaultValue}`
                  : ''),
            ),
          ]),
          h(
            'div',
            { key: 'hint', style: FIELD.hint },
            known
              ? T(
                  `范围 ${range.min}–${range.max}${key === 'autoDelayGraceHours' ? '；保存时想恢复默认就改回默认值' : ''}`,
                  `Range ${range.min}–${range.max}`,
                )
              : T(
                  '这个参数来自新版插件，重启 DSH 后才会生效',
                  'This option comes from a newer plugin build — restart DSH to enable it',
                ),
          ),
        ])
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 520 } }, [
        h('div', { key: 'time' }, [
          h('label', { key: 'label', style: FIELD.label }, T('每天自动产出时间', 'Daily run time')),
          h('input', {
            key: 'input',
            type: 'time',
            step: 60,
            value: time,
            style: FIELD.control,
            onChange: (event) => {
              setTime(event.target.value || '00:00')
              setStatus('')
            },
          }),
          h(
            'div',
            { key: 'hint', style: FIELD.hint },
            midnight
              ? T(
                  '现在是 24:00（次日零点）。改完立即生效，并同步所有会话的提醒。',
                  'Currently 24:00 (next-day midnight). Changes apply immediately to every session\'s reminder.',
                )
              : T(
                  '要做「24:00」就选 00:00 —— 两者是同一时刻。改完立即生效，并同步所有会话的提醒。',
                  'For 24:00 pick 00:00 — they are the same instant. Changes apply immediately to every session\'s reminder.',
                ),
          ),
        ]),
        h('div', { key: 'target' }, [
          h('label', { key: 'label', style: FIELD.label }, T('在哪条会话里触发', 'Which session runs it')),
          h(
            'select',
            {
              key: 'select',
              value: target,
              style: FIELD.control,
              onChange: (event) => {
                setTarget(event.target.value)
                setStatus('')
              },
            },
            [
              h('option', { key: 'auto', value: '' }, T('自动（最近活跃的会话）', 'Auto (most recent session)')),
              ...targetExtra,
              ...groups.map((group) =>
                h(
                  'optgroup',
                  { key: `g:${group.cwd}`, label: shortCwd(group.cwd) },
                  group.items.map((candidate) =>
                    h('option', { key: candidate.id, value: candidate.id }, optionLabel(candidate)),
                  ),
                ),
              ),
            ],
          ),
          h(
            'div',
            { key: 'hint', style: FIELD.hint },
            T(
              '选「自动」就按最近活跃会话决定。指定某条会话后，只保留那一条提醒，其余会被删除。',
              'Auto decides by the most recent session. Picking one keeps only that reminder and removes the others.',
            ),
          ),
        ]),
        h('div', { key: 'log' }, [
          h(
            'label',
            { key: 'label', style: FIELD.label },
            T('产出后自动写入日志文件', 'Write each summary into a log file'),
          ),
          h('input', {
            key: 'input',
            type: 'text',
            value: logFile,
            placeholder: T(
              '留空＝自动探测（日志.txt）；也可填绝对路径',
              'Empty = auto-detect (日志.txt); an absolute path also works',
            ),
            style: { ...FIELD.control, width: '100%', boxSizing: 'border-box' },
            onChange: (event) => {
              setLogFile(event.target.value)
              setStatus('')
            },
          }),
          h(
            'div',
            { key: 'hint', style: FIELD.hint },
            T(
              '留空时在目标会话所在目录里找 日志.txt / 日志.md / daily-log.txt。' +
                '同一天已有内容默认不覆盖，保护你手写的部分。',
              'Empty looks for 日志.txt / 日志.md / daily-log.txt in the pinned session folder. ' +
                'An existing day block is left untouched by default.',
            ),
          ),
          h(
            'div',
            { key: 'resolved', style: { ...FIELD.hint, opacity: 0.85 } },
            payload.logResolved
              ? T('实际写入：', 'Writes to: ') + payload.logResolved
              : T(
                  '实际写入：未定位到日志文件（可填目录或文件名）',
                  'Writes to: no log file resolved — fill in a folder or file name',
                ),
          ),
        ]),
        h('div', { key: 'archived', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
          h(
            'label',
            {
              key: 'label',
              style: { ...FIELD.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
            },
            [
              h('input', {
                key: 'input',
                type: 'checkbox',
                checked: includeArchived,
                onChange: (event) => {
                  setIncludeArchived(event.target.checked)
                  setStatus('')
                },
              }),
              T('包含已归档会话', 'Include archived sessions'),
            ],
          ),
          h(
            'div',
            { key: 'hint', style: FIELD.hint },
            T(
              '归档只是界面隐藏，日志不会删；关掉后取数与候选都会跳过它们。',
              'Archiving only hides them in the UI — logs stay. Turn off to skip them in sampling and candidates.',
            ),
          ),
        ]),
        h('div', { key: 'tuning', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
          h('div', { key: 'heading', style: { ...FIELD.label, marginBottom: 6 } },
            T('取数与分界', 'Sampling & day cutoff')),
          ...TUNING_ORDER.map(tuningField),
        ]),
        h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
          h('button', { key: 'save', type: 'button', style: FIELD.primary, onClick: onSave, disabled: busy }, T('保存', 'Save')),
          h('span', { key: 'status', style: FIELD.hint }, status),
        ]),
        h(
          'div',
          { key: 'reminders', style: FIELD.hint },
          reminders.length === 0
            ? T('目前没有生效的提醒，保存后会建一条。', 'No active reminder yet — saving creates one.')
            : T('当前提醒：', 'Active reminders: ') + reminders.map(describeReminder).join('；'),
        ),
        h(
          'div',
          { key: 'footer', style: { ...FIELD.hint, display: 'flex', justifyContent: 'space-between', gap: 12 } },
          [
            h(
              'span',
              { key: 'hidden' },
              untitledCount > 0
                ? T(
                    `已隐藏 ${untitledCount} 个无标题会话（空壳/探针，不可选）`,
                    `${untitledCount} untitled session(s) hidden (shells/probes, not selectable)`,
                  )
                : '',
            ),
            h(
              'span',
              { key: 'version', style: { opacity: 0.7, whiteSpace: 'nowrap' } },
              `v${payload.version || '?'}`,
            ),
          ],
        ),
      ])
    }

    return {
      // `cannot get property "remote.commands" without inject`
      // （官方 ui-commands 的 CommandUiRuntime 同样声明这两个）。
      inject: ['slots', 'remote', 'remote.commands'],
      apply(ctx) {
        const pick = (name) => {
          try {
            return typeof ctx.get === 'function' ? ctx.get(name) : undefined
          } catch {
            return undefined
          }
        }

        // uiSession.current 的快照形状是 { key, hooks, keyedHooks, props }，
        // 当前会话 id 存在 `key` 上（见 ui-session 的 publishMain：current.value.key）。
        const currentSessionId = () => {
          try {
            const snap = pick('uiSession')?.current?.getSnapshot?.()
            const id = snap && snap.key
            return typeof id === 'string' && id ? id : undefined
          } catch {
            return undefined
          }
        }

        // 点击时执行，并返回一行文字显示在横栏上（既是反馈，也是诊断）。
        const onActivate = () => {
          const sessionId = currentSessionId()
          const remote = ctx.remote
          const execute = remote?.commands?.execute
          if (!sessionId || typeof execute !== 'function') {
            return T(
              `诊断 sid=${sessionId ? 'y' : 'n'} cmd=${typeof execute === 'function' ? 'y' : 'n'}`,
              `diag sid=${sessionId ? 'y' : 'n'} cmd=${typeof execute === 'function' ? 'y' : 'n'}`,
            )
          }
          return Promise.resolve(remote.commands.execute(sessionId, '/daily-summary', [])).then(
            (result) => {
              // 必须看 value：命令名解析不出来时 ok 仍为 true，但 value 是 undefined。
              if (!result || result.ok === false) {
                const code = result && result.error && (result.error.code || result.error.message)
                return T('失败：', 'Failed: ') + (code || T('未知原因', 'unknown reason'))
              }
              if (result.value === undefined) {
                return T(
                  '命令 /daily-summary 未注册，请重启 DSH',
                  '/daily-summary is not registered — restart DSH',
                )
              }
              const kind = result.value.result && result.value.result.kind
              if (kind === 'error') {
                const text = result.value.result.text || T('执行出错', 'command failed')
                return T('失败：', 'Failed: ') + String(text).slice(0, 40)
              }
              return T('已触发生成，稍等…', 'Started — give it a moment…')
            },
            (error) =>
              T('触发异常：', 'Request error: ') +
              (error && error.message ? error.message : error),
          )
        }

        // 把动作交给模块级变量，注册稳定组件本身（不能包一层箭头函数，
        // 否则每次渲染都是新组件类型，useState 会被重置）。
        activateAction = onActivate

        // 设置页走同一条命令通道（commands.execute），不另开 RPC：
        // 「一条操作、多个调用方」——设置页、斜杠命令、agent 工具共用 Host 侧 reconcileReminders。
        const runSettingsCommand = (line) => {
          const sessionId = currentSessionId()
          const execute = ctx.remote?.commands?.execute
          if (!sessionId) {
            throw new Error(
              T('请先在左侧选一个对话，再来改设置', 'Select a conversation on the left first'),
            )
          }
          if (typeof execute !== 'function') {
            throw new Error(T('命令通道不可用，请重启 DSH', 'Command channel unavailable — restart DSH'))
          }
          return Promise.resolve(execute(sessionId, line, [])).then((result) => {
            if (!result || result.ok === false) {
              const code = result && result.error && (result.error.code || result.error.message)
              throw new Error(code || T('未知原因', 'unknown reason'))
            }
            if (result.value === undefined) {
              throw new Error(`/${SETTINGS_COMMAND} 未注册，请重启 DSH`)
            }
            const inner = result.value.result
            if (!inner || inner.kind === 'error') {
              throw new Error((inner && inner.text) || T('执行出错', 'command failed'))
            }
            return JSON.parse(inner.text)
          })
        }

        settingsActions = {
          load: () => runSettingsCommand(`/${SETTINGS_COMMAND}`),
          save: ({ time, target, log, tuning, includeArchived }) => {
            // 先落时间/目标/日志（现有逻辑），再逐个发可调项命令。
            // tuning 参数形如 { 键: { value, defaultValue, overridden } }，由设置页组件备好。
            let chain = runSettingsCommand(`/${SETTINGS_COMMAND} time ${time}`)
              .then(() => runSettingsCommand(`/${SETTINGS_COMMAND} target ${target || 'auto'}`))
              .then(() => runSettingsCommand(`/${SETTINGS_COMMAND} log ${log || 'auto'}`))
            if (includeArchived !== undefined) {
              chain = chain.then(() =>
                runSettingsCommand(
                  `/${SETTINGS_COMMAND} archived ${includeArchived ? 'on' : 'off'}`,
                ),
              )
            }
            if (tuning) {
              for (const [key, spec] of Object.entries(tuning)) {
                // 判据：用户想把该键设成与默认一致 → 走 `default`（从 settings 里移除 override）；
                // 否则只要有变化就写当前值。没有变化就不发命令，避免每次保存都写一遍。
                const backToDefault =
                  spec && spec.overridden === true && String(spec.value) === String(spec.defaultValue)
                const changed =
                  spec && spec.value !== undefined && String(spec.value) !== String(spec.currentValue)
                if (!changed && !backToDefault) continue
                const line = `/daily-summary-settings tuning ${key} ${
                  backToDefault ? 'default' : spec.value
                }`
                chain = chain.then(() => runSettingsCommand(line))
              }
            }
            return chain
          },
        }

        // 设置面板左侧导航里新增一页（settings.section 的 replaceRisk 是 none，
        // 只加一项、不盖掉官方那几页）。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'daily-summary',
              order: 60,
              label: () => T('每日总结', 'Daily Summary'),
            },
            DailySummarySettings,
          ),
        )

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'daily-summary',
              order: 5,
              label: T('每日总结', 'Daily Summary'),
            },
            DailySummaryBar,
          ),
        )
      },
    }
  },
})
