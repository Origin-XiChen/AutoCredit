import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { APP_META, POPUP_SECONDS } from '@shared/constants'
import type { AppId, PopupData } from '@shared/types'
import { getNotificationState } from './fullscreen'

const POPUP_BOTTOM_GAP = 24

interface WindowManagerOptions {
  preload: string
}

function rendererUrl(): string | undefined {
  return process.env['ELECTRON_RENDERER_URL']
}

export class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private popupWindow: BrowserWindow | null = null
  private popupData: PopupData | null = null
  private popupResolve: ((cancelled: boolean) => void) | null = null
  private popupTimer: NodeJS.Timeout | null = null
  private popupGuardTimer: NodeJS.Timeout | null = null
  private quitting = false

  constructor(private readonly options: WindowManagerOptions) {}

  get window(): BrowserWindow | null {
    return this.mainWindow
  }

  get isQuitting(): boolean {
    return this.quitting
  }

  setQuitting(value: boolean): void {
    this.quitting = value
  }

  createMainWindow(show: boolean, options: { onClose: (event: Electron.Event) => void }): BrowserWindow {
    const window = new BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 960,
      minHeight: 660,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      titleBarStyle: 'hidden',
      title: 'AutoCredit',
      icon: join(app.getAppPath(), 'resources', 'icon.png'),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    })

    window.setMenuBarVisibility(false)
    window.on('close', options.onClose)
    window.once('ready-to-show', () => {
      if (show) window.show()
    })
    void this.load(window, 'index.html')
    this.mainWindow = window
    return window
  }

  showMain(): void {
    if (!this.mainWindow) return
    if (this.mainWindow.isMinimized()) this.mainWindow.restore()
    this.mainWindow.show()
    this.mainWindow.focus()
  }

  toggleMain(): void {
    if (!this.mainWindow) return
    if (this.mainWindow.isVisible() && !this.mainWindow.isMinimized()) {
      this.mainWindow.hide()
    } else {
      this.showMain()
    }
  }

  minimizeMain(): void {
    this.mainWindow?.minimize()
  }

  maximizeMain(): void {
    if (!this.mainWindow) return
    if (this.mainWindow.isMaximized()) {
      this.mainWindow.unmaximize()
    } else {
      this.mainWindow.maximize()
    }
  }

  hideMain(): void {
    this.mainWindow?.hide()
  }

  /**
   * Shows the 10 second countdown. Resolves `true` when the user cancelled,
   * `false` when the countdown expired or the popup must be skipped.
   */
  showPopup(ids: AppId[]): Promise<boolean> {
    if (!ids.length) return Promise.resolve(false)
    if (this.popupResolve) return Promise.resolve(false)

    const apps = ids.map((id) => ({ id, name: APP_META[id].name }))
    this.popupData = { apps, seconds: POPUP_SECONDS }

    const window = new BrowserWindow({
      width: 372,
      height: Math.min(320, 116 + apps.length * 14),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    window.setAlwaysOnTop(true, 'screen-saver')
    this.popupWindow = window
    this.positionPopup(window)

    window.once('ready-to-show', () => {
      this.positionPopup(window)
      window.showInactive()
    })

    void this.load(window, 'popup.html')

    return new Promise<boolean>((resolve) => {
      this.popupResolve = resolve
      this.popupTimer = setTimeout(() => this.settlePopup(false), POPUP_SECONDS * 1000)

      // If a fullscreen app starts during the countdown, stay quiet and proceed.
      const guard = async (): Promise<void> => {
        const state = await getNotificationState(true)
        if (state.suppressed && this.popupResolve) {
          this.settlePopup(false)
        }
      }
      this.popupGuardTimer = setTimeout(() => {
        void guard()
        setTimeout(() => {
          void guard()
        }, 3200)
      }, 3200)

      window.on('closed', () => {
        if (this.popupWindow === window) this.popupWindow = null
        if (this.popupResolve) this.settlePopup(false)
      })
    })
  }

  private positionPopup(window: BrowserWindow): void {
    const display = screen.getPrimaryDisplay()
    const { workArea } = display
    const bounds = window.getBounds()
    window.setPosition(
      Math.round(workArea.x + workArea.width - bounds.width - 18),
      Math.round(workArea.y + workArea.height - bounds.height - POPUP_BOTTOM_GAP),
    )
  }

  getPopupData(): PopupData | null {
    return this.popupData
  }

  cancelPopup(): void {
    this.settlePopup(true)
  }

  private settlePopup(cancelled: boolean): void {
    if (!this.popupResolve) return
    const resolve = this.popupResolve
    this.popupResolve = null
    this.popupData = null
    if (this.popupTimer) clearTimeout(this.popupTimer)
    if (this.popupGuardTimer) clearTimeout(this.popupGuardTimer)
    this.popupTimer = null
    this.popupGuardTimer = null

    const window = this.popupWindow
    this.popupWindow = null
    if (window && !window.isDestroyed()) {
      window.webContents.send('popup:dismiss')
      setTimeout(() => {
        if (!window.isDestroyed()) window.destroy()
      }, 180)
    }
    resolve(cancelled)
  }

  private async load(window: BrowserWindow, entry: string): Promise<void> {
    const base = rendererUrl()
    try {
      if (base) {
        await window.loadURL(`${base.replace(/\/$/, '')}/${entry}`)
      } else {
        await window.loadFile(join(__dirname, `../renderer/${entry}`))
      }
    } catch {
      // The window may be destroyed before its content finishes loading.
    }
  }
}
