import type { AppId, BootstrapState, RunStatus } from '@shared/types'
import { APP_META, visibleAppIds } from '@shared/constants'

export function IconHome({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 10.5 12 3.5l8.5 7" />
      <path d="M5.5 9.5v9a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-9" />
      <path d="M9.5 20v-5.5h5V20" />
    </svg>
  )
}

export function IconLogs({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  )
}

export function IconSettings({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  )
}

export function IconCheck({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  )
}

export function IconX({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

export function IconRefresh({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0-2.3 6" />
      <path d="M20 4.5V11h-6.5" />
    </svg>
  )
}

export function IconBolt({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z" />
    </svg>
  )
}

export function IconClock({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

export function IconShield({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 5 6v5.5c0 4.3 2.9 7.6 7 9.5 4.1-1.9 7-5.2 7-9.5V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

export function IconExternal({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18.5 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5h4.5" />
    </svg>
  )
}

export function IconFolder({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
    </svg>
  )
}

export function IconSearch({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  large,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  large?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? '开关'}
      className={`switch${checked ? ' on' : ''}${large ? ' large' : ''}`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onChange(!checked)
      }}
    >
      <span className="switch-knob" />
    </button>
  )
}

export const STATUS_META: Record<RunStatus, { label: string; tone: string }> = {
  idle: { label: '待签到', tone: 'neutral' },
  running: { label: '签到中', tone: 'blue' },
  success: { label: '已签到', tone: 'green' },
  already: { label: '已签到', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'orange' },
  'needs-auth': { label: '需重新登录', tone: 'orange' },
  'needs-setup': { label: '待配置', tone: 'gray' },
  unavailable: { label: '暂不可领', tone: 'gray' },
}

export function StatusPill({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.idle
  return (
    <span className={`status-pill tone-${meta.tone}`}>
      <i className="status-dot" />
      {meta.label}
    </span>
  )
}

const GLYPHS: Record<AppId, { mark: string; badge?: string }> = {
  trae: { mark: 'T' },
  qoder: { mark: 'Q' },
  'qoder-cn': { mark: 'Q', badge: 'CN' },
  workbuddy: { mark: 'W' },
  doubao: { mark: '豆' },
}

export function AppGlyph({ id, size = 40 }: { id: AppId; size?: number }) {
  const glyph = GLYPHS[id]
  return (
    <span className={`app-glyph glyph-${id}`} style={{ width: size, height: size, fontSize: size * 0.44 }}>
      {glyph.mark}
      {glyph.badge && <i className="glyph-badge">{glyph.badge}</i>}
    </span>
  )
}

export function localDateKey(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatClock(iso?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatLogTime(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds(),
  ).padStart(2, '0')}`
}

export function formatLastSuccess(iso?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  if (localDateKey(date) === localDateKey()) return `今天 ${formatClock(iso)}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${formatClock(iso)}`
}

export function formatFullDate(date = new Date()): string {
  const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()]
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · ${week}`
}

export function scheduleTime(id: AppId, state: BootstrapState): string {
  const app = state.apps[id]
  return app.useCustomTime ? app.time : state.settings.defaultTime
}

export function nextRunText(id: AppId, state: BootstrapState): string {
  if (!state.settings.masterEnabled) return '已暂停'
  if (!state.apps[id].enabled) return '已关闭'
  const runtime = state.runtime[id]
  const time = scheduleTime(id, state)
  const today = localDateKey()
  if (runtime.lastSuccessDate === today || (runtime.probeDate === today && runtime.todayCheckedIn)) {
    return `明天 ${time}`
  }
  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const [h, m] = time.split(':').map(Number)
  if (nowMinutes >= h * 60 + m) return '等待补签'
  return `今天 ${time}`
}

export function checkedInCount(state: BootstrapState): number {
  const today = localDateKey()
  return visibleAppIds(state.settings).filter((id) => {
    const runtime = state.runtime[id]
    return runtime.lastSuccessDate === today || (runtime.probeDate === today && runtime.todayCheckedIn)
  }).length
}

export function enabledCount(state: BootstrapState): number {
  return visibleAppIds(state.settings).filter(
    (id) => state.apps[id].enabled && state.runtime[id].status !== 'unavailable',
  ).length
}

export function totalCredits(state: BootstrapState): number {
  const today = localDateKey()
  return visibleAppIds(state.settings).reduce((sum, id) => {
    const runtime = state.runtime[id]
    const done = runtime.lastSuccessDate === today
    return sum + (done && runtime.credits ? runtime.credits : 0)
  }, 0)
}

export function appName(id: AppId): string {
  return APP_META[id]?.name ?? id
}
