<p align="center"><img src="./icon.svg" width="72" alt="dsh-ask-timer 图标"></p>

# dsh-ask-timer

简体中文 · [English](./README_EN.md)

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![platform](https://img.shields.io/badge/DSH-Web%20%7C%20Desktop-blue)](https://www.deepseek.com/harness/)
[![version](https://img.shields.io/badge/version-0.1.0-orange)](./package.json)

**面向 [DeepSeek Harness](https://www.deepseek.com/harness/) 的答题倒计时与提示音插件：在 `ask_user_question` 等待你回答时显示剩余时间，最后几秒每秒滴答，并可以在设置页导入自己的提示音。**

DeepSeek Harness 的提问本身没有“回答窗口”的概念。到了 PTC 模式（`ops-ptc` / `ptc` 预设），`ask_user_question` 是 `run_code` 程序里的嵌套调用，回答窗口完全由 `run_code` 的时间预算决定——预算一到，提问会被直接取消。本插件把这段时间显示成会话标题栏里的倒计时，并在最后 `N` 秒每秒响一声滴答；问题出现时还会播放一次完整提示音。提示音可以由你导入，倒计时秒数、音量和总开关都可以在设置页调整。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| **标题栏倒计时** | 仅在 `ask_user_question` 等待回答时出现，显示 `run_code` 预算的剩余时间；普通阻塞提问显示已等待时长，不虚构截止时间 |
| **最后 N 秒滴答** | 剩余时间进入最后 `countdownSeconds` 秒（默认 10）后，每秒响一次短促滴答，最后 3 秒音调更高 |
| **问题提示音** | 每次提问出现时播放一次提示音；默认使用插件自带音频，也可在设置页导入自己的文件 |
| **切页继续发声** | 切到其它会话或插件页后，倒计时声音继续；切回来不重置、不重播、每秒只响一下，也没有浮动框遮挡页面 |
| **设置页** | 导入/预览音频、音量滑块、提示音总开关、倒计时音效开关与秒数 |
| **测试命令** | `/ask-timer-test` 连续发起 3 个模拟真实提问的测试题，每题内容不同、都会响一次提示音，到点自动取消 |
| **纯本地** | 只在本机进程内读写设置与音频文件，不联网、不写会话日志、不增加模型工具定义 |

## 安装

### 从 GitHub 安装（推荐）

在 DeepSeek Harness 中打开 **插件（Plugins） → 添加插件（Add plugin）**，粘贴本仓库地址：

```text
https://github.com/mafuyuyu/dsh-ask-timer
```

安装后在同一页面把 **dsh-ask-timer** 组合包启用（默认安装即启用）。

> 插件行的 id 是 `ask-timer`。如果你已经在 profile 的 `cordis.patch.yml` 里手动插入过这一行，就不要再把它作为 bundle 安装，否则同一个 id 会被插入两次。

### 从本地目录安装

把仓库下载到本地，在 **添加插件** 中填入该目录的绝对路径，例如：

```text
D:\plugins\dsh-ask-timer
```

本地安装是目录链接：客户端改动刷新页面即可生效，Host 端改动需要重启 DSH。

### 当前开发目录

本仓库也可以直接作为 profile 的本地依赖（开发时使用）：

1. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 中加入：
   ```json
   "dsh-ask-timer": "link:D:/deepseek-worker/mark-plugins/dsh-ask-timer"
   ```
2. 在 profile 目录执行 `pnpm install`。
3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾插入：
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
4. 重启一次 DSH，让 Host 与浏览器加载插件的两半代码。

## 使用方法

### 真实提问

当模型通过 `ask_user_question` 问你问题时：

1. 会话标题栏右侧出现 `⏳ 答题 m:ss` 徽标；
2. 倒计时来自当前正在运行的 `run_code` 调用：
   - 模型显式传了 `timeoutMs` 就用它；
   - 没传则用本插件的 `fallbackWindowMs`（默认 600000，即 10 分钟）；
3. 问题出现时播放一次提示音；
4. 剩余时间进入最后 `countdownSeconds` 秒后，每秒响一次滴答；
5. 到 0 仍未回答时，`run_code` 会取消提问——这就是真实行为；回答后徽标立即消失；
6. 点击徽标可以重播一次提示音。

如果问题本身是 DSH 的 timed 提问（`mode: timed`），倒计时直接使用问题卡片自带的前台窗口；按 DSH 的设计，聚焦/选择时它会暂停等待你，切走再回来会继续。

### 测试命令

在会话输入框里直接输入（**没有参数**，不要加秒数）：

```text
/ask-timer-test
```

它会连续发起 **3 次**提问，一次一题，三题内容不同，而且**每次提问都会响一次提示音**。每题的行为都模拟正常的 `run_code` 嵌套提问：

- 阻塞式提问，没有 timed 前台窗口，所以**选择选项不会暂停倒计时**；
- 插件按绝对截止时间显示倒计时，最后 `countdownSeconds` 秒每秒响一次滴答；
- 到点仍未回答时由 Host 自动取消该题，然后继续下一题；
- 每题窗口 = `max(15 秒, countdownSeconds + 5 秒)`，最长 60 秒。

全部结束后命令返回三题的结果摘要（已回答 / 超时自动取消 / 被取消）。

> 斜杠命令后面直接跟参数时，输入框不会把它识别成命令参数；本命令不接收参数，直接发送 `/ask-timer-test` 即可。

### 设置页

两个入口指向同一份设置：

- **设置 → 答题倒计时 / Ask timer**（设置面板左侧独立页）；
- **设置 → 插件 → dsh-ask-timer → 配置**（插件行页，若该行出现在插件列表里）。

页面包含：

- **选择音频文件**：原生文件选择框，支持 mp3 / wav / ogg / m4a / flac / webm，最大 8 MB；
- **播放预览**：播放当前生效的音频（导入的优先 → 配置里的 `audioFile` → 插件自带 `assets/default.wav`），即使提示音总开关关闭也能预览；
- **音量**：0–100% 滑块，拖动即时生效并自动保存；
- **启用提示音**：总开关；
- **倒计时音效**：开关 + 「最后几秒」数字框（1–300）；
- **恢复内置**：删除导入的音频，回退到配置或插件自带音频。

保存位置：

- 导入的音频：`$DSH_HOME/dsh-ask-timer/custom.<ext>`（默认 `C:\Users\<你>\.dsh\dsh-ask-timer`）；
- 音量/开关/倒计时设置：同目录 `settings.json`，优先级高于 YAML 配置里的同名键。

浏览器要求页面先有一次点击才允许发声；如果预览没声音，先点一下页面再试。

## 行为与限制

- 倒计时徽标只显示**当前会话**的待回答问题；切换到其它会话后不再显示徽标，但已登记截止时间的提问会继续按秒发声。
- 没有“浮动框”：不需要、也不会在其它页面上遮挡内容。
- 普通阻塞提问在没有 `run_code` 预算可参考时显示“已等待 m:ss”，不会虚构倒计时。
- timed 提问的前台倒计时会在聚焦/选择时暂停，这是 DSH 的行为，不是本插件的暂停；切走再回来会从剩余时间继续。
- 浏览器后台标签页会节流定时器；把 DSH 窗口完全最小化到后台时，滴答可能不精确。正常在应用内切页不受影响。
- 音频文件按扩展名决定 Content-Type；不支持的扩展名会被 Host 拒绝（415），超过 8 MB 返回 413。
- 插件不修改问题卡片本身，也不改变 `ask_user_question` 的回答流程。
- 每个槽位组件都在错误边界内：插件渲染出错只会隐藏对应控件，不会拖垮整个界面。

## 配置

插件行的配置键（在 `cordis.patch.yml` 或插件页的高级配置里）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `audioFile` | `''` | 可选：提示音频文件的绝对路径。设置页导入的文件优先于它；都没有时用插件自带的 `assets/default.wav`。 |
| `volume` | `0.7` | 音量 0–1（设置页滑块会覆盖此值）。 |
| `soundEnabled` | `true` | 提示音总开关（设置页会覆盖此值）。 |
| `countdownEnabled` | `true` | 倒计时滴答开关（设置页会覆盖此值）。 |
| `countdownSeconds` | `10` | 最后几秒每秒滴答一次，1–300（设置页会覆盖此值）。 |
| `fallbackWindowMs` | `600000` | 模型没给 `run_code` 传 `timeoutMs` 时使用的回答窗口；应与 `ptc-runtime` 的 `timeoutMs` 保持一致。 |

## 目录结构

```text
dsh-ask-timer/
├─ index.js                 # Host：设置/音频/偏好路由，注册 /ask-timer-test
├─ client.js                # 浏览器：标题栏倒计时、滴答调度、设置页
├─ cordis.patch.yml         # bundle 安装时的插入行
├─ assets/default.wav       # 插件自带的默认提示音
├─ test/host-routes.test.mjs# Host 路由单测
├─ icon.svg                 # 插件图标
├─ README.md / README_EN.md
└─ LICENSE
```

## 开发与验证

```sh
# Host 路由单测（无需网络）
node test/host-routes.test.mjs

# 语法检查
node --check index.js
node --check client.js
```

客户端改动刷新页面即可；Host 端（`index.js`、命令注册、路由）改动需要重启 DSH。

## 隐私与安全

- Host 只有四条**已认证**的同源路由：`GET /api/ask-timer/config`、`GET/POST/DELETE /api/ask-timer/audio`、`PUT /api/ask-timer/settings`。
- 只读取配置指定的音频文件或设置页导入的文件；不接受任意路径请求，不访问外部网络。
- 设置与导入音频保存在本机 `$DSH_HOME/dsh-ask-timer/`，不写入会话日志、不产生模型请求，也不注册模型工具（`/ask-timer-test` 是人类触发的命令）。
- 删除导入音频或卸载插件不会影响已有会话。

## 许可证

[MIT](./LICENSE) © 2026 mafuyuyu
