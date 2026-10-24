import { APP_META, visibleAppIds } from '@shared/constants'
import type { AppId, RunStatus } from '@shared/types'
import type { Adapter, Outcome, ProbeResult } from './checkin/types'
import { checkinDateKey, isTimeReached, localDateKey } from './date'
import { getNotificationState } from './fullscreen'
import type { Logger } from './logger'
import type { Store } from './store'

const TICK_MS = 15_000
const RETRY_MS = 10 * 60_000
const MAX_ATTEMPTS = 3

export interface PopupPresenter {
  show(ids: AppId[]): Promise<boolean>
}

interface SchedulerOptions {
  store: Store
  logger: Logger
  adapters: Record<AppId, Adapter>
  popup: PopupPresenter
  onChange: () => void
}

/**
 * Quietly checks in due programs. All work is serialized so a manual run and
 * the periodic tick can never hit the same account twice.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout
  private startTimer?: NodeJS.Timeout
  private queue: Promise<void> = Promise.resolve()
  private tickQueued = false
  private today = localDateKey()

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    this.stop()
    this.options.logger.info(`调度器已启动，每 ${TICK_MS / 1000} 秒检查一次签到时间`)
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    this.startTimer = setTimeout(() => {
      void this.catchUp('启动')
    }, 3000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.startTimer) clearTimeout(this.startTimer)
    this.timer = undefined
    this.startTimer = undefined
  }

  /** Probes every program and immediately catches up on anything overdue. */
  async catchUp(reason: string): Promise<void> {
    this.options.logger.info(`系统${reason}，开始检查错过的签到`)
    await this.probeAll()
    await this.tick()
  }

  async tick(): Promise<void> {
    if (this.tickQueued) return
    this.tickQueued = true
    try {
      await this.enqueue(() => this.performTick())
    } finally {
      this.tickQueued = false
    }
  }

  async probeAll(ids?: AppId[]): Promise<void> {
    const targets = ids && ids.length ? ids : this.activeAppIds()
    await this.enqueue(async () => {
      this.rollDate()
      this.options.logger.info(
        `正在检测 ${targets.map((id) => APP_META[id].name).join('、')} 的签到状态`,
      )
      for (const id of targets) {
        let result: ProbeResult
        try {
          result = await this.options.adapters[id].probe()
        } catch (error) {
          result = {
            checkedIn: false,
            status: 'failed',
            message: error instanceof Error ? error.message : '状态检测失败',
          }
        }
        this.applyProbe(id, result)
      }
      this.options.onChange()
    })
  }

  async runNow(ids?: AppId[]): Promise<void> {
    const requested =
      ids && ids.length
        ? ids
        : this.activeAppIds().filter((id) => this.options.store.apps[id].enabled)
    const targets = requested.filter((id) => this.options.store.apps[id].enabled)
    if (!targets.length) {
      this.options.logger.warn('没有可签到或已启用的程序')
      return
    }
    await this.enqueue(async () => {
      this.rollDate()
      this.options.logger.info(`手动签到：${targets.map((id) => APP_META[id].name).join('、')}`)
      for (const id of targets) {
        const readiness = this.options.adapters[id].readiness()
        if (!readiness.ready) {
          const today = this.dateKeyFor(id)
          this.options.store.updateRuntime(id, {
            status: readiness.status ?? readinessStatus(id),
            message: readiness.message,
            lastAttemptDate: today,
            lastAttemptAt: new Date().toISOString(),
            attempts: Math.max(1, this.attemptsFor(id)),
          })
          this.options.logger.warn(`${APP_META[id].name}：${readiness.message}`, id)
          continue
        }
        await this.execute(id)
      }
      this.options.onChange()
    })
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private rollDate(): void {
    const current = localDateKey()
    if (current === this.today) return
    this.today = current
    this.options.store.normalizeToday()
    this.options.logger.info('日期已更新，签到状态已重置')
    this.options.onChange()
  }

  private scheduleTime(id: AppId): string {
    const app = this.options.store.apps[id]
    return app.useCustomTime ? app.time : this.options.store.settings.defaultTime
  }

  /** 程序所属的签到日：Qoder 系列 10:00 之前仍算前一天。 */
  private dateKeyFor(id: AppId): string {
    return checkinDateKey(APP_META[id].checkinResetHour ?? 0)
  }

  /** 只会累计同一个签到日内的尝试次数，跨过 10:00 边界后重新计数。 */
  private attemptsFor(id: AppId): number {
    const runtime = this.options.store.runtime[id]
    return runtime.lastAttemptDate === this.dateKeyFor(id) ? runtime.attempts : 0
  }

  private doneToday(id: AppId): boolean {
    const today = this.dateKeyFor(id)
    const runtime = this.options.store.runtime[id]
    if (runtime.lastSuccessDate === today) return true
    return runtime.probeDate === today && runtime.todayCheckedIn === true
  }

  private settledToday(id: AppId): boolean {
    const today = this.dateKeyFor(id)
    const runtime = this.options.store.runtime[id]
    if (runtime.lastAttemptDate !== today) return false
    if (runtime.status === 'cancelled') return true
    if (
      runtime.status === 'needs-setup' ||
      runtime.status === 'needs-auth' ||
      runtime.status === 'unavailable'
    ) {
      return true
    }
    if (runtime.status === 'failed') {
      if (runtime.attempts >= MAX_ATTEMPTS) return true
      const last = runtime.lastAttemptAt ? new Date(runtime.lastAttemptAt).getTime() : 0
      return Date.now() - last < RETRY_MS
    }
    return false
  }

  private activeAppIds(): AppId[] {
    return visibleAppIds(this.options.store.settings)
  }

  private dueApps(): AppId[] {
    const { store } = this.options
    if (!store.settings.masterEnabled) return []
    return this.activeAppIds().filter((id) => {
      if (!store.apps[id].enabled) return false
      if (this.doneToday(id)) return false
      if (!isTimeReached(this.scheduleTime(id))) return false
      if (this.settledToday(id)) return false
      return true
    })
  }

  private async performTick(): Promise<void> {
    this.rollDate()
    if (!this.options.store.settings.masterEnabled) return

    const due = this.dueApps()
    if (!due.length) return

    const ready: AppId[] = []
    for (const id of due) {
      const readiness = this.options.adapters[id].readiness()
      if (!readiness.ready) {
        this.options.store.updateRuntime(id, {
          status: readiness.status ?? readinessStatus(id),
          message: readiness.message,
          lastAttemptDate: this.dateKeyFor(id),
          lastAttemptAt: new Date().toISOString(),
          attempts: Math.max(1, this.attemptsFor(id)),
        })
        this.options.logger.warn(`${APP_META[id].name}：${readiness.message}`, id)
        continue
      }
      const runtime = this.options.store.runtime[id]
      if (runtime.status === 'running') continue
      ready.push(id)
    }
    this.options.onChange()
    if (!ready.length) return

    const names = ready.map((id) => APP_META[id].name).join('、')
    const notification = await getNotificationState(true)
    if (notification.suppressed) {
      this.options.logger.info(
        `检测到${notification.reason || '全屏 / 忙碌状态'}，本次静默签到，不弹出提醒`,
      )
    } else {
      this.options.logger.info(`即将为 ${names} 签到，10 秒倒计时开始`)
      const cancelled = await this.options.popup.show(ready)
      if (cancelled) {
        for (const id of ready) {
          this.options.store.updateRuntime(id, {
            status: 'cancelled',
            message: '今日签到已被取消，可在总览中手动签到',
            lastAttemptDate: this.dateKeyFor(id),
            lastAttemptAt: new Date().toISOString(),
          })
        }
        this.options.logger.info(`已取消今日 ${names} 的签到`)
        this.options.onChange()
        return
      }
    }

    for (const id of ready) {
      await this.execute(id)
    }
    this.options.onChange()
  }

  private async execute(id: AppId): Promise<void> {
    const startedAt = new Date()
    const today = this.dateKeyFor(id)
    const attempts = this.attemptsFor(id) + 1
    this.options.store.updateRuntime(id, {
      status: 'running',
      message: '正在签到…',
      attempts,
      lastAttemptDate: today,
      lastAttemptAt: startedAt.toISOString(),
    })
    this.options.onChange()
    this.options.logger.info(`开始签到 ${APP_META[id].name}`, id)

    let outcome: Outcome
    try {
      outcome = await this.options.adapters[id].checkIn()
    } catch (error) {
      outcome = {
        status: 'failed',
        message: error instanceof Error ? error.message : '未知错误',
      }
    }
    this.applyOutcome(id, outcome, attempts)
  }

  private applyOutcome(id: AppId, outcome: Outcome, attempts: number): void {
    const name = APP_META[id].name
    const today = this.dateKeyFor(id)
    const nowIso = new Date().toISOString()
    const current = this.options.store.runtime[id]

    switch (outcome.status) {
      case 'success':
      case 'already': {
        const already = outcome.status === 'already'
        this.options.store.updateRuntime(id, {
          status: already ? 'already' : 'success',
          message: outcome.message,
          credits: outcome.credits ?? current.credits,
          todayCheckedIn: true,
          probeDate: today,
          lastSuccessDate: today,
          lastSuccessAt: current.lastSuccessDate === today && current.lastSuccessAt ? current.lastSuccessAt : nowIso,
        })
        if (already) {
          this.options.logger.info(`${name}：${outcome.message}`, id)
        } else {
          this.options.logger.success(`${name}：${outcome.message}`, id)
        }
        break
      }
      case 'needs-setup':
      case 'needs-auth':
      case 'unavailable': {
        this.options.store.updateRuntime(id, {
          status: outcome.status as RunStatus,
          message: outcome.message,
          credits: outcome.credits ?? current.credits,
        })
        this.options.logger.warn(`${name}：${outcome.message}`, id)
        break
      }
      case 'failed': {
        const willRetry = attempts < MAX_ATTEMPTS
        const suffix = willRetry ? `，10 分钟后第 ${attempts + 1} 次尝试` : '，今日不再重试'
        this.options.store.updateRuntime(id, {
          status: 'failed',
          message: `${outcome.message}${suffix}`,
          attempts,
          lastAttemptAt: nowIso,
          lastAttemptDate: today,
        })
        this.options.logger.error(`${name}：${outcome.message}${suffix}`, id)
        break
      }
      case 'pending': {
        this.options.store.updateRuntime(id, {
          status: 'idle',
          message: outcome.message,
          todayCheckedIn: false,
        })
        this.options.logger.info(`${name}：${outcome.message}`, id)
        break
      }
    }
    this.options.onChange()
  }

  private applyProbe(id: AppId, probe: ProbeResult): void {
    const name = APP_META[id].name
    const today = this.dateKeyFor(id)
    const current = this.options.store.runtime[id]

    if (current.status === 'running') return
    if (current.status === 'cancelled' && current.lastAttemptDate === today && !probe.checkedIn) {
      return
    }

    if (probe.checkedIn) {
      const firstTimeToday = current.lastSuccessDate !== today
      this.options.store.updateRuntime(id, {
        status: 'already',
        message: probe.message || '今日已签到',
        credits: probe.credits ?? current.credits,
        todayCheckedIn: true,
        probeDate: today,
        lastSuccessDate: today,
        lastSuccessAt: firstTimeToday ? new Date().toISOString() : current.lastSuccessAt,
      })
      this.options.logger.info(`${name}：${probe.message || '今日已签到'}`, id)
      return
    }

    if (current.lastSuccessDate === today) {
      // A later probe (e.g. a transient network failure) must not undo today's success.
      return
    }

    switch (probe.status) {
      case 'pending': {
        this.options.store.updateRuntime(id, {
          status: 'idle',
          message: '今日待签到',
          todayCheckedIn: false,
          probeDate: today,
        })
        this.options.logger.info(`${name}：今日待签到`, id)
        break
      }
      case 'needs-setup':
      case 'needs-auth':
      case 'unavailable': {
        this.options.store.updateRuntime(id, {
          status: probe.status as RunStatus,
          message: probe.message,
          todayCheckedIn: false,
          probeDate: today,
        })
        this.options.logger.warn(`${name}：${probe.message}`, id)
        break
      }
      case 'failed': {
        this.options.store.updateRuntime(id, {
          status: 'failed',
          message: probe.message,
          todayCheckedIn: false,
          probeDate: today,
        })
        this.options.logger.warn(`${name}：状态检测失败：${probe.message}`, id)
        break
      }
      default:
        break
    }
  }
}

function readinessStatus(id: AppId): RunStatus {
  return id === 'qoder' || id === 'qoder-cn' || id === 'doubao' ? 'needs-setup' : 'needs-auth'
}
