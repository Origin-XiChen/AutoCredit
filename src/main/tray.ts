import { Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'node:fs'

interface TrayControllerOptions {
  iconPath: string
  isMasterEnabled: () => boolean
  onShow: () => void
  onRunNow: () => void
  onToggleMaster: (enabled: boolean) => void
  onSettings: () => void
  onQuit: () => void
}

export class TrayController {
  private tray: Tray | null = null

  constructor(private readonly options: TrayControllerOptions) {
    const image = existsSync(options.iconPath)
      ? nativeImage.createFromPath(options.iconPath).resize({ width: 20, height: 20 })
      : nativeImage.createEmpty()
    this.tray = new Tray(image)
    this.tray.setToolTip('AutoCredit · 每日静默签到')
    this.tray.on('double-click', () => this.options.onShow())
    this.update()
  }

  update(): void {
    if (!this.tray) return
    const menu = Menu.buildFromTemplate([
      { label: '显示 AutoCredit', click: () => this.options.onShow() },
      { label: '立即签到', click: () => this.options.onRunNow() },
      { type: 'separator' },
      {
        label: '自动签到',
        type: 'checkbox',
        checked: this.options.isMasterEnabled(),
        click: (item) => this.options.onToggleMaster(item.checked),
      },
      { label: '设置…', click: () => this.options.onSettings() },
      { type: 'separator' },
      { label: '退出 AutoCredit', click: () => this.options.onQuit() },
    ])
    this.tray.setContextMenu(menu)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
