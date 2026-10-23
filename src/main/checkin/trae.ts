import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import type { DetectResult } from '@shared/types'
import { asRecord, pickNumber, pickString, request } from '../http'
import type { Adapter, AdapterDeps, Outcome, ProbeResult, Readiness } from './types'

const SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155,
  47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76,
  149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
])
const SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181,
  74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235,
  187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
])

interface TraeAuth {
  token: string
  refreshToken?: string
  expiredAt?: number
  refreshExpiredAt?: number
  userId?: string
  host?: string
}

interface TraeStorageInfo {
  auth: TraeAuth
  deviceId?: string
  machineId?: string
  ideVersion?: string
  source: string
}

function storageCandidates(): string[] {
  const roots = [process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')]
  const names = ['TRAE SOLO CN', 'Trae CN', 'Trae', 'TRAE SOLO']
  return roots.flatMap((root) => names.map((name) => join(root, name, 'User', 'globalStorage', 'storage.json')))
}

/** 国际版 trae.ai 没有每日签到，只有中国版 trae.cn 才需要签到。 */
function isInternational(info: TraeStorageInfo): boolean {
  if (info.auth.host) return /trae\.ai/i.test(info.auth.host)
  return !/[\\/](Trae CN|TRAE SOLO CN)[\\/]/.test(info.source)
}

const INTERNATIONAL_MESSAGE = '检测到 Trae 国际版（trae.ai），国际版没有每日签到，无需签到'

function decryptAuthValue(value: string): TraeAuth {
  const buffer = Buffer.from(value, 'base64')
  const header = buffer.subarray(0, 6)
  if (!(header[0] === 0x74 && header[1] === 0x63 && header[2] === 0x05 && header[3] === 0x10)) {
    throw new Error('未知的 Trae 登录态加密格式')
  }
  const randomBytesPart = buffer.subarray(6, 38)
  const encrypted = buffer.subarray(38)
  const salt = Buffer.alloc(64)
  for (let i = 0; i < 64; i += 1) salt[i] = SALT_A[i] ^ SALT_B[i]
  const finalHash = createHash('sha512')
    .update(Buffer.concat([createHash('sha512').update(randomBytesPart).digest(), salt]))
    .digest()
  const decipher = createDecipheriv('aes-128-cbc', finalHash.subarray(0, 16), finalHash.subarray(16, 32))
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  const stored = plain.subarray(0, 64)
  const payload = plain.subarray(64)
  const computed = createHash('sha512').update(payload).digest()
  if (!stored.equals(computed)) throw new Error('Trae 登录态校验失败')
  return JSON.parse(payload.toString('utf8')) as TraeAuth
}

function loadStorage(): TraeStorageInfo | undefined {
  const candidates = storageCandidates()
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  const infos: TraeStorageInfo[] = []
  for (const path of candidates) {
    try {
      const storage = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const raw = storage['iCubeAuthInfo://icube.cloudide']
      if (!raw) continue
      const auth =
        typeof raw === 'string' && raw.trim().startsWith('{')
          ? (JSON.parse(raw) as TraeAuth)
          : decryptAuthValue(String(raw))
      if (!auth.token) continue

      let deviceId: string | undefined
      for (const key of Object.keys(storage)) {
        const match = /^iCubeAuthInfo:\/\/icube-dc:(\d+)$/.exec(key)
        if (match) {
          deviceId = match[1]
          break
        }
      }
      const telemetry = asRecord(storage['telemetry.machineId'])
      const machineId =
        typeof storage['telemetry.machineId'] === 'string'
          ? (storage['telemetry.machineId'] as string)
          : pickString(telemetry, ['machineId'])
      const ideVersion =
        typeof storage['iCubeLastVersion'] === 'string' ? (storage['iCubeLastVersion'] as string) : undefined

      infos.push({ auth, deviceId, machineId, ideVersion, source: path })
    } catch {
      // try the next client
    }
  }
  return infos.find((info) => !isInternational(info)) ?? infos[0]
}

function deviceType(): string {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

function buildHeaders(info: TraeStorageInfo, token: string): Record<string, string> {
  const osInfo =
    process.platform === 'win32'
      ? `Windows ${release()}`
      : process.platform === 'darwin'
        ? `Darwin ${release()}`
        : `Linux ${release()}`
  return {
    Authorization: `Cloud-IDE-JWT ${token}`,
    'X-Cloudide-Token': token,
    'x-uid': String(info.auth.userId ?? ''),
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-device-id': info.deviceId || randomBytes(16).toString('hex'),
    'x-machine-id': info.machineId || randomBytes(32).toString('hex'),
    'x-request-id': randomUUID(),
    'x-ide-version': info.ideVersion || '3.3.67',
    'x-ide-version-code': (info.ideVersion || '20260401').replace(/\./g, ''),
    'x-device-type': deviceType(),
    'x-os-version': osInfo,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

async function exchangeToken(info: TraeStorageInfo): Promise<string | undefined> {
  if (!info.auth.refreshToken) return undefined
  const host = info.auth.host || 'https://api.trae.cn'
  const result = await request(
    `${host}/cloudide/api/v3/trae/oauth/ExchangeToken`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ClientID: 'ono9krqynydwx5',
        RefreshToken: info.auth.refreshToken,
        ClientSecret: '-',
        UserID: String(info.auth.userId ?? ''),
      }),
    },
    15_000,
  )
  const record = asRecord(result.json)
  const section = asRecord(record?.Result)
  return pickString(section, ['Token'])
}

async function withToken<T>(
  info: TraeStorageInfo,
  operation: (token: string) => Promise<{ unauthorized: boolean; value: T }>,
): Promise<T> {
  let token = info.auth.token
  const expiring = !info.auth.expiredAt || info.auth.expiredAt - Date.now() < 30 * 60 * 1000
  if (expiring) {
    const refreshed = await exchangeToken(info).catch(() => undefined)
    if (refreshed) token = refreshed
  }
  let result = await operation(token)
  if (result.unauthorized) {
    const refreshed = await exchangeToken(info).catch(() => undefined)
    if (refreshed) {
      token = refreshed
      result = await operation(token)
    }
  }
  if (result.unauthorized) {
    throw new Error('AUTH_EXPIRED')
  }
  return result.value
}

export class TraeAdapter implements Adapter {
  readonly id = 'trae' as const

  constructor(private readonly deps: AdapterDeps) {}

  readiness(): Readiness {
    const info = loadStorage()
    if (!info) {
      return {
        ready: false,
        message: '未找到本机 Trae 登录态，请先打开并登录 Trae 客户端',
      }
    }
    if (isInternational(info)) {
      return { ready: false, status: 'unavailable', message: INTERNATIONAL_MESSAGE }
    }
    if (info.auth.refreshExpiredAt && info.auth.refreshExpiredAt < Date.now()) {
      return { ready: false, message: 'Trae 登录态已过期，请重新登录客户端' }
    }
    return { ready: true, message: '已连接本机 Trae 登录态' }
  }

  async detect(): Promise<DetectResult> {
    const info = loadStorage()
    if (!info) {
      return { ok: false, message: '未找到本机 Trae 登录态，请先打开并登录 Trae 客户端' }
    }
    if (isInternational(info)) {
      return { ok: true, message: INTERNATIONAL_MESSAGE }
    }
    try {
      const probe = await this.probe()
      if (probe.status === 'needs-auth') {
        return { ok: false, message: probe.message }
      }
      return {
        ok: true,
        message: probe.checkedIn ? '登录态有效，今日已签到' : '登录态有效，今日待签到',
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '检测失败' }
    }
  }

  async probe(): Promise<ProbeResult> {
    const info = loadStorage()
    if (!info) {
      return { checkedIn: false, status: 'needs-setup', message: '未找到本机 Trae 登录态' }
    }
    if (isInternational(info)) {
      return { checkedIn: false, status: 'unavailable', message: INTERNATIONAL_MESSAGE }
    }
    const host = info.auth.host || 'https://api.trae.cn'
    try {
      const outcome = await withToken(info, async (token) => {
        const response = await request(
          `${host}/trae/api/v2/ug/checkin_credits/status`,
          { method: 'POST', headers: buildHeaders(info, token), body: '{}' },
          15_000,
        )
        return { unauthorized: response.status === 401, value: response }
      })
      if (!outcome.ok) {
        return {
          checkedIn: false,
          status: 'failed',
          message: `签到状态读取失败（HTTP ${outcome.status}）`,
        }
      }
      const body = asRecord(outcome.json)
      if (!body || body.code !== 0) {
        const message = pickString(body, ['message']) || '签到状态读取失败'
        return { checkedIn: false, status: 'failed', message }
      }
      const checkedIn = body.checked_in === true
      const credits =
        (pickNumber(body, ['credits']) ?? 0) + (pickNumber(body, ['extra_credits']) ?? 0)
      return {
        checkedIn,
        status: checkedIn ? 'already' : 'pending',
        message: checkedIn ? '今日已签到' : '今日待签到',
        credits: credits > 0 ? credits : undefined,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '检测失败'
      if (message === 'AUTH_EXPIRED') {
        return {
          checkedIn: false,
          status: 'needs-auth',
          message: 'Trae 登录态已过期，请重新打开并登录 Trae 客户端',
        }
      }
      return { checkedIn: false, status: 'failed', message: `网络请求失败：${message}` }
    }
  }

  async checkIn(): Promise<Outcome> {
    const info = loadStorage()
    if (!info) {
      return { status: 'needs-setup', message: '未找到本机 Trae 登录态，请先登录 Trae 客户端' }
    }
    if (isInternational(info)) {
      return { status: 'unavailable', message: INTERNATIONAL_MESSAGE }
    }
    const host = info.auth.host || 'https://api.trae.cn'
    try {
      return await withToken<Outcome>(info, async (token) => {
        const statusResponse = await request(
          `${host}/trae/api/v2/ug/checkin_credits/status`,
          { method: 'POST', headers: buildHeaders(info, token), body: '{}' },
          15_000,
        )
        if (statusResponse.status === 401) {
          return { unauthorized: true, value: { status: 'needs-auth' as const, message: '登录态失效' } }
        }
        const statusBody = asRecord(statusResponse.json)
        if (!statusResponse.ok || !statusBody || statusBody.code !== 0) {
          return {
            unauthorized: false,
            value: {
              status: 'failed' as const,
              message: pickString(statusBody, ['message']) || `签到状态读取失败（HTTP ${statusResponse.status}）`,
            },
          }
        }
        if (statusBody.checked_in === true) {
          const credits =
            (pickNumber(statusBody, ['credits']) ?? 0) + (pickNumber(statusBody, ['extra_credits']) ?? 0)
          return {
            unauthorized: false,
            value: {
              status: 'already' as const,
              message: '今日已签到，已自动跳过',
              credits: credits > 0 ? credits : undefined,
            },
          }
        }

        const claimResponse = await request(
          `${host}/trae/api/v2/ug/checkin_credits/claim`,
          { method: 'POST', headers: buildHeaders(info, token), body: '{}' },
          20_000,
        )
        if (claimResponse.status === 401) {
          return { unauthorized: true, value: { status: 'needs-auth' as const, message: '登录态失效' } }
        }
        const claimBody = asRecord(claimResponse.json)
        if (!claimResponse.ok || !claimBody || claimBody.code !== 0) {
          return {
            unauthorized: false,
            value: {
              status: 'failed' as const,
              message:
                pickString(claimBody, ['message']) || `签到失败（HTTP ${claimResponse.status}）`,
            },
          }
        }
        const gained =
          pickNumber(claimBody, ['gained_credits', 'credits_gained', 'reward', 'extra_credits', 'credits']) ??
          undefined
        return {
          unauthorized: false,
          value: {
            status: 'success' as const,
            message: gained ? `签到成功，+${gained} 积分` : '签到成功',
            credits: gained,
          },
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '签到失败'
      if (message === 'AUTH_EXPIRED') {
        return {
          status: 'needs-auth',
          message: 'Trae 登录态已过期，请重新打开并登录 Trae 客户端',
        }
      }
      return { status: 'failed', message: `网络请求失败：${message}` }
    }
  }
}
