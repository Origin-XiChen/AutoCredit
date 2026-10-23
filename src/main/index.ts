import { app, dialog, ipcMain, powerMonitor, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_META, APP_ORDER } from '@shared/constants'
import type {
  AppConfig,
  AppId,
  DetectResult,
  GlobalSettings,
  SavePatResult,
} from '@shared/types'
import { DoubaoAdapter } from './checkin/doubao'
import { QoderAdapter } from './checkin/qoder'
import { TraeAdapter } from './checkin/trae'
import type { Adapter } from './checkin/types'
import { WorkBuddyAdapter } from './checkin/workbuddy'
import { isValidTime, localDateKey } from './date'
import { Logger } from './logger'
import { Scheduler } from './scheduler'
import { Store } from './store'
import { TrayController } from './tray'
import { checkForUpdates, initUpdater, setAllowPrerelease } from './updater'
import { WindowManager } from './windows'

app.setAppUserModelId('com.xichen.autocredit')

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  let store: Store
  let logger: Logger
  let windows: WindowManager
  let scheduler: Scheduler
  let tray: TrayController
  let adapters: Record<AppId, Adapter>

  const broadcastState = (): void => {
    if (!store || !windows?.window || windows.window.isDestroyed()) return
    windows.window.webContents.send('state:update', store.bootstrap())
  }

  const applyLoginItem = (autoLaunch: boolean): void => {
    if (!app.isPackaged) return
    app.setLoginItemSettings({
      openAtLogin: autoLaunch,
      args: ['--hidden'],
    })
  }

  const setMaster = (enabled: boolean): void => {
    store.updateSettings({ masterEnabled: enabled })
    logger.info(enabled ? '自动签到已开启' : '自动签到已暂停')
    tray?.update()
    broadcastState()
    if (enabled) void scheduler.tick()
  }

  const quitApp = (): void => {
    windows.setQuitting(true)
    app.quit()
  }

  app.on('second-instance', () => windows?.showMain())
  app.on('before-quit', () => windows?.setQuitting(true))
  app.on('will-quit', () => scheduler?.stop())
  app.on('activate', () => windows?.showMain())
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && store && !store.settings.closeToTray) {
      quitApp()
    }
  })

  app.whenReady().then(async () => {
    const userData = app.getPath('userData')
    const firstRun = !existsSync(join(userData, 'config.json'))

    store = new Store()
    logger = new Logger(store.logsDir, store.settings.logRetentionDays)
    logger.attach((entry) => {
      if (windows?.window && !windows.window.isDestroyed()) {
        windows.window.webContents.send('log:new', entry)
      }
    })
    logger.info(`AutoCredit ${app.getVersion()} 已启动`)

    const deps = { store }
    adapters = {
      trae: new TraeAdapter(deps),
      qoder: new QoderAdapter('qoder', 'global', deps),
      'qoder-cn': new QoderAdapter('qoder-cn', 'cn', deps),
      workbuddy: new WorkBuddyAdapter(deps),
      doubao: new DoubaoAdapter(deps),
    }

    windows = new WindowManager({
      preload: join(__dirname, '../preload/index.js'),
    })

    applyLoginItem(store.settings.autoLaunch)

    const hiddenLaunch =
      process.argv.includes('--hidden') && store.settings.startMinimized
    windows.createMainWindow(firstRun || !hiddenLaunch, {
      onClose: (event) => {
        if (windows.isQuitting) return
        if (store.settings.closeToTray) {
          event.preventDefault()
          windows.hideMain()
        } else {
          quitApp()
        }
      },
    })

    scheduler = new Scheduler({
      store,
      logger,
      adapters,
      popup: { show: (ids) => windows.showPopup(ids) },
      onChange: broadcastState,
    })

    tray = new TrayController({
      iconPath: join(app.getAppPath(), 'resources', 'icon.png'),
      isMasterEnabled: () => store.settings.masterEnabled,
      onShow: () => windows.showMain(),
      onRunNow: () => {
        windows.showMain()
        void scheduler.runNow()
      },
      onToggleMaster: (enabled) => setMaster(enabled),
      onSettings: () => windows.showMain(),
      onCheckUpdates: () => {
        void checkForUpdates(true)
      },
      onQuit: () => quitApp(),
    })

    registerIpc()
    scheduler.start()

    initUpdater({
      logger,
      allowPrerelease: store.settings.allowPrerelease,
      onBeforeInstall: () => windows.setQuitting(true),
    })

    powerMonitor.on('resume', () => {
      setTimeout(() => {
        void scheduler.catchUp('已从休眠中唤醒')
      }, 2500)
    })
    powerMonitor.on('unlock-screen', () => {
      setTimeout(() => {
        void scheduler.catchUp('已解锁')
      }, 1500)
    })
  }).catch((error: unknown) => {
    console.error('AutoCredit failed to start:', error)
    app.quit()
  })

  function registerIpc(): void {
    ipcMain.handle('state:get', () => store.bootstrap())

    ipcMain.handle('master:set', (_event, enabled: unknown) => {
      setMaster(enabled === true)
    })

    ipcMain.handle('settings:update', (_event, rawPatch: unknown) => {
      const patch = sanitizeSettings(rawPatch)
      if (!Object.keys(patch).length) return
      store.updateSettings(patch)
      if (patch.developerMode === false && store.apps.doubao.enabled) {
        store.updateApp('doubao', { enabled: false })
        logger.info('开发者模式已关闭，豆包签到已停用', 'doubao')
      }
      if (patch.autoLaunch !== undefined) applyLoginItem(patch.autoLaunch)
      if (patch.allowPrerelease !== undefined) {
        setAllowPrerelease(patch.allowPrerelease)
        logger.info(patch.allowPrerelease ? '已开启接收 dev 版本更新' : '已关闭接收 dev 版本更新')
      }
      if (patch.masterEnabled !== undefined) {
        logger.info(patch.masterEnabled ? '自动签到已开启' : '自动签到已暂停')
      }
      logger.info('设置已更新')
      tray?.update()
      broadcastState()
      if (patch.masterEnabled !== false) void scheduler.tick()
    })

    ipcMain.handle('app:update', (_event, rawId: unknown, rawPatch: unknown) => {
      const id = toAppId(rawId)
      if (!id) return
      const patch = sanitizeAppPatch(rawPatch)
      if (!Object.keys(patch).length) return
      if (id === 'doubao' && patch.enabled === true && !store.settings.developerMode) {
        logger.warn('豆包签到属于实验功能，请先在设置中开启开发者模式', id)
        return
      }
      store.updateApp(id, patch)
      const meta = APP_META[id]
      if (patch.enabled !== undefined) {
        logger.info(`${meta.name} 签到已${patch.enabled ? '启用' : '关闭'}`, id)
      }
      if (patch.useCustomTime !== undefined) {
        logger.info(`${meta.name} 独立签到时间已${patch.useCustomTime ? '开启' : '关闭'}`, id)
      }
      broadcastState()
      void scheduler.tick()
    })

    ipcMain.handle('pat:save', async (_event, rawId: unknown, rawPat: unknown): Promise<SavePatResult> => {
      const id = toAppId(rawId)
      if (id !== 'qoder' && id !== 'qoder-cn') {
        return { ok: false, message: '该程序不需要手动令牌' }
      }
      const pat = typeof rawPat === 'string' ? rawPat.trim() : ''
      if (!pat) return { ok: false, message: '请输入个人访问令牌' }
      if (pat.length < 8) return { ok: false, message: '令牌长度不正确，请检查后重试' }

      try {
        store.setPat(id, pat)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '保存令牌失败' }
      }
      store.updateRuntime(id, {
        status: 'idle',
        message: '正在验证令牌…',
        todayCheckedIn: false,
        probeDate: undefined,
        lastAttemptDate: undefined,
        lastAttemptAt: undefined,
        attempts: 0,
      })
      logger.info(`已保存 ${APP_META[id].name} 个人访问令牌`, id)
      broadcastState()

      const result = await adapters[id].detect()
      store.updateRuntime(id, {
        status: result.ok ? 'idle' : 'needs-auth',
        message: result.ok ? '令牌有效，等待签到' : result.message,
        userLabel: result.userLabel,
      })
      if (result.ok) {
        logger.success(`${APP_META[id].name}：${result.message}`, id)
        void scheduler.probeAll([id]).then(() => scheduler.tick())
      } else {
        logger.warn(`${APP_META[id].name}：${result.message}`, id)
      }
      broadcastState()
      return { ok: result.ok, message: result.message }
    })

    ipcMain.handle('pat:clear', (_event, rawId: unknown) => {
      const id = toAppId(rawId)
      if (id !== 'qoder' && id !== 'qoder-cn') return
      store.clearPat(id)
      store.updateRuntime(id, {
        status: 'needs-setup',
        message: '尚未保存个人访问令牌',
        userLabel: undefined,
        todayCheckedIn: false,
      })
      logger.info(`已清除 ${APP_META[id].name} 个人访问令牌`, id)
      broadcastState()
    })

    ipcMain.handle('app:detect', async (_event, rawId: unknown): Promise<DetectResult> => {
      const id = toAppId(rawId)
      if (!id) return { ok: false, message: '未知程序' }
      const result = await adapters[id].detect()
      if (result.ok && (store.runtime[id].status === 'needs-auth' || store.runtime[id].status === 'needs-setup')) {
        store.updateRuntime(id, {
          status: 'idle',
          message: '连接正常，等待签到',
          userLabel: result.userLabel,
        })
      }
      if (result.ok) {
        logger.success(`${APP_META[id].name}：${result.message}`, id)
      } else {
        logger.warn(`${APP_META[id].name}：${result.message}`, id)
      }
      broadcastState()
      return result
    })

    ipcMain.handle('probe:all', async () => {
      await scheduler.probeAll()
    })

    ipcMain.handle('run:now', async (_event, rawIds: unknown) => {
      const ids = Array.isArray(rawIds)
        ? rawIds.map((value) => toAppId(value)).filter((value): value is AppId => Boolean(value))
        : undefined
      await scheduler.runNow(ids)
    })

    ipcMain.handle('logs:get', () => logger.entries())

    ipcMain.handle('logs:clear', () => {
      logger.clear()
      broadcastState()
    })

    ipcMain.handle('logs:export', async (): Promise<string | null> => {
      const options = {
        title: '导出 AutoCredit 日志',
        defaultPath: join(app.getPath('documents'), `AutoCredit-日志-${localDateKey()}.txt`),
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      }
      const result = windows.window
        ? await dialog.showSaveDialog(windows.window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      logger.exportToFile(result.filePath)
      return result.filePath
    })

    ipcMain.handle('popup:data', () => windows.getPopupData())
    ipcMain.on('popup:cancel', () => windows.cancelPopup())

    ipcMain.handle('open:external', async (_event, rawUrl: unknown) => {
      const url = typeof rawUrl === 'string' ? rawUrl : ''
      if (!/^https?:\/\//i.test(url)) return
      await shell.openExternal(url)
    })

    ipcMain.handle('open:path', async (_event, rawPath: unknown) => {
      const path = typeof rawPath === 'string' ? rawPath : ''
      if (path !== store.dataDir && path !== store.logsDir) return
      await shell.openPath(path)
    })

    ipcMain.on('window:minimize', () => windows.minimizeMain())
    ipcMain.on('window:maximize', () => windows.maximizeMain())
    ipcMain.on('window:close', () => windows.window?.close())
  }
}

function toAppId(value: unknown): AppId | undefined {
  return typeof value === 'string' && (APP_ORDER as string[]).includes(value)
    ? (value as AppId)
    : undefined
}

function sanitizeSettings(input: unknown): Partial<GlobalSettings> {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Record<string, unknown>
  const patch: Partial<GlobalSettings> = {}
  if (typeof raw.masterEnabled === 'boolean') patch.masterEnabled = raw.masterEnabled
  if (typeof raw.autoLaunch === 'boolean') patch.autoLaunch = raw.autoLaunch
  if (typeof raw.startMinimized === 'boolean') patch.startMinimized = raw.startMinimized
  if (typeof raw.closeToTray === 'boolean') patch.closeToTray = raw.closeToTray
  if (typeof raw.defaultTime === 'string' && isValidTime(raw.defaultTime)) {
    patch.defaultTime = raw.defaultTime
  }
  if (raw.theme === 'system' || raw.theme === 'light' || raw.theme === 'dark') {
    patch.theme = raw.theme
  }
  if (typeof raw.logRetentionDays === 'number' && Number.isFinite(raw.logRetentionDays)) {
    patch.logRetentionDays = Math.min(90, Math.max(1, Math.round(raw.logRetentionDays)))
  }
  if (typeof raw.developerMode === 'boolean') patch.developerMode = raw.developerMode
  if (typeof raw.allowPrerelease === 'boolean') patch.allowPrerelease = raw.allowPrerelease
  return patch
}

function sanitizeAppPatch(input: unknown): Partial<AppConfig> {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Record<string, unknown>
  const patch: Partial<AppConfig> = {}
  if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled
  if (typeof raw.useCustomTime === 'boolean') patch.useCustomTime = raw.useCustomTime
  if (typeof raw.time === 'string' && isValidTime(raw.time)) patch.time = raw.time
  return patch
}
