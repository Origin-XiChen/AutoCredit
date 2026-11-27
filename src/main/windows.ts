import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { APP_META, POPUP_SECONDS } from '@shared/constants'
import type { AppId, PopupData } from '@shared/types'
import { getNotificationState } from './fullscreen'

const POPUP_BOTTOM_GAP = 24

export type PopupOutcome = 'cancelled' | 'started' | 'skipped'

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
  private popupResolve: ((outcome: PopupOutcome) => void) | null = null
  private popupTimer: NodeJS.Timeout | null = null
  private popupGuardTimer: NodeJS.Timeout | null = null
  private popupPhase: 'countdown' | 'running' | 'success' | 'error' = 'countdown'
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
   * Shows the 10 second countdown. Resolves `cancelled` when the user cancelled,
   * `started` when the countdown expired (popup stays open for check-in progress),
   * and `skipped` when no popup can be shown.
   */
  showPopup(ids: AppId[]): Promise<PopupOutcome> {
    if (!ids.length) return Promise.resolve('skipped')
    if (this.popupResolve || this.popupWindow) return Promise.resolve('skipped')

    this.popupPhase = 'countdown'
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

    return new Promise<PopupOutcome>((resolve) => {
      this.popupResolve = resolve
      this.popupTimer = setTimeout(() => this.startPopup(), POPUP_SECONDS * 1000)

      // If a fullscreen app starts during the countdown, stay quiet and proceed.
      const guard = async (): Promise<void> => {
        const state = await getNotificationState(true)
        if (state.suppressed && this.popupResolve) {
          this.settlePopup('skipped')
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
        if (this.popupResolve) this.settlePopup('skipped')
      })
    })
  }

  private startPopup(): void {
    const resolve = this.popupResolve
    if (!resolve || !this.popupWindow || this.popupWindow.isDestroyed()) return
    this.popupResolve = null
    this.popupData = null
    this.clearPopupTimers()
    this.popupPhase = 'running'
    this.popupWindow.webContents.send('popup:phase', { phase: 'running' })
    resolve('started')
  }

  /** Called after check-ins finish to show the result and close the popup. */
  async finishPopup(success: boolean): Promise<void> {
    const window = this.popupWindow
    if (!window || window.isDestroyed()) return
    this.popupPhase = success ? 'success' : 'error'
    window.webContents.send('popup:phase', { phase: this.popupPhase })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    this.popupWindow = null
    if (!window.isDestroyed()) {
      window.webContents.send('popup:dismiss')
      setTimeout(() => {
        if (!window.isDestroyed()) window.destroy()
      }, 180)
    }
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
    if (this.popupPhase !== 'countdown') return
    this.settlePopup('cancelled')
  }

  private clearPopupTimers(): void {
    if (this.popupTimer) clearTimeout(this.popupTimer)
    if (this.popupGuardTimer) clearTimeout(this.popupGuardTimer)
    this.popupTimer = null
    this.popupGuardTimer = null
  }

  private settlePopup(outcome: PopupOutcome): void {
    const resolve = this.popupResolve
    if (!resolve) return
    this.popupResolve = null
    this.popupData = null
    this.clearPopupTimers()

    const window = this.popupWindow
    this.popupWindow = null
    if (window && !window.isDestroyed()) {
      window.webContents.send('popup:dismiss')
      setTimeout(() => {
        if (!window.isDestroyed()) window.destroy()
      }, 180)
    }
    resolve(outcome)
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
