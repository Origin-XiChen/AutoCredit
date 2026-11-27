import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, net } from 'electron'
import type { UpdateStatus } from '@shared/types'
import type { Logger } from './logger'

const TARGET_VERSION = '1.2.0'
const FILE_NAME = 'AutoCredit-Setup-1.2.0.exe'
const DOWNLOAD_URL =
  'https://github.com/Origin-XiChen/AutoCredit/releases/download/v1.2.0/AutoCredit-Setup-1.2.0.exe'
const SHA256 = 'd2aef88ce0759002bc98618213263c622bd974d32597b7ab29b814a3e4af73d3'

let loggerRef: Logger | null = null
let emit: (status: UpdateStatus) => void = () => {}
let busy = false
let announced = false

export function initMigration(options: {
  logger: Logger
  sendStatus: (status: UpdateStatus) => void
}): void {
  loggerRef = options.logger
  emit = options.sendStatus
}

function versionLess(current: string, target: string): boolean {
  const left = current.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = target.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b
  }
  return false
}

function migrationAvailable(): boolean {
  const testing = process.env['AUTOCREDIT_MIGRATION_TEST'] === '1'
  if (!app.isPackaged && !testing) return false
  return versionLess(app.getVersion(), TARGET_VERSION)
}

/** 返回 true 表示当前应走迁移流程，不再检查 Electron 更新。 */
export function announceMigration(manual = false): boolean {
  if (!migrationAvailable()) return false
  if (announced && !manual) return true
  announced = true
  emit({
    phase: 'migration',
    version: TARGET_VERSION,
    message: `AutoCredit ${TARGET_VERSION} 已发布：改用更轻量的新架构，功能与配置保持一致。`,
  })
  return true
}

export async function installMigration(): Promise<void> {
  if (busy || !migrationAvailable()) return
  busy = true
  try {
    const localFile = process.env['AUTOCREDIT_MIGRATION_FILE']
    const expected = (
      process.env['AUTOCREDIT_MIGRATION_SHA256'] ?? SHA256
    ).toLowerCase()

    let buffer: Buffer
    if (localFile) {
      emit({
        phase: 'migration-downloading',
        version: TARGET_VERSION,
        message: '正在读取本地安装包…',
      })
      buffer = readFileSync(localFile)
    } else {
      const url = process.env['AUTOCREDIT_MIGRATION_URL'] ?? DOWNLOAD_URL
      emit({
        phase: 'migration-downloading',
        version: TARGET_VERSION,
        message: '正在下载新版本安装包…',
      })
      loggerRef?.info(`开始下载迁移安装包：${url}`)
      const response = await net.fetch(url, { redirect: 'follow' })
      if (!response.ok) {
        throw new Error(`下载失败：HTTP ${response.status}`)
      }
      buffer = Buffer.from(await response.arrayBuffer())
    }

    emit({
      phase: 'migration-downloading',
      version: TARGET_VERSION,
      message: '正在校验安装包…',
    })
    const hash = createHash('sha256').update(buffer).digest('hex')
    if (expected && hash !== expected) {
      throw new Error('安装包校验失败，请稍后重试')
    }

    const dir = join(tmpdir(), 'AutoCredit')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, FILE_NAME)
    writeFileSync(file, buffer)

    if (process.env['AUTOCREDIT_MIGRATION_DRY_RUN'] === '1') {
      emit({
        phase: 'migration-downloading',
        version: TARGET_VERSION,
        message: `安装包已下载并通过校验：${file}`,
      })
      busy = false
      return
    }

    emit({
      phase: 'migration-downloading',
      version: TARGET_VERSION,
      message: '正在启动安装程序…',
    })
    const child = spawn(file, [], { detached: true, stdio: 'ignore' })
    child.unref()
    loggerRef?.info('已启动新版本安装程序，应用即将退出')
    setTimeout(() => app.quit(), 700)
  } catch (error) {
    busy = false
    const message = error instanceof Error ? error.message : '未知错误'
    loggerRef?.warn(`迁移安装包下载失败：${message}`)
    emit({ phase: 'error', version: TARGET_VERSION, message })
    throw error
  }
}
