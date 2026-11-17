/**
 * Browser half of dsh-ask-timer.
 *
 * 1. A compact countdown in the Session header's utility row while
 *    ask_user_question waits for this user.
 * 2. One settings component registered both as the independent "答题倒计时"
 *    Settings page and as this plugin row's configuration page: import a chime
 *    file, preview it, drag the volume, switch the chime, and configure the
 *    per-second countdown ticks.
 *
 * The deadline comes from the running run_code call (its own timeoutMs argument,
 * falling back to the configured window) because a PTC-nested question is bounded
 * by that program budget. A timed question's own carrier countdown wins when the
 * Host attached one. Questions without either deadline show elapsed wait time.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ask-timer',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Defaults mirrored by the Host settings route. */
    const DEFAULTS = {
      soundEnabled: true,
      volume: 0.7,
      fallbackWindowMs: 600000,
      countdownEnabled: true,
      countdownSeconds: 10,
      hasAudio: false,
      audioUrl: '/api/ask-timer/audio',
      audioVersion: '',
      audioSource: 'none',
      audioName: '',
      maxBytes: 8 * 1024 * 1024,
    }

    const BUTTON_STYLE = {
      height: '30px',
      padding: '0 12px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '12px',
      cursor: 'pointer',
    }

    const settings = { ...DEFAULTS }
    let configRequested = false
    let settingsVersion = 0
    const settingsListeners = new Set()
    /** Client-clock first sighting of one question key. */
    const firstSeen = new Map()
    let audioContext = null
    let audioUnlocked = false
    let saveTimer
    /** Chime keys already played; survives component remounts and session switches. */
    const playedChimes = new Set()
    /** Last ticked second per question key; shared by every countdown surface. */
    const lastTickSecond = new Map()
    /** Test questions with a Host-enforced window, keyed by question id. */
    const testQuestions = new Map()
    /** Normal run_code questions' absolute deadlines, keyed by sound identity. */
    const detachedDeadlines = new Map()
    let testTicker

    /** Notify the settings page after a settings change or config refresh. */
    function bumpSettings() {
      settingsVersion += 1
      for (const listener of settingsListeners) listener()
    }

    /** @param listener - settings change listener. @returns its unsubscribe. */
    function subscribeSettings(listener) {
      settingsListeners.add(listener)
      return () => { settingsListeners.delete(listener) }
    }

    /** @returns current settings version snapshot. */
    function settingsSnapshot() {
      return settingsVersion
    }

    /**
     * Fetch the Host settings; a forced call re-reads them after a save.
     * @param force - read again even when a request already ran.
     * @returns the load promise.
     */
    function loadConfig(force) {
      if (configRequested && force !== true) return Promise.resolve()
      configRequested = true
      return (async () => {
        for (const path of ['api/ask-timer/config', '/api/ask-timer/config']) {
          try {
            const response = await fetch(path, { headers: { accept: 'application/json' } })
            if (!response.ok) continue
            const value = await response.json()
            if (value && typeof value === 'object') {
              Object.assign(settings, value)
              if (typeof value.volume === 'number') settings.volume = Math.min(1, Math.max(0, value.volume))
              bumpSettings()
            }
            return
          } catch {
            // Try the absolute form next; a 404 also falls through.
          }
        }
      })()
    }

    /** @returns whether the UI language is Chinese. */
    function isZh() {
      const lang = String((typeof document !== 'undefined' && document.documentElement && document.documentElement.lang)
        || (typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
      return lang.indexOf('zh') === 0
    }

    /** Localized copy for the badge and the settings page. */
    function copy() {
      return isZh()
        ? {
          answer: '答题',
          review: '计划审核',
          waiting: '等待中',
          continued: '可稍后回答',
          replay: '点击可重播提示音',
          deadlineTip: '本次截止窗口',
          noDeadlineTip: '该问题没有截止时间',
          title: '答题倒计时',
          desc: '当 DeepSeek Harness 等你回答 ask_user_question 时，会话标题栏右侧会显示剩余时间；问题出现时响一次提示音，最后几秒每秒响一次倒计时音效。',
          audioTitle: '提示音',
          builtin: '当前使用内置双音提示',
          bundled: '当前使用插件自带的默认音效',
          imported: (name) => '当前使用导入的音频：' + name,
          configured: (name) => '当前使用配置文件指定的音频：' + name,
          choose: '选择音频文件',
          preview: '播放预览',
          clear: '恢复内置',
          busy: '处理中…',
          uploaded: '已导入并切换到这个音频。',
          cleared: '已删除导入的音频。',
          tooBig: '文件太大（上限 8 MB）',
          volume: '音量',
          sound: '启用提示音',
          soundHint: '总开关；关闭后不播放任何声音，只显示倒计时。',
          countdownTitle: '倒计时音效',
          countdownHint: '最后 N 秒每秒响一次短促的滴答声（不会重复播放完整提示音）。',
          countdownSecondsLabel: '最后几秒',
          secondsUnit: '秒',
          note: '支持 mp3 / wav / ogg / m4a / flac / webm，最大 8 MB。导入文件、音量、开关和倒计时设置会保存在 DSH 数据目录。浏览器要求页面先有一次点击才允许发声；如果预览没声音，先点一下页面再试。',
        }
        : {
          answer: 'Answer',
          review: 'Review',
          waiting: 'waiting',
          continued: 'answer later',
          replay: 'Click to replay the chime',
          deadlineTip: 'this deadline',
          noDeadlineTip: 'this question has no deadline',
          title: 'Answer timer',
          desc: 'While DeepSeek Harness waits for your answer to ask_user_question, a countdown appears in the Session header; the chime plays when the question appears and short ticks play once per second near the end.',
          audioTitle: 'Chime',
          builtin: 'Using the built-in two-tone chime',
          bundled: 'Using the default chime shipped with the plugin',
          imported: (name) => 'Using imported audio: ' + name,
          configured: (name) => 'Using audio from config: ' + name,
          choose: 'Choose audio file',
          preview: 'Preview',
          clear: 'Use built-in',
          busy: 'Working…',
          uploaded: 'Imported and switched to this audio file.',
          cleared: 'Imported audio removed.',
          tooBig: 'File is too large (8 MB max)',
          volume: 'Volume',
          sound: 'Enable chime',
          soundHint: 'Master switch; when off, nothing plays and only the countdown remains.',
          countdownTitle: 'Countdown ticks',
          countdownHint: 'A short tick once per second during the last N seconds (the full chime is not repeated).',
          countdownSecondsLabel: 'Last',
          secondsUnit: 's',
          note: 'mp3 / wav / ogg / m4a / flac / webm, up to 8 MB. The imported file and these controls are stored in the DSH data directory. Browsers require one click before audio can play; click the page once, then Preview.',
        }
    }

    /** Resume the audio context on the first real gesture. */
    function unlockAudio() {
      if (audioUnlocked) return
      audioUnlocked = true
      try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext
        if (AudioCtor) {
          audioContext = audioContext || new AudioCtor()
          if (audioContext.state === 'suspended') void audioContext.resume()
        }
      } catch {
        // Sound is optional; a blocked context stays silent.
      }
      window.removeEventListener('pointerdown', unlockAudio, true)
    }

    /** Synthesize the fallback two-tone chime. */
    function beep() {
      try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext
        if (!AudioCtor) return
        audioContext = audioContext || new AudioCtor()
        if (audioContext.state === 'suspended') void audioContext.resume()
        const start = audioContext.currentTime
        const volume = Math.min(1, Math.max(0.001, Number(settings.volume) || DEFAULTS.volume))
        ;[880, 660].forEach((frequency, index) => {
          const oscillator = audioContext.createOscillator()
          const gain = audioContext.createGain()
          oscillator.type = 'sine'
          oscillator.frequency.value = frequency
          const at = start + index * 0.18
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(volume, at + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
          oscillator.connect(gain)
          gain.connect(audioContext.destination)
          oscillator.start(at)
          oscillator.stop(at + 0.17)
        })
      } catch {
        // A blocked AudioContext cannot be forced.
      }
    }

    /**
     * Play the current audio source; the explicit Preview bypasses the sound switch.
     * @param force - play even when soundEnabled is off.
     */
    function playCurrent(force) {
      if (force !== true && settings.soundEnabled === false) return
      if (settings.hasAudio && typeof settings.audioUrl === 'string' && settings.audioUrl !== '') {
        try {
          const version = typeof settings.audioVersion === 'string' && settings.audioVersion !== ''
            ? '?v=' + encodeURIComponent(settings.audioVersion) : ''
          const audio = new Audio(settings.audioUrl + version)
          audio.volume = Math.min(1, Math.max(0, Number(settings.volume) || DEFAULTS.volume))
          const playing = audio.play()
          if (playing && typeof playing.catch === 'function') playing.catch(() => beep())
          return
        } catch {
          // Fall through to the synthesized tone.
        }
      }
      beep()
    }

    /** Play the chime for the badge/notification path. */
    function chime() {
      playCurrent(false)
    }

    /**
     * Play the chime once per question identity, even when the badge remounts
     * after a session switch or the request tracker fires too.
     * @param key - stable question identity.
     */
    function chimeOnce(key) {
      if (typeof key !== 'string' || key === '') return
      if (playedChimes.has(key)) return
      playedChimes.add(key)
      if (playedChimes.size > 300) playedChimes.clear()
      chime()
    }

    /**
     * Play at most one tick per question per second, even when both countdown
     * surfaces are mounted or one remounts on a session switch.
     * @param key - stable question identity.
     * @param second - remaining whole second.
     * @param urgent - higher tick pitch.
     */
    function tickOnce(key, second, urgent) {
      if (typeof key !== 'string' || key === '') return
      if (lastTickSecond.get(key) === second) return
      lastTickSecond.set(key, second)
      if (lastTickSecond.size > 300) lastTickSecond.clear()
      tick(urgent)
    }

    /** Start the module-level tick scheduler if it is idle. */
    function ensureTicker() {
      if (testTicker !== undefined) return
      testTicker = window.setInterval(() => {
        const now = Date.now()
        const enabled = settings.countdownEnabled !== false
        const limit = Math.max(1, Math.trunc(Number(settings.countdownSeconds) || DEFAULTS.countdownSeconds))
        for (const [id, entry] of [...testQuestions.entries()]) {
          const remaining = Math.max(0, Math.ceil((entry.start + entry.windowMs - now) / 1000))
          if (remaining <= 0) {
            testQuestions.delete(id)
            continue
          }
          if (enabled && remaining <= limit) tickOnce('test:' + id, remaining, remaining <= 3)
        }
        for (const [key, deadline] of [...detachedDeadlines.entries()]) {
          const remaining = Math.max(0, Math.ceil((deadline - now) / 1000))
          if (remaining <= 0) {
            detachedDeadlines.delete(key)
            continue
          }
          if (enabled && remaining <= limit) tickOnce(key, remaining, remaining <= 3)
        }
        if (testQuestions.size === 0 && detachedDeadlines.size === 0 && testTicker !== undefined) {
          window.clearInterval(testTicker)
          testTicker = undefined
        }
      }, 250)
    }

    /**
     * Register a test question's absolute window for the detached tick scheduler.
     * @param id - stable test question id.
     * @param windowMs - foreground window in ms.
     */
    function trackTestQuestion(id, windowMs) {
      if (id === '' || !(windowMs > 0)) return
      if (!testQuestions.has(id)) testQuestions.set(id, { start: Date.now(), windowMs })
      ensureTicker()
    }

    /**
     * Drop a settled test question and stop the scheduler when nothing is left.
     * @param id - stable test question id.
     */
    function forgetTestQuestion(id) {
      if (id === '') return
      testQuestions.delete(id)
      if (testQuestions.size === 0 && detachedDeadlines.size === 0 && testTicker !== undefined) {
        window.clearInterval(testTicker)
        testTicker = undefined
      }
    }

    /**
     * Short countdown tick, once per second near the deadline.
     * @param urgent - higher pitch for the final seconds.
     */
    function tick(urgent) {
      if (settings.soundEnabled === false) return
      try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext
        if (!AudioCtor) return
        audioContext = audioContext || new AudioCtor()
        if (audioContext.state === 'suspended') void audioContext.resume()
        const start = audioContext.currentTime
        const oscillator = audioContext.createOscillator()
        const gain = audioContext.createGain()
        oscillator.type = 'square'
        oscillator.frequency.value = urgent ? 1568 : 1046
        const volume = Math.min(1, Math.max(0.001, (Number(settings.volume) || DEFAULTS.volume) * 0.7))
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(volume, start + 0.005)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.055)
        oscillator.connect(gain)
        gain.connect(audioContext.destination)
        oscillator.start(start)
        oscillator.stop(start + 0.06)
      } catch {
        // A blocked AudioContext cannot be forced.
      }
    }

    /**
     * Same-origin request with the document-relative and absolute base forms.
     * @param path - route path without a leading slash.
     * @param init - fetch init.
     * @returns the response.
     */
    async function send(path, init) {
      let lastError
      for (const candidate of [path, '/' + path]) {
        try {
          const response = await fetch(candidate, init)
          if (response.status === 404 && candidate === path) {
            lastError = new Error('HTTP 404')
            continue
          }
          return response
        } catch (error) {
          lastError = error
        }
      }
      throw lastError instanceof Error ? lastError : new Error('request failed')
    }

    /**
     * Persist live preferences and adopt the merged response.
     * @param patch - volume, soundEnabled, countdownEnabled and/or countdownSeconds.
     * @returns the host's merged settings.
     */
    async function savePrefs(patch) {
      const response = await send('api/ask-timer/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + String(response.status)))
      const value = await response.json()
      if (value && typeof value === 'object') {
        Object.assign(settings, value)
        if (typeof value.volume === 'number') settings.volume = Math.min(1, Math.max(0, value.volume))
        bumpSettings()
      }
    }

    /** @param seconds - nonnegative seconds. @returns m:ss. */
    function clock(seconds) {
      const total = Math.max(0, Math.floor(seconds))
      const minutes = Math.floor(total / 60)
      const rest = total % 60
      return String(minutes) + ':' + String(rest).padStart(2, '0')
    }

    /**
     * Newest running root run_code call.
     * @param running - Chat running-call list.
     * @returns the call, or undefined.
     */
    function runningRunCode(running) {
      let best
      for (const call of running || []) {
        if (!call || call.name !== 'run_code' || call.phase !== 'start') continue
        if (best === undefined || call.time > best.time) best = call
      }
      return best
    }

    /**
     * Read the model's explicit timeoutMs argument when it was supplied.
     * @param call - started run_code call.
     * @returns the positive budget, or undefined.
     */
    function requestedTimeout(call) {
      try {
        const value = call.args && typeof call.args.value === 'function' ? call.args.value('timeoutMs') : undefined
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
      } catch {
        // Partial arguments are normal while the call is still preparing.
      }
      return undefined
    }

    /**
     * Header countdown entry.
     * @param props - Session-scoped slot props (sessionId, useSessionStatus, useChat).
     * @returns the badge element, or null while no question waits.
     */
    function AskTimerBadge(props) {
      const sessionId = props && props.sessionId
      const useSessionStatus = props && props.useSessionStatus
      const useChat = props && props.useChat
      const [now, setNow] = React.useState(() => Date.now())

      const pending = useSessionStatus((statuses) => {
        if (!statuses || typeof statuses.get !== 'function') return undefined
        const status = statuses.get(sessionId)
        return status === undefined ? undefined : status.pendingInteraction
      })
      const running = useChat(snapshot => snapshot && snapshot.legacy ? snapshot.legacy.runningCalls : undefined)
      const run = runningRunCode(running)

      const question = pending && (pending.kind === 'question' || pending.kind === 'plan-review') ? pending : undefined
      const questionKey = question === undefined ? undefined : question.key
      let card
      try {
        card = question === undefined ? undefined : question.snapshot()
      } catch {
        card = undefined
      }
      const firstQuestion = question === undefined ? undefined : (question.questions && question.questions[0])
      const testWindow = testWindowOf(firstQuestion)
      const shown = question !== undefined && !(card && card.closed === true)
      const firstSeenKey = testWindow > 0 && firstQuestion && typeof firstQuestion.id === 'string'
        ? 'seen:' + firstQuestion.id
        : questionKey
      const soundKey = testWindow > 0 && firstQuestion && typeof firstQuestion.id === 'string'
        ? 'test:' + firstQuestion.id
        : run !== undefined && firstQuestion && typeof firstQuestion.id === 'string'
          ? 'q:' + firstQuestion.id + ':' + run.time
          : questionKey

      // Remember when this question first appeared for the no-deadline case.
      React.useEffect(() => {
        if (firstSeenKey === undefined) return
        if (!firstSeen.has(firstSeenKey)) firstSeen.set(firstSeenKey, Date.now())
        if (firstSeen.size > 300) firstSeen.clear()
      }, [firstSeenKey])

      // Chime once per question identity; remounts do not replay it.
      const previousKey = React.useRef(undefined)
      React.useEffect(() => {
        if (questionKey === undefined) {
          previousKey.current = undefined
          return
        }
        if (previousKey.current !== questionKey) {
          previousKey.current = questionKey
          chimeOnce(soundKey)
        }
      }, [questionKey])

      // Tick only while the badge is shown; refresh the clock on each appearance.
      React.useEffect(() => {
        if (!shown) return undefined
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 250)
        return () => window.clearInterval(timer)
      }, [shown, questionKey])

      const t = copy()
      const carrier = card && card.countdown && typeof card.countdown.remainingMs === 'number' ? card.countdown : undefined

      let remainingSeconds
      let budgetMs = settings.fallbackWindowMs
      let deadlineKnown = false

      if (carrier !== undefined) {
        remainingSeconds = Math.max(0, Math.ceil(carrier.remainingMs / 1000))
        deadlineKnown = true
      } else if (run !== undefined) {
        const requested = requestedTimeout(run)
        budgetMs = requested === undefined ? settings.fallbackWindowMs : requested
        remainingSeconds = Math.max(0, Math.ceil((run.time + budgetMs - now) / 1000))
        deadlineKnown = true
      } else if (testWindow > 0) {
        const since = firstSeen.get(firstSeenKey)
        if (since !== undefined) {
          budgetMs = testWindow
          remainingSeconds = Math.max(0, Math.ceil((since + testWindow - now) / 1000))
          deadlineKnown = true
        }
      }

      // One short tick per second during the configured final seconds, shared
      // with the floating overlay so a remount cannot double it.
      React.useEffect(() => {
        if (!shown || settings.countdownEnabled === false) return
        if (remainingSeconds === undefined) return
        const limit = Math.max(1, Math.trunc(Number(settings.countdownSeconds) || DEFAULTS.countdownSeconds))
        if (remainingSeconds > limit) return
        tickOnce(
          soundKey,
          remainingSeconds,
          remainingSeconds <= 3 || remainingSeconds === 0,
        )
      }, [shown, questionKey, remainingSeconds])

      // Keep ticking a normal run_code question even after this badge unmounts
      // (the user switched to another page). Timed carrier questions are skipped
      // because their foreground countdown pauses by design.
      React.useEffect(() => {
        if (!shown || testWindow > 0 || carrier !== undefined || !deadlineKnown || run === undefined) return
        if (soundKey === undefined) return
        detachedDeadlines.set(soundKey, run.time + budgetMs)
        ensureTicker()
      }, [shown, questionKey, remainingSeconds, soundKey])

      const lastDeadlineKey = React.useRef(undefined)
      React.useEffect(() => {
        const nextKey = questionKey === undefined ? undefined : soundKey
        if (lastDeadlineKey.current !== undefined && lastDeadlineKey.current !== nextKey) {
          detachedDeadlines.delete(lastDeadlineKey.current)
        }
        lastDeadlineKey.current = nextKey
      }, [questionKey, soundKey])


      if (!shown) return null

      const zh = isZh()
      const label = question.kind === 'plan-review' ? t.review : t.answer
      const continued = card && card.waitState === 'continued'
      let text
      let tip
      if (continued) {
        text = label + ' · ' + t.continued
        tip = label + ' · ' + t.continued + ' · ' + t.replay
      } else if (deadlineKnown) {
        text = label + ' ' + clock(remainingSeconds)
        tip = label + '：剩余 ' + clock(remainingSeconds) + '（' + t.deadlineTip + ' ' + clock(Math.round(budgetMs / 1000)) + '） · ' + t.replay
      } else {
        const since = firstSeen.get(firstSeenKey)
        const elapsed = Math.max(0, Math.floor((now - (since === undefined ? now : since)) / 1000))
        text = label + ' ' + t.waiting + ' ' + clock(elapsed)
        tip = label + '：' + t.waiting + ' ' + clock(elapsed) + '（' + t.noDeadlineTip + '） · ' + t.replay
      }

      const countdownLimit = Math.max(1, Math.trunc(Number(settings.countdownSeconds) || DEFAULTS.countdownSeconds))
      const urgent = deadlineKnown && remainingSeconds !== undefined
        && remainingSeconds <= (settings.countdownEnabled === false ? 10 : countdownLimit)
      const style = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '26px',
        padding: '0 9px',
        borderRadius: '999px',
        border: '1px solid ' + (urgent ? 'rgba(229, 72, 77, 0.5)' : 'var(--dsw-alias-border-l1)'),
        background: urgent ? 'rgba(229, 72, 77, 0.12)' : 'var(--dsw-alias-bg-layer-1)',
        color: urgent ? 'var(--dsw-alias-label-danger, #e5484d)' : 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        cursor: 'pointer',
      }

      return h('button', {
        type: 'button',
        style,
        title: tip,
        'aria-label': tip,
        'data-ask-timer': questionKey,
        onClick: () => chime(),
      },
        h('span', { style: { fontSize: '13px', lineHeight: 1 } }, urgent ? '⏰' : '⏳'),
        h('span', null, text),
      )
    }

    /**
     * Foreground window encoded in a /ask-timer-test question id.
     * @param question - one question item.
     * @returns the window in ms, or 0 when the question is not a test question.
     */
    function testWindowOf(question) {
      if (!question || typeof question.id !== 'string' || question.id.indexOf('ask-timer-test-') !== 0) return 0
      const parts = question.id.split('-')
      const windowMs = Number(parts[parts.length - 1])
      return Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0
    }

    /** Settings form for the chime file, preview, volume, and countdown ticks. */
    function AudioSettings() {
      React.useSyncExternalStore(subscribeSettings, settingsSnapshot)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(undefined)
      const [saveError, setSaveError] = React.useState(undefined)
      const t = copy()
      const source = settings.audioSource === 'imported' || settings.audioSource === 'configured'
        || settings.audioSource === 'bundled' ? settings.audioSource : 'none'
      const name = typeof settings.audioName === 'string' ? settings.audioName : ''
      const status = source === 'imported' ? t.imported(name)
        : source === 'configured' ? t.configured(name)
          : source === 'bundled' ? t.bundled : t.builtin
      const volume = Math.min(1, Math.max(0, Number(settings.volume) || DEFAULTS.volume))
      const countdownSeconds = Math.max(1, Math.trunc(Number(settings.countdownSeconds) || DEFAULTS.countdownSeconds))

      /** @param patch - preference patch. */
      async function persist(patch) {
        try {
          await savePrefs(patch)
          setSaveError(undefined)
        } catch (error) {
          setSaveError(String((error && error.message) || error))
          void loadConfig(true)
        }
      }

      /** @param file - picked file. */
      async function upload(file) {
        setBusy(true)
        setMessage(undefined)
        try {
          if (file.size > (Number(settings.maxBytes) || DEFAULTS.maxBytes)) throw new Error(t.tooBig)
          const response = await send('api/ask-timer/audio', {
            method: 'POST',
            headers: {
              'content-type': file.type || 'application/octet-stream',
              'x-audio-name': encodeURIComponent(file.name),
            },
            body: file,
          })
          if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + String(response.status)))
          await loadConfig(true)
          setMessage({ ok: true, text: t.uploaded })
          playCurrent(true)
        } catch (error) {
          setMessage({ ok: false, text: String((error && error.message) || error) })
        } finally {
          setBusy(false)
        }
      }

      /** Remove the imported file and fall back to config or the packaged default. */
      async function clearImported() {
        setBusy(true)
        setMessage(undefined)
        try {
          const response = await send('api/ask-timer/audio', { method: 'DELETE' })
          if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + String(response.status)))
          await loadConfig(true)
          setMessage({ ok: true, text: t.cleared })
        } catch (error) {
          setMessage({ ok: false, text: String((error && error.message) || error) })
        } finally {
          setBusy(false)
        }
      }

      /** @param event - file input change. */
      function onPick(event) {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (file) void upload(file)
      }

      /** Persist the two debounced numeric controls together. */
      function scheduleSave() {
        if (saveTimer !== undefined) window.clearTimeout(saveTimer)
        saveTimer = window.setTimeout(() => {
          saveTimer = undefined
          void persist({ volume: settings.volume, countdownSeconds: settings.countdownSeconds })
        }, 300)
      }

      /** @param event - range change. */
      function onVolume(event) {
        const next = Math.min(1, Math.max(0, Number(event.target.value)))
        settings.volume = next
        bumpSettings()
        scheduleSave()
      }

      /** @param event - switch change. */
      function onSound(event) {
        const enabled = event.target.checked === true
        settings.soundEnabled = enabled
        bumpSettings()
        void persist({ soundEnabled: enabled })
      }

      /** @param event - countdown switch change. */
      function onCountdown(event) {
        const enabled = event.target.checked === true
        settings.countdownEnabled = enabled
        bumpSettings()
        void persist({ countdownEnabled: enabled })
      }

      /** @param event - countdown seconds change. */
      function onCountdownSeconds(event) {
        const next = Math.min(300, Math.max(1, Math.trunc(Number(event.target.value) || DEFAULTS.countdownSeconds)))
        settings.countdownSeconds = next
        bumpSettings()
        scheduleSave()
      }

      const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }
      const labelStyle = { width: '88px', flex: 'none', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' }
      const hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }
      const inputStyle = {
        height: '26px',
        width: '72px',
        padding: '0 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
      }

      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '680px' } },
        h('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t.title),
        h('p', { style: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } }, t.desc),
        h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            padding: '14px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '12px',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
          h('div', { style: rowStyle },
            h('span', { style: labelStyle }, t.audioTitle),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 } },
              h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } }, status),
              h('div', { style: rowStyle },
                h('input', {
                  type: 'file',
                  accept: 'audio/*,.mp3,.wav,.ogg,.oga,.m4a,.flac,.webm',
                  disabled: busy,
                  onChange: onPick,
                  style: { fontSize: '12px', maxWidth: '100%', color: 'var(--dsw-alias-label-primary)' },
                }),
                h('button', {
                  type: 'button',
                  disabled: busy,
                  style: BUTTON_STYLE,
                  onClick: () => playCurrent(true),
                }, t.preview),
                source === 'imported' ? h('button', {
                  type: 'button',
                  disabled: busy,
                  style: BUTTON_STYLE,
                  onClick: () => void clearImported(),
                }, t.clear) : null,
                busy ? h('span', { style: hintStyle }, t.busy) : null,
              ),
            ),
          ),
          h('div', { style: rowStyle },
            h('span', { style: labelStyle }, t.volume),
            h('input', {
              type: 'range',
              min: '0',
              max: '1',
              step: '0.05',
              value: String(volume),
              'aria-label': t.volume,
              onChange: onVolume,
              style: { width: '220px', accentColor: 'var(--dsw-alias-brand-primary)' },
            }),
            h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } }, String(Math.round(volume * 100)) + '%'),
          ),
          h('div', { style: rowStyle },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: settings.soundEnabled !== false,
                onChange: onSound,
                style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary)' },
              }),
              t.sound,
            ),
            h('span', { style: hintStyle }, t.soundHint),
          ),
          h('div', { style: rowStyle },
            h('span', { style: labelStyle }, t.countdownTitle),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: settings.countdownEnabled !== false,
                onChange: onCountdown,
                style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary)' },
              }),
              t.countdownSecondsLabel,
            ),
            h('input', {
              type: 'number',
              min: '1',
              max: '300',
              step: '1',
              value: String(countdownSeconds),
              disabled: settings.countdownEnabled === false,
              'aria-label': t.countdownTitle,
              onChange: onCountdownSeconds,
              style: inputStyle,
            }),
            h('span', { style: hintStyle }, t.secondsUnit),
            h('span', { style: hintStyle }, t.countdownHint),
          ),
          message === undefined ? null : h('div', {
            style: {
              fontSize: '12px',
              color: message.ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-danger, #e5484d)',
            },
          }, message.text),
          saveError === undefined ? null : h('div', {
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-danger, #e5484d)' },
          }, saveError),
          h('div', { style: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } }, t.note),
        ),
      )
    }

    /**
     * Plugin-row configuration entry: a one-liner in the summary row and the full
     * form on the row's configuration page.
     * @param props - { view, form } from the plugin manager.
     * @returns summary text or the form.
     */
    function RowConfigEntry(props) {
      if (props && props.view === 'summary') {
        const t = copy()
        const source = settings.audioSource
        const status = source === 'imported' ? t.imported(settings.audioName || '')
          : source === 'configured' ? t.configured(settings.audioName || '')
            : source === 'bundled' ? t.bundled : t.builtin
        return h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, status)
      }
      return h(AudioSettings)
    }

    return {
      inject: ['slots', 'remote'],
      apply(ctx) {
        loadConfig()
        try {
          window.addEventListener('pointerdown', unlockAudio, true)
        } catch {
          // Older shells still show the badge; only the fallback tone needs this.
        }
        ctx.effect(() => {
          const dispose = ctx.remote.$on('user-questions/request', (request, next) => {
            const questions = request && Array.isArray(request.questions) ? request.questions : []
            const first = questions[0]
            const id = first && typeof first.id === 'string' ? first.id : ''
            const windowMs = testWindowOf(first)
            if (windowMs > 0 && id !== '') {
              const seenKey = 'seen:' + id
              if (!firstSeen.has(seenKey)) firstSeen.set(seenKey, Date.now())
              trackTestQuestion(id, windowMs)
              chimeOnce('test:' + id)
            }
            const result = typeof next === 'function' ? next() : undefined
            if (windowMs > 0 && id !== '') {
              const end = () => { forgetTestQuestion(id) }
              if (result && typeof result.then === 'function') result.then(end, end)
              else end()
              if (request && request.signal && typeof request.signal.addEventListener === 'function') {
                request.signal.addEventListener('abort', end, { once: true })
              }
            }
            return result
          })
          return () => { if (typeof dispose === 'function') dispose() }
        }, 'ask-timer: question chime')
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'ask-timer.badge', order: 45 },
            AskTimerBadge,
          ))
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'ask-timer', order: 80, label: '答题倒计时 / Ask timer' },
            AudioSettings,
          ))
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: 'dsh-ask-timer#ask-timer' },
            RowConfigEntry,
          ))
      },
    }
  },
})