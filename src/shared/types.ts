export type AppId = 'trae' | 'qoder' | 'qoder-cn' | 'workbuddy' | 'doubao'

export type ThemeMode = 'system' | 'light' | 'dark'

export type RunStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'already'
  | 'failed'
  | 'cancelled'
  | 'needs-auth'
  | 'needs-setup'
  | 'unavailable'

export type LogLevel = 'info' | 'success' | 'warn' | 'error'

export interface AppConfig {
  enabled: boolean
  useCustomTime: boolean
  time: string
}

export interface AppRuntime {
  status: RunStatus
  message: string
  credits?: number
  lastSuccessDate?: string
  lastSuccessAt?: string
  lastAttemptAt?: string
  lastAttemptDate?: string
  attempts: number
  todayCheckedIn?: boolean
  probeDate?: string
  userLabel?: string
  updatedAt?: string
}

export interface GlobalSettings {
  masterEnabled: boolean
  defaultTime: string
  autoLaunch: boolean
  startMinimized: boolean
  closeToTray: boolean
  theme: ThemeMode
  logRetentionDays: number
  developerMode: boolean
  allowPrerelease: boolean
}

export interface ConfigFile {
  version: number
  settings: GlobalSettings
  apps: Record<AppId, AppConfig>
  runtime: Record<AppId, AppRuntime>
  machineId: string
  createdAt: string
}

export interface AppMeta {
  id: AppId
  name: string
  fullName: string
  description: string
  autoAuth: boolean
  patUrl?: string
  accountHint: string
  note?: string
  /** 每日签到刷新时刻（小时），此时间之前仍属于前一个签到日。 */
  checkinResetHour?: number
}

export interface BootstrapState {
  settings: GlobalSettings
  apps: Record<AppId, AppConfig>
  runtime: Record<AppId, AppRuntime>
  metas: AppMeta[]
  secrets: Record<AppId, boolean>
  version: string
  dataDir: string
  logsDir: string
  isPackaged: boolean
}

export interface LogEntry {
  id: number
  ts: number
  level: LogLevel
  appId?: AppId
  message: string
}

export interface PopupApp {
  id: AppId
  name: string
}

export interface PopupData {
  apps: PopupApp[]
  seconds: number
}

export interface DetectResult {
  ok: boolean
  message: string
  userLabel?: string
}

export interface SavePatResult {
  ok: boolean
  message: string
}

export interface AppInfo {
  version: string
  dataDir: string
  logsDir: string
  isPackaged: boolean
}

export interface AutoCreditApi {
  getState(): Promise<BootstrapState>
  onState(callback: (state: BootstrapState) => void): () => void
  onLog(callback: (entry: LogEntry) => void): () => void
  setMaster(enabled: boolean): Promise<void>
  updateSettings(patch: Partial<GlobalSettings>): Promise<void>
  updateApp(id: AppId, patch: Partial<AppConfig>): Promise<void>
  savePat(id: AppId, pat: string): Promise<SavePatResult>
  clearPat(id: AppId): Promise<void>
  detect(id: AppId): Promise<DetectResult>
  probeAll(): Promise<void>
  runNow(ids?: AppId[]): Promise<void>
  checkUpdates(): Promise<void>
  getLogs(): Promise<LogEntry[]>
  clearLogs(): Promise<void>
  exportLogs(): Promise<string | null>
  getPopupData(): Promise<PopupData | null>
  onPopupDismiss(callback: () => void): () => void
  popupCancel(): void
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  windowMinimize(): void
  windowMaximize(): void
  windowClose(): void
}
