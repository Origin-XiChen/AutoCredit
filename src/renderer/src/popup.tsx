import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PopupData } from '@shared/types'
import { IconX } from './ui'
import './popup.css'

export default function PopupApp() {
  const [data, setData] = useState<PopupData | null>(null)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    void window.autoCredit.getPopupData().then(setData)
    return window.autoCredit.onPopupDismiss(() => setClosing(true))
  }, [])

  const cancel = (): void => {
    if (closing) return
    setClosing(true)
    setTimeout(() => window.autoCredit.popupCancel(), 150)
  }

  if (!data) return null

  return (
    <div className={`popup-card${closing ? ' closing' : ''}`}>
      <div className="popup-content">
        <h1>即将为以下程序签到</h1>
        <p className="popup-hint">{data.seconds} 秒后自动签到，点击右侧 × 可取消</p>
        <ul className="popup-list">
          {data.apps.map((app) => (
            <li key={app.id}>
              <span>{app.name}</span>
            </li>
          ))}
        </ul>
      </div>

      <button className="popup-cancel" onClick={cancel} aria-label="取消签到">
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
      </button>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
)
