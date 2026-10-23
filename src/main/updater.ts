import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { Logger } from './logger'

interface UpdaterOptions {
  logger: Logger
  allowPrerelease: boolean
  onBeforeInstall: () => void
}

let manualCheck = false

/** 是否接收预发布（dev / beta）版本，由设置中的开关控制。 */
export function setAllowPrerelease(value: boolean): void {
  autoUpdater.allowPrerelease = value
}

export function initUpdater(options: UpdaterOptions): void {
  autoUpdater.allowPrerelease = options.allowPrerelease
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
  })

  autoUpdater.on('update-not-available', () => {
    options.logger.info('当前已是最新版本')
    if (manualCheck) {
      manualCheck = false
      void dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: `当前已是最新版本（${app.getVersion()}）`,
        buttons: ['好'],
      })
    }
  })

  autoUpdater.on('error', (error) => {
    options.logger.warn(`检查更新失败：${error.message}`)
    if (manualCheck) {
      manualCheck = false
      void dialog.showMessageBox({
        type: 'warning',
        title: '检查更新',
        message: '检查更新失败，请稍后重试',
        detail: error.message,
        buttons: ['好'],
      })
    }
  })

  autoUpdater.on('update-downloaded', async (info) => {
    if (!app.isPackaged) return
    const result = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `AutoCredit ${info.version} 已下载`,
      detail: '重启应用后将自动完成安装，也可以稍后在退出时安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) {
      options.onBeforeInstall()
      autoUpdater.quitAndInstall()
    }
  })

  setTimeout(() => {
    void checkForUpdates(false)
  }, 10_000)
}

export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      void dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: '开发模式下不检查更新',
        buttons: ['好'],
      })
    }
    return
  }

  manualCheck = manual
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // Failures are reported through the updater's `error` event.
  }
}
