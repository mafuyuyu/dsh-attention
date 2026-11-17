import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'attention-test-'))
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
mod.apply(ctx, { answer: { volume: 0.5 }, approval: { intervalSeconds: 30 } })
const configFetch = handlers.get('/api/attention/config|GET')
const audioFetch = handlers.get('/api/attention/audio|GET,POST,DELETE')
const settingsFetch = handlers.get('/api/attention/settings|PUT')
if (!configFetch || !audioFetch || !settingsFetch) throw new Error('routes not registered: ' + [...handlers.keys()].join(', '))
if (!commandDef || commandDef.name !== 'attention-test') throw new Error('test command not registered')

const base = 'http://local/api/attention/audio'
const config = async () => (await configFetch()).json()

const first = await config()
if (first.answer.audioSource !== 'bundled' || first.approval.audioSource !== 'bundled') {
  throw new Error('expected bundled defaults: ' + JSON.stringify(first))
}
if (first.answer.volume !== 0.5 || first.answer.enabled !== true) throw new Error('answer config defaults: ' + JSON.stringify(first.answer))
if (first.answer.countdownEnabled !== true || first.answer.countdownSeconds !== 10) throw new Error('answer countdown defaults')
if (first.approval.volume !== 0.7 || first.approval.intervalSeconds !== 30 || first.approval.repeatEnabled !== true) {
  throw new Error('approval config defaults: ' + JSON.stringify(first.approval))
}
if (first.answer.systemNotification !== false || first.approval.systemNotification !== false) {
  throw new Error('system notifications must default off: ' + JSON.stringify(first))
}

const wav = Buffer.from('RIFF....WAVEfmt ')
const upload = await audioFetch(new Request(base + '?group=answer', {
  method: 'POST',
  headers: { 'x-audio-name': encodeURIComponent('ding.wav'), 'content-type': 'audio/wav' },
  body: wav,
}))
if (upload.status !== 200) throw new Error('answer upload failed: ' + upload.status + ' ' + await upload.text())
let current = await config()
if (current.answer.audioSource !== 'imported' || current.answer.audioName !== 'answer.wav') throw new Error('answer import missing: ' + JSON.stringify(current.answer))
if (current.approval.audioSource !== 'bundled') throw new Error('approval must stay independent: ' + JSON.stringify(current.approval))

const uploadApproval = await audioFetch(new Request(base + '?group=approval', {
  method: 'POST',
  headers: { 'x-audio-name': encodeURIComponent('bell.mp3'), 'content-type': 'audio/mpeg' },
  body: wav,
}))
if (uploadApproval.status !== 200) throw new Error('approval upload failed: ' + uploadApproval.status)
current = await config()
if (current.approval.audioSource !== 'imported' || current.approval.audioName !== 'approval.mp3') throw new Error('approval import missing: ' + JSON.stringify(current.approval))
if (current.answer.audioName !== 'answer.wav') throw new Error('answer import changed: ' + JSON.stringify(current.answer))

const bad = await audioFetch(new Request(base + '?group=answer', {
  method: 'POST',
  headers: { 'x-audio-name': encodeURIComponent('notes.txt'), 'content-type': 'text/plain' },
  body: wav,
}))
if (bad.status !== 415) throw new Error('expected 415 for unsupported type, got ' + bad.status)

const put = await settingsFetch(new Request('http://local/api/attention/settings', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    answer: { volume: 0.25, enabled: false, countdownEnabled: false, countdownSeconds: 5, systemNotification: true },
    approval: { volume: 0.4, repeatEnabled: false, intervalSeconds: 7, systemNotification: true },
  }),
}))
if (put.status !== 200) throw new Error('settings put failed: ' + put.status + ' ' + await put.text())
const saved = await config()
if (saved.answer.volume !== 0.25 || saved.answer.enabled !== false || saved.answer.countdownEnabled !== false || saved.answer.countdownSeconds !== 5 || saved.answer.systemNotification !== true) {
  throw new Error('answer preferences not persisted: ' + JSON.stringify(saved.answer))
}
if (saved.approval.volume !== 0.4 || saved.approval.repeatEnabled !== false || saved.approval.intervalSeconds !== 7 || saved.approval.systemNotification !== true) {
  throw new Error('approval preferences not persisted: ' + JSON.stringify(saved.approval))
}

const audioGet = await audioFetch(new Request(base + '?group=approval'))
if (audioGet.status !== 200 || audioGet.headers.get('content-type') !== 'audio/mpeg') {
  throw new Error('approval audio get failed: ' + audioGet.status + ' ' + audioGet.headers.get('content-type'))
}

const removed = await audioFetch(new Request(base + '?group=answer', { method: 'DELETE' }))
if (removed.status !== 200) throw new Error('delete failed: ' + removed.status)
const third = await config()
if (third.answer.audioSource !== 'bundled') throw new Error('expected bundled fallback: ' + JSON.stringify(third.answer))
if (third.approval.audioSource !== 'imported') throw new Error('approval must survive answer delete: ' + JSON.stringify(third.approval))

const result = await commandDef.handler({
  rawInput: '',
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
    test: id.startsWith('attention-test-'),
    run: parts[2],
    index: Number(parts[parts.length - 2]),
    window: Number(parts[parts.length - 1]),
  }
})
if (!parsed.every(item => item.test && item.window === 15000)) throw new Error('unexpected question ids: ' + ids.join(','))
if (parsed.map(item => item.index).join(',') !== '1,2,3') throw new Error('unexpected question order: ' + ids.join(','))
if (parsed.some(item => item.run !== parsed[0].run || item.run === 'undefined')) throw new Error('run token missing: ' + ids.join(','))
if (!String(result.text).includes('连续 3 次')) throw new Error('unexpected summary: ' + result.text)

rmSync(home, { recursive: true, force: true })
console.log(JSON.stringify({
  ok: true,
  bundled: first.answer.audioSource + '/' + first.approval.audioSource,
  prefs: saved.answer.volume + '/' + saved.answer.enabled + '/' + saved.answer.countdownSeconds + '|' + saved.approval.volume + '/' + saved.approval.repeatEnabled + '/' + saved.approval.intervalSeconds,
  questions: ids.join('|'),
}))