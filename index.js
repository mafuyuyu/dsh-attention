/**
 * Host half of dsh-ask-timer.
 *
 * Serves the settings, the chime file (imported, configured, or the packaged
 * default), stores the live preferences the settings page edits, and registers
 * the /ask-timer-test command that opens one timed test question.
 */
import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve, join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'ask-timer'

/** Routes, the test command, and the user-question service. */
export const inject = ['connection', 'commands', 'userQuestions']

const CONFIG_PATH = '/api/ask-timer/config'
const AUDIO_PATH = '/api/ask-timer/audio'
const SETTINGS_PATH = '/api/ask-timer/settings'

/** Largest accepted imported audio file. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024

/** Number of consecutive questions /ask-timer-test asks. */
const TEST_QUESTION_COUNT = 3

/** Bounds of one test question's foreground window. */
const MIN_TEST_WINDOW_MS = 15000
const MAX_TEST_WINDOW_MS = 60000

/** Packaged default chime, shipped with the plugin. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const BUNDLED_AUDIO = join(PACKAGE_DIR, 'assets', 'default.wav')

/** Deployment defaults; every key may be overridden by the row's config. */
export const DEFAULTS = {
  soundEnabled: true,
  volume: 0.7,
  fallbackWindowMs: 600000,
  countdownEnabled: true,
  countdownSeconds: 10,
  audioFile: '',
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
 * Coerce the row config into the shape the client reads.
 * @param config - raw Cordis row config.
 * @returns validated settings.
 */
function normalize(config = {}) {
  const volume = Number(config.volume)
  const fallback = Number(config.fallbackWindowMs)
  const countdownSeconds = Math.trunc(Number(config.countdownSeconds))
  return {
    soundEnabled: config.soundEnabled !== false,
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULTS.volume,
    fallbackWindowMs: Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULTS.fallbackWindowMs,
    countdownEnabled: config.countdownEnabled !== false,
    countdownSeconds: Number.isFinite(countdownSeconds) && countdownSeconds >= 1 && countdownSeconds <= 300
      ? countdownSeconds : DEFAULTS.countdownSeconds,
    audioFile: typeof config.audioFile === 'string' ? config.audioFile.trim() : '',
  }
}

/** @returns the managed DSH home directory. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** @returns the directory holding imported audio files and preferences. */
function customDir() {
  return join(dshHome(), 'dsh-ask-timer')
}

/** @returns file names of previously imported audio files. */
async function customNames() {
  try {
    const names = await readdir(customDir())
    return names.filter(name => name.startsWith('custom.'))
  } catch {
    return []
  }
}

/** @returns absolute path of the imported file, or undefined. */
async function importedFile() {
  const names = await customNames()
  return names.length === 0 ? undefined : join(customDir(), names[0])
}

/**
 * Read the preferences saved by the settings page.
 * @returns validated preferences (possibly empty).
 */
async function readPreferences() {
  try {
    const value = JSON.parse(await readFile(join(customDir(), 'settings.json'), 'utf8'))
    const preferences = {}
    if (value && typeof value === 'object') {
      const volume = Number(value.volume)
      if (Number.isFinite(volume)) preferences.volume = Math.min(1, Math.max(0, volume))
      if (typeof value.soundEnabled === 'boolean') preferences.soundEnabled = value.soundEnabled
      if (typeof value.countdownEnabled === 'boolean') preferences.countdownEnabled = value.countdownEnabled
      const countdownSeconds = Math.trunc(Number(value.countdownSeconds))
      if (Number.isFinite(countdownSeconds) && countdownSeconds >= 1 && countdownSeconds <= 300) {
        preferences.countdownSeconds = countdownSeconds
      }
    }
    return preferences
  } catch {
    return {}
  }
}

/**
 * Merge a preference patch into the stored document.
 * @param patch - volume, soundEnabled, countdownEnabled and/or countdownSeconds.
 * @returns the stored preferences.
 */
async function writePreferences(patch) {
  const current = await readPreferences()
  const next = { ...current }
  const volume = Number(patch.volume)
  if (Number.isFinite(volume)) next.volume = Math.min(1, Math.max(0, volume))
  if (typeof patch.soundEnabled === 'boolean') next.soundEnabled = patch.soundEnabled
  if (typeof patch.countdownEnabled === 'boolean') next.countdownEnabled = patch.countdownEnabled
  const countdownSeconds = Math.trunc(Number(patch.countdownSeconds))
  if (Number.isFinite(countdownSeconds) && countdownSeconds >= 1 && countdownSeconds <= 300) {
    next.countdownSeconds = countdownSeconds
  }
  await mkdir(customDir(), { recursive: true })
  await writeFile(join(customDir(), 'settings.json'), JSON.stringify(next))
  return next
}

/**
 * Row config overlaid with the settings page's saved preferences.
 * @param settings - normalized row settings.
 * @returns effective settings.
 */
async function effectiveSettings(settings) {
  const preferences = await readPreferences()
  return {
    ...settings,
    volume: preferences.volume === undefined ? settings.volume : preferences.volume,
    soundEnabled: preferences.soundEnabled === undefined ? settings.soundEnabled : preferences.soundEnabled,
    countdownEnabled: preferences.countdownEnabled === undefined ? settings.countdownEnabled : preferences.countdownEnabled,
    countdownSeconds: preferences.countdownSeconds === undefined ? settings.countdownSeconds : preferences.countdownSeconds,
  }
}

/**
 * Resolve the audio file the plugin should serve: an imported file first, then
 * the row's configured path, then the packaged default.
 * @param settings - normalized settings.
 * @returns the file and where it came from, or undefined.
 */
async function activeAudio(settings) {
  const imported = await importedFile()
  if (imported !== undefined) return { file: imported, source: 'imported' }
  if (settings.audioFile !== '') {
    const configured = isAbsolute(settings.audioFile) ? settings.audioFile : resolve(process.cwd(), settings.audioFile)
    try {
      const info = await stat(configured)
      if (info.isFile()) return { file: configured, source: 'configured' }
    } catch {
      // Fall through to the packaged default.
    }
  }
  try {
    const info = await stat(BUNDLED_AUDIO)
    if (info.isFile()) return { file: BUNDLED_AUDIO, source: 'bundled' }
  } catch {
    // The packaged default may be absent in a hand-trimmed install.
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
 * Describe the effective audio and countdown settings for the client.
 * @param settings - normalized row settings.
 * @returns settings payload.
 */
async function configPayload(settings) {
  const effective = await effectiveSettings(settings)
  const active = await activeAudio(effective)
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
    version: 3,
    soundEnabled: effective.soundEnabled,
    volume: effective.volume,
    fallbackWindowMs: effective.fallbackWindowMs,
    countdownEnabled: effective.countdownEnabled,
    countdownSeconds: effective.countdownSeconds,
    hasAudio: active !== undefined,
    audioUrl: AUDIO_PATH,
    audioVersion,
    audioSource: active === undefined ? 'none' : active.source,
    audioName,
    maxBytes: MAX_AUDIO_BYTES,
  }
}

/**
 * Stream the active chime bytes.
 * @param settings - normalized settings.
 * @returns the audio response, or a 404 when no usable file exists.
 */
async function audioResponse(settings) {
  const active = await activeAudio(settings)
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
 * Store an uploaded audio file as the imported chime.
 * @param request - buffered upload request; `x-audio-name` carries the file name.
 * @returns a JSON outcome.
 */
async function uploadAudio(request) {
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
    await mkdir(customDir(), { recursive: true })
    for (const name of await customNames()) await rm(join(customDir(), name), { force: true })
    const stored = 'custom' + extension
    await writeFile(join(customDir(), stored), bytes)
    return json({ ok: true, name: stored, bytes: bytes.length })
  } catch {
    return new Response('failed to store audio file', { status: 500 })
  }
}

/**
 * Remove imported audio files so the configured file or the packaged default wins.
 * @returns a JSON outcome.
 */
async function removeAudio() {
  try {
    for (const name of await customNames()) await rm(join(customDir(), name), { force: true })
    return json({ ok: true })
  } catch {
    return new Response('failed to remove audio file', { status: 500 })
  }
}

/**
 * Persist the settings page's live preferences.
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
    id: 'ask-timer-test-' + runId + '-' + String(index) + '-' + String(windowMs),
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
 * Ask three consecutive blocking questions that mimic an ordinary run_code ask:
 * no foreground timed wait, a Host-enforced absolute window, and no pause when
 * the user interacts. Each question can also be answered early.
 * @param ctx - host context carrying the user-question service.
 * @param invocation - command invocation with the live agent and signal.
 * @param settings - normalized row settings (for the countdown length).
 * @returns the command result shown in the conversation.
 */
async function runTimerTest(ctx, invocation, settings) {
  try {
    const effective = await effectiveSettings(settings)
    const windowMs = Math.min(MAX_TEST_WINDOW_MS, Math.max(MIN_TEST_WINDOW_MS, (effective.countdownSeconds + 5) * 1000))
    const results = []
    const runId = Date.now().toString(36) + (Math.random().toString(36).slice(2, 6) || 'x')
    for (let index = 1; index <= TEST_QUESTION_COUNT; index += 1) {
      if (invocation.signal.aborted) break
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, windowMs)
      try {
        const answer = await ctx.userQuestions.ask({
          questions: [testQuestion(runId, index, windowMs)],
          agent: invocation.agent,
          signal: AbortSignal.any([invocation.signal, controller.signal]),
        })
        const labels = (answer.answers || [])
          .map(item => [...(item.selected || []), ...(item.custom ? [item.custom] : [])].join(' / '))
          .filter(label => label.length > 0)
        results.push('第 ' + String(index) + ' 题：已回答（' + (labels.length > 0 ? labels.join('；') : '空') + '）')
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (controller.signal.aborted && !invocation.signal.aborted) {
          results.push('第 ' + String(index) + ' 题：超时自动取消')
        } else if (invocation.signal.aborted || code === 'ASK_CANCELLED') {
          results.push('第 ' + String(index) + ' 题：已被你取消')
          break
        } else {
          throw error
        }
      } finally {
        clearTimeout(timer)
      }
    }
    return { kind: 'success', text: '连续 3 次答题倒计时测试结束：\n' + results.join('\n') }
  } catch (error) {
    return { kind: 'error', text: '测试失败：' + String((error && error.message) || error) }
  }
}

/**
 * Register the settings, audio, upload, removal, preferences, and test-command
 * surfaces.
 * @param ctx - Host context carrying Connection, Commands and UserQuestions.
 * @param config - row config.
 */
export function apply(ctx, config = {}) {
  const settings = normalize(config)
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'ask-timer-test',
      description: '连续 3 次模拟正常提问的倒计时与提示音测试（无参数，直接发送）。',
      handler: invocation => runTimerTest(ctx, invocation, settings),
    })
  }, 'ask-timer: command')
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
        const method = String(request.method || 'GET').toUpperCase()
        if (method === 'POST') return uploadAudio(request)
        if (method === 'DELETE') return removeAudio()
        return audioResponse(settings)
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
  }, 'ask-timer: routes')
}