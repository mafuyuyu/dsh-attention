/**
 * Browser half of dsh-attention.
 *
 * Two independent reminder groups:
 * - answer: Session-header countdown while ask_user_question waits, one chime
 *   when the question appears, and a per-second tick in the last N seconds.
 * - approval: a headless watcher on the global pending-interaction store that
 *   chimes when a permission approval appears and repeats every configured
 *   interval until the approval settles. No countdown is drawn for approvals.
 *
 * Both groups have their own imported audio, volume and switches.
 */
window.__ModuleLoader__.load({
  id: 'dsh-attention',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const DEFAULT_GROUP = (group) => group === 'answer'
      ? {
        enabled: true,
        volume: 0.7,
        countdownEnabled: true,
        countdownSeconds: 10,
        systemNotification: false,
        hasAudio: false,
        audioUrl: '/api/attention/audio?group=answer',
        audioVersion: '',
        audioSource: 'none',
        audioName: '',
      }
      : {
        enabled: true,
        volume: 0.7,
        repeatEnabled: true,
        intervalSeconds: 60,
        systemNotification: false,
        hasAudio: false,
        audioUrl: '/api/attention/audio?group=approval',
        audioVersion: '',
        audioSource: 'none',
        audioName: '',
      }

    const DEFAULTS = {
      fallbackWindowMs: 600000,
      maxBytes: 8 * 1024 * 1024,
      answer: DEFAULT_GROUP('answer'),
      approval: DEFAULT_GROUP('approval'),
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

    const settings = {
      fallbackWindowMs: DEFAULTS.fallbackWindowMs,
      maxBytes: DEFAULTS.maxBytes,
      answer: { ...DEFAULTS.answer },
      approval: { ...DEFAULTS.approval },
    }
    let configRequested = false
    let settingsVersion = 0
    const settingsListeners = new Set()
    /** Client-clock first sighting of one question identity. */
    const firstSeen = new Map()
    let audioContext = null
    let audioUnlocked = false
    let saveTimer
    /** Preference patches accumulated across the debounce window. */
    let pendingSave = { answer: {}, approval: {} }
    /** Chime keys already played; survives component remounts and session switches. */
    const playedChimes = new Set()
    /** Last ticked second per question key; shared by every countdown surface. */
    const lastTickSecond = new Map()
    /** Test questions with a Host-enforced window, keyed by question id. */
    const testQuestions = new Map()
    let testTicker
    /** Active approval reminders keyed by session + interaction key. */
    const approvalReminders = new Map()
    /** Pending system notifications keyed by session + interaction key. */
    const pendingNotifications = new Map()
    /** Last observed system-notification capability, for the settings page. */
    const notificationProbe = { support: 'unknown', permission: 'unknown', error: '' }

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

    /** @param group - answer or approval. @returns that group's settings. */
    function groupSettings(group) {
      return group === 'approval' ? settings.approval : settings.answer
    }

    /** @param value - raw volume. @returns a 0-1 volume. */
    function clampVolume(value) {
      const number = Number(value)
      return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0.7
    }

    /** Apply one config payload from the Host. */
    function applyConfig(value) {
      if (!value || typeof value !== 'object') return
      if (Number.isFinite(Number(value.fallbackWindowMs))) settings.fallbackWindowMs = Number(value.fallbackWindowMs)
      if (Number.isFinite(Number(value.maxBytes))) settings.maxBytes = Number(value.maxBytes)
      if (value.answer && typeof value.answer === 'object') {
        Object.assign(settings.answer, value.answer)
        settings.answer.volume = clampVolume(settings.answer.volume)
      }
      if (value.approval && typeof value.approval === 'object') {
        Object.assign(settings.approval, value.approval)
        settings.approval.volume = clampVolume(settings.approval.volume)
      }
      bumpSettings()
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
        for (const path of ['api/attention/config', '/api/attention/config']) {
          try {
            const response = await fetch(path, { headers: { accept: 'application/json' } })
            if (!response.ok) continue
            applyConfig(await response.json())
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
          answerLabel: '答题',
          reviewLabel: '计划审核',
          waiting: '等待中',
          continued: '可稍后回答',
          replay: '点击可重播提示音',
          deadlineTip: '本次截止窗口',
          noDeadlineTip: '该问题没有截止时间',
          title: '答题与审批提醒',
          desc: '在 DeepSeek Harness 等待你回答 ask_user_question 时显示倒计时；在工具请求权限审批时按间隔播放提醒音。答题与审批两组提示音、音量和开关互相独立。',
          answerTitle: '答题提醒',
          answerDesc: '提问出现时播放一次提示音，最后 N 秒每秒滴答，标题栏显示剩余时间。',
          approvalTitle: '权限审批提醒',
          approvalDesc: '有工具请求权限审批时立即播放一次提示音，并按设定的间隔重复提醒，直到你批准或拒绝；不显示倒计时。',
          audioTitle: '提示音',
          builtin: '使用内置提示音（兜底）',
          bundled: '使用插件自带的默认音效',
          imported: (name) => '使用导入的音频：' + name,
          configured: (name) => '使用配置文件指定的音频：' + name,
          choose: '选择音频文件',
          preview: '播放预览',
          clear: '恢复内置',
          busy: '处理中…',
          uploaded: '已导入并切换到这个音频。',
          cleared: '已删除导入的音频。',
          tooBig: '文件太大（上限 8 MB）',
          volume: '音量',
          enabled: '启用提示音',
          answerEnabledHint: '关闭后答题不发声，只显示倒计时。',
          approvalEnabledHint: '关闭后权限审批不发声。',
          countdownTitle: '倒计时音效',
          countdownHint: '最后 N 秒每秒响一次短促滴答。',
          countdownSecondsLabel: '最后几秒',
          approvalRepeat: '重复提醒',
          approvalRepeatHint: '关闭后只在审批出现时响一次。',
          approvalInterval: '提醒间隔',
          secondsUnit: '秒',
          systemNotify: '系统气泡通知',
          systemNotifyHint: '只提示“有提问或权限审批在等待”，不显示问题或审批内容。',
          notifyQuestionTitle: '答题等待中',
          notifyQuestionBody: '有一个问题在等待你回答',
          notifyReviewTitle: '计划审核等待中',
          notifyReviewBody: '有一个计划在等待你审核',
          notifyApprovalTitle: '权限审批等待中',
          notifyApprovalBody: '有工具正在等待你的授权',
          testNotify: '发送测试通知',
          notificationPermission: '系统通知权限',
          notifyUnsupported: '当前环境不支持系统通知',
          notifyTestSent: '已发送一条测试通知，请查看系统通知区域。',
          notifyTestFailed: '测试通知失败',
          notifyBlocked: '如果权限是 denied，请在浏览器/系统的网站设置里允许本页通知。',
          note: '支持 mp3 / wav / ogg / m4a / flac / webm，最大 8 MB。两组设置分别保存；导入音频、音量与开关保存在 DSH 数据目录。浏览器要求页面先有一次点击才允许发声；系统气泡通知还需要操作系统允许 DSH 的通知。',
        }
        : {
          answerLabel: 'Answer',
          reviewLabel: 'Review',
          waiting: 'waiting',
          continued: 'answer later',
          replay: 'Click to replay the chime',
          deadlineTip: 'this deadline',
          noDeadlineTip: 'this question has no deadline',
          title: 'Answer & approval alerts',
          desc: 'Shows a countdown while DeepSeek Harness waits for your answer to ask_user_question, and plays a reminder at a chosen interval while a tool asks for permission approval. Answer and approval have independent audio, volume and switches.',
          answerTitle: 'Answer alerts',
          answerDesc: 'One chime when the question appears, a per-second tick in the last N seconds, and a countdown in the Session header.',
          approvalTitle: 'Approval alerts',
          approvalDesc: 'One immediate chime when a permission approval appears, then a reminder at the configured interval until you allow or reject; no countdown is shown.',
          audioTitle: 'Chime',
          builtin: 'Using the synthesized fallback',
          bundled: 'Using the default audio shipped with the plugin',
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
          enabled: 'Enable chime',
          answerEnabledHint: 'When off, answers stay silent and only the countdown remains.',
          approvalEnabledHint: 'When off, approval prompts stay silent.',
          countdownTitle: 'Countdown ticks',
          countdownHint: 'A short tick once per second during the last N seconds.',
          countdownSecondsLabel: 'Last',
          approvalRepeat: 'Repeat',
          approvalRepeatHint: 'When off, the approval chimes once when it appears.',
          approvalInterval: 'Interval',
          secondsUnit: 's',
          systemNotify: 'System notification',
          systemNotifyHint: 'Only says a question or approval is waiting; never shows question or approval content.',
          notifyQuestionTitle: 'Answer needed',
          notifyQuestionBody: 'A question is waiting for your answer',
          notifyReviewTitle: 'Review needed',
          notifyReviewBody: 'A plan is waiting for your review',
          notifyApprovalTitle: 'Approval needed',
          notifyApprovalBody: 'A tool is waiting for your permission',
          testNotify: 'Send test notification',
          notificationPermission: 'System notification permission',
          notifyUnsupported: 'System notifications are not supported here',
          notifyTestSent: 'A test notification was sent; check the system notification area.',
          notifyTestFailed: 'Test notification failed',
          notifyBlocked: 'If permission is denied, allow notifications for this page in the browser or system settings.',
          note: 'mp3 / wav / ogg / m4a / flac / webm, up to 8 MB. The two groups are stored separately in the DSH data directory. Browsers require one click before audio can play; system notifications also need the operating system to allow DSH notifications.',
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

    /** Synthesize the fallback chime for one group. */
    function beepGroup(group) {
      try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext
        if (!AudioCtor) return
        audioContext = audioContext || new AudioCtor()
        if (audioContext.state === 'suspended') void audioContext.resume()
        const start = audioContext.currentTime
        const target = groupSettings(group)
        const volume = Math.min(1, Math.max(0.001, Number(target.volume) || 0.7))
        const tones = group === 'approval' ? [523, 392] : [880, 660]
        tones.forEach((frequency, index) => {
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
     * Play one group's chime.
     * @param group - answer or approval.
     * @param force - play even when the group switch is off (preview).
     */
    function playGroup(group, force) {
      const target = groupSettings(group)
      if (force !== true && target.enabled === false) return
      if (target.hasAudio && typeof target.audioUrl === 'string' && target.audioUrl !== '') {
        try {
          const version = typeof target.audioVersion === 'string' && target.audioVersion !== ''
            ? '&v=' + encodeURIComponent(target.audioVersion) : ''
          const audio = new Audio(target.audioUrl + version)
          audio.volume = clampVolume(target.volume)
          const playing = audio.play()
          if (playing && typeof playing.catch === 'function') playing.catch(() => beepGroup(group))
          return
        } catch {
          // Fall through to the synthesized tone.
        }
      }
      beepGroup(group)
    }

    /**
     * Ask for notification permission once, ideally from a user gesture.
     * @returns the permission promise, or undefined when notifications are unavailable.
     */
    function refreshNotificationProbe() {
      try {
        if (typeof Notification === 'undefined') {
          notificationProbe.support = 'unsupported'
          notificationProbe.permission = 'none'
        } else {
          notificationProbe.support = 'supported'
          notificationProbe.permission = Notification.permission
        }
      } catch (error) {
        notificationProbe.support = 'error'
        notificationProbe.error = String((error && error.message) || error)
      }
      return notificationProbe
    }

    function ensureNotificationPermission() {
      try {
        if (typeof Notification === 'undefined') return undefined
        if (Notification.permission === 'granted' || Notification.permission === 'denied') {
          notificationProbe.permission = Notification.permission
          return Promise.resolve(Notification.permission)
        }
        const result = Notification.requestPermission()
        if (result && typeof result.then === 'function') {
          return result.then((permission) => {
            notificationProbe.permission = permission
            return permission
          })
        }
        return result
      } catch {
        return undefined
      }
    }

    /**
     * Show one generic system bubble; question and approval content is never included.
     * @param key - stable pending-interaction identity.
     * @param kind - question, plan-review or approval.
     */
    function showSystemNotification(key, kind) {
      try {
        if (typeof Notification === 'undefined') return
        if (Notification.permission === 'denied') return
        if (Notification.permission === 'default') {
          const pending = ensureNotificationPermission()
          if (pending && typeof pending.then === 'function') {
            pending.then((permission) => {
              if (permission === 'granted' && !pendingNotifications.has(key)) showSystemNotification(key, kind)
            }, () => {})
          }
          return
        }
        const labels = copy()
        const title = kind === 'approval' ? labels.notifyApprovalTitle
          : kind === 'plan-review' ? labels.notifyReviewTitle : labels.notifyQuestionTitle
        const body = kind === 'approval' ? labels.notifyApprovalBody
          : kind === 'plan-review' ? labels.notifyReviewBody : labels.notifyQuestionBody
        const notification = new Notification(title, {
          body,
          silent: true,
          requireInteraction: true,
          tag: 'dsh-attention:' + key,
        })
        notification.onclick = () => {
          try { window.focus() } catch {
            // The OS still activates DSH from the notification click.
          }
          try { notification.close() } catch {
            // Already dismissed.
          }
          pendingNotifications.delete(key)
        }
        pendingNotifications.set(key, notification)
        notificationProbe.error = ''
      } catch (error) {
        notificationProbe.error = String((error && error.message) || error)
        // Notifications are optional; audio reminders keep working.
      }
    }

    /**
     * Close one pending system bubble.
     * @param key - stable pending-interaction identity.
     */
    function closeSystemNotification(key) {
      const notification = pendingNotifications.get(key)
      if (notification === undefined) return
      pendingNotifications.delete(key)
      try { notification.close() } catch {
        // Already dismissed.
      }
    }

    /**
     * Show or close system bubbles for the current pending interactions.
     * Only the interaction kind is read; question and approval content is never touched.
     * @param statuses - Session status map from useSessionStatus.
     */
    function syncSystemNotifications(statuses) {
      const active = new Map()
      if (statuses && typeof statuses.forEach === 'function') {
        statuses.forEach((status, sessionId) => {
          const pending = status && status.pendingInteraction
          if (!pending) return
          const kind = pending.kind
          if (kind !== 'question' && kind !== 'plan-review' && kind !== 'approval') return
          const group = kind === 'approval' ? 'approval' : 'answer'
          if (groupSettings(group).systemNotification !== true) return
          active.set(String(sessionId) + ':' + String(pending.key), kind)
        })
      }
      for (const key of [...pendingNotifications.keys()]) {
        if (!active.has(key)) closeSystemNotification(key)
      }
      for (const [key, kind] of active) {
        if (!pendingNotifications.has(key)) showSystemNotification(key, kind)
      }
    }

    /** Short countdown tick, once per second near the deadline. */
    function tick(urgent) {
      const target = settings.answer
      if (target.enabled === false) return
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
        const volume = Math.min(1, Math.max(0.001, clampVolume(target.volume) * 0.7))
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
     * Play the chime once per question identity.
     * @param key - stable question identity.
     * @param group - answer or approval.
     */
    function chimeOnce(key, group) {
      if (typeof key !== 'string' || key === '') return
      if (playedChimes.has(key)) return
      playedChimes.add(key)
      if (playedChimes.size > 300) playedChimes.clear()
      playGroup(group, false)
    }

    /**
     * Play at most one tick per question per second.
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

    /** Start the module-level question tick scheduler if it is idle. */
    function ensureTicker() {
      if (testTicker !== undefined) return
      testTicker = window.setInterval(() => {
        const now = Date.now()
        const enabled = settings.answer.countdownEnabled !== false
        const limit = Math.max(1, Math.trunc(Number(settings.answer.countdownSeconds) || 10))
        for (const [id, entry] of [...testQuestions.entries()]) {
          const remaining = Math.max(0, Math.ceil((entry.start + entry.windowMs - now) / 1000))
          if (remaining <= 0) {
            testQuestions.delete(id)
            continue
          }
          if (enabled && remaining <= limit) tickOnce('test:' + id, remaining, remaining <= 3)
        }
        if (testQuestions.size === 0 && testTicker !== undefined) {
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
      if (testQuestions.size === 0 && testTicker !== undefined) {
        window.clearInterval(testTicker)
        testTicker = undefined
      }
    }

    /** @returns the approval repeat interval in milliseconds. */
    function approvalIntervalMs() {
      return Math.max(1, Math.trunc(Number(settings.approval.intervalSeconds) || 60)) * 1000
    }

    /** @param entry - reminder entry. */
    function stopApprovalTimer(entry) {
      if (entry.timer !== undefined) {
        window.clearInterval(entry.timer)
        entry.timer = undefined
      }
    }

    /** @param entry - reminder entry. */
    function syncApprovalEntry(entry) {
      const group = settings.approval
      const wanted = group.enabled !== false && group.repeatEnabled !== false
      const intervalMs = approvalIntervalMs()
      if (!wanted) {
        stopApprovalTimer(entry)
        return
      }
      if (entry.timer !== undefined && entry.intervalMs === intervalMs) return
      stopApprovalTimer(entry)
      entry.intervalMs = intervalMs
      entry.timer = window.setInterval(() => {
        if (settings.approval.enabled === false || settings.approval.repeatEnabled === false) return
        playGroup('approval', false)
      }, intervalMs)
    }

    /** @param key - approval identity. @param playNow - chime immediately. */
    function startApprovalReminder(key, playNow) {
      const entry = approvalReminders.get(key) ?? { timer: undefined, intervalMs: 0 }
      approvalReminders.set(key, entry)
      if (playNow === true && settings.approval.enabled !== false) playGroup('approval', false)
      syncApprovalEntry(entry)
    }

    /** @param key - approval identity. */
    function removeApprovalReminder(key) {
      const entry = approvalReminders.get(key)
      if (entry === undefined) return
      stopApprovalTimer(entry)
      approvalReminders.delete(key)
    }

    /**
     * Reconcile the reminder timers with the global pending-interaction snapshot.
     * @param statuses - Session status map from useSessionStatus.
     */
    function syncApprovalReminders(statuses) {
      const active = new Set()
      if (statuses && typeof statuses.forEach === 'function') {
        statuses.forEach((status, sessionId) => {
          const pending = status && status.pendingInteraction
          if (pending && pending.kind === 'approval') {
            active.add(String(sessionId) + ':' + String(pending.key))
          }
        })
      }
      for (const key of [...approvalReminders.keys()]) {
        if (!active.has(key)) removeApprovalReminder(key)
      }
      for (const key of active) {
        if (!approvalReminders.has(key)) startApprovalReminder(key, true)
        else syncApprovalEntry(approvalReminders.get(key))
      }
    }

    /**
     * Same-origin request with the document-relative and absolute base forms.
     * @param path - route path without a leading slash (may carry a query).
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
     * Persist preference patches and adopt the merged response.
     * @param patch - nested answer/approval preference patch.
     * @returns the host's merged settings.
     */
    async function savePrefs(patch) {
      const response = await send('api/attention/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + String(response.status)))
      applyConfig(await response.json())
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
     * Foreground window encoded in an /attention-test question id.
     * @param question - one question item.
     * @returns the window in ms, or 0 when the question is not a test question.
     */
    function testWindowOf(question) {
      if (!question || typeof question.id !== 'string' || question.id.indexOf('attention-test-') !== 0) return 0
      const parts = question.id.split('-')
      const windowMs = Number(parts[parts.length - 1])
      return Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0
    }

    /** Header countdown entry for questions. */
    function AttentionBadge(props) {
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
          chimeOnce(soundKey, 'answer')
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

      // One short tick per second during the configured final seconds.
      React.useEffect(() => {
        if (!shown || settings.answer.countdownEnabled === false) return
        if (remainingSeconds === undefined) return
        const limit = Math.max(1, Math.trunc(Number(settings.answer.countdownSeconds) || 10))
        if (remainingSeconds > limit) return
        tickOnce(soundKey, remainingSeconds, remainingSeconds <= 3 || remainingSeconds === 0)
      }, [shown, questionKey, remainingSeconds])

      if (!shown) return null

      const zh = isZh()
      const label = question.kind === 'plan-review' ? t.reviewLabel : t.answerLabel
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

      const countdownLimit = Math.max(1, Math.trunc(Number(settings.answer.countdownSeconds) || 10))
      const urgent = deadlineKnown && remainingSeconds !== undefined
        && remainingSeconds <= (settings.answer.countdownEnabled === false ? 10 : countdownLimit)
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
        'data-attention-badge': questionKey,
        onClick: () => playGroup('answer', false),
      },
        h('span', { style: { fontSize: '13px', lineHeight: 1 } }, urgent ? '⏰' : '⏳'),
        h('span', null, text),
      )
    }

    /**
     * Headless attention watcher: sees every Session's pending interaction, keeps
     * the approval reminder timers running, and shows or closes system bubbles.
     * @param props - global slot props (useSessionStatus).
     * @returns null.
     */
    function AttentionWatcher(props) {
      const version = React.useSyncExternalStore(subscribeSettings, settingsSnapshot)
      const statuses = props.useSessionStatus(snapshot => snapshot)
      React.useEffect(() => {
        syncApprovalReminders(statuses)
        syncSystemNotifications(statuses)
      }, [statuses, version])
      React.useEffect(() => () => {
        for (const key of [...pendingNotifications.keys()]) closeSystemNotification(key)
      }, [])
      return null
    }

    /** Settings page with the two independent groups. */
    function AttentionSettings() {
      React.useSyncExternalStore(subscribeSettings, settingsSnapshot)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(undefined)
      const [saveError, setSaveError] = React.useState(undefined)
      const [probe, setProbe] = React.useState(() => refreshNotificationProbe())
      const t = copy()

      /** @param group - answer or approval. @param patch - preference patch. */
      function queueSave(group, patch) {
        Object.assign(pendingSave[group], patch)
        if (saveTimer !== undefined) window.clearTimeout(saveTimer)
        saveTimer = window.setTimeout(() => {
          const next = pendingSave
          pendingSave = { answer: {}, approval: {} }
          saveTimer = undefined
          void savePrefs(next).catch((error) => setSaveError(String((error && error.message) || error)))
        }, 300)
      }

      /** @param group - answer or approval. @param patch - preference patch. */
      function persistNow(group, patch) {
        void savePrefs({ [group]: patch }).then(() => setSaveError(undefined)).catch((error) => {
          setSaveError(String((error && error.message) || error))
          void loadConfig(true)
        })
      }

      /** @param group - answer or approval. @param file - picked file. */
      async function upload(group, file) {
        setBusy(group)
        setMessage(undefined)
        try {
          if (file.size > (Number(settings.maxBytes) || DEFAULTS.maxBytes)) throw new Error(t.tooBig)
          const target = groupSettings(group)
          const response = await send(target.audioUrl, {
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
          playGroup(group, true)
        } catch (error) {
          setMessage({ ok: false, text: String((error && error.message) || error) })
        } finally {
          setBusy('')
        }
      }

      /** @param group - answer or approval. */
      async function clearImported(group) {
        setBusy(group)
        setMessage(undefined)
        try {
          const target = groupSettings(group)
          const response = await send(target.audioUrl, { method: 'DELETE' })
          if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + String(response.status)))
          await loadConfig(true)
          setMessage({ ok: true, text: t.cleared })
        } catch (error) {
          setMessage({ ok: false, text: String((error && error.message) || error) })
        } finally {
          setBusy('')
        }
      }

      /** Send one generic test notification so the user can check the OS surface. */
      async function testSystemNotification() {
        setMessage(undefined)
        try {
          const permission = await ensureNotificationPermission()
          setProbe({ ...refreshNotificationProbe() })
          if (typeof Notification === 'undefined') throw new Error(t.notifyUnsupported)
          if (permission !== 'granted') throw new Error(t.notificationPermission + ': ' + String(permission))
          new Notification('dsh-attention 测试通知', {
            body: '看到这条系统通知说明气泡通知可用。',
            silent: true,
          })
          setMessage({ ok: true, text: t.notifyTestSent })
        } catch (error) {
          refreshNotificationProbe()
          notificationProbe.error = String((error && error.message) || error)
          setProbe({ ...notificationProbe })
          setMessage({ ok: false, text: t.notifyTestFailed + '：' + notificationProbe.error })
        }
      }

      /** @param group - answer or approval. @param event - file input change. */
      function onPick(group, event) {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (file) void upload(group, file)
      }

      const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }
      const labelStyle = { width: '88px', flex: 'none', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' }
      const hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }
      const inputStyle = {
        height: '26px',
        width: '78px',
        padding: '0 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
      }
      const cardStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '14px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
      }

      /** @param group - answer or approval. @param description - group description. */
      function renderGroup(group, title, description) {
        const target = groupSettings(group)
        const source = target.audioSource === 'imported' || target.audioSource === 'configured'
          || target.audioSource === 'bundled' ? target.audioSource : 'none'
        const name = typeof target.audioName === 'string' ? target.audioName : ''
        const status = source === 'imported' ? t.imported(name)
          : source === 'configured' ? t.configured(name)
            : source === 'bundled' ? t.bundled : t.builtin
        const volume = clampVolume(target.volume)
        const isAnswer = group === 'answer'
        const seconds = isAnswer
          ? Math.max(1, Math.trunc(Number(settings.answer.countdownSeconds) || 10))
          : Math.max(1, Math.trunc(Number(settings.approval.intervalSeconds) || 60))

        const extra = isAnswer
          ? h('div', { style: rowStyle },
            h('span', { style: labelStyle }, t.countdownTitle),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: settings.answer.countdownEnabled !== false,
                onChange: (event) => {
                  settings.answer.countdownEnabled = event.target.checked === true
                  bumpSettings()
                  persistNow('answer', { countdownEnabled: settings.answer.countdownEnabled })
                },
                style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary)' },
              }),
              t.countdownSecondsLabel,
            ),
            h('input', {
              type: 'number', min: '1', max: '300', step: '1',
              value: String(seconds),
              disabled: settings.answer.countdownEnabled === false,
              'aria-label': t.countdownTitle,
              onChange: (event) => {
                const next = Math.min(300, Math.max(1, Math.trunc(Number(event.target.value) || 10)))
                settings.answer.countdownSeconds = next
                bumpSettings()
                queueSave('answer', { countdownSeconds: next })
              },
              style: inputStyle,
            }),
            h('span', { style: hintStyle }, t.secondsUnit),
            h('span', { style: hintStyle }, t.countdownHint),
          )
          : h('div', { style: rowStyle },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: settings.approval.repeatEnabled !== false,
                onChange: (event) => {
                  settings.approval.repeatEnabled = event.target.checked === true
                  bumpSettings()
                  persistNow('approval', { repeatEnabled: settings.approval.repeatEnabled })
                },
                style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary)' },
              }),
              t.approvalRepeat,
            ),
            h('span', { style: labelStyle }, t.approvalInterval),
            h('input', {
              type: 'number', min: '1', max: '3600', step: '1',
              value: String(seconds),
              disabled: settings.approval.repeatEnabled === false,
              'aria-label': t.approvalInterval,
              onChange: (event) => {
                const next = Math.min(3600, Math.max(1, Math.trunc(Number(event.target.value) || 60)))
                settings.approval.intervalSeconds = next
                bumpSettings()
                queueSave('approval', { intervalSeconds: next })
              },
              style: inputStyle,
            }),
            h('span', { style: hintStyle }, t.secondsUnit),
            h('span', { style: hintStyle }, t.approvalRepeatHint),
          )

        return h('div', { style: cardStyle },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('div', { style: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, title),
            h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } }, description),
          ),
          h('div', { style: rowStyle },
            h('span', { style: labelStyle }, t.audioTitle),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 } },
              h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } }, status),
              h('div', { style: rowStyle },
                h('input', {
                  type: 'file',
                  accept: 'audio/*,.mp3,.wav,.ogg,.oga,.m4a,.flac,.webm',
                  disabled: busy === group,
                  onChange: (event) => onPick(group, event),
                  style: { fontSize: '12px', maxWidth: '100%', color: 'var(--dsw-alias-label-primary)' },
                }),
                h('button', {
                  type: 'button', disabled: busy === group, style: BUTTON_STYLE,
                  onClick: () => playGroup(group, true),
                }, t.preview),
                source === 'imported' ? h('button', {
                  type: 'button', disabled: busy === group, style: BUTTON_STYLE,
                  onClick: () => void clearImported(group),
                }, t.clear) : null,
                busy === group ? h('span', { style: hintStyle }, t.busy) : null,
              ),
            ),
          ),
          h('div', { style: rowStyle },
            h('span', { style: labelStyle }, t.volume),
            h('input', {
              type: 'range', min: '0', max: '1', step: '0.05',
              value: String(volume),
              'aria-label': t.volume,
              onChange: (event) => {
                const next = Math.min(1, Math.max(0, Number(event.target.value)))
                groupSettings(group).volume = next
                bumpSettings()
                queueSave(group, { volume: next })
              },
              style: { width: '220px', accentColor: 'var(--dsw-alias-brand-primary)' },
            }),
            h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } }, String(Math.round(volume * 100)) + '%'),
          ),
          h('div', { style: rowStyle },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: target.enabled !== false,
                onChange: (event) => {
                  groupSettings(group).enabled = event.target.checked === true
                  bumpSettings()
                  persistNow(group, { enabled: event.target.checked === true })
                },
                style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary)' },
              }),
              t.enabled,
            ),
            h('span', { style: hintStyle }, isAnswer ? t.answerEnabledHint : t.approvalEnabledHint),
          ),
          h('div', { style: rowStyle },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: target.systemNotification === true,
                onChange: (event) => {
                  const next = event.target.checked === true
                  groupSettings(group).systemNotification = next
                  if (next) void ensureNotificationPermission()
                  bumpSettings()
                  persistNow(group, { systemNotification: next })
                },
                style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary)' },
              }),
              t.systemNotify,
            ),
            h('span', { style: hintStyle }, t.systemNotifyHint),
          ),
          extra,
        )
      }

      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' } },
        h('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t.title),
        h('p', { style: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } }, t.desc),
        renderGroup('answer', t.answerTitle, t.answerDesc),
        renderGroup('approval', t.approvalTitle, t.approvalDesc),
        message === undefined ? null : h('div', {
          style: { fontSize: '12px', color: message.ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-danger, #e5484d)' },
        }, message.text),
        saveError === undefined ? null : h('div', {
          style: { fontSize: '12px', color: 'var(--dsw-alias-label-danger, #e5484d)' },
        }, saveError),
        h('div', { style: rowStyle },
          h('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void testSystemNotification() }, t.testNotify),
          h('span', { style: hintStyle }, t.notificationPermission + '：' + probe.permission + (probe.error ? ' · ' + probe.error : '')),
        ),
        h('div', { style: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } }, t.notifyBlocked),
        h('div', { style: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } }, t.note),
      )
    }

    /** Plugin-row configuration entry. */
    function RowConfigEntry(props) {
      if (props && props.view === 'summary') {
        const t = copy()
        return h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
          t.answerTitle + ' + ' + t.approvalTitle)
      }
      return h(AttentionSettings)
    }

    return {
      inject: ['slots', 'remote'],
      apply(ctx) {
        loadConfig()
        refreshNotificationProbe()
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
              chimeOnce('test:' + id, 'answer')
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
        }, 'attention: question chime')
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'attention.watcher', order: 25 },
            AttentionWatcher,
          ))
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'attention.badge', order: 45 },
            AttentionBadge,
          ))
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'attention', order: 80, label: '答题与审批提醒 / Attention' },
            AttentionSettings,
          ))
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: 'dsh-attention#attention' },
            RowConfigEntry,
          ))
      },
    }
  },
})