import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppId, LogEntry, LogLevel } from '@shared/types'
import { localDateKey } from './date'

const MAX_BUFFER = 2000

function sanitize(message: string): string {
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]+/gi, '$1***')
    .replace(/(Cloud-IDE-JWT\s+)\S+/gi, '$1***')
    .replace(/((?:accessToken|refreshToken|personal_token|token|authorization)\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1***')
    .replace(/[\r\n]+/g, ' ')
}

export class Logger {
  private buffer: LogEntry[] = []
  private nextId = 1
  private listener?: (entry: LogEntry) => void

  constructor(
    private readonly logsDir: string,
    private readonly retentionDays: number,
  ) {
    mkdirSync(logsDir, { recursive: true })
    this.loadToday()
    this.cleanup()
  }

  attach(listener: (entry: LogEntry) => void): void {
    this.listener = listener
  }

  private fileFor(date = new Date()): string {
    return join(this.logsDir, `autocredit-${localDateKey(date)}.jsonl`)
  }

  private loadToday(): void {
    const file = this.fileFor()
    if (!existsSync(file)) return
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-800)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LogEntry
          this.buffer.push(entry)
          this.nextId = Math.max(this.nextId, entry.id + 1)
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // ignore unreadable log
    }
  }

  private cleanup(): void {
    try {
      const cutoff = Date.now() - Math.max(1, this.retentionDays) * 86_400_000
      for (const name of readdirSync(this.logsDir)) {
        if (!name.startsWith('autocredit-') || !name.endsWith('.jsonl')) continue
        const datePart = name.slice('autocredit-'.length, -'.jsonl'.length)
        const stamp = new Date(`${datePart}T00:00:00`).getTime()
        if (Number.isFinite(stamp) && stamp < cutoff) {
          unlinkSync(join(this.logsDir, name))
        }
      }
    } catch {
      // ignore cleanup failure
    }
  }

  log(level: LogLevel, message: string, appId?: AppId): LogEntry {
    const entry: LogEntry = {
      id: this.nextId++,
      ts: Date.now(),
      level,
      appId,
      message: sanitize(message),
    }
    this.buffer.push(entry)
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER)
    }
    try {
      appendFileSync(this.fileFor(), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // logging must never break the scheduler
    }
    this.listener?.(entry)
    return entry
  }

  info(message: string, appId?: AppId): void {
    this.log('info', message, appId)
  }

  success(message: string, appId?: AppId): void {
    this.log('success', message, appId)
  }

  warn(message: string, appId?: AppId): void {
    this.log('warn', message, appId)
  }

  error(message: string, appId?: AppId): void {
    this.log('error', message, appId)
  }

  entries(): LogEntry[] {
    return [...this.buffer]
  }

  clear(): void {
    this.buffer = []
    try {
      for (const name of readdirSync(this.logsDir)) {
        if (name.startsWith('autocredit-') && name.endsWith('.jsonl')) {
          unlinkSync(join(this.logsDir, name))
        }
      }
    } catch {
      // ignore
    }
    this.info('日志已清空')
  }

  exportText(): string {
    return this.buffer
      .map((entry) => {
        const time = new Date(entry.ts).toLocaleString('zh-CN', { hour12: false })
        const app = entry.appId ? ` [${entry.appId}]` : ''
        return `[${time}] [${entry.level.toUpperCase()}]${app} ${entry.message}`
      })
      .join('\n')
  }

  exportToFile(path: string): void {
    writeFileSync(path, this.exportText(), 'utf8')
  }
}
