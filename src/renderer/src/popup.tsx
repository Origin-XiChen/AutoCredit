import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PopupData } from '@shared/types'
import { installTauriApi } from './tauri-api'
import { IconCheck, IconX } from './ui'
import './popup.css'

installTauriApi()

type Phase = 'countdown' | 'running' | 'success' | 'error'

const TITLES: Record<Phase, string> = {
  countdown: '即将为以下程序签到',
  running: '正在签到…',
  success: '签到完成',
  error: '签到未完成',
}

function hintFor(phase: Phase, seconds: number): string {
  switch (phase) {
    case 'running':
      return '正在依次签到，完成后会自动关闭提醒'
    case 'success':
      return '今日签到已完成，提醒即将关闭'
    case 'error':
      return '请打开主界面查看详情'
    default:
      return `${seconds} 秒后自动签到，点击右侧 × 可取消`
  }
}

export default function PopupApp() {
  const [data, setData] = useState<PopupData | null>(null)
  const [phase, setPhase] = useState<Phase>('countdown')
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    void window.autoCredit.getPopupData().then(setData)
    const offDismiss = window.autoCredit.onPopupDismiss(() => setClosing(true))
    const offPhase = window.autoCredit.onPopupPhase?.((payload) => setPhase(payload.phase))
    return () => {
      offDismiss()
      offPhase?.()
    }
  }, [])

  const cancel = (): void => {
    if (closing || phase !== 'countdown') return
    setClosing(true)
    setTimeout(() => window.autoCredit.popupCancel(), 150)
  }

  if (!data) return null

  return (
    <div className={`popup-card ${phase}${closing ? ' closing' : ''}`}>
      <div className="popup-content">
        <h1>{TITLES[phase]}</h1>
        <p className="popup-hint">{hintFor(phase, data.seconds)}</p>
        <ul className="popup-list">
          {data.apps.map((app) => (
            <li key={app.id}>
              <span>{app.name}</span>
            </li>
          ))}
        </ul>
      </div>

      <button
        className="popup-cancel"
        onClick={cancel}
        disabled={phase !== 'countdown'}
        aria-label={phase === 'countdown' ? '取消签到' : TITLES[phase]}
      >
        {phase === 'countdown' ? (
          <>
            <svg className="countdown-ring" viewBox="0 0 64 64">
              <circle className="ring-track" cx="32" cy="32" r="26" />
              <circle
                className="ring-progress"
                cx="32"
                cy="32"
                r="26"
                pathLength="100"
                style={{ animationDuration: `${data.seconds}s` }}
              />
            </svg>
            <span className="cancel-glyph">
              <IconX size={20} />
            </span>
          </>
        ) : phase === 'running' ? (
          <span className="status-ring status-running">
            <span className="dots">
              <span />
              <span />
              <span />
            </span>
          </span>
        ) : (
          <span className={`status-ring ${phase === 'success' ? 'status-success' : 'status-error'}`}>
            {phase === 'success' ? <IconCheck size={26} /> : <IconX size={22} />}
          </span>
        )}
      </button>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
)
