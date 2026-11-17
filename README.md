<p align="center"><img src="./icon.svg" width="72" alt="dsh-attention 图标"></p>

# dsh-attention

简体中文 · [English](./README_EN.md)

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![platform](https://img.shields.io/badge/DSH-Web%20%7C%20Desktop-blue)](https://www.deepseek.com/harness/)
[![version](https://img.shields.io/badge/version-0.2.4-orange)](./package.json)

**面向 [DeepSeek Harness](https://www.deepseek.com/harness/) 的答题与审批提醒插件：等待你回答 `ask_user_question` 时显示倒计时并在最后几秒滴答；工具请求权限审批时按间隔播放提醒音，直到你批准或拒绝。**

DeepSeek Harness 的提问本身没有“回答窗口”。到了 PTC 模式（`ops-ptc` / `ptc` 预设），`ask_user_question` 是 `run_code` 程序里的嵌套调用，回答窗口完全由 `run_code` 的时间预算决定——预算一到，提问会被直接取消。

权限审批也有同样的问题：当 bash、写文件等操作请求审批时，如果你正在看别的会话或页面，很容易错过。

本插件把这两类“需要你出手”的时刻分成**两个独立分组**：

- **答题提醒**：标题栏倒计时、问题出现时一次提示音、最后 `N` 秒每秒滴答；
- **权限审批提醒**：审批出现时立即响一次，然后按设定间隔**重复提醒**，直到你点击按钮（批准/拒绝），**不显示倒计时**。

两组各有自己的音频、音量和开关，互不影响。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| **答题倒计时** | 仅在 `ask_user_question` 等待时出现，显示 `run_code` 预算的剩余时间；普通阻塞提问显示已等待时长，不虚构截止时间 |
| **答题提示音** | 问题出现时播放一次；默认使用插件自带音频，也可在设置页导入自己的文件 |
| **最后 N 秒滴答** | 剩余时间进入最后 `countdownSeconds` 秒（默认 10）后每秒响一次，最后 3 秒音调更高 |
| **权限审批提醒** | 审批出现时立即响一次，按 `intervalSeconds`（默认 60 秒）重复提醒，直到你批准或拒绝；可关闭重复，只在出现时响一次 |
| **两组独立** | 答题与审批分别设置音频、音量、开关；答题另有倒计时开关与秒数，审批另有重复开关与间隔 |
| **系统气泡通知** | 答题与审批都可选开启：在系统通知中心弹出“有提问/审批在等待”的通用提示，不显示问题或审批内容；默认关闭 |
| **切页继续发声** | 声音由模块级调度器驱动，切到其它会话或插件页后继续；切回来不重置、不重播、每秒只响一下，也没有浮动框 |
| **设置页** | 两组各一张卡片：导入/预览/恢复内置、音量滑块、开关与参数 |
| **测试命令** | `/attention-test` 连续发起 3 个模拟真实提问的测试题，每题内容不同、都会响一次提示音，到点自动取消 |
| **纯本地** | 只在本机进程内读写设置与音频文件，不联网、不写会话日志、不增加模型工具定义 |

## 安装

### 从 GitHub 安装（推荐）

在 DeepSeek Harness 中打开 **插件（Plugins） → 添加插件（Add plugin）**，粘贴本仓库地址：

```text
https://github.com/mafuyuyu/dsh-attention
```

安装后在同一页面把 **dsh-attention** 组合包启用（默认安装即启用）。

> 插件行的 id 是 `attention`。如果你已经在 profile 的 `cordis.patch.yml` 里手动插入过这一行，就不要再把它作为 bundle 安装，否则同一个 id 会被插入两次。

### 从本地目录安装

把仓库下载到本地，在 **添加插件** 中填入该目录的绝对路径，例如：

```text
D:\plugins\dsh-attention
```

本地安装是目录链接：客户端改动刷新页面即可生效，Host 端改动需要重启 DSH。

### 开发目录（当前开发方式）

1. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 中加入：
   ```json
   "dsh-attention": "link:D:/deepseek-worker/mark-plugins/dsh-attention"
   ```
2. 在 profile 目录执行 `pnpm install`（或给 `node_modules/dsh-attention` 建一个指向该目录的链接）。
3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾插入：
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
4. 重启一次 DSH，让 Host 与浏览器加载插件的两半代码。

### 从 dsh-ask-timer 升级

本插件的前身是 `dsh-ask-timer`（0.1.0，只有答题倒计时）。升级时：

- 把 profile 里的依赖、bundle 列表和 `cordis.patch.yml` 的插件行从 `ask-timer` 换成 `attention`；
- 数据会自动迁移：首次读取时如果 `~/.dsh/dsh-attention` 不存在，会把 `~/.dsh/dsh-ask-timer/` 里的 `settings.json` 复制过来，把旧的 `custom.<ext>` 音频重命名为答题组的 `answer.<ext>`；
- 旧的扁平设置（`volume` / `soundEnabled` / `countdownSeconds`）会作为答题组的偏好读取，审批组使用默认值。

GitHub 上的旧仓库地址会自动跳转到新仓库。

## 使用方法

### 答题提醒

当模型通过 `ask_user_question` 问你问题时：

1. 会话标题栏右侧出现 `⏳ 答题 m:ss` 徽标；
2. 倒计时来自当前正在运行的 `run_code` 调用：模型显式传了 `timeoutMs` 就用它，否则用 `fallbackWindowMs`（默认 600000，即 10 分钟）；
3. 问题出现时播放一次答题提示音；
4. 剩余时间进入最后 `countdownSeconds` 秒后，每秒响一次滴答；
5. 到 0 仍未回答时，`run_code` 会取消提问——这就是真实行为；回答后徽标立即消失；
6. 点击徽标可以重播一次提示音。

timed 提问（`mode: timed`）直接使用问题卡片自带的前台窗口；按 DSH 的设计，聚焦/选择时它会暂停等待你，切走再回来会继续。

### 权限审批提醒

当 bash、写文件、插件构建等操作请求权限审批时：

1. 审批出现时立即播放一次审批提示音（不受答题组影响）；
2. 如果“重复提醒”开着，之后每隔 `intervalSeconds` 秒再响一次，直到你点击批准或拒绝；
3. 审批不显示倒计时，也不会出现浮动框；
4. 即使你正在别的会话或插件页，提醒仍会继续；审批解决后自动停止。

审批提醒依赖 DSH 的全局待处理交互（pending interaction）状态，因此：

- 只针对**权限审批**（approval）本身；计划审核（plan-review）仍由答题组负责倒计时和提示音；
- 同一会话里同时有待回答问题与待审批时，DSH 只暴露优先级最高的那个，另一种的提醒可能会暂时延后。

### 测试命令

在会话输入框里直接输入（没有参数）：

```text
/attention-test
```

它会连续发起 **3 次**提问，一次一题，三题内容不同，而且**每次提问都会响一次提示音**。每题的行为都模拟正常的 `run_code` 嵌套提问：

- 阻塞式提问，没有 timed 前台窗口，所以**选择选项不会暂停倒计时**；
- 插件按绝对截止时间显示倒计时，最后 `countdownSeconds` 秒每秒响一次滴答；
- 到点仍未回答时由 Host 自动取消该题，然后继续下一题；
- 每题窗口 = `max(15 秒, countdownSeconds + 5 秒)`，最长 60 秒。

全部结束后命令返回三题的结果摘要（已回答 / 超时自动取消 / 被取消）。

> 这个命令测试的是**答题组**；审批提示音可以直接在设置页用“播放预览”试听。

### 设置页

两个入口指向同一份设置：

- **设置 → 答题与审批提醒 / Attention**（设置面板左侧独立页）；
- **设置 → 插件 → dsh-attention → 配置**（插件行页，若该行出现在插件列表里）。

页面分成两张独立卡片：

**答题提醒**

- 选择音频文件 / 播放预览 / 恢复内置；
- 音量滑块；
- 启用提示音；
- 倒计时音效开关 + 最后几秒（1–300）；
- 系统气泡通知（默认关闭，只提示有提问在等待，不显示问题内容）。

**权限审批提醒**

- 选择音频文件 / 播放预览 / 恢复内置；
- 音量滑块；
- 启用提示音；
- 重复提醒开关 + 提醒间隔（1–3600 秒，默认 60）；
- 系统气泡通知（默认关闭，只提示有审批在等待，不显示审批内容）。

保存位置：

- 导入的答题音频：`$DSH_HOME/dsh-attention/answer.<ext>`；
- 导入的审批音频：`$DSH_HOME/dsh-attention/approval.<ext>`；
- 两组偏好：同目录 `settings.json`，优先级高于 YAML 配置里的同名键。

浏览器要求页面先有一次点击才允许发声；如果预览没声音，先点一下页面再试。系统气泡通知还需要操作系统允许 DSH 的通知。

页面底部还有「发送测试通知」按钮，并显示当前系统通知权限（`granted` / `default` / `denied` / `unsupported`）与最近一次自动通知尝试（如 `question:ok`）。如果显示 `denied`，请在浏览器或系统的网站设置里允许本页通知；如果是 `granted` 却仍看不到气泡，请检查 Windows 通知中心 / 操作中心或 macOS 通知设置是否允许 DSH。

## 配置

插件行的配置键（在 `cordis.patch.yml` 或插件页的高级配置里）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `fallbackWindowMs` | `600000` | 模型没给 `run_code` 传 `timeoutMs` 时使用的回答窗口；应与 `ptc-runtime` 的 `timeoutMs` 保持一致。 |
| `answer.enabled` | `true` | 答题提示音总开关。 |
| `answer.volume` | `0.7` | 答题音量 0–1。 |
| `answer.countdownEnabled` | `true` | 最后 N 秒滴答开关。 |
| `answer.countdownSeconds` | `10` | 最后几秒每秒滴答一次，1–300。 |
| `answer.audioFile` | `''` | 可选：答题提示音频的绝对路径；设置页导入的文件优先，都没有时用插件自带的 `assets/default.wav`。 |
| `answer.systemNotification` | `false` | 是否在系统通知中心弹出答题气泡（只提示有提问在等待，不显示问题内容）。 |
| `approval.enabled` | `true` | 审批提示音总开关。 |
| `approval.volume` | `0.7` | 审批音量 0–1。 |
| `approval.repeatEnabled` | `true` | 审批出现后是否按间隔重复提醒。 |
| `approval.intervalSeconds` | `60` | 重复提醒间隔，1–3600 秒。 |
| `approval.audioFile` | `''` | 可选：审批提示音频的绝对路径；设置页导入的文件优先，都没有时用插件自带的 `assets/approval.wav`。 |
| `approval.systemNotification` | `false` | 是否在系统通知中心弹出审批气泡（只提示有审批在等待，不显示审批内容）。 |

设置页保存的偏好会覆盖行配置里的同名键（每组独立覆盖）。

## 目录结构

```text
dsh-attention/
├─ index.js                  # Host：两组设置/音频/偏好路由，注册 /attention-test
├─ client.js                 # 浏览器：答题倒计时、审批提醒调度、设置页
├─ cordis.patch.yml          # bundle 安装时的插入行
├─ assets/default.wav        # 答题自带的默认提示音
├─ assets/approval.wav       # 审批自带的默认提示音
├─ test/host-routes.test.mjs # Host 路由单测
├─ icon.svg                  # 插件图标（铃铛 + 问号）
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

- Host 只有四条**已认证**的同源路由：`GET /api/attention/config`、`GET/POST/DELETE /api/attention/audio`、`PUT /api/attention/settings`。
- 只读取配置指定的音频文件或设置页导入的文件；不接受任意路径请求，不访问外部网络。
- 审批提醒只读取全局待处理交互的 `kind` 和 `key`，不读取、不记录审批内容与工具参数。
- 设置与导入音频保存在本机 `$DSH_HOME/dsh-attention/`，不写入会话日志、不产生模型请求，也不注册模型工具（`/attention-test` 是人类触发的命令）。
- 删除导入音频或卸载插件不会影响已有会话；从 `dsh-ask-timer` 迁移只在首次读取时复制一次旧数据。

## 许可证

[MIT](./LICENSE) © 2026 mafuyuyu