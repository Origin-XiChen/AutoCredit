import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ORDER, DEFAULT_CONFIG } from '@shared/constants'
import type { AppConfig, AppId, AppRuntime, BootstrapState, ConfigFile, GlobalSettings } from '@shared/types'
import { APP_META } from '@shared/constants'
import { localDateKey } from './date'

type Secrets = Partial<Record<AppId, string>>

const DEFAULT_MACHINE_ID = randomUUID()

export class Store {
  readonly dataDir = app.getPath('userData')
  readonly logsDir = join(this.dataDir, 'logs')
  private readonly configPath = join(this.dataDir, 'config.json')
  private readonly secretsPath = join(this.dataDir, 'secrets.bin')
  private config: ConfigFile
  private secrets: Secrets = {}
  private secretsReady = false

  constructor() {
    mkdirSync(this.dataDir, { recursive: true })
    mkdirSync(this.logsDir, { recursive: true })
    this.config = this.loadConfig()
    this.loadSecrets()
    this.normalizeToday()
  }

  private loadConfig(): ConfigFile {
    const fallback = (): ConfigFile => ({
      ...DEFAULT_CONFIG,
      settings: { ...DEFAULT_CONFIG.settings },
      apps: structuredClone(DEFAULT_CONFIG.apps),
      runtime: structuredClone(DEFAULT_CONFIG.runtime),
      machineId: DEFAULT_MACHINE_ID,
      createdAt: new Date().toISOString(),
    })

    if (!existsSync(this.configPath)) return fallback()

    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<ConfigFile>
      const base = fallback()
      const settings = { ...base.settings, ...(raw.settings ?? {}) }
      const apps = {} as Record<AppId, AppConfig>
      const runtime = {} as Record<AppId, AppRuntime>
      for (const id of APP_ORDER) {
        apps[id] = { ...base.apps[id], ...(raw.apps?.[id] ?? {}) }
        runtime[id] = { ...base.runtime[id], ...(raw.runtime?.[id] ?? {}) }
      }
      return {
        version: 1,
        settings,
        apps,
        runtime,
        machineId: raw.machineId || base.machineId,
        createdAt: raw.createdAt || base.createdAt,
      }
    } catch {
      return fallback()
    }
  }

  private loadSecrets(): void {
    this.secretsReady = safeStorage.isEncryptionAvailable()
    if (!this.secretsReady || !existsSync(this.secretsPath)) return
    try {
      const encoded = readFileSync(this.secretsPath, 'utf8').trim()
      if (!encoded) return
      const decrypted = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      this.secrets = JSON.parse(decrypted) as Secrets
    } catch {
      this.secrets = {}
    }
  }

  private saveSecrets(): void {
    if (!this.secretsReady) {
      throw new Error('系统安全存储不可用，无法保存访问令牌')
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(this.secrets))
    writeFileSync(this.secretsPath, encrypted.toString('base64'), 'utf8')
  }

  save(): void {
    const tempPath = `${this.configPath}.tmp`
    writeFileSync(tempPath, JSON.stringify(this.config, null, 2), 'utf8')
    renameSync(tempPath, this.configPath)
  }

  get settings(): GlobalSettings {
    return this.config.settings
  }

  get apps(): Record<AppId, AppConfig> {
    return this.config.apps
  }

  get runtime(): Record<AppId, AppRuntime> {
    return this.config.runtime
  }

  get machineId(): string {
    return this.config.machineId
  }

  updateSettings(patch: Partial<GlobalSettings>): void {
    this.config.settings = { ...this.config.settings, ...patch }
    this.save()
  }

  updateApp(id: AppId, patch: Partial<AppConfig>): void {
    this.config.apps[id] = { ...this.config.apps[id], ...patch }
    this.save()
  }

  updateRuntime(id: AppId, patch: Partial<AppRuntime>): void {
    this.config.runtime[id] = {
      ...this.config.runtime[id],
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    this.save()
  }

  getPat(id: AppId): string {
    return this.secrets[id] ?? ''
  }

  hasPat(id: AppId): boolean {
    return Boolean(this.secrets[id])
  }

  setPat(id: AppId, value: string): void {
    if (id !== 'qoder' && id !== 'qoder-cn') {
      throw new Error('该程序不需要手动令牌')
    }
    this.secrets[id] = value.trim()
    this.saveSecrets()
  }

  clearPat(id: AppId): void {
    delete this.secrets[id]
    this.saveSecrets()
  }

  normalizeToday(): void {
    const today = localDateKey()
    for (const id of APP_ORDER) {
      const runtime = this.config.runtime[id]
      const staleProbe = runtime.probeDate !== today
      if (staleProbe && runtime.todayCheckedIn) {
        runtime.todayCheckedIn = false
      }
      if (runtime.lastAttemptDate !== today) {
        runtime.attempts = 0
        if (runtime.status === 'failed' || runtime.status === 'cancelled') {
          runtime.status = 'idle'
          runtime.message = '等待签到'
        }
      }
      if (
        runtime.lastSuccessDate !== today &&
        !(runtime.probeDate === today && runtime.todayCheckedIn) &&
        (runtime.status === 'success' || runtime.status === 'already')
      ) {
        runtime.status = 'idle'
        runtime.message = '等待签到'
      }
      if (runtime.status === 'running') {
        runtime.status = 'idle'
        runtime.message = '等待签到'
      }
    }
    this.save()
  }

  bootstrap(): BootstrapState {
    return {
      settings: this.config.settings,
      apps: this.config.apps,
      runtime: this.config.runtime,
      metas: APP_ORDER.map((id) => APP_META[id]),
      secrets: {
        trae: false,
        qoder: this.hasPat('qoder'),
        'qoder-cn': this.hasPat('qoder-cn'),
        workbuddy: false,
        doubao: false,
      },
      version: app.getVersion(),
      dataDir: this.dataDir,
      logsDir: this.logsDir,
      isPackaged: app.isPackaged,
    }
  }
}
