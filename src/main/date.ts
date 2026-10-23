export function localDateKey(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function timeToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

export function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatDateTime(timestamp?: string | number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '—'
  return `${localDateKey(date)} ${formatClock(date)}`
}

export function nextRunLabel(params: {
  enabled: boolean
  masterEnabled: boolean
  time: string
  todayCheckedIn: boolean
}): string {
  if (!params.masterEnabled) return '已暂停'
  if (!params.enabled) return '已关闭'
  if (params.todayCheckedIn) return `明天 ${params.time}`
  const now = new Date()
  if (timeToMinutes(formatClock(now)) >= timeToMinutes(params.time)) {
    return '等待补签'
  }
  return `今天 ${params.time}`
}

export function isTimeReached(time: string, now = new Date()): boolean {
  return timeToMinutes(formatClock(now)) >= timeToMinutes(time)
}
