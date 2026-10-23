import { useEffect, useMemo, useState } from 'react'
import { APP_META, APP_ORDER } from '@shared/constants'
import type { AppId, LogEntry, LogLevel } from '@shared/types'
import { IconSearch, formatLogTime } from './ui'

interface LogsPageProps {
  logs: LogEntry[]
  onClear: () => void
  onExport: () => void
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  info: '信息',
  success: '成功',
  warn: '警告',
  error: '错误',
}

const LEVELS: Array<LogLevel | 'all'> = ['all', 'info', 'success', 'warn', 'error']

export default function LogsPage({ logs, onClear, onExport }: LogsPageProps) {
  const [query, setQuery] = useState('')
  const [appFilter, setAppFilter] = useState<AppId | 'all'>('all')
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all')
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    if (!confirmClear) return
    const timer = setTimeout(() => setConfirmClear(false), 3200)
    return () => clearTimeout(timer)
  }, [confirmClear])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return logs.filter((entry) => {
      if (appFilter !== 'all' && entry.appId !== appFilter) return false
      if (levelFilter !== 'all' && entry.level !== levelFilter) return false
      if (needle && !entry.message.toLowerCase().includes(needle)) return false
      return true
    })
  }, [logs, appFilter, levelFilter, query])

  return (
    <div className="page page-logs">
      <div className="page-header">
        <div>
          <span className="eyebrow">运行记录</span>
          <h1>日志</h1>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={onExport} disabled={logs.length === 0}>
            导出日志
          </button>
          <button
            className={`btn ${confirmClear ? 'danger' : 'ghost'}`}
            disabled={logs.length === 0}
            onClick={() => {
              if (confirmClear) {
                setConfirmClear(false)
                onClear()
              } else {
                setConfirmClear(true)
              }
            }}
          >
            {confirmClear ? '确认清空？' : '清空'}
          </button>
        </div>
      </div>

      <div className="log-toolbar">
        <label className="search-box">
          <IconSearch />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索日志内容"
            spellCheck={false}
          />
        </label>
        <div className="segmented">
          {LEVELS.map((level) => (
            <button
              key={level}
              className={levelFilter === level ? 'active' : ''}
              onClick={() => setLevelFilter(level)}
            >
              {level === 'all' ? '全部' : LEVEL_LABEL[level]}
            </button>
          ))}
        </div>
      </div>

      <div className="chip-row">
        <button className={`chip${appFilter === 'all' ? ' active' : ''}`} onClick={() => setAppFilter('all')}>
          全部程序
        </button>
        {APP_ORDER.map((id) => (
          <button
            key={id}
            className={`chip${appFilter === id ? ' active' : ''}`}
            onClick={() => setAppFilter(id)}
          >
            {APP_META[id].name}
          </button>
        ))}
        <span className="chip-count">
          {filtered.length} / {logs.length} 条
        </span>
      </div>

      <div className="log-panel">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">◌</span>
            <p>{logs.length === 0 ? '还没有运行记录' : '没有匹配的日志'}</p>
            <span>签到结果、网络错误和设置变更都会记录在这里。</span>
          </div>
        ) : (
          filtered.map((entry) => (
            <div className="log-row" key={entry.id}>
              <span className="log-time">{formatLogTime(entry.ts)}</span>
              <span className={`log-level level-${entry.level}`}>{LEVEL_LABEL[entry.level]}</span>
              {entry.appId ? (
                <span className={`app-tag tag-${entry.appId}`}>{APP_META[entry.appId]?.name ?? entry.appId}</span>
              ) : (
                <span className="app-tag tag-system">系统</span>
              )}
              <span className="log-message">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
