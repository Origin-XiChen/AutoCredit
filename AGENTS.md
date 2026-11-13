# AGENTS.md — AutoCredit 最高优先级接管文档

> **所有 AI / 自动化代理在阅读、修改、打包、提交或发布本项目之前，必须先完整阅读本文件。**
>
> 本文件优先级高于任何临时对话、历史习惯和自动生成建议。若其他说明与本文件冲突，以本文件为准；若本文件未覆盖且存在风险，先询问用户，不要自行决定。
>
> 接管后的第一条回复必须明确声明「已阅读 AGENTS.md」，并遵守以下开工检查。

---

## 0. 开工前强制检查

1. 完整阅读本文件，尤其是「不可违反的约束」和「发布 checklist」。
2. 执行 `git status`、`git log -5 --oneline`，确认工作区是否干净、当前版本与最近提交。
3. 读取 `package.json` 的 `version`，不要凭记忆判断版本号。
4. 确认本次任务没有触碰下文任何红线；如触碰，先向用户说明并获得确认。
5. 任何无法验证的改动都必须如实说明，不得声称「已测试」或「已发布」。

---

## 1. 项目快照

| 项目 | 值 |
| --- | --- |
| 名称 | AutoCredit |
| 当前版本 | **1.1.4** |
| 平台 | Windows 10 / 11 桌面应用 |
| 技术栈 | Electron 45 + electron-vite 6 + React 19 + TypeScript + electron-builder 26 + electron-updater |
| 仓库 | https://github.com/Origin-XiChen/AutoCredit |
| 分支 | `main` |
| 许可证 | GPL-3.0-only |
| 安装包产物 | `release/AutoCredit-<version>-Setup.exe`、`.blockmap`、`latest.yml` |
| 最后更新 | 2026-11-13 |

产品定位：每天在 **Trae CN、Qoder、Qoder CN、WorkBuddy** 上自动签到并领取积分。豆包为默认隐藏的实验功能，仅在设置中开启开发者模式后可见。

本项目仅供个人使用，与上述平台及其公司无任何关联。

---

## 2. 不可违反的约束

### 2.1 产品范围

- 稳定支持：Trae CN、Qoder、Qoder CN、WorkBuddy。
- 实验支持：豆包。**默认必须隐藏**，只有 `settings.developerMode === true` 时才显示、才允许启用。
- 关闭开发者模式时，必须自动停用豆包（`apps.doubao.enabled = false`），并禁止再次启用。
- Trae 显示名统一为 **Trae CN**；内部 id 仍为 `trae`，不要改 id。
- 不要新增未经验证的签到平台；新增实验适配器必须遵守「默认隐藏 + 开发者模式」规则。

### 2.2 签到规则

- **Trae**：只支持中国版（trae.cn）。国际版（trae.ai）没有每日签到，必须识别并提示「国际版没有每日签到，无需签到」，不得发起签到请求。
- **WorkBuddy**：只支持中国版（`*.cn` 域名）。国际版同样跳过并提示，不得发起签到请求。
- **Qoder / Qoder CN**：签到日从 **10:00** 起算，`checkinResetHour = 10`。
  - 10:00 前探测到的「已领取」属于前一天，不能记为当天已完成。
  - 10:00 前手动签到也只记前一天，不能阻止当天签到。
  - 失败重试次数按签到日结算，10:00 前失败不消耗当天次数。
  - 其他程序 `checkinResetHour = 0`（自然日）。
- 同一天同一程序只成功签到一次；失败按调度器的间隔重试。
- 签到前右下角倒计时弹窗可取消；全屏应用运行时自动跳过。

### 2.3 界面与弹窗

- 整体风格：极简、扁平、克制；禁止玻璃拟态、渐变、重阴影、花哨装饰。
- 顶部栏和侧边栏是悬浮卡片，内容区是平面面板，不要给内容区再加卡片外框。
- 窗口的最小化、最大化、还原、拖动、缩放动画必须平滑。
- 右下角签到弹窗：
  - 必须是纯圆角矩形，无图标、无彩色背景、无边框、无重阴影。
  - 淡入淡出动画，禁止瞬间显示/隐藏。
  - 位置：距屏幕右侧 **18px**，距任务栏 **24px**，确保四角完整可见。
  - 高度随程序数量动态变化，不得留固定空白。
  - 卡片必须使用 `box-sizing: border-box`，防止 padding 导致底部圆角被裁切。
- 更新反馈必须使用应用内状态条/弹窗，不要再用系统 `dialog.showMessageBox`。

### 2.4 启动、托盘与卸载

- 双击启动必须显示主界面；只有开启「开机自启动时最小化到托盘」时才隐藏到托盘。
- 关闭窗口默认最小化到托盘，签到计划继续运行。
- 托盘常驻；右键菜单包含显示、立即签到、主开关、设置、检查更新、退出。
- 托盘「检查更新」必须打开主窗口并跳到「设置 → 关于」，使用应用内结果条反馈。
- 安装包必须包含注册到 Windows「设置 → 应用」的卸载程序。
- 卸载默认保留本机配置与加密令牌，重新安装后可继续使用。

### 2.5 更新

- 必须保留 GitHub Releases 自动更新（electron-updater）。
- 设置 → 关于提供「检查更新」按钮；结果显示在应用内状态条。
- 设置 → 关于提供「接收 dev 版本」开关；开启后 `allowPrerelease = true`。
- 新版本下载完成后显示应用内弹窗，提供「稍后 / 立即重启」，不再弹系统对话框。
- 后台自动检查失败不得打断用户；只有手动检查才显示失败信息。
- 发布必须是正式版（`isPrerelease = false`），并设为 Latest。

### 2.6 安全与隐私

- Qoder / Qoder CN 的 PAT 必须用 Electron `safeStorage`（Windows DPAPI）加密保存在本机。
- 日志与配置只保存在本机用户数据目录；**任何日志都不得包含令牌、Cookie 或完整登录态**。
- 不引入遥测、埋点、远程上报；更新检查只访问本项目 GitHub Release。
- 不要把用户本机的登录态、令牌、路径写入仓库或提交历史。
- 安全说明与漏洞报告方式见 `SECURITY.md`。

### 2.7 Git 与发布

- 只允许 **XiChen** 和 **DeepSeek** 作为提交作者；不得出现其他 AI 标识或工具署名。
- 不要改写历史、不要 force push `main`。
- 每次发布使用独立、聚焦的提交；不要混入无关格式化或调试代码。
- 不要在用户未明确要求时提交、推送或发布。
- 发布前必须清理临时脚本、测试 profile、截图等中间产物。

---

## 3. 架构地图

```
src/
  main/                     Electron 主进程
    index.ts                组合根：窗口、IPC、调度器、适配器、托盘、更新初始化
    scheduler.ts            定时/补签/重试/探测，签到日边界在此应用
    date.ts                 localDateKey、checkinDateKey(resetHour)
    store.ts                配置、登录态、日志、安全存储
    windows.ts              主窗口、弹窗窗口、显示/隐藏
    tray.ts                 托盘菜单
    updater.ts              electron-updater + update:status 事件
    logger.ts               本地日志
    http.ts                 请求封装
    fullscreen.ts           全屏检测
    checkin/
      types.ts              Adapter / Readiness / ProbeResult / Outcome / locate
      paths.ts              路径展开（%VAR%、~）、目录扫描等定位辅助
      trae.ts               Trae CN 签到（含国际版识别）
      qoder.ts              Qoder / Qoder CN（PAT）
      workbuddy.ts          WorkBuddy（含国际版识别）
      doubao.ts             豆包实验签到（CDP 调试端口）
  preload/index.ts         contextBridge 暴露 AutoCreditApi
  shared/
    constants.ts            APP_META、APP_ORDER、visibleAppIds、默认配置
    types.ts                共享类型（AppId、BootstrapState、UpdateStatus 等）
  renderer/
    src/App.tsx             页面框架、更新就绪弹窗、通知、导航
    src/Overview.tsx        总览
    src/Settings.tsx        设置（启动与时间 / 程序与账号 / 通用 / 关于）
    src/Logs.tsx            日志
    src/ui.tsx              通用组件（AppGlyph、Switch、StatusPill 等）
    src/popup.tsx / .css    右下角签到倒计时弹窗
    src/styles.css          全局样式
```

关键机制：

- `visibleAppIds(settings)` 是豆包可见性的唯一入口；总览、设置、日志、调度器都必须使用它。
- 适配器统一实现 `readiness / detect / probe / checkIn`；`Readiness.status` 可覆盖默认状态（国际版用 `unavailable`）。
- 签到日由 `checkinDateKey(APP_META[id].checkinResetHour ?? 0)` 计算，所有「是否已完成 / 探测日 / 尝试次数」都必须使用它，不要直接用自然日。
- 主进程通过 `update:status` 推送更新状态；`ui:settings-about` 用于托盘跳转关于页。
- 渲染层只能通过 `window.autoCredit` 调用主进程能力，不要直接使用 Node API。
- 程序定位统一走适配器的 `locate()`（设置页「自动搜索」）：`customPath` 表示登录态 / 数据路径，`customExePath` 表示客户端路径；两者留空时自动检测，填写了但不存在时也必须回退到自动检测，不能因路径失效导致签到整体失败。

---

## 4. 修改流程

1. 阅读相关源码，不要凭记忆修改。
2. 只做任务要求的最小改动；不要顺手重构、加无关抽象或改文案风格。
3. 涉及签到逻辑时，先确认签到日边界、国际版判断和开发者模式没有被破坏。
4. 完成前必须运行：
   ```bash
   npm run typecheck
   npm run build
   ```
   涉及安装包或发布时再运行：
   ```bash
   npm run dist
   ```
5. 尽量实际启动应用验证 UI（开发测试用独立 `--user-data-dir` 和 `-dev` 标识，避免与正式版托盘混淆）。
6. 如改动影响行为或版本，更新本文件的「项目快照」和「版本进度」。
7. 向用户汇报：改了什么、验证了什么、未验证什么、是否已提交/发布。

---

## 5. 发布 checklist（必须逐项完成）

- [ ] 用户明确要求发布。
- [ ] `package.json` 版本号已提升，`package-lock.json` 一致。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run dist` 成功，`release/` 中生成 `AutoCredit-<version>-Setup.exe`、`.blockmap`、`latest.yml`。
- [ ] 已实际验证关键界面或签到流程；无法验证的部分已如实说明。
- [ ] 已更新本文件的「当前版本」「最后更新」「版本进度」。
- [ ] 只暂存本次相关文件，确认没有临时脚本、日志、截图、用户数据。
- [ ] 提交作者只有 XiChen / DeepSeek，提交信息聚焦本次变更。
- [ ] 已推送 `main`，且没有 force push。
- [ ] GitHub Release 使用 `v<version>` 标签，正式版，设为 Latest。
- [ ] Release 附件包含安装包、`.blockmap`、`latest.yml` 三项。
- [ ] 发布后核对 Release 资产与 Latest 状态，并向用户汇报链接。

---

## 6. 版本进度

> 维护规则：每次发布必须在此表追加一行，并同步更新第 1 节的当前版本与最后更新时间。版本事实以 `package.json` 和 GitHub Release 为准。

| 版本 | 主要变更 |
| --- | --- |
| 1.0.0 | 初始公开版本：Trae CN、Qoder、Qoder CN、WorkBuddy 每日签到；托盘常驻；NSIS 安装/卸载；GitHub 自动更新 |
| 1.0.1 | 双击启动打开主界面；新增开机自启动最小化选项；完善自动更新与卸载注册 |
| 1.1.0 | 新增豆包实验签到（默认隐藏，开发者模式启用）；新增 Trae / WorkBuddy 国际版无需签到提醒；新增「接收 dev 版本」开关 |
| 1.1.1 | 设置 → 关于新增「检查更新」入口与版本提示；Trae 显示名统一为 Trae CN |
| 1.1.2 | Qoder / Qoder CN 签到日改为 10:00 起算，修复前一日状态被误判为当天已完成导致的漏签 |
| 1.1.3 | 更新结果改为应用内状态条与自绘弹窗，移除系统对话框；NSIS 安装向导加入品牌图标、横幅与侧栏 |
| 1.1.4 | 设置页支持为 Trae CN、WorkBuddy、豆包手动填写/浏览/自动搜索路径；自动搜索兼容非默认安装目录，自定义路径无效时自动回退 |

---

## 7. 历史坑与既定决策

- **弹窗被任务栏裁切**：使用全屏坐标定位底部会裁切圆角；最终位置是右侧 18px、任务栏上方 24px。
- **弹窗底部尖角**：`.popup-card` 未设置 `box-sizing: border-box` 时，padding 会撑出窗口边界。
- **开发版 Electron 启动即退出**：与已安装正式版的单实例锁冲突；测试必须使用独立 `--user-data-dir`。
- **豆包无法真正静默**：接口依赖 `a_bogus`、`msToken`、`device_id` 等动态签名，裸请求返回 `710010702 系统错误`；当前用 CDP 调试端口模拟点击，可能闪一下客户端窗口。
- **豆包单实例限制**：若豆包已普通运行且未开调试端口，需要先完全退出再签到。
- **Qoder 10:00 刷新**：10:00 前的签到属于前一天，所有完成状态与重试计数必须按签到日计算。
- **国际版无签到**：Trae 国际版（trae.ai）与 WorkBuddy 国际版都不应调用签到接口，只提示并标记不可用。
- **更新弹窗风格**：用户明确要求应用内自绘弹窗，不要再恢复系统原生对话框。
- **提交署名**：历史要求提交中只出现 XiChen 和 DeepSeek，不要添加其他 AI 工具标识。
- **跨电脑路径差异**：Trae / WorkBuddy / 豆包可能安装在非默认目录，登录态目录也可能被改名或重定向；自动搜索必须覆盖常见目录并允许用户在设置中手动填写 `customPath` / `customExePath`，且无效自定义路径要自动回退。

---

## 8. 文档维护

- 本文件是最高优先级接管文档，任何 AI 在改动前必须阅读并在首条回复中声明。
- 每次发布都必须更新第 1 节和第 6 节；不要把过期版本留在文档里。
- 新增或修改硬约束时，同步更新本文件对应章节，并在第 7 节补充原因。
- 如果本文件与代码实际行为不一致，先停止发布，查清事实后再更新文档或代码，不能两边长期矛盾。
