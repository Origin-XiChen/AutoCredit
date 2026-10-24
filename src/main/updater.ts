import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import type { Logger } from './logger'

interface UpdaterOptions {
  logger: Logger
  allowPrerelease: boolean
  onBeforeInstall: () => void
  sendStatus: (status: UpdateStatus) => void
}

let manualCheck = false
let emitStatus: (status: UpdateStatus) => void = () => {}
let beforeInstall: () => void = () => {}

/** 是否接收预发布（dev / beta）版本，由设置中的开关控制。 */
export function setAllowPrerelease(value: boolean): void {
  autoUpdater.allowPrerelease = value
}

export function initUpdater(options: UpdaterOptions): void {
  autoUpdater.allowPrerelease = options.allowPrerelease
  emitStatus = options.sendStatus
  beforeInstall = options.onBeforeInstall
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (message) => options.logger.info(`更新：${String(message)}`),
    warn: (message) => options.logger.warn(`更新：${String(message)}`),
    error: (message) => options.logger.error(`更新：${String(message)}`),
    debug: (message) => options.logger.info(`更新：${String(message)}`),
  }

  autoUpdater.on('update-available', (info) => {
    options.logger.info(`发现新版本 ${info.version}，正在后台下载`)
    emitStatus({
      phase: 'available',
      version: info.version,
      message: `发现新版本 ${info.version}，正在后台下载…`,
    })
  })

  autoUpdater.on('update-not-available', () => {
    options.logger.info('当前已是最新版本')
    if (!manualCheck) return
    manualCheck = false
    emitStatus({
      phase: 'latest',
      version: app.getVersion(),
      message: `当前已是最新版本（${app.getVersion()}）`,
    })
  })

  autoUpdater.on('error', (error) => {
    options.logger.warn(`检查更新失败：${error.message}`)
    if (!manualCheck) return
    manualCheck = false
    emitStatus({ phase: 'error', message: `检查更新失败：${error.message}` })
  })

  autoUpdater.on('update-downloaded', (info) => {
    if (!app.isPackaged) return
    manualCheck = false
    emitStatus({
      phase: 'ready',
      version: info.version,
      message: `新版本 ${info.version} 已下载，重启应用后完成安装`,
    })
  })

  setTimeout(() => {
    void checkForUpdates(false)
  }, 10_000)
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) {
    if (manual) emitStatus({ phase: 'blocked', message: '开发模式下不检查更新' })
    return
  }

  manualCheck = manual
  if (manual) emitStatus({ phase: 'checking', message: '正在检查更新…' })
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // 失败通过 autoUpdater 的 error 事件统一回报。
  }
}

/** 下载完成后由界面按钮触发，重启并安装已下载的版本。 */
export function installUpdate(): void {
  beforeInstall()
  autoUpdater.quitAndInstall()
}
