import { APP_META, visibleAppIds } from '@shared/constants'
import type { AppId, BootstrapState } from '@shared/types'
import type { SettingsTab } from './Settings'
import {
  AppGlyph,
  IconBolt,
  IconClock,
  IconRefresh,
  STATUS_META,
  StatusPill,
  Switch,
  checkedInCount,
  enabledCount,
  formatFullDate,
  formatLastSuccess,
  localDateKey,
  nextRunText,
  scheduleTime,
  totalCredits,
} from './ui'

interface OverviewProps {
  state: BootstrapState
  onToggleMaster: (next: boolean) => void
  masterBusy: boolean
  onToggleApp: (id: AppId, next: boolean) => void
  onRunNow: (id?: AppId) => void
  manualBusy: AppId | 'all' | null
  onDetect: (id: AppId) => void
  detecting: AppId | null
  onRefresh: () => void
  probing: boolean
  onOpenSettings: (tab: SettingsTab, app?: AppId) => void
}

function overallNext(state: BootstrapState): string {
  if (!state.settings.masterEnabled) return '已暂停'
  const today = localDateKey()
  const pending = visibleAppIds(state.settings).filter((id) => {
    if (!state.apps[id].enabled) return false
    const runtime = state.runtime[id]
    // 国际版等不可签到的程序不参与补签计时
    if (runtime.status === 'unavailable') return false
    return !(runtime.lastSuccessDate === today || (runtime.probeDate === today && runtime.todayCheckedIn))
  })
  if (!pending.length) return '明日'
  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  let earliest = Number.POSITIVE_INFINITY
  let overdue = false
  for (const id of pending) {
    const time = scheduleTime(id, state)
    const [h, m] = time.split(':').map(Number)
    const minutes = h * 60 + m
    if (minutes <= nowMinutes) overdue = true
    earliest = Math.min(earliest, minutes)
  }
  if (overdue) return '等待补签'
  const [h, m] = [Math.floor(earliest / 60), earliest % 60]
  return `今天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export default function Overview({
  state,
  onToggleMaster,
  masterBusy,
  onToggleApp,
  onRunNow,
  manualBusy,
  onDetect,
  detecting,
  onRefresh,
  probing,
  onOpenSettings,
}: OverviewProps) {
  const done = checkedInCount(state)
  const enabled = enabledCount(state)
  const credits = totalCredits(state)
  const master = state.settings.masterEnabled
  const appIds = visibleAppIds(state.settings)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">{formatFullDate()}</span>
          <h1>今日签到</h1>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={onRefresh} disabled={probing}>
            <IconRefresh className={probing ? 'spin' : undefined} />
            {probing ? '检测中…' : '刷新状态'}
          </button>
          <button
            className="btn primary"
            onClick={() => onRunNow()}
            disabled={manualBusy !== null || enabled === 0}
          >
            <IconBolt />
            {manualBusy === 'all' ? '签到中…' : '全部签到'}
          </button>
        </div>
      </div>

      <section className="hero">
        <div className="hero-copy">
          <span className="hero-kicker">主开关</span>
          <h2>{master ? '自动签到已开启' : '自动签到已暂停'}</h2>
          <p>
            {master
              ? `每天 ${state.settings.defaultTime} 自动签到已启用的程序；错过时间后会在电脑唤醒时立即补签。`
              : '开启后只签到下方已启用的程序，签到前会弹出 10 秒倒计时提醒。'}
          </p>
          <div className="hero-stats">
            <div>
              <strong>
                {done}
                <em>/{enabled}</em>
              </strong>
              <span>今日完成</span>
            </div>
            <div>
              <strong>{credits > 0 ? `+${credits}` : '0'}</strong>
              <span>今日积分</span>
            </div>
            <div>
              <strong className={overallNext(state) === '等待补签' ? 'warn-text' : undefined}>
                {overallNext(state)}
              </strong>
              <span>下一轮</span>
            </div>
          </div>
        </div>
        <div className="hero-control">
          <Switch large checked={master} onChange={onToggleMaster} disabled={masterBusy} label="自动签到主开关" />
          <span>{master ? '按计划静默运行' : '点击开启'}</span>
        </div>
      </section>

      <div className="app-grid">
        {appIds.map((id) => {
          const meta = APP_META[id]
          const app = state.apps[id]
          const runtime = state.runtime[id]
          const tone = STATUS_META[runtime.status]?.tone ?? 'neutral'
          const needsPat = !meta.autoAuth && !state.secrets[id]
          return (
            <article key={id} className={`app-card${app.enabled ? '' : ' is-disabled'}`}>
              <header className="app-head">
                <AppGlyph id={id} size={42} />
                <div className="app-title">
                  <h3>
                    {meta.name}
                    {app.useCustomTime && <i className="mini-badge">定时</i>}
                  </h3>
                  <span>{meta.autoAuth ? '自动读取登录态' : '个人访问令牌'}</span>
                </div>
                <Switch
                  checked={app.enabled}
                  onChange={(next) => onToggleApp(id, next)}
                  label={`${meta.name} 签到开关`}
                />
              </header>

              <div className={`app-status tone-${tone}`}>
                <StatusPill status={runtime.status} />
                <p>{runtime.message}</p>
              </div>

              <div className="app-meta">
                <div>
                  <span>下次签到</span>
                  <strong>{nextRunText(id, state)}</strong>
                </div>
                <div>
                  <span>当前积分</span>
                  <strong>{runtime.credits ?? '—'}</strong>
                </div>
                <div>
                  <span>最近成功</span>
                  <strong>{formatLastSuccess(runtime.lastSuccessAt)}</strong>
                </div>
              </div>

              <footer className="app-actions">
                <button
                  className="btn primary sm"
                  onClick={() => onRunNow(id)}
                  disabled={!app.enabled || manualBusy !== null}
                >
                  {manualBusy === id ? (
                    <>
                      <span className="spinner tiny" />
                      签到中
                    </>
                  ) : (
                    '立即签到'
                  )}
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => onDetect(id)}
                  disabled={detecting === id}
                >
                  {detecting === id ? '检测中…' : '检测'}
                </button>
                {needsPat && (
                  <button className="btn link sm" onClick={() => onOpenSettings('apps', id)}>
                    配置令牌
                  </button>
                )}
              </footer>
            </article>
          )
        })}
      </div>

      <div className="notice">
        <IconClock size={18} />
        <p>
          <strong>签到提醒</strong>
          到点前屏幕右下角会弹出 10 秒倒计时窗口，红色圆环走完即自动签到；点击红色 × 可取消当天签到。
          全屏、游戏或演示模式下不会弹窗，会直接静默签到。
        </p>
      </div>
    </div>
  )
}
