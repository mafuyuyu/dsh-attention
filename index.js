/**
 * Host half of dsh-attention.
 *
 * Serves the settings and audio for two independent reminder groups — answer
 * countdown/chime and permission-approval reminders — under
 * `$DSH_HOME/dsh-attention/`, migrates the legacy dsh-ask-timer directory once,
 * and registers the /attention-test command.
 */
import { readFile, writeFile, mkdir, rm, readdir, stat, copyFile } from 'node:fs/promises'
import { extname, isAbsolute, resolve, join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'attention'

/** Routes, the test command, and the user-question service. */
export const inject = ['connection', 'commands', 'userQuestions']

const CONFIG_PATH = '/api/attention/config'
const AUDIO_PATH = '/api/attention/audio'
const SETTINGS_PATH = '/api/attention/settings'

const DATA_DIR_NAME = 'dsh-attention'
const LEGACY_DIR_NAME = 'dsh-ask-timer'
const GROUPS = ['answer', 'approval']

/** Largest accepted uploaded audio file. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024

/** Number of consecutive questions /attention-test asks. */
const TEST_QUESTION_COUNT = 3

/** Bounds of one test question's foreground window. */
const MIN_TEST_WINDOW_MS = 15000
const MAX_TEST_WINDOW_MS = 60000

/** Packaged default chimes. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const BUNDLED_AUDIO = {
  answer: join(PACKAGE_DIR, 'assets', 'default.wav'),
  approval: join(PACKAGE_DIR, 'assets', 'approval.wav'),
}

/** Deployment defaults; every key may be overridden by the row's config. */
export const DEFAULTS = {
  fallbackWindowMs: 600000,
  answer: {
    enabled: true,
    volume: 0.7,
    countdownEnabled: true,
    countdownSeconds: 10,
    audioFile: '',
    systemNotification: false,
  },
  approval: {
    enabled: true,
    volume: 0.7,
    repeatEnabled: true,
    intervalSeconds: 60,
    audioFile: '',
    systemNotification: false,
  },
}

const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
}

/**
 * Clamp a numeric field.
 * @param value - raw value.
 * @param fallback - default.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param integer - truncate to an integer.
 * @returns the validated number.
 */
function numberInRange(value, fallback, min, max, integer) {
  const number = integer ? Math.trunc(Number(value)) : Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

/**
 * Coerce one group config.
 * @param raw - raw group config.
 * @param defaults - group defaults.
 * @param legacy - optional legacy flat config used for the answer group.
 * @returns normalized group config.
 */
function normalizeGroup(raw, defaults, legacy) {
  const source = raw && typeof raw === 'object' ? raw : (legacy && typeof legacy === 'object' ? legacy : {})
  return {
    enabled: source.enabled !== undefined ? source.enabled !== false : (source.soundEnabled !== false),
    volume: numberInRange(source.volume, defaults.volume, 0, 1, false),
    ...(defaults.countdownEnabled !== undefined
      ? {
        countdownEnabled: source.countdownEnabled !== false,
        countdownSeconds: numberInRange(source.countdownSeconds, defaults.countdownSeconds, 1, 300, true),
      }
      : {
        repeatEnabled: source.repeatEnabled !== false,
        intervalSeconds: numberInRange(source.intervalSeconds, defaults.intervalSeconds, 1, 3600, true),
      }),
    audioFile: typeof source.audioFile === 'string' ? source.audioFile.trim() : '',
    systemNotification: source.systemNotification === true,
  }
}

/**
 * Coerce the row config into the two-group shape.
 * @param config - raw Cordis row config.
 * @returns validated settings.
 */
export function normalize(config = {}) {
  return {
    fallbackWindowMs: numberInRange(config.fallbackWindowMs, DEFAULTS.fallbackWindowMs, 1, 2_147_483_647, false),
    answer: normalizeGroup(config.answer, DEFAULTS.answer, config),
    approval: normalizeGroup(config.approval, DEFAULTS.approval),
  }
}

/** @returns the managed DSH home directory. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** @returns the directory holding imported audio and preferences. */
function dataDir() {
  return join(dshHome(), DATA_DIR_NAME)
}

/** @returns the pre-rename data directory. */
function legacyDir() {
  return join(dshHome(), LEGACY_DIR_NAME)
}

let migration

/**
 * Copy the legacy dsh-ask-timer data once when this plugin has no data directory.
 * `custom.<ext>` becomes the answer group's `answer.<ext>`.
 * @returns the one-time migration promise.
 */
function ensureMigrated() {
  migration ??= (async () => {
    try {
      await stat(dataDir())
      return
    } catch {
      // No new directory yet; migrate if the legacy one exists.
    }
    try {
      const entries = await readdir(legacyDir())
      await mkdir(dataDir(), { recursive: true })
      for (const entry of entries) {
        if (entry === 'settings.json') {
          await copyFile(join(legacyDir(), entry), join(dataDir(), 'settings.json'))
        } else if (entry.startsWith('custom.')) {
          await copyFile(join(legacyDir(), entry), join(dataDir(), 'answer.' + entry.slice('custom.'.length)))
        }
      }
    } catch {
      // Nothing to migrate.
    }
  })()
  return migration
}

/**
 * Read the preferences saved by the settings page.
 * @returns validated preference groups.
 */
async function readPreferences() {
  await ensureMigrated()
  try {
    const value = JSON.parse(await readFile(join(dataDir(), 'settings.json'), 'utf8'))
    if (!value || typeof value !== 'object') return { answer: {}, approval: {} }
    const answer = value.answer && typeof value.answer === 'object'
      ? value.answer
      : value
    const approval = value.approval && typeof value.approval === 'object' ? value.approval : {}
    const preferences = { answer: {}, approval: {} }
    const volume = Number(answer.volume)
    if (Number.isFinite(volume)) preferences.answer.volume = Math.min(1, Math.max(0, volume))
    if (typeof answer.enabled === 'boolean') preferences.answer.enabled = answer.enabled
    else if (typeof answer.soundEnabled === 'boolean') preferences.answer.enabled = answer.soundEnabled
    if (typeof answer.countdownEnabled === 'boolean') preferences.answer.countdownEnabled = answer.countdownEnabled
    if (typeof answer.systemNotification === 'boolean') preferences.answer.systemNotification = answer.systemNotification
    const countdownSeconds = Math.trunc(Number(answer.countdownSeconds))
    if (Number.isFinite(countdownSeconds) && countdownSeconds >= 1 && countdownSeconds <= 300) {
      preferences.answer.countdownSeconds = countdownSeconds
    }
    const approvalVolume = Number(approval.volume)
    if (Number.isFinite(approvalVolume)) preferences.approval.volume = Math.min(1, Math.max(0, approvalVolume))
    if (typeof approval.enabled === 'boolean') preferences.approval.enabled = approval.enabled
    if (typeof approval.repeatEnabled === 'boolean') preferences.approval.repeatEnabled = approval.repeatEnabled
    if (typeof approval.systemNotification === 'boolean') preferences.approval.systemNotification = approval.systemNotification
    const intervalSeconds = Math.trunc(Number(approval.intervalSeconds))
    if (Number.isFinite(intervalSeconds) && intervalSeconds >= 1 && intervalSeconds <= 3600) {
      preferences.approval.intervalSeconds = intervalSeconds
    }
    return preferences
  } catch {
    return { answer: {}, approval: {} }
  }
}

/**
 * Merge a preference patch into the stored document.
 * @param patch - nested answer/approval groups, or legacy flat answer keys.
 * @returns the stored preferences.
 */
async function writePreferences(patch) {
  await ensureMigrated()
  const current = await readPreferences()
  const next = {
    answer: { ...current.answer },
    approval: { ...current.approval },
  }
  const answer = patch.answer && typeof patch.answer === 'object' ? patch.answer : patch
  const approval = patch.approval && typeof patch.approval === 'object' ? patch.approval : {}
  const volume = Number(answer.volume)
  if (Number.isFinite(volume)) next.answer.volume = Math.min(1, Math.max(0, volume))
  if (typeof answer.enabled === 'boolean') next.answer.enabled = answer.enabled
  else if (typeof answer.soundEnabled === 'boolean') next.answer.enabled = answer.soundEnabled
  if (typeof answer.countdownEnabled === 'boolean') next.answer.countdownEnabled = answer.countdownEnabled
  if (typeof answer.systemNotification === 'boolean') next.answer.systemNotification = answer.systemNotification
  const countdownSeconds = Math.trunc(Number(answer.countdownSeconds))
  if (Number.isFinite(countdownSeconds) && countdownSeconds >= 1 && countdownSeconds <= 300) {
    next.answer.countdownSeconds = countdownSeconds
  }
  const approvalVolume = Number(approval.volume)
  if (Number.isFinite(approvalVolume)) next.approval.volume = Math.min(1, Math.max(0, approvalVolume))
  if (typeof approval.enabled === 'boolean') next.approval.enabled = approval.enabled
  if (typeof approval.repeatEnabled === 'boolean') next.approval.repeatEnabled = approval.repeatEnabled
  if (typeof approval.systemNotification === 'boolean') next.approval.systemNotification = approval.systemNotification
  const intervalSeconds = Math.trunc(Number(approval.intervalSeconds))
  if (Number.isFinite(intervalSeconds) && intervalSeconds >= 1 && intervalSeconds <= 3600) {
    next.approval.intervalSeconds = intervalSeconds
  }
  await mkdir(dataDir(), { recursive: true })
  await writeFile(join(dataDir(), 'settings.json'), JSON.stringify(next))
  return next
}

/**
 * Row config overlaid with the settings page's saved preferences.
 * @param settings - normalized row settings.
 * @returns effective two-group settings.
 */
async function effectiveSettings(settings) {
  const preferences = await readPreferences()
  return {
    fallbackWindowMs: settings.fallbackWindowMs,
    answer: { ...settings.answer, ...preferences.answer },
    approval: { ...settings.approval, ...preferences.approval },
  }
}

/** @param group - one of the two groups. @returns the group or throws. */
function requireGroup(group) {
  if (!GROUPS.includes(group)) throw new Error('unknown audio group')
  return group
}

/**
 * File names owned by one group. The answer group also treats legacy `custom.*`
 * files as its own.
 * @param group - answer or approval.
 * @returns matching file names.
 */
async function groupFiles(group) {
  try {
    const names = await readdir(dataDir())
    return names.filter(name => name.startsWith(group + '.')
      || (group === 'answer' && name.startsWith('custom.')))
  } catch {
    return []
  }
}

/**
 * Resolve the audio the group should play: imported, configured, then packaged.
 * @param group - answer or approval.
 * @param groupSettings - effective group settings.
 * @returns the file and source, or undefined.
 */
async function activeAudio(group, groupSettings) {
  const names = await groupFiles(group)
  if (names.length > 0) return { file: join(dataDir(), names[0]), source: 'imported' }
  if (groupSettings.audioFile !== '') {
    const configured = isAbsolute(groupSettings.audioFile)
      ? groupSettings.audioFile
      : resolve(process.cwd(), groupSettings.audioFile)
    try {
      const info = await stat(configured)
      if (info.isFile()) return { file: configured, source: 'configured' }
    } catch {
      // Fall through to the packaged default.
    }
  }
  try {
    const info = await stat(BUNDLED_AUDIO[group])
    if (info.isFile()) return { file: BUNDLED_AUDIO[group], source: 'bundled' }
  } catch {
    // A trimmed install may omit the packaged file.
  }
  return undefined
}

/** @param value - JSON value. @returns a JSON Response. */
function json(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Describe one group for the client.
 * @param group - answer or approval.
 * @param groupSettings - effective group settings.
 * @returns group payload.
 */
async function groupPayload(group, groupSettings) {
  const active = await activeAudio(group, groupSettings)
  let audioVersion = ''
  let audioName = ''
  if (active !== undefined) {
    try {
      const info = await stat(active.file)
      audioVersion = String(info.mtimeMs)
    } catch {
      audioVersion = ''
    }
    audioName = basename(active.file)
  }
  return {
    enabled: groupSettings.enabled,
    volume: groupSettings.volume,
    systemNotification: groupSettings.systemNotification === true,
    ...(group === 'answer'
      ? {
        countdownEnabled: groupSettings.countdownEnabled,
        countdownSeconds: groupSettings.countdownSeconds,
      }
      : {
        repeatEnabled: groupSettings.repeatEnabled,
        intervalSeconds: groupSettings.intervalSeconds,
      }),
    hasAudio: active !== undefined,
    audioUrl: AUDIO_PATH + '?group=' + group,
    audioVersion,
    audioSource: active === undefined ? 'none' : active.source,
    audioName,
  }
}

/**
 * Describe every effective setting for the client.
 * @param settings - normalized row settings.
 * @returns settings payload.
 */
async function configPayload(settings) {
  await ensureMigrated()
  const effective = await effectiveSettings(settings)
  return {
    version: 4,
    fallbackWindowMs: effective.fallbackWindowMs,
    maxBytes: MAX_AUDIO_BYTES,
    answer: await groupPayload('answer', effective.answer),
    approval: await groupPayload('approval', effective.approval),
  }
}

/**
 * Stream one group's active chime bytes.
 * @param group - answer or approval.
 * @param settings - normalized row settings.
 * @returns the audio response, or a 404 when no usable file exists.
 */
async function audioResponse(group, settings) {
  const effective = await effectiveSettings(settings)
  const active = await activeAudio(group, effective[group])
  if (active === undefined) return new Response('no audio file configured', { status: 404 })
  try {
    const bytes = await readFile(active.file)
    const type = AUDIO_TYPES[extname(active.file).toLowerCase()] ?? 'application/octet-stream'
    return new Response(bytes, {
      headers: {
        'content-type': type,
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
      },
    })
  } catch {
    return new Response('audio file unavailable', { status: 404 })
  }
}

/**
 * Store an uploaded audio file for one group.
 * @param group - answer or approval.
 * @param request - buffered upload request; `x-audio-name` carries the file name.
 * @returns a JSON outcome.
 */
async function uploadAudio(group, request) {
  const rawName = request.headers.get('x-audio-name') ?? ''
  let fileName = ''
  try {
    fileName = decodeURIComponent(rawName)
  } catch {
    return new Response('invalid file name', { status: 400 })
  }
  const extension = extname(fileName).toLowerCase()
  if (AUDIO_TYPES[extension] === undefined) return new Response('unsupported audio type', { status: 415 })
  let bytes
  try {
    bytes = Buffer.from(await request.arrayBuffer())
  } catch {
    return new Response('unreadable body', { status: 400 })
  }
  if (bytes.length === 0) return new Response('empty body', { status: 400 })
  if (bytes.length > MAX_AUDIO_BYTES) return new Response('audio file too large', { status: 413 })
  try {
    await ensureMigrated()
    await mkdir(dataDir(), { recursive: true })
    for (const name of await groupFiles(group)) await rm(join(dataDir(), name), { force: true })
    const stored = group + extension
    await writeFile(join(dataDir(), stored), bytes)
    return json({ ok: true, group, name: stored, bytes: bytes.length })
  } catch {
    return new Response('failed to store audio file', { status: 500 })
  }
}

/**
 * Remove one group's imported audio so config or the packaged default wins.
 * @param group - answer or approval.
 * @returns a JSON outcome.
 */
async function removeAudio(group) {
  try {
    await ensureMigrated()
    for (const name of await groupFiles(group)) await rm(join(dataDir(), name), { force: true })
    return json({ ok: true, group })
  } catch {
    return new Response('failed to remove audio file', { status: 500 })
  }
}

/**
 * Persist the settings page's preferences.
 * @param request - buffered JSON request.
 * @param settings - normalized row settings.
 * @returns the merged settings payload.
 */
async function updateSettings(request, settings) {
  let patch
  try {
    patch = JSON.parse(await request.text())
  } catch {
    return new Response('invalid JSON', { status: 400 })
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return new Response('invalid body', { status: 400 })
  }
  try {
    await writePreferences(patch)
    return json(await configPayload(settings))
  } catch {
    return new Response('failed to save settings', { status: 500 })
  }
}

/**
 * Build one test question. The id carries the question index and the foreground
 * window so the Client can draw the same absolute deadline the Host enforces.
 * @param runId - per-run token.
 * @param index - 1-based question number.
 * @param windowMs - foreground window of this question.
 * @returns the question item.
 */
function testQuestion(runId, index, windowMs) {
  const prompts = [
    '第 1 次模拟提问：倒计时不会因为你的选择而暂停，到点会自动取消。请随便选一项。',
    '第 2 次模拟提问：本次测试连续提问 3 次，每次都会响一次提示音。请随便选一项。',
    '第 3 次模拟提问：最后一题。若每次提问都听到了提示音，请选“测试通过”。',
  ]
  return {
    id: 'attention-test-' + runId + '-' + String(index) + '-' + String(windowMs),
    header: '倒计时测试 ' + String(index) + '/' + String(TEST_QUESTION_COUNT),
    question: prompts[index - 1],
    options: [
      { label: '测试通过', description: '倒计时和提示音都正常' },
      { label: '有问题', description: '没听到提示音或显示不对' },
    ],
    multiSelect: false,
  }
}

/**
 * Ask three consecutive blocking questions that mimic an ordinary run_code ask.
 * @param ctx - host context carrying the user-question service.
 * @param invocation - command invocation with the live agent and signal.
 * @param settings - normalized row settings.
 * @returns the command result shown in the conversation.
 */
async function runAttentionTest(ctx, invocation, settings) {
  try {
    const effective = await effectiveSettings(settings)
    const windowMs = Math.min(
      MAX_TEST_WINDOW_MS,
      Math.max(MIN_TEST_WINDOW_MS, (effective.answer.countdownSeconds + 5) * 1000),
    )
    const runId = Date.now().toString(36) + (Math.random().toString(36).slice(2, 6) || 'x')
    const questions = Array.from(
      { length: TEST_QUESTION_COUNT },
      (_, index) => testQuestion(runId, index + 1, windowMs),
    )
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, windowMs)
    try {
      const answer = await ctx.userQuestions.ask({
        questions,
        agent: invocation.agent,
        signal: AbortSignal.any([invocation.signal, controller.signal]),
      })
      const answers = answer.answers || []
      const lines = questions.map((question, index) => {
        const item = answers.find(entry => entry && entry.id === question.id)
        const labels = item
          ? [...(item.selected || []), ...(item.custom ? [item.custom] : [])].filter(label => label.length > 0).join(' / ')
          : ''
        return '第 ' + String(index + 1) + ' 题：' + (labels !== '' ? labels : '空')
      })
      return { kind: 'success', text: '3 题提问倒计时测试结束：\n' + lines.join('\n') }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (controller.signal.aborted && !invocation.signal.aborted) {
        return { kind: 'success', text: '3 题提问倒计时测试结束：\n第 1～3 题：超时自动取消' }
      }
      if (invocation.signal.aborted || code === 'ASK_CANCELLED') {
        return { kind: 'success', text: '3 题提问倒计时测试结束：\n第 1～3 题：已被你取消' }
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { kind: 'error', text: '测试失败：' + String((error && error.message) || error) }
  }
}

/**
 * Register the settings, audio, preferences, and test-command surfaces.
 * @param ctx - Host context carrying Connection, Commands and UserQuestions.
 * @param config - row config.
 */
export function apply(ctx, config = {}) {
  const settings = normalize(config)
  void ensureMigrated()
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'attention-test',
      description: '一次包含 3 个问题的倒计时与提示音测试（同一张卡片、最后一次提交；无参数，直接发送）。',
      handler: invocation => runAttentionTest(ctx, invocation, settings),
    })
  }, 'attention: command')
  ctx.effect(() => {
    const disposeConfig = ctx.connection.fetch.register({
      path: CONFIG_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json(await configPayload(settings)),
    })
    const disposeAudio = ctx.connection.fetch.register({
      path: AUDIO_PATH,
      methods: ['GET', 'POST', 'DELETE'],
      requestBody: 'buffered',
      fetch: (request) => {
        const url = new URL(request.url)
        const group = url.searchParams.get('group')
        if (!GROUPS.includes(group)) return new Response('unknown audio group', { status: 400 })
        const method = String(request.method || 'GET').toUpperCase()
        if (method === 'POST') return uploadAudio(group, request)
        if (method === 'DELETE') return removeAudio(group)
        return audioResponse(group, settings)
      },
    })
    const disposeSettings = ctx.connection.fetch.register({
      path: SETTINGS_PATH,
      methods: ['PUT'],
      requestBody: 'buffered',
      fetch: (request) => updateSettings(request, settings),
    })
    return () => {
      void disposeConfig()
      void disposeAudio()
      void disposeSettings()
    }
  }, 'attention: routes')
}
