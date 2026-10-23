import { useEffect, useRef, useState } from 'react'
import type { AppId, BootstrapState, LogEntry } from '@shared/types'
import type { SettingsTab } from './Settings'
import SettingsPage from './Settings'
import LogsPage from './Logs'
import Overview from './Overview'
import { IconHome, IconLogs, IconSettings, IconCheck } from './ui'

type Page = 'overview' | 'logs' | 'settings'

interface ToastState {
  id: number
  text: string
  tone: 'info' | 'success' | 'error'
}

export default function App() {
  const [state, setState] = useState<BootstrapState | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [page, setPage] = useState<Page>('overview')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('startup')
  const [focusApp, setFocusApp] = useState<AppId | undefined>()
  const [toast, setToast] = useState<ToastState | null>(null)
  const [masterBusy, setMasterBusy] = useState(false)
  const [manualBusy, setManualBusy] = useState<AppId | 'all' | null>(null)
  const [detecting, setDetecting] = useState<AppId | null>(null)
  const [probing, setProbing] = useState(false)
  const toastId = useRef(0)

  useEffect(() => {
    let active = true
    void Promise.all([window.autoCredit.getState(), window.autoCredit.getLogs()])
      .then(([initial, initialLogs]) => {
        if (!active) return
        setState(initial)
        setLogs([...initialLogs].reverse())
      })
      .catch(() => {
        if (active) setState(null)
      })

    const offState = window.autoCredit.onState((next) => setState(next))
    const offLog = window.autoCredit.onLog((entry) => {
      setLogs((previous) => [entry, ...previous].slice(0, 2000))
    })
    return () => {
      active = false
      offState()
      offLog()
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 2800)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const theme = state?.settings.theme ?? 'system'
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (query.matches ? 'dark' : 'light') : theme
    }
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [state?.settings.theme])

  const notify = (text: string, tone: ToastState['tone'] = 'info'): void => {
    toastId.current += 1
    setToast({ id: toastId.current, text, tone })
  }

  const toggleMaster = async (next: boolean): Promise<void> => {
    setMasterBusy(true)
    try {
      await window.autoCredit.setMaster(next)
      notify(next ? '自动签到已开启' : '自动签到已暂停', next ? 'success' : 'info')
    } catch (error) {
      notify(error instanceof Error ? error.message : '操作失败', 'error')
    } finally {
      setMasterBusy(false)
    }
  }

  const toggleApp = async (id: AppId, next: boolean): Promise<void> => {
    try {
      await window.autoCredit.updateApp(id, { enabled: next })
    } catch (error) {
      notify(error instanceof Error ? error.message : '操作失败', 'error')
    }
  }

  const runNow = async (id?: AppId): Promise<void> => {
    setManualBusy(id ?? 'all')
    try {
      await window.autoCredit.runNow(id ? [id] : undefined)
      notify(id ? '已执行签到流程' : '全部签到流程已执行')
    } catch (error) {
      notify(error instanceof Error ? error.message : '签到失败', 'error')
    } finally {
      setManualBusy(null)
    }
  }

  const detect = async (id: AppId): Promise<void> => {
    setDetecting(id)
    try {
      const result = await window.autoCredit.detect(id)
      notify(result.message, result.ok ? 'success' : 'error')
    } catch (error) {
      notify(error instanceof Error ? error.message : '检测失败', 'error')
    } finally {
      setDetecting(null)
    }
  }

  const probeAll = async (): Promise<void> => {
    setProbing(true)
    try {
      await window.autoCredit.probeAll()
      notify('状态检测完成')
    } catch (error) {
      notify(error instanceof Error ? error.message : '检测失败', 'error')
    } finally {
      setProbing(false)
    }
  }

  const openSettings = (tab: SettingsTab = 'startup', app?: AppId): void => {
    setSettingsTab(tab)
    setFocusApp(app)
    setPage('settings')
  }

  const clearLogs = async (): Promise<void> => {
    try {
      await window.autoCredit.clearLogs()
      setLogs([])
      notify('日志已清空')
    } catch (error) {
      notify(error instanceof Error ? error.message : '清空失败', 'error')
    }
  }

  const exportLogs = async (): Promise<void> => {
    try {
      const path = await window.autoCredit.exportLogs()
      if (path) notify(`日志已导出到 ${path}`, 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出失败', 'error')
    }
  }

  return (
    <div className="window">
      <div className="shell">
        <header className="titlebar" onDoubleClick={() => window.autoCredit.windowMaximize()}>
          <div className="traffic">
            <button className="traffic-btn close" aria-label="关闭" onClick={() => window.autoCredit.windowClose()}>
              <span>✕</span>
            </button>
            <button className="traffic-btn min" aria-label="最小化" onClick={() => window.autoCredit.windowMinimize()}>
              <span>−</span>
            </button>
            <button className="traffic-btn max" aria-label="最大化" onClick={() => window.autoCredit.windowMaximize()}>
              <span>+</span>
            </button>
          </div>
          <div className="titlebar-title">AutoCredit</div>
          <div className={`titlebar-status${state?.settings.masterEnabled ? ' active' : ''}`}>
            <i />
            {state?.settings.masterEnabled ? '自动签到运行中' : '自动签到已暂停'}
          </div>
        </header>

        <div className="layout">
          <aside className="sidebar">
            <div className="brand">
              <span className="brand-logo">
                <IconCheck size={18} />
              </span>
              <span className="brand-text">
                <strong>AutoCredit</strong>
                <small>每日静默签到</small>
              </span>
            </div>

            <nav className="nav">
              <button className={`nav-item${page === 'overview' ? ' active' : ''}`} onClick={() => setPage('overview')}>
                <IconHome />
                <span>总览</span>
              </button>
              <button className={`nav-item${page === 'logs' ? ' active' : ''}`} onClick={() => setPage('logs')}>
                <IconLogs />
                <span>日志</span>
                {logs.length > 0 && <i className="nav-count">{logs.length > 99 ? '99+' : logs.length}</i>}
              </button>
              <button className={`nav-item${page === 'settings' ? ' active' : ''}`} onClick={() => setPage('settings')}>
                <IconSettings />
                <span>设置</span>
              </button>
            </nav>

            <div className="sidebar-footer">
              <div className="master-card">
                <div className="master-text">
                  <span>自动签到</span>
                  <small>{state?.settings.masterEnabled ? '主开关已开启' : '主开关已关闭'}</small>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(state?.settings.masterEnabled)}
                  aria-label="自动签到主开关"
                  className={`master-switch${state?.settings.masterEnabled ? ' on' : ''}`}
                  disabled={!state || masterBusy}
                  onClick={() => toggleMaster(!state?.settings.masterEnabled)}
                >
                  <i />
                </button>
              </div>
              <div className="version-line">
                <span>v{state?.version ?? '1.0.0'}</span>
                <span>静默运行 · 不打扰</span>
              </div>
            </div>
          </aside>

          <main className="content">
            {!state ? (
              <div className="loading">
                <span className="spinner" />
                <p>正在读取本地配置…</p>
              </div>
            ) : page === 'overview' ? (
              <Overview
                state={state}
                onToggleMaster={toggleMaster}
                masterBusy={masterBusy}
                onToggleApp={toggleApp}
                onRunNow={runNow}
                manualBusy={manualBusy}
                onDetect={detect}
                detecting={detecting}
                onRefresh={probeAll}
                probing={probing}
                onOpenSettings={openSettings}
              />
            ) : page === 'logs' ? (
              <LogsPage
                logs={logs}
                onClear={clearLogs}
                onExport={exportLogs}
              />
            ) : (
              <SettingsPage
                state={state}
                tab={settingsTab}
                onTabChange={setSettingsTab}
                focusApp={focusApp}
                onFocusHandled={() => setFocusApp(undefined)}
                onToggleMaster={toggleMaster}
                masterBusy={masterBusy}
                onUpdateSettings={async (patch) => {
                  try {
                    await window.autoCredit.updateSettings(patch)
                  } catch (error) {
                    notify(error instanceof Error ? error.message : '保存失败', 'error')
                  }
                }}
                onUpdateApp={async (id, patch) => {
                  try {
                    await window.autoCredit.updateApp(id, patch)
                  } catch (error) {
                    notify(error instanceof Error ? error.message : '保存失败', 'error')
                  }
                }}
                onDetect={detect}
                detecting={detecting}
                onSavePat={async (id, pat) => {
                  try {
                    const result = await window.autoCredit.savePat(id, pat)
                    notify(result.message, result.ok ? 'success' : 'error')
                    return result
                  } catch (error) {
                    const message = error instanceof Error ? error.message : '保存失败'
                    notify(message, 'error')
                    return { ok: false, message }
                  }
                }}
                onClearPat={async (id) => {
                  try {
                    await window.autoCredit.clearPat(id)
                    notify('令牌已清除')
                  } catch (error) {
                    notify(error instanceof Error ? error.message : '清除失败', 'error')
                  }
                }}
                onProbeAll={probeAll}
                probing={probing}
                onExportLogs={exportLogs}
                onOpenLogs={() => setPage('logs')}
                notify={notify}
              />
            )}
          </main>
        </div>
      </div>

      {toast && (
        <div className={`toast tone-${toast.tone}`}>
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  )
}
