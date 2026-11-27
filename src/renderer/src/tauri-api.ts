import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  AppConfig,
  AppId,
  AutoCreditApi,
  BootstrapState,
  DetectResult,
  GlobalSettings,
  LocateResult,
  LogEntry,
  PopupData,
  PopupPhasePayload,
  SavePatResult,
  UpdateStatus,
} from '@shared/types'

function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listen<T>(event, (payload) => callback(payload.payload)).then((fn) => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => {
    disposed = true
    unlisten?.()
    unlisten = undefined
  }
}

/** 在 Tauri 中复用现有的 window.autoCredit 接口，渲染层无需改调用方式。 */
export function installTauriApi(): void {
  if (!('__TAURI_INTERNALS__' in window)) return

  const api: AutoCreditApi = {
    getState: () => invoke<BootstrapState>('state_get'),
    onState: (callback) => subscribe<BootstrapState>('state:update', callback),
    onLog: (callback) => subscribe<LogEntry>('log:new', callback),
    setMaster: (enabled: boolean) => invoke('master_set', { enabled }),
    updateSettings: (patch: Partial<GlobalSettings>) => invoke('settings_update', { patch }),
    updateApp: (id: AppId, patch: Partial<AppConfig>) => invoke('app_update', { id, patch }),
    savePat: (id: AppId, pat: string) => invoke<SavePatResult>('pat_save', { id, pat }),
    clearPat: (id: AppId) => invoke('pat_clear', { id }),
    detect: (id: AppId) => invoke<DetectResult>('app_detect', { id }),
    locateApp: (id: AppId) => invoke<LocateResult>('app_locate', { id }),
    pickPath: (kind: 'file' | 'directory') => invoke<string | null>('path_pick', { kind }),
    probeAll: () => invoke('probe_all'),
    runNow: (ids?: AppId[]) => invoke('run_now', { ids }),
    checkUpdates: () => invoke('update_check'),
    onUpdateStatus: (callback) => subscribe<UpdateStatus>('update:status', callback),
    onOpenSettingsAbout: (callback) => subscribe<void>('ui:settings-about', () => callback()),
    installUpdate: () => invoke('update_install'),
    getLogs: () => invoke<LogEntry[]>('logs_get'),
    clearLogs: () => invoke('logs_clear'),
    exportLogs: () => invoke<string | null>('logs_export'),
    getPopupData: () => invoke<PopupData | null>('popup_data'),
    onPopupDismiss: (callback) => subscribe<void>('popup:dismiss', () => callback()),
    onPopupPhase: (callback) => subscribe<PopupPhasePayload>('popup:phase', callback),
    popupCancel: () => invoke('popup_cancel'),
    openExternal: (url: string) => invoke('open_external', { url }),
    openPath: (path: string) => invoke('open_path', { path }),
    windowMinimize: () => invoke('window_minimize'),
    windowMaximize: () => invoke('window_maximize'),
    windowClose: () => invoke('window_close'),
  }

  window.autoCredit = api
}
