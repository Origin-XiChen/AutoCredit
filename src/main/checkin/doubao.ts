import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { join } from 'node:path'
import type { DetectResult } from '@shared/types'
import { asRecord, pickNumber, pickString } from '../http'
import type { Adapter, AdapterDeps, Outcome, ProbeResult, Readiness } from './types'

const DEBUG_PORT = 9222
const STATUS_PATH = '/alice/ug/campaign/v3/detail/'
const CHECKIN_PATH = '/alice/ug/campaign/landing/checkin'
const LAUNCH_TIMEOUT = 30_000

interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

interface DoubaoStatus {
  checkedIn: boolean
  credits?: number
}

interface Recorder {
  responses: Map<string, string>
  finished: Set<string>
  stop: () => void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fetchTargets(timeoutMs = 1200): Promise<CdpTarget[] | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: CdpTarget[] | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = httpGet(
      { host: '127.0.0.1', port: DEBUG_PORT, path: '/json/list', timeout: timeoutMs },
      (response) => {
        let data = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          data += chunk
        })
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data) as unknown
            finish(Array.isArray(parsed) ? (parsed as CdpTarget[]) : undefined)
          } catch {
            finish(undefined)
          }
        })
      },
    )
    request.on('timeout', () => {
      request.destroy()
      finish(undefined)
    })
    request.on('error', () => finish(undefined))
  })
}

/** Minimal Chrome DevTools Protocol client used to drive the Doubao desktop app. */
class CdpSession {
  private nextId = 0
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      let message: CdpMessage
      try {
        message = JSON.parse(String(event.data)) as CdpMessage
      } catch {
        return
      }
      if (typeof message.id === 'number') {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(message.error.message || '调试指令执行失败'))
        else entry.resolve(message.result)
        return
      }
      if (!message.method) return
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params ?? {})
        } catch {
          // listeners must never break the session
        }
      }
    }
    socket.onclose = () => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('豆包调试连接已断开'))
        this.pending.delete(id)
      }
    }
  }

  static connect(url: string, timeoutMs = 8000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {
          // ignore
        }
        reject(new Error('连接豆包调试端口超时'))
      }, timeoutMs)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve(new CdpSession(socket))
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('无法连接豆包调试端口'))
      }
    })
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('发送调试指令失败'))
      }
    })
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const bucket = this.listeners.get(method) ?? new Set()
    bucket.add(listener)
    this.listeners.set(method, bucket)
    return () => {
      bucket.delete(listener)
    }
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      // ignore
    }
  }
}

const PAGE_STATE_EXPR = `(() => {
  const nodes = [...document.querySelectorAll('button,div,span,a,p')]
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const text = (el) => (el.textContent || '').trim()
  const button = nodes.some((el) => text(el) === '立即签到' && visible(el))
  const success = nodes.some((el) => {
    const value = text(el)
    return value.length > 0 && value.length <= 12 && /签到成功|今日已签到|已签到/.test(value) && visible(el)
  })
  return JSON.stringify({ button, success })
})()`

const CLICK_POINT_EXPR = `(() => {
  const nodes = [...document.querySelectorAll('button,div,span,a')]
  const el = nodes.find((node) => {
    const rect = node.getBoundingClientRect()
    return (node.textContent || '').trim() === '立即签到' && rect.width > 0 && rect.height > 0
  })
  if (!el) return ''
  const rect = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) })
})()`

export class DoubaoAdapter implements Adapter {
  readonly id = 'doubao' as const

  constructor(private readonly deps: AdapterDeps) {}

  private findExecutable(): string | undefined {
    const local = process.env.LOCALAPPDATA || ''
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const candidates = [
      join(local, 'Doubao', 'Application', 'Doubao.exe'),
      join(local, 'Programs', 'Doubao', 'Application', 'Doubao.exe'),
      join(programFiles, 'Doubao', 'Application', 'Doubao.exe'),
      join(programFilesX86, 'Doubao', 'Application', 'Doubao.exe'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    for (const root of [join(local, 'Programs'), programFiles, programFilesX86]) {
      try {
        for (const name of readdirSync(root)) {
          if (!/doubao/i.test(name)) continue
          for (const exe of [
            join(root, name, 'Application', 'Doubao.exe'),
            join(root, name, 'Doubao.exe'),
          ]) {
            if (existsSync(exe)) return exe
          }
        }
      } catch {
        // ignore unreadable roots
      }
    }
    return undefined
  }

  private async openPage(targets?: CdpTarget[]): Promise<CdpSession | undefined> {
    const list = targets ?? (await fetchTargets(1200))
    const page = list?.find((target) => target.type === 'page' && target.url.includes('doubao-chat/chat'))
    if (!page?.webSocketDebuggerUrl) return undefined
    try {
      return await CdpSession.connect(page.webSocketDebuggerUrl)
    } catch {
      return undefined
    }
  }

  private async readPageState(session: CdpSession): Promise<{ button: boolean; success: boolean }> {
    const response = asRecord(
      await session.send('Runtime.evaluate', { expression: PAGE_STATE_EXPR, returnByValue: true }, 8000),
    )
    const remote = asRecord(response?.result)
    const raw = remote?.value
    if (typeof raw !== 'string') return { button: false, success: false }
    try {
      const parsed = asRecord(JSON.parse(raw))
      return { button: parsed?.button === true, success: parsed?.success === true }
    } catch {
      return { button: false, success: false }
    }
  }

  private async startRecording(session: CdpSession): Promise<Recorder> {
    await session.send('Network.enable', { maxPostDataSize: 262_144 }, 8000)
    const responses = new Map<string, string>()
    const finished = new Set<string>()
    const stopResponse = session.on('Network.responseReceived', (params) => {
      const response = asRecord(params.response)
      const url = pickString(response, ['url'])
      if (url) responses.set(String(params.requestId), url)
    })
    const stopFinished = session.on('Network.loadingFinished', (params) => {
      finished.add(String(params.requestId))
    })
    return {
      responses,
      finished,
      stop: () => {
        stopResponse()
        stopFinished()
      },
    }
  }

  private async responseFor(
    session: CdpSession,
    recorder: Recorder,
    path: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const [requestId, url] of recorder.responses) {
        if (!url.includes(path) || !recorder.finished.has(requestId)) continue
        try {
          const body = asRecord(await session.send('Network.getResponseBody', { requestId }, 6000))
          const text = body?.body
          if (typeof text === 'string' && text) return JSON.parse(text) as unknown
        } catch {
          // body may not be ready yet, retry on the next tick
        }
      }
      await delay(280)
    }
    return undefined
  }

  private parseStatus(json: unknown): DoubaoStatus | undefined {
    const data = asRecord(asRecord(json)?.data)
    const tasks = data?.tasks
    if (!Array.isArray(tasks)) return undefined
    for (const item of tasks) {
      const task = asRecord(item)
      if (!task || task.campaign_code !== 'daily_signin') continue
      const daily = asRecord(task.daily_checkin)
      if (!daily) continue
      return {
        checkedIn: daily.checked_in_today === true,
        credits: pickNumber(daily.reward, ['reward_amount', 'amount']),
      }
    }
    return undefined
  }

  private async clickCheckIn(session: CdpSession, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const response = asRecord(
        await session.send('Runtime.evaluate', { expression: CLICK_POINT_EXPR, returnByValue: true }, 6000),
      )
      const remote = asRecord(response?.result)
      const raw = remote?.value
      if (typeof raw === 'string' && raw) {
        try {
          const point = asRecord(JSON.parse(raw))
          const x = point?.x
          const y = point?.y
          if (typeof x === 'number' && typeof y === 'number') {
            await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
            await session.send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x,
              y,
              button: 'left',
              clickCount: 1,
            })
            await session.send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x,
              y,
              button: 'left',
              clickCount: 1,
            })
            return true
          }
        } catch {
          // retry
        }
      }
      await delay(500)
    }
    return false
  }

  private async waitCheckInResult(
    session: CdpSession,
    recorder: Recorder,
    timeoutMs: number,
  ): Promise<{ ok: boolean; credits?: number; message?: string } | undefined> {
    const json = await this.responseFor(session, recorder, CHECKIN_PATH, timeoutMs)
    if (json !== undefined) {
      const data = asRecord(asRecord(json)?.data)
      if (data?.checked_in === true) {
        return {
          ok: true,
          credits: pickNumber(data, ['reward_amount', 'reward', 'credits', 'quota']),
        }
      }
      const message = pickString(asRecord(json), ['msg', 'message'])
      return { ok: false, message: message || '豆包签到未完成' }
    }
    const state = await this.readPageState(session)
    if (state.success) return { ok: true }
    return undefined
  }

  private async ensureDebugPort(): Promise<{ ok: boolean; message: string }> {
    if (await fetchTargets(800)) return { ok: true, message: '' }
    const executable = this.findExecutable()
    if (!executable) {
      return { ok: false, message: '未找到豆包桌面端，请先安装并登录豆包' }
    }
    try {
      const child = spawn(executable, [`--remote-debugging-port=${DEBUG_PORT}`], {
        stdio: 'ignore',
        windowsHide: false,
      })
      child.on('error', () => undefined)
      child.unref()
    } catch (error) {
      return {
        ok: false,
        message: `启动豆包失败：${error instanceof Error ? error.message : '未知错误'}`,
      }
    }
    const deadline = Date.now() + LAUNCH_TIMEOUT
    while (Date.now() < deadline) {
      await delay(800)
      if (await fetchTargets(700)) return { ok: true, message: '' }
    }
    return {
      ok: false,
      message: '未能连接豆包调试端口；若豆包已在运行，请先完全退出豆包后重试',
    }
  }

  readiness(): Readiness {
    if (!this.deps.store.settings.developerMode) {
      return { ready: false, message: '豆包签到属于实验功能，请先在设置中开启开发者模式' }
    }
    if (!this.findExecutable()) {
      return { ready: false, message: '未找到豆包桌面端，请先安装并登录豆包' }
    }
    return { ready: true, message: '已找到豆包客户端，签到时会自动启动' }
  }

  async detect(): Promise<DetectResult> {
    if (!this.deps.store.settings.developerMode) {
      return { ok: false, message: '请先在设置中开启开发者模式' }
    }
    if (!this.findExecutable()) {
      return { ok: false, message: '未找到豆包桌面端，请先安装并登录豆包' }
    }
    const session = await this.openPage()
    if (!session) {
      return { ok: true, message: '已找到豆包客户端，签到时会自动启动' }
    }
    try {
      const state = await this.readPageState(session)
      if (state.success) return { ok: true, message: '豆包已登录，今日已签到' }
      if (state.button) return { ok: true, message: '豆包已登录，今日待签到' }
      return { ok: true, message: '豆包客户端已就绪，签到时会自动确认状态' }
    } finally {
      session.close()
    }
  }

  async probe(): Promise<ProbeResult> {
    if (!this.deps.store.settings.developerMode) {
      return { checkedIn: false, status: 'unavailable', message: '开发者模式未开启' }
    }
    if (!this.findExecutable()) {
      return { checkedIn: false, status: 'needs-setup', message: '未找到豆包桌面端' }
    }
    const session = await this.openPage()
    if (!session) {
      return { checkedIn: false, status: 'pending', message: '豆包客户端未运行，签到时会自动启动' }
    }
    try {
      const state = await this.readPageState(session)
      if (state.success) return { checkedIn: true, status: 'already', message: '今日已签到' }
      return { checkedIn: false, status: 'pending', message: '今日待签到' }
    } finally {
      session.close()
    }
  }

  async checkIn(): Promise<Outcome> {
    const { settings } = this.deps.store
    if (!settings.developerMode) {
      return { status: 'unavailable', message: '开发者模式未开启' }
    }
    if (!this.findExecutable()) {
      return { status: 'needs-setup', message: '未找到豆包桌面端，请先安装并登录豆包' }
    }

    const debug = await this.ensureDebugPort()
    if (!debug.ok) return { status: 'failed', message: debug.message }

    const session = await this.openPage()
    if (!session) return { status: 'failed', message: '未能连接豆包页面，请稍后重试' }

    let recorder: Recorder | undefined
    try {
      recorder = await this.startRecording(session)
      await session.send('Page.enable', {}, 6000).catch(() => undefined)
      await session.send('Page.reload', {}, 6000).catch(() => undefined)

      const statusJson = await this.responseFor(session, recorder, STATUS_PATH, 20_000)
      const status = statusJson === undefined ? undefined : this.parseStatus(statusJson)
      if (status?.checkedIn) {
        return { status: 'already', message: '今日已签到，已自动跳过', credits: status.credits }
      }

      const clicked = await this.clickCheckIn(session, 15_000)
      if (!clicked) {
        return {
          status: 'failed',
          message: '未找到豆包“立即签到”按钮，请打开豆包确认活动状态',
        }
      }

      const result = await this.waitCheckInResult(session, recorder, 25_000)
      if (result?.ok) {
        const credits = result.credits ?? status?.credits
        return {
          status: 'success',
          message: credits ? `签到成功，+${credits} 额度` : '签到成功',
          credits,
        }
      }
      return {
        status: 'failed',
        message: result?.message || '未能确认豆包签到结果，请打开客户端查看',
      }
    } catch (error) {
      return {
        status: 'failed',
        message: `豆包签到失败：${error instanceof Error ? error.message : '未知错误'}`,
      }
    } finally {
      recorder?.stop()
      session.close()
    }
  }
}
