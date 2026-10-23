import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppId,
  AutoCreditApi,
  BootstrapState,
  DetectResult,
  LogEntry,
  PopupData,
  SavePatResult,
} from '@shared/types'

const api: AutoCreditApi = {
  getState: () => ipcRenderer.invoke('state:get') as Promise<BootstrapState>,
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BootstrapState): void => {
      callback(state)
    }
    ipcRenderer.on('state:update', listener)
    return () => {
      ipcRenderer.removeListener('state:update', listener)
    }
  },
  onLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: LogEntry): void => {
      callback(entry)
    }
    ipcRenderer.on('log:new', listener)
    return () => {
      ipcRenderer.removeListener('log:new', listener)
    }
  },
  setMaster: (enabled: boolean) => ipcRenderer.invoke('master:set', enabled) as Promise<void>,
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch) as Promise<void>,
  updateApp: (id: AppId, patch) => ipcRenderer.invoke('app:update', id, patch) as Promise<void>,
  savePat: (id: AppId, pat: string) =>
    ipcRenderer.invoke('pat:save', id, pat) as Promise<SavePatResult>,
  clearPat: (id: AppId) => ipcRenderer.invoke('pat:clear', id) as Promise<void>,
  detect: (id: AppId) => ipcRenderer.invoke('app:detect', id) as Promise<DetectResult>,
  probeAll: () => ipcRenderer.invoke('probe:all') as Promise<void>,
  runNow: (ids?: AppId[]) => ipcRenderer.invoke('run:now', ids) as Promise<void>,
  getLogs: () => ipcRenderer.invoke('logs:get') as Promise<LogEntry[]>,
  clearLogs: () => ipcRenderer.invoke('logs:clear') as Promise<void>,
  exportLogs: () => ipcRenderer.invoke('logs:export') as Promise<string | null>,
  getPopupData: () => ipcRenderer.invoke('popup:data') as Promise<PopupData | null>,
  onPopupDismiss: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('popup:dismiss', listener)
    return () => {
      ipcRenderer.removeListener('popup:dismiss', listener)
    }
  },
  popupCancel: () => ipcRenderer.send('popup:cancel'),
  openExternal: (url: string) => ipcRenderer.invoke('open:external', url) as Promise<void>,
  openPath: (path: string) => ipcRenderer.invoke('open:path', path) as Promise<void>,
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
}

contextBridge.exposeInMainWorld('autoCredit', api)
