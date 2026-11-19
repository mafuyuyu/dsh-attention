<p align="center"><img src="./icon.svg" width="72" alt="dsh-attention icon"></p>

# dsh-attention

[简体中文](./README.md) · English

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![platform](https://img.shields.io/badge/DSH-Web%20%7C%20Desktop-blue)](https://www.deepseek.com/harness/)
[![version](https://img.shields.io/badge/version-0.2.9-orange)](./package.json)

**Answer and approval alerts for [DeepSeek Harness](https://www.deepseek.com/harness/), primarily for DSH-OPS mode: a countdown with last-seconds ticks while `ask_user_question` waits for you, and a repeating chime while a tool asks for permission approval, until you allow or reject it.**

A DeepSeek Harness question has no "answer window" of its own. In PTC mode (`ops-ptc` / `ptc` presets) `ask_user_question` is a nested call inside a `run_code` program, and the answer window is exactly the program's time budget — when it runs out, the question is cancelled.

Approvals have the same problem: when bash, file writes, or another operation asks for permission while you are looking at a different Session or page, it is easy to miss.

This plugin splits both "you are needed" moments into **two independent groups**:

- **Answer alerts**: Session-header countdown, one chime when the question appears, and a per-second tick during the last `N` seconds.
- **Approval alerts**: one immediate chime when an approval appears, then a reminder at the configured interval **until you click a button** (allow or reject). **No countdown is shown for approvals.**

Each group has its own audio, volume, and switches.

## Scope: DSH-OPS and standard mode

- **DSH-OPS mode (`ops-ptc` / PTC presets)**: `ask_user_question` is a nested call inside a `run_code` program; the answer window is exactly the program's time budget, and the question is cancelled when it runs out. The plugin's **countdown, last-seconds ticks, and answer-window reminders are designed primarily for this mode**.
- **Standard mode**: `ask_user_question` is called directly, **with no timeout and no automatic cancellation**; the plugin only shows a positive "waiting m:ss" timer and never invents a countdown. The question chime, system notifications, and approval reminders still work.
- `/attention-test` simulates a DSH-OPS nested ask (with a window) to verify the countdown and ticks.

| Mode | preset | `ask_user_question` | Invocation | Plugin display |
| --- | --- | --- | --- | --- |
| Standard | `standard` | yes | direct call, no timeout | waiting m:ss |
| PTC | `ptc` / `ops-ptc` (OPS PTC) | yes | nested inside `run_code`, bounded by the program budget | countdown + last-seconds ticks |
| Minimal | `minimal` | **no** | the mode has no ask tool | no answer countdown/bubble |
| Creative | `cordis` | yes | direct call, no timeout | waiting m:ss |

Rule of thumb: only presets with the PTC executor (`dsh-tool-executor-ptc`, i.e. `run_code`) nest asks inside the program; presets with the ask tool but no executor call it directly; presets without the ask tool never produce a question card. Approval reminders are mode-independent.

## Features

| Capability | What it does |
| --- | --- |
| **Answer countdown** | Appears only while `ask_user_question` waits; DSH-OPS mode shows the remaining `run_code` budget, while a direct ask in standard mode has no timeout and shows a positive "waiting m:ss" timer |
| **Answer chime** | Plays once when the question appears; uses the packaged default or a file imported in the settings page |
| **Last-seconds ticks** | During the last `countdownSeconds` seconds (default 10) a short tick plays once per second, with a higher pitch for the final 3 seconds |
| **Approval reminder** | One immediate chime when a permission approval appears, then a repeat every `intervalSeconds` (default 60) until you allow or reject; repeat can be turned off so it chimes only once |
| **Two independent groups** | Answer and approval each have their own audio, volume, and switch; answer also has a tick switch and length, approval a repeat switch and interval |
| **System notifications** | Optional for both groups: an OS-level bubble says a question or approval is waiting, never its content, and **only appears while the DSH window is unfocused, minimized, or you switched to another app**; off by default |
| **Keeps sounding across pages** | Sounds are driven by module-level schedulers, so they continue after switching to another Session or plugin page; returning does not reset, replay, or double anything, and there is no floating overlay |
| **Settings page** | One card per group: import/preview/restore, volume slider, switches and parameters |
| **Test command** | `/attention-test` sends one ask containing three questions (one card, submit only on the last question, earlier answers editable before submitting), one chime for the batch, and an automatic cancel at the deadline |
| **Local only** | Reads/writes only local settings and audio files: no network, no Session-log writes, no model tool schemas |

## Install

### From GitHub (recommended)

In DeepSeek Harness open **Plugins → Add plugin** and paste this repository URL:

```text
https://github.com/mafuyuyu/dsh-attention
```

Then enable the **dsh-attention** bundle on the same page (it is enabled by the install).

> The plugin row id is `attention`. If you already insert that row manually in your profile's `cordis.patch.yml`, do not also install the package as a bundle, or the same id will be inserted twice.

### From a local directory

Download the repository and paste its absolute directory path into **Add plugin**, for example:

```text
D:\plugins\dsh-attention
```

A local install links the directory: client changes apply on a page refresh, Host changes need a DSH restart.

### From this development checkout

1. Add to `~/.dsh/profiles/desktop/package.json` under `dependencies`:
   ```json
   "dsh-attention": "link:D:/deepseek-worker/mark-plugins/dsh-attention"
   ```
2. Run `pnpm install` in the profile directory (or link `node_modules/dsh-attention` to this directory).
3. Append to `~/.dsh/profiles/desktop/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: attention
         name: 'dsh-attention'
         config:
           fallbackWindowMs: 600000
           answer:
             enabled: true
             volume: 0.7
             countdownEnabled: true
             countdownSeconds: 10
             audioFile: ''
           approval:
             enabled: true
             volume: 0.7
             repeatEnabled: true
             intervalSeconds: 60
             audioFile: ''
   ```
4. Restart DSH once so both halves load.

### Upgrading from dsh-ask-timer

This plugin was formerly `dsh-ask-timer` (0.1.0, answer countdown only). To upgrade:

- replace the profile dependency, bundle entry, and `cordis.patch.yml` row from `ask-timer` with `attention`;
- data migrates automatically: on first read, if `~/.dsh/dsh-attention` does not exist, the old `~/.dsh/dsh-ask-timer/settings.json` is copied over and any `custom.<ext>` audio is renamed to the answer group's `answer.<ext>`;
- the old flat preferences (`volume` / `soundEnabled` / `countdownSeconds`) are read as answer-group preferences; the approval group starts with defaults.

Old GitHub repository URLs redirect to the new repository.

## Usage

### Answer alerts

When the model asks you something through `ask_user_question`:

1. A `⏳ 答题 m:ss` badge appears at the right of the Session header.
2. The countdown comes from the running `run_code` call: the model's explicit `timeoutMs` when supplied, otherwise `fallbackWindowMs` (default 600000, i.e. 10 minutes).
3. The answer chime plays once when the question appears.
4. During the last `countdownSeconds` seconds a short tick plays once per second.
5. At zero the `run_code` budget cancels the question — that is the real behaviour; answering hides the badge immediately.
6. Click the badge to replay the chime.

For a DSH timed question (`mode: timed`) the badge reuses the question card's own foreground window; by DSH design it pauses while you focus or select and resumes when you leave.

### Approval alerts

When bash, a file write, a plugin build, or another operation asks for permission:

1. The approval chime plays once immediately (independent of the answer group).
2. If **repeat** is on, it plays again every `intervalSeconds` seconds until you allow or reject.
3. Approvals show no countdown and never create a floating overlay.
4. Reminders continue even while you are in another Session or plugin page, and stop when the approval settles.

Approval reminders use DSH's global pending-interaction state, so:

- they target **permission approvals** only; plan review (plan-review) stays with the answer group's countdown and chime;
- when a Session has both a pending question and a pending approval, DSH exposes only the highest-precedence interaction, so the other reminder can be delayed briefly.

### Test command

Type this in the composer (no arguments):

```text
/attention-test
```

It sends **one** ask containing **three questions**, matching a real multi-question ask:

- **the first two questions have no submit button; only the last one submits**, and earlier answers can be edited before submitting;
- the batch plays one chime when it appears;
- blocking, with no timed foreground window, so **selecting an option does not pause the countdown**;
- the plugin draws an absolute deadline and ticks once per second during the last `countdownSeconds` seconds;
- at the deadline the Host cancels the whole batch;
- batch window = `max(15 s, countdownSeconds + 5 s)`, capped at 60 s.

After submitting or cancelling, the command reports a summary for all three questions (answered / timed out / cancelled).

> This command tests the **answer group**; preview the approval chime with **Preview** on the settings page.

### Settings page

Both entries open the same settings:

- **Settings → 答题与审批提醒 / Attention** (a standalone page in the Settings panel);
- **Settings → Plugins → dsh-attention → Configure** (the row page, when the row is listed).

The page has two independent cards:

**Answer alerts**

- choose audio file / preview / restore built-in;
- volume slider;
- enable chime;
- countdown-tick switch + last N seconds (1–300);
- system notification (off by default; says only that a question is waiting, never the content).

**Approval alerts**

- choose audio file / preview / restore built-in;
- volume slider;
- enable chime;
- repeat switch + interval (1–3600 seconds, default 60);
- system notification (off by default; says only that an approval is waiting, never the content).

Storage:

- answer audio: `$DSH_HOME/dsh-attention/answer.<ext>`;
- approval audio: `$DSH_HOME/dsh-attention/approval.<ext>`;
- both preference groups: `settings.json` in the same directory, overriding YAML row keys.

Browsers require one click in the page before audio may play; if Preview is silent, click the page once and try again. System notifications also need the operating system to allow DSH notifications.

Automatic bubbles appear only while the DSH window is unfocused, minimized, or you switched to another app; they close when the window regains focus. The **Send test notification** button at the bottom of the settings page is a manual diagnostic and is not subject to that restriction.

The same area also shows the current system notification permission (`granted` / `default` / `denied` / `unsupported`) and the last automatic attempt (for example `question:ok`). If it says `denied`, allow notifications for this page in the browser or system settings; if it says `granted` but no bubble appears, check the Windows Notification Center or the macOS notification settings for DSH.

## Configuration

Plugin row keys (in `cordis.patch.yml` or the plugin page's advanced config):

| Key | Default | Meaning |
| --- | --- | --- |
| `fallbackWindowMs` | `600000` | Answer window used when the model does not pass `timeoutMs` to `run_code`; keep it in sync with `ptc-runtime`'s `timeoutMs`. |
| `answer.enabled` | `true` | Answer chime master switch. |
| `answer.volume` | `0.7` | Answer volume 0–1. |
| `answer.countdownEnabled` | `true` | Last-seconds tick switch. |
| `answer.countdownSeconds` | `10` | Tick once per second during the last N seconds, 1–300. |
| `answer.audioFile` | `''` | Optional absolute path to answer audio; an imported file wins, then this, then the packaged `assets/default.wav`. |
| `answer.systemNotification` | `false` | Show an OS bubble when a question waits (generic text only, never the question content). |
| `approval.enabled` | `true` | Approval chime master switch. |
| `approval.volume` | `0.7` | Approval volume 0–1. |
| `approval.repeatEnabled` | `true` | Repeat the approval chime at the interval after the first one. |
| `approval.intervalSeconds` | `60` | Repeat interval, 1–3600 seconds. |
| `approval.audioFile` | `''` | Optional absolute path to approval audio; an imported file wins, then this, then the packaged `assets/approval.wav`. |
| `approval.systemNotification` | `false` | Show an OS bubble when an approval waits (generic text only, never the approval content). |

Preferences saved on the settings page override the row keys per group.

## Layout

```text
dsh-attention/
├─ index.js                  # Host: two-group settings/audio routes + /attention-test
├─ client.js                 # Browser: answer countdown, approval scheduler, settings page
├─ cordis.patch.yml          # row inserted when installed as a bundle
├─ assets/default.wav        # packaged answer chime
├─ assets/approval.wav       # packaged approval chime
├─ test/host-routes.test.mjs # Host route unit test
├─ icon.svg                  # bell + question mark
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

- The Host exposes four **authenticated**, same-origin routes: `GET /api/attention/config`, `GET/POST/DELETE /api/attention/audio`, and `PUT /api/attention/settings`.
- It reads only the configured audio file or the file imported from the settings page; it never accepts arbitrary paths and makes no external network requests.
- Approval reminders read only the `kind` and `key` of the global pending interaction; they never read or log the approval content or tool arguments.
- Settings and imported audio live under `$DSH_HOME/dsh-attention/`; the plugin writes no Session logs, makes no model requests, and registers no model tools (`/attention-test` is a human-triggered command).
- Removing imported audio or uninstalling the plugin does not affect existing Sessions; the dsh-ask-timer migration copies old data once on first read.

## License

[MIT](./LICENSE) © 2026 mafuyuyu