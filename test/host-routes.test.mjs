import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'ask-timer-test-'))
process.env.DSH_HOME = home

const handlers = new Map()
let commandDef
const asked = []
const ctx = {
  effect(run) {
    if (typeof run === 'function') {
      const value = run()
      if (value && typeof value.next === 'function') {
        for (const _ of value) { /* drain yielded disposers */ }
      }
    }
    return () => {}
  },
  connection: {
    fetch: {
      register(options) {
        handlers.set(options.path + '|' + options.methods.join(','), options.fetch)
        return () => {}
      },
    },
  },
  commands: {
    register(definition) {
      commandDef = definition
      return () => {}
    },
  },
  userQuestions: {
    async ask(request) {
      asked.push(request)
      return { answers: [{ id: request.questions[0].id, selected: ['测试通过'] }] }
    },
  },
}

const mod = await import(new URL('../index.js', import.meta.url).href)
mod.apply(ctx, { volume: 0.5 })
const configFetch = handlers.get('/api/ask-timer/config|GET')
const audioFetch = handlers.get('/api/ask-timer/audio|GET,POST,DELETE')
const settingsFetch = handlers.get('/api/ask-timer/settings|PUT')
if (!configFetch || !audioFetch || !settingsFetch) throw new Error('routes not registered: ' + [...handlers.keys()].join(', '))
if (!commandDef || commandDef.name !== 'ask-timer-test') throw new Error('test command not registered')

const base = 'http://local/api/ask-timer/audio'
const config = async () => (await configFetch()).json()

const first = await config()
if (first.hasAudio !== true || first.audioSource !== 'bundled') throw new Error('expected bundled default: ' + JSON.stringify(first))
if (first.volume !== 0.5 || first.soundEnabled !== true) throw new Error('expected config defaults: ' + JSON.stringify(first))
if (first.countdownEnabled !== true || first.countdownSeconds !== 10) throw new Error('expected countdown defaults: ' + JSON.stringify(first))

const wav = Buffer.from('RIFF....WAVEfmt ')
const upload = await audioFetch(new Request(base, {
  method: 'POST',
  headers: { 'x-audio-name': encodeURIComponent('ding.wav'), 'content-type': 'audio/wav' },
  body: wav,
}))
if (upload.status !== 200) throw new Error('upload failed: ' + upload.status + ' ' + await upload.text())
const second = await config()
if (second.hasAudio !== true || second.audioSource !== 'imported' || second.audioName !== 'custom.wav') {
  throw new Error('imported audio not reported: ' + JSON.stringify(second))
}

const put = await settingsFetch(new Request('http://local/api/ask-timer/settings', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ volume: 0.25, soundEnabled: false, countdownEnabled: false, countdownSeconds: 5 }),
}))
if (put.status !== 200) throw new Error('settings put failed: ' + put.status + ' ' + await put.text())
const saved = await config()
if (saved.volume !== 0.25 || saved.soundEnabled !== false || saved.countdownEnabled !== false || saved.countdownSeconds !== 5) {
  throw new Error('preferences not persisted: ' + JSON.stringify(saved))
}

const removed = await audioFetch(new Request(base, { method: 'DELETE' }))
if (removed.status !== 200) throw new Error('delete failed: ' + removed.status)
const third = await config()
if (third.audioSource !== 'bundled') throw new Error('expected bundled fallback: ' + JSON.stringify(third))

const result = await commandDef.handler({
  rawInput: '10',
  agent: { id: 'test-agent' },
  signal: new AbortController().signal,
  commandId: 'cmd-test',
  attachments: [],
})
if (result.kind !== 'success') throw new Error('test command failed: ' + JSON.stringify(result))
if (asked.length !== 3) throw new Error('expected 3 questions, got ' + asked.length)
const ids = asked.map(request => request.questions[0].id)
if (new Set(ids).size !== 3) throw new Error('question ids must be unique per run: ' + ids.join(','))
const parsed = ids.map((id) => {
  const parts = id.split('-')
  return {
    test: id.startsWith('ask-timer-test-'),
    run: parts[3],
    index: Number(parts[parts.length - 2]),
    window: Number(parts[parts.length - 1]),
  }
})
if (!parsed.every(item => item.test && item.window === 15000)) throw new Error('unexpected question ids: ' + ids.join(','))
if (parsed.map(item => item.index).join(',') !== '1,2,3') throw new Error('unexpected question order: ' + ids.join(','))
if (parsed.some(item => item.run !== parsed[0].run || item.run === 'undefined')) throw new Error('run token missing: ' + ids.join(','))
if (!String(result.text).includes('连续 3 次')) throw new Error('unexpected summary: ' + result.text)

rmSync(home, { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, bundled: first.audioSource, prefs: saved.volume + '/' + saved.soundEnabled + '/' + saved.countdownEnabled + '/' + saved.countdownSeconds, questions: ids.join('|') }))