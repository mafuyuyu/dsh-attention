<p align="center"><img src="./icon.svg" width="72" alt="dsh-ask-timer icon"></p>

# dsh-ask-timer

[简体中文](./README.md) · English

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![platform](https://img.shields.io/badge/DSH-Web%20%7C%20Desktop-blue)](https://www.deepseek.com/harness/)
[![version](https://img.shields.io/badge/version-0.1.0-orange)](./package.json)

**An answer countdown and chime plugin for [DeepSeek Harness](https://www.deepseek.com/harness/): show the remaining time while `ask_user_question` waits for you, tick once per second near the end, and import your own chime from the settings page.**

A DeepSeek Harness question has no "answer window" of its own. In PTC mode (`ops-ptc` / `ptc` presets) `ask_user_question` is a nested call inside a `run_code` program, and the answer window is exactly the program's time budget — when it runs out, the question is cancelled. This plugin turns that budget into a countdown in the Session header, plays one full chime when the question appears, and ticks once per second during the last `N` seconds. The chime file, countdown length, volume, and master switch are configurable in the settings page.

## Features

| Capability | What it does |
| --- | --- |
| **Header countdown** | Appears only while `ask_user_question` waits, showing the remaining `run_code` budget; an ordinary blocking question without a budget shows elapsed wait time instead of an invented deadline |
| **Last-seconds ticks** | During the last `countdownSeconds` seconds (default 10) a short tick plays once per second, with a higher pitch for the final 3 seconds |
| **Question chime** | Plays once whenever a question appears; uses the packaged default audio or a file imported from the settings page |
| **Keeps sounding across pages** | Switching to another Session or plugin page keeps the ticks going; switching back does not reset the countdown, does not replay the chime, and never doubles a tick — and there is no floating overlay covering other pages |
| **Settings page** | Import/preview audio, volume slider, master chime switch, countdown-tick switch and length |
| **Test command** | `/ask-timer-test` asks three consecutive questions that mimic a real ask: different content, one chime each, and an automatic cancel at the deadline |
| **Local only** | Reads/writes only local settings and audio files: no network, no Session-log writes, no model tool schemas |

## Install

### From GitHub (recommended)

In DeepSeek Harness open **Plugins → Add plugin** and paste this repository URL:

```text
https://github.com/mafuyuyu/dsh-ask-timer
```

Then enable the **dsh-ask-timer** bundle on the same page (it is enabled by the install).

> The plugin row id is `ask-timer`. If you already insert that row manually in your profile's `cordis.patch.yml`, do not also install the package as a bundle, or the same id will be inserted twice.

### From a local directory

Download the repository and paste its absolute directory path into **Add plugin**, for example:

```text
D:\plugins\dsh-ask-timer
```

A local install links the directory: client changes apply on a page refresh, Host changes need a DSH restart.

### From this development checkout

1. Add to `~/.dsh/profiles/desktop/package.json` under `dependencies`:
   ```json
   "dsh-ask-timer": "link:D:/deepseek-worker/mark-plugins/dsh-ask-timer"
   ```
2. Run `pnpm install` in the profile directory.
3. Append to `~/.dsh/profiles/desktop/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: ask-timer
         name: 'dsh-ask-timer'
         config:
           audioFile: ''
           volume: 0.7
           fallbackWindowMs: 600000
           countdownSeconds: 10
           countdownEnabled: true
   ```
4. Restart DSH once so both halves load.

## Usage

### Real questions

When the model asks you something through `ask_user_question`:

1. A `⏳ 答题 m:ss` badge appears at the right of the Session header.
2. The countdown comes from the running `run_code` call:
   - the model's explicit `timeoutMs` when supplied;
   - otherwise this plugin's `fallbackWindowMs` (default 600000, i.e. 10 minutes).
3. The full chime plays once when the question appears.
4. During the last `countdownSeconds` seconds a short tick plays once per second.
5. At zero the `run_code` budget cancels the question — that is the real behaviour; answering hides the badge immediately.
6. Click the badge to replay the chime.

For a DSH timed question (`mode: timed`) the badge reuses the question card's own foreground window; by DSH design that window pauses while you focus or select, and resumes when you leave.

### Test command

Type this in the composer (no arguments — do not append a number):

```text
/ask-timer-test
```

It asks **three consecutive questions**, one at a time, with different content, and **each question plays one chime**. Every question mimics an ordinary `run_code` ask:

- blocking, with no timed foreground window, so **selecting an option does not pause the countdown**;
- the plugin draws an absolute deadline and ticks once per second during the last `countdownSeconds` seconds;
- at the deadline the Host cancels that question and the command moves on;
- per-question window = `max(15 s, countdownSeconds + 5 s)`, capped at 60 s.

When all three finish, the command reports a summary (answered / timed out / cancelled).

> A slash command followed by text is not treated as command input by the composer; this command takes no arguments, so just send `/ask-timer-test`.

### Settings page

Both entries open the same settings:

- **Settings → 答题倒计时 / Ask timer** (a standalone page in the Settings panel);
- **Settings → Plugins → dsh-ask-timer → Configure** (the row page, when the row is listed).

The page contains:

- **Choose audio file**: a native file picker for mp3 / wav / ogg / m4a / flac / webm, up to 8 MB;
- **Preview**: plays the effective audio (imported → `audioFile` config → packaged `assets/default.wav`), even when the master switch is off;
- **Volume**: 0–100% slider, applied live and saved automatically;
- **Enable chime**: master switch;
- **Countdown ticks**: switch plus a "last N seconds" field (1–300);
- **Use built-in**: removes the imported file and falls back to the configured or packaged audio.

Storage:

- imported audio: `$DSH_HOME/dsh-ask-timer/custom.<ext>` (default `C:\Users\<you>\.dsh\dsh-ask-timer`);
- volume / switches / countdown: `settings.json` in the same directory, overriding the YAML keys.

Browsers require one click in the page before audio may play; if Preview is silent, click the page once and try again.

## Behaviour and limits

- The header badge shows only the **current Session's** pending question; after switching Sessions no badge is shown, but a question with a known deadline keeps ticking.
- There is no floating overlay, so nothing covers other pages.
- An ordinary blocking question with no `run_code` budget shows "waiting m:ss" instead of a deadline.
- A timed question's foreground window pauses while focused/selected — that is DSH's behaviour, not this plugin's pause; it resumes from the remaining time.
- Background tabs throttle timers; ticks may be imprecise when the whole DSH window is minimised. Switching pages inside the app is unaffected.
- Audio type is derived from the file extension; unsupported extensions are rejected by the Host (415), and files over 8 MB get 413.
- The plugin never modifies the question card or the `ask_user_question` answer flow.
- Every slot component is wrapped in an error boundary: a rendering failure hides that control instead of breaking the UI.

## Configuration

Plugin row keys (in `cordis.patch.yml` or the plugin page's advanced config):

| Key | Default | Meaning |
| --- | --- | --- |
| `audioFile` | `''` | Optional absolute path to a chime file. A file imported in the settings page wins over it; when neither exists the packaged `assets/default.wav` is used. |
| `volume` | `0.7` | Volume 0–1 (the settings slider overrides it). |
| `soundEnabled` | `true` | Master chime switch (the settings page overrides it). |
| `countdownEnabled` | `true` | Countdown-tick switch (the settings page overrides it). |
| `countdownSeconds` | `10` | Tick once per second during the last N seconds, 1–300 (the settings page overrides it). |
| `fallbackWindowMs` | `600000` | Answer window used when the model does not pass `timeoutMs` to `run_code`; keep it in sync with `ptc-runtime`'s `timeoutMs`. |

## Layout

```text
dsh-ask-timer/
├─ index.js                 # Host: settings/audio/preference routes + /ask-timer-test
├─ client.js                # Browser: header countdown, tick scheduler, settings page
├─ cordis.patch.yml         # row inserted when installed as a bundle
├─ assets/default.wav       # packaged default chime
├─ test/host-routes.test.mjs# Host route unit test
├─ icon.svg
├─ README.md / README_EN.md
└─ LICENSE
```

## Development and checks

```sh
node test/host-routes.test.mjs   # host routes, no network needed
node --check index.js
node --check client.js
```

Client changes apply on a page refresh; Host changes (`index.js`, command registration, routes) need a DSH restart.

## Privacy and security

- The Host exposes four **authenticated**, same-origin routes: `GET /api/ask-timer/config`, `GET/POST/DELETE /api/ask-timer/audio`, and `PUT /api/ask-timer/settings`.
- It reads only the configured audio file or the file imported from the settings page; it never accepts arbitrary paths and makes no external network requests.
- Settings and imported audio live under `$DSH_HOME/dsh-ask-timer/`; the plugin writes no Session logs, makes no model requests, and registers no model tools (`/ask-timer-test` is a human-triggered command).
- Removing the imported audio or uninstalling the plugin does not affect existing Sessions.

## License

[MIT](./LICENSE) © 2026 mafuyuyu
