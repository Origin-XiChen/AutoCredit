import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { APP_META, visibleAppIds } from '@shared/constants'
import type { AppId, AppConfig, BootstrapState, GlobalSettings, SavePatResult } from '@shared/types'
import {
  AppGlyph,
  IconExternal,
  IconFolder,
  IconRefresh,
  IconShield,
  StatusPill,
  Switch,
  formatLastSuccess,
  nextRunText,
  scheduleTime,
} from './ui'

export type SettingsTab = 'startup' | 'apps' | 'general' | 'about'

interface SettingsPageProps {
  state: BootstrapState
  tab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  focusApp?: AppId
  onFocusHandled: () => void
  onToggleMaster: (next: boolean) => void
  masterBusy: boolean
  onUpdateSettings: (patch: Partial<GlobalSettings>) => void
  onUpdateApp: (id: AppId, patch: Partial<AppConfig>) => void
  onDetect: (id: AppId) => void
  detecting: AppId | null
  onSavePat: (id: AppId, pat: string) => Promise<SavePatResult>
  onClearPat: (id: AppId) => void
  onProbeAll: () => void
  probing: boolean
  onExportLogs: () => void
  onOpenLogs: () => void
  notify: (text: string, tone?: 'info' | 'success' | 'error') => void
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'startup', label: '启动与时间' },
  { id: 'apps', label: '程序与账号' },
  { id: 'general', label: '通用' },
  { id: 'about', label: '关于' },
]

function isTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function Row({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <span>{title}</span>
        {description && <small>{description}</small>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="section-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="panel">{children}</div>
    </section>
  )
}

function PatEditor({
  id,
  saved,
  onSave,
  onClear,
  onDetect,
  detecting,
}: {
  id: AppId
  saved: boolean
  onSave: (id: AppId, pat: string) => Promise<SavePatResult>
  onClear: (id: AppId) => void
  onDetect: (id: AppId) => void
  detecting: AppId | null
}) {
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const meta = APP_META[id]

  useEffect(() => {
    if (saved) setDraft('')
  }, [saved])

  const submit = async (): Promise<void> => {
    const token = draft.trim()
    if (!token) {
      setError('请先粘贴个人访问令牌')
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const result = await onSave(id, token)
      if (!result.ok) {
        setError(result.message)
      } else {
        setDraft('')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pat-editor">
      <div className="pat-status">
        <span className={`pat-dot${saved ? ' saved' : ''}`} />
        {saved ? '令牌已加密保存在本机' : '尚未保存令牌'}
        {meta.patUrl && (
          <button className="btn link sm" onClick={() => window.autoCredit.openExternal(meta.patUrl!)}>
            获取令牌
            <IconExternal />
          </button>
        )}
      </div>
      <div className="pat-input-row">
        <input
          className="input"
          type="password"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={saved ? '输入新的令牌可替换已保存的令牌' : '粘贴个人访问令牌（PAT）'}
          onChange={(event) => {
            setDraft(event.target.value)
            if (error) setError(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !saving) void submit()
          }}
        />
        <button className="btn primary" onClick={() => void submit()} disabled={saving || !draft.trim()}>
          {saving ? '验证中…' : '保存'}
        </button>
        {saved && (
          <button className="btn ghost danger-text" onClick={() => onClear(id)}>
            清除
          </button>
        )}
        <button className="btn ghost" onClick={() => onDetect(id)} disabled={detecting === id}>
          {detecting === id ? '检测中…' : '检测'}
        </button>
      </div>
      {error && <p className="pat-error">{error}</p>}
    </div>
  )
}

export default function SettingsPage({
  state,
  tab,
  onTabChange,
  focusApp,
  onFocusHandled,
  onToggleMaster,
  masterBusy,
  onUpdateSettings,
  onUpdateApp,
  onDetect,
  detecting,
  onSavePat,
  onClearPat,
  onProbeAll,
  probing,
  onExportLogs,
  onOpenLogs,
  notify,
}: SettingsPageProps) {
  const [highlight, setHighlight] = useState<AppId | undefined>()
  const rowRefs = useRef<Record<string, HTMLElement | null>>({})
  const { settings } = state
  const appIds = visibleAppIds(settings)

  useEffect(() => {
    if (!focusApp || tab !== 'apps') return
    const node = rowRefs.current[focusApp]
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlight(focusApp)
      const timer = setTimeout(() => setHighlight(undefined), 2200)
      onFocusHandled()
      return () => clearTimeout(timer)
    }
    return undefined
  }, [focusApp, tab, onFocusHandled])

  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      notify('路径已复制')
    } catch {
      notify('复制失败，请手动选择路径', 'error')
    }
  }

  return (
    <div className="page page-settings">
      <div className="page-header">
        <div>
          <span className="eyebrow">偏好设置</span>
          <h1>设置</h1>
        </div>
        <div className="settings-tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? 'active' : ''}
              onClick={() => onTabChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'startup' && (
        <div className="settings-body">
          <Section title="启动" description="让 AutoCredit 保持在后台，安静地完成每日签到。">
            <Row title="主开关" description="关闭后所有定时签到暂停，已启用的程序也暂时不签到。">
              <Switch
                checked={settings.masterEnabled}
                onChange={onToggleMaster}
                disabled={masterBusy}
                label="自动签到主开关"
              />
            </Row>
            <Row title="开机自启动" description="登录 Windows 后自动启动，是否显示主界面由下一项决定。">
              <Switch
                checked={settings.autoLaunch}
                onChange={(autoLaunch) => onUpdateSettings({ autoLaunch })}
                label="开机自启动"
              />
            </Row>
            <Row title="开机自启动时最小化到托盘" description="开机启动时不显示主界面，仅在托盘运行；双击图标启动仍会打开主界面。">
              <Switch
                checked={settings.startMinimized}
                onChange={(startMinimized) => onUpdateSettings({ startMinimized })}
                label="开机自启动时最小化到托盘"
              />
            </Row>
            <Row title="关闭窗口时最小化到托盘" description="点击关闭按钮不会退出程序，签到计划继续运行。">
              <Switch
                checked={settings.closeToTray}
                onChange={(closeToTray) => onUpdateSettings({ closeToTray })}
                label="关闭窗口时最小化到托盘"
              />
            </Row>
          </Section>

          <Section title="签到时间" description="程序读取系统时间。错过签到时间后，只要电脑处于唤醒状态就会立即补签。">
            <Row title="默认签到时间" description="所有未开启独立时间的程序都使用这个时间。">
              <input
                className="time-input"
                type="time"
                value={settings.defaultTime}
                onChange={(event) => {
                  if (isTime(event.target.value)) onUpdateSettings({ defaultTime: event.target.value })
                }}
              />
            </Row>
            <div className="inline-note">
              <IconClockInline />
              <span>建议安排在 10:10 之后：Qoder 每日签到活动在 10:00 刷新。</span>
            </div>
          </Section>

          <Section
            title="独立签到时间"
            description="为每个程序单独设定签到时间，关闭时统一使用默认时间。"
          >
            {appIds.map((id) => {
              const app = state.apps[id]
              const meta = APP_META[id]
              return (
                <div className="time-row" key={id}>
                  <AppGlyph id={id} size={34} />
                  <div className="time-copy">
                    <span>{meta.name}</span>
                    <small>
                      {app.useCustomTime ? `每天 ${app.time} 签到` : `使用默认 ${settings.defaultTime}`}
                    </small>
                  </div>
                  <Switch
                    checked={app.useCustomTime}
                    onChange={(useCustomTime) => onUpdateApp(id, { useCustomTime })}
                    label={`${meta.name} 使用独立签到时间`}
                  />
                  <input
                    className="time-input"
                    type="time"
                    value={app.time}
                    disabled={!app.useCustomTime}
                    onChange={(event) => {
                      if (isTime(event.target.value)) onUpdateApp(id, { time: event.target.value })
                    }}
                  />
                </div>
              )
            })}
          </Section>
        </div>
      )}

      {tab === 'apps' && (
        <div className="settings-body">
          <div className="inline-note info-note">
            <IconShield size={18} />
            <span>
              主开关开启后，只会签到下面已启用的程序。Trae 与 WorkBuddy 自动读取本机客户端登录态；Qoder 需要一次性保存个人访问令牌。
            </span>
          </div>

          {appIds.map((id) => {
            const app = state.apps[id]
            const runtime = state.runtime[id]
            const meta = APP_META[id]
            const saved = state.secrets[id]
            return (
              <section
                key={id}
                ref={(node) => {
                  rowRefs.current[id] = node
                }}
                className={`panel app-setting${highlight === id ? ' highlight' : ''}`}
              >
                <header className="app-setting-head">
                  <AppGlyph id={id} size={40} />
                  <div className="app-setting-title">
                    <h2>
                      {meta.name}
                      <span className="auth-badge">{meta.autoAuth ? '自动登录态' : 'PAT'}</span>
                      {id === 'doubao' && <span className="auth-badge">实验</span>}
                    </h2>
                    <p>{meta.description}</p>
                  </div>
                  <StatusPill status={runtime.status} />
                  <Switch
                    checked={app.enabled}
                    onChange={(enabled) => onUpdateApp(id, { enabled })}
                    label={`${meta.name} 签到开关`}
                  />
                </header>

                <div className="app-setting-meta">
                  <div>
                    <span>状态</span>
                    <strong>{runtime.message}</strong>
                  </div>
                  <div>
                    <span>下次签到</span>
                    <strong>{nextRunText(id, state)}</strong>
                  </div>
                  <div>
                    <span>签到时间</span>
                    <strong>{scheduleTime(id, state)}</strong>
                  </div>
                  <div>
                    <span>最近成功</span>
                    <strong>{formatLastSuccess(runtime.lastSuccessAt)}</strong>
                  </div>
                </div>

                {meta.note && <p className="app-note">{meta.note}</p>}

                {meta.autoAuth ? (
                  <div className="auto-auth-row">
                    <span className="auto-auth-hint">
                      <IconShield size={15} />
                      {meta.accountHint}
                    </span>
                    <button className="btn ghost sm" onClick={() => onDetect(id)} disabled={detecting === id}>
                      {detecting === id ? '检测中…' : '检测登录态'}
                    </button>
                  </div>
                ) : (
                  <PatEditor
                    id={id}
                    saved={Boolean(saved)}
                    onSave={onSavePat}
                    onClear={onClearPat}
                    onDetect={onDetect}
                    detecting={detecting}
                  />
                )}
              </section>
            )
          })}
        </div>
      )}

      {tab === 'general' && (
        <div className="settings-body">
          <Section title="外观" description="AutoCredit 会跟随系统外观，也可以手动指定。">
            <Row title="主题" description="切换后立即生效。">
              <div className="segmented compact">
                {([
                  ['system', '跟随系统'],
                  ['light', '浅色'],
                  ['dark', '深色'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    className={settings.theme === value ? 'active' : ''}
                    onClick={() => onUpdateSettings({ theme: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>
            <Row title="日志保留" description="超过指定天数的旧日志会自动清理。">
              <select
                className="input select"
                value={settings.logRetentionDays}
                onChange={(event) => onUpdateSettings({ logRetentionDays: Number(event.target.value) })}
              >
                <option value={7}>7 天</option>
                <option value={14}>14 天</option>
                <option value={30}>30 天</option>
                <option value={90}>90 天</option>
              </select>
            </Row>
          </Section>

          <Section title="开发者模式" description="实验性功能默认隐藏，开启后才会出现在其他设置页中。">
            <Row
              title="开发者模式"
              description="开启后可看到豆包签到。豆包签到会启动本机豆包客户端，并通过调试端口模拟点击领取每日额度，可能随客户端更新失效。"
            >
              <Switch
                checked={settings.developerMode}
                onChange={(developerMode) => onUpdateSettings({ developerMode })}
                label="开发者模式"
              />
            </Row>
          </Section>

          <Section title="数据" description="配置、日志和令牌都保存在本机，不经过任何第三方服务器。">
            <Row title="数据目录" description={state.dataDir}>
              <button className="btn ghost sm" onClick={() => copyPath(state.dataDir)}>
                复制路径
              </button>
              <button className="btn ghost sm" onClick={() => void window.autoCredit.openPath(state.dataDir)}>
                <IconFolder />
                打开
              </button>
            </Row>
            <Row title="令牌存储" description="个人访问令牌使用 Windows 系统安全存储（DPAPI）加密。">
              <span className="secure-badge">
                <IconShield size={14} />
                已启用
              </span>
            </Row>
          </Section>
        </div>
      )}

      {tab === 'about' && (
        <div className="settings-body">
          <div className="about-hero">
            <span className="about-logo">AC</span>
            <div>
              <h2>AutoCredit</h2>
              <p>Trae · Qoder · Qoder CN · WorkBuddy 每日静默签到</p>
              <span className="about-version">版本 {state.version} · {state.isPackaged ? '正式版' : '开发版'}</span>
            </div>
          </div>

          <Section title="更新" description="程序启动时会自动检查 GitHub 上的新版本，也可从托盘菜单手动检查。">
            <Row title="接收 dev 版本" description="开启后会同时检查预发布（dev / beta）版本；关闭时只接收正式版本。">
              <Switch
                checked={settings.allowPrerelease}
                onChange={(allowPrerelease) => onUpdateSettings({ allowPrerelease })}
                label="接收 dev 版本更新"
              />
            </Row>
          </Section>

          <Section title="工作方式">
            <div className="about-text">
              <p>
                AutoCredit 在后台读取系统时间，到达设定时间后弹出 10 秒倒计时提醒；期间未取消则依次为已启用的程序领取签到积分。
                如果电脑休眠、锁屏或处于全屏应用，会在恢复后立即静默补签。
              </p>
              <p>
                Trae 与 WorkBuddy 使用本机客户端保存的登录态自动完成签到；Qoder 与 Qoder CN 使用你在设置中保存的个人访问令牌。
                所有令牌只保存在本机，并使用系统安全存储加密。
              </p>
            </div>
          </Section>

          <Section title="接口说明">
            <div className="about-text">
              <p>
                签到接口来自各客户端自身的网络请求，属于非公开接口。客户端更新后接口可能发生变化，届时日志中会出现失败原因，本程序也需要相应更新。
                本程序仅为你自己的本机账号完成每日签到，请遵守各平台的服务条款。
              </p>
            </div>
          </Section>

          <div className="about-actions">
            <button className="btn primary" onClick={onProbeAll} disabled={probing}>
              <IconRefresh className={probing ? 'spin' : undefined} />
              {probing ? '检测中…' : '检查全部状态'}
            </button>
            <button className="btn ghost" onClick={onOpenLogs}>
              查看日志
            </button>
            <button className="btn ghost" onClick={onExportLogs}>
              导出日志
            </button>
          </div>

          <div className="about-meta">
            <span>数据目录：{state.dataDir}</span>
            <span>日志目录：{state.logsDir}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function IconClockInline() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}
