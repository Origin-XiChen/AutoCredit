import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { AppId, DetectResult } from '@shared/types'
import { asRecord, describeHttpError, pickNumber, pickString, request } from '../http'
import type { Adapter, AdapterDeps, Outcome, ProbeResult, Readiness } from './types'

type QoderMode = 'global' | 'cn'

interface QoderEndpoints {
  openApi: string
  environment: string
}

const ENDPOINTS: Record<QoderMode, QoderEndpoints> = {
  global: { openApi: 'https://openapi.qoder.sh', environment: '3' },
  cn: { openApi: 'https://openapi.qoder.com.cn', environment: '0' },
}

interface MachineIdentity {
  machineToken: string
  machineCode: string
  machineType: string
}

interface Campaign {
  campaignId?: string
  claimStatus?: string
  actionType?: string
  claimable?: boolean
  benefit?: {
    kind?: string
    amount?: number
    validity?: { days?: number }
  }
}

const identityCache = new Map<string, { identity: MachineIdentity; at: number }>()

function qoderHome(): string {
  return process.env.USERPROFILE || process.env.HOME || ''
}

function umidCandidates(mode: QoderMode): string[] {
  const custom = process.env.QODER_UMID_EXE
  if (custom) return [custom]
  const local = process.env.LOCALAPPDATA || ''
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  if (mode === 'cn') {
    return [
      join(local, 'Programs', 'Qoder CN', 'resources', 'umid', 'runtime-info.exe'),
      join(local, 'Programs', 'Qoder', 'resources', 'umid', 'runtime-info.exe'),
      join(programFiles, 'Qoder CN', 'resources', 'umid', 'runtime-info.exe'),
      join(programFiles, 'Qoder', 'resources', 'umid', 'runtime-info.exe'),
    ]
  }
  return [
    join(local, 'Programs', 'Qoder', 'resources', 'umid', 'runtime-info.exe'),
    join(programFiles, 'Qoder', 'resources', 'umid', 'runtime-info.exe'),
  ]
}

function runUmid(exe: string, environment: string, accountId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [environment, '--account-stdin'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('设备校验超时'))
    }, 10_000)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(stderr.trim() || `设备校验组件退出 ${code}`))
        return
      }
      resolve(stdout)
    })
    child.stdin.end(JSON.stringify({ account: accountId }))
  })
}

async function resolveMachineIdentity(
  mode: QoderMode,
  accountId: string,
): Promise<MachineIdentity | undefined> {
  const key = `${mode}:${accountId}`
  const hit = identityCache.get(key)
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.identity

  for (const exe of umidCandidates(mode)) {
    if (!existsSync(exe)) continue
    try {
      const output = await runUmid(exe, ENDPOINTS[mode].environment, accountId)
      const parsed = asRecord(JSON.parse(output))
      if (!parsed) continue
      const identity: MachineIdentity = {
        machineToken: pickString(parsed, ['machineToken']) || '',
        machineCode: pickString(parsed, ['machineCode']) || '',
        machineType: pickString(parsed, ['machineType']) || '',
      }
      if (!identity.machineToken || !identity.machineCode || !identity.machineType) continue
      identityCache.set(key, { identity, at: Date.now() })
      return identity
    } catch {
      // try the next installation
    }
  }
  return undefined
}

export class QoderAdapter implements Adapter {
  constructor(
    readonly id: AppId,
    private readonly mode: QoderMode,
    private readonly deps: AdapterDeps,
  ) {}

  private get pat(): string {
    return this.deps.store.getPat(this.id)
  }

  private machineId(): string {
    return this.deps.store.machineId
  }

  private exchangeHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'AutoCredit/1.0',
      'Cosy-Version': '1.0.1',
      'Cosy-ClientType': '5',
    }
  }

  private async exchangePat(): Promise<string> {
    if (!this.pat) throw new Error('NO_PAT')
    const response = await request(
      `${ENDPOINTS[this.mode].openApi}/api/v1/jobToken/exchange`,
      {
        method: 'POST',
        headers: this.exchangeHeaders(),
        body: JSON.stringify({ personal_token: this.pat }),
      },
      15_000,
    )
    if (response.status === 401 || response.status === 403) throw new Error('BAD_PAT')
    if (!response.ok) throw new Error(describeHttpError(response, '个人访问令牌交换失败'))
    const body = asRecord(response.json)
    const token = pickString(body, ['token'])
    if (!token) throw new Error('个人访问令牌交换未返回有效令牌')
    return token
  }

  private async userInfo(jobToken: string): Promise<{ id: string; email?: string; name?: string }> {
    const response = await request(
      `${ENDPOINTS[this.mode].openApi}/api/v1/userinfo`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${jobToken}`,
          Accept: 'application/json',
          'User-Agent': 'AutoCredit/1.0',
          'Cosy-Version': '1.0.1',
          'Cosy-ClientType': '5',
        },
      },
      15_000,
    )
    if (response.status === 401 || response.status === 403) throw new Error('BAD_PAT')
    if (!response.ok) throw new Error(describeHttpError(response, '读取 Qoder 账号信息失败'))
    const body = asRecord(response.json)
    return {
      id: pickString(body, ['id']) || '',
      email: pickString(body, ['email']),
      name: pickString(body, ['name', 'username']),
    }
  }

  private sashHeaders(jobToken: string, identity?: MachineIdentity): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${jobToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Cosy-ClientType': '10',
      'Cosy-Version': '1.13.3',
      'Cosy-MachineId': this.machineId(),
      'Cosy-MachineOS': process.arch === 'arm64' ? 'aarch64_windows' : 'x86_64_windows',
      'Cosy-MachineHostname': hostname(),
      'User-Agent': 'Qoder',
    }
    if (identity) {
      headers['Cosy-MachineToken'] = identity.machineToken
      headers['Cosy-MachineCode'] = identity.machineCode
      headers['Cosy-MachineType'] = identity.machineType
    }
    return headers
  }

  private async campaigns(
    jobToken: string,
    identity?: MachineIdentity,
  ): Promise<Campaign[]> {
    const response = await request(
      `${ENDPOINTS[this.mode].openApi}/sash/api/v1/me/campaigns?forceRefresh=true`,
      { method: 'GET', headers: this.sashHeaders(jobToken, identity) },
      15_000,
    )
    if (response.status === 401 || response.status === 403) throw new Error('BAD_PAT')
    if (!response.ok) throw new Error(describeHttpError(response, '读取 Qoder 签到活动失败'))
    const body = asRecord(response.json)
    const list = body?.campaigns
    return Array.isArray(list) ? (list as Campaign[]) : []
  }

  private findDailyCampaign(campaigns: Campaign[]): Campaign | undefined {
    return (
      campaigns.find(
        (item) =>
          item.actionType === 'CLAIM_BENEFIT' &&
          (item.benefit?.kind === 'CREDITS' || item.benefit?.amount === 100),
      ) || campaigns.find((item) => item.actionType === 'CLAIM_BENEFIT')
    )
  }

  private async claim(
    jobToken: string,
    identity: MachineIdentity | undefined,
    campaignId: string,
  ): Promise<Record<string, unknown>> {
    const response = await request(
      `${ENDPOINTS[this.mode].openApi}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`,
      {
        method: 'POST',
        headers: this.sashHeaders(jobToken, identity),
        body: '{}',
      },
      20_000,
    )
    if (response.status === 401 || response.status === 403) throw new Error('BAD_PAT')
    if (!response.ok) throw new Error(describeHttpError(response, '领取 Qoder Credits 失败'))
    return asRecord(response.json) ?? {}
  }

  private errorOutcome(error: unknown, fallback: string): Outcome {
    const message = error instanceof Error ? error.message : fallback
    if (message === 'NO_PAT') {
      return {
        status: 'needs-setup',
        message: '尚未保存 Qoder 个人访问令牌（PAT）',
      }
    }
    if (message === 'BAD_PAT') {
      return {
        status: 'needs-auth',
        message: '个人访问令牌无效或已过期，请重新生成并保存',
      }
    }
    return { status: 'failed', message }
  }

  private async loadContext(): Promise<{
    jobToken: string
    user: { id: string; email?: string; name?: string }
    identity?: MachineIdentity
    campaigns: Campaign[]
  }> {
    const jobToken = await this.exchangePat()
    const user = await this.userInfo(jobToken)
    const identity = user.id ? await resolveMachineIdentity(this.mode, user.id) : undefined
    const campaigns = await this.campaigns(jobToken, identity)
    return { jobToken, user, identity, campaigns }
  }

  readiness(): Readiness {
    if (!this.pat) {
      return {
        ready: false,
        message: `未配置 ${this.mode === 'cn' ? 'Qoder CN' : 'Qoder'} 个人访问令牌`,
      }
    }
    return { ready: true, message: '已保存个人访问令牌' }
  }

  async detect(): Promise<DetectResult> {
    if (!this.pat) {
      return { ok: false, message: '请先保存个人访问令牌（PAT）' }
    }
    try {
      const jobToken = await this.exchangePat()
      const user = await this.userInfo(jobToken)
      return {
        ok: true,
        message: '令牌有效',
        userLabel: user.email || user.name || (user.id ? `用户 ${user.id.slice(-6)}` : undefined),
      }
    } catch (error) {
      const outcome = this.errorOutcome(error, '令牌检测失败')
      return { ok: false, message: outcome.message }
    }
  }

  async probe(): Promise<ProbeResult> {
    try {
      const context = await this.loadContext()
      const campaign = this.findDailyCampaign(context.campaigns)
      if (!campaign?.campaignId) {
        return {
          checkedIn: false,
          status: 'unavailable',
          message: '当前没有可领取的签到活动，可能不在活动期内',
        }
      }
      if (campaign.claimStatus === 'CLAIMED') {
        return {
          checkedIn: true,
          status: 'already',
          message: '今日已领取',
          credits: campaign.benefit?.amount ?? 100,
        }
      }
      if (campaign.claimable === false) {
        return {
          checkedIn: false,
          status: 'unavailable',
          message: '签到窗口尚未开放或今日暂不可领取',
        }
      }
      return {
        checkedIn: false,
        status: 'pending',
        message: '今日待领取',
        credits: campaign.benefit?.amount ?? 100,
      }
    } catch (error) {
      const outcome = this.errorOutcome(error, '读取 Qoder 签到状态失败')
      return {
        checkedIn: false,
        status: outcome.status === 'success' || outcome.status === 'already' ? 'failed' : outcome.status,
        message: outcome.message,
      }
    }
  }

  async checkIn(): Promise<Outcome> {
    try {
      const context = await this.loadContext()
      const campaign = this.findDailyCampaign(context.campaigns)
      if (!campaign?.campaignId) {
        return {
          status: 'unavailable',
          message: '当前没有可领取的签到活动，可能不在活动期内',
        }
      }
      const amount = campaign.benefit?.amount ?? 100
      if (campaign.claimStatus === 'CLAIMED') {
        return { status: 'already', message: '今日已领取，已自动跳过', credits: amount }
      }
      if (campaign.claimable === false) {
        return { status: 'unavailable', message: '签到窗口尚未开放或今日暂不可领取' }
      }
      const result = await this.claim(context.jobToken, context.identity, campaign.campaignId)
      const benefit = asRecord(result.benefit)
      const gained = pickNumber(benefit, ['amount']) ?? amount
      const message = pickString(result, ['message', 'msg'])
      return {
        status: 'success',
        message: message
          ? `领取成功：${message}`
          : gained
            ? `领取成功，+${gained} Credits`
            : '领取成功',
        credits: gained,
      }
    } catch (error) {
      return this.errorOutcome(error, 'Qoder 签到失败')
    }
  }
}
