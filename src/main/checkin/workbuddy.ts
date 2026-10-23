import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DetectResult } from '@shared/types'
import { asRecord, pickNumber, pickString, request } from '../http'
import type { Adapter, AdapterDeps, Outcome, ProbeResult, Readiness } from './types'

interface Credential {
  token: string
  uid: string
  domain: string
  expiresAt?: number
  source: string
}

/** 国际版 WorkBuddy 没有每日签到，只有中国版（codebuddy.cn）才需要签到。 */
function isInternationalDomain(domain: string): boolean {
  return !/\.cn$/i.test(domain)
}

const INTERNATIONAL_MESSAGE = '检测到 WorkBuddy 国际版，国际版没有每日签到，无需签到'

const HELPER = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
function parseEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (value.$wbEncrypted !== 1 || typeof value.envelope !== 'string') return;
  let inner;
  try { inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8')); } catch { return; }
  const nonce = Buffer.from(inner.nonce, 'base64');
  const authTag = Buffer.from(inner.authTag, 'base64');
  const ciphertext = Buffer.from(inner.ciphertext, 'base64');
  if (nonce.length !== 12 || authTag.length !== 16 || !ciphertext.length) return;
  return { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext };
}
function aad(keyId, suite) {
  const lp = (v) => { const b = Buffer.from(v, 'utf8'); const h = Buffer.allocUnsafe(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
  const s = Buffer.allocUnsafe(4); s.writeUInt32BE(suite);
  return Buffer.concat([Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]), lp('WBEV1'), lp('sym-v1'), s, lp(keyId), Buffer.from([2]), Buffer.from([0]), Buffer.from([0])]);
}
try {
  const file = process.argv[2];
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const auth = doc.auth || {};
  const account = doc.account || {};
  let token = auth.accessToken;
  if (token && typeof token === 'object') {
    const raw = String(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
    const payload = JSON.parse(raw);
    const key = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
    const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    const env = parseEnvelope(token);
    if (!env) throw new Error('credential envelope is invalid');
    if (env.keyId !== keyId) throw new Error('credential key does not match this client');
    const d = crypto.createDecipheriv('aes-256-gcm', key, env.nonce, { authTagLength: 16 });
    d.setAAD(aad(env.keyId, env.suite));
    d.setAuthTag(env.authTag);
    token = Buffer.concat([d.update(env.ciphertext), d.final()]).toString('utf8');
  }
  if (typeof token !== 'string' || !token) throw new Error('no access token');
  process.stdout.write(JSON.stringify({
    token,
    uid: String(account.uid || auth.uid || ''),
    domain: String(auth.domain || 'www.codebuddy.cn'),
    expiresAt: Number(auth.expiresAt) || undefined,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error && error.message ? error.message : 'decrypt failed' }));
}
`

interface CachedCredential {
  credential: Credential
  at: number
  mtimeMs: number
}

export class WorkBuddyAdapter implements Adapter {
  readonly id = 'workbuddy' as const
  private cache: CachedCredential | undefined

  constructor(private readonly deps: AdapterDeps) {}

  private credentialCandidates(): string[] {
    const local = process.env.LOCALAPPDATA || ''
    const roaming = process.env.APPDATA || ''
    return [
      join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
      join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    ]
  }

  private findCredentialFile(): string | undefined {
    return this.credentialCandidates()
      .filter((path) => existsSync(path))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  }

  private findExecutable(): string | undefined {
    const local = process.env.LOCALAPPDATA || ''
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const candidates = [
      join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      join(programFiles, 'WorkBuddy', 'WorkBuddy.exe'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    try {
      for (const root of [join(local, 'Programs'), programFiles]) {
        for (const name of readdirSync(root)) {
          if (!/workbuddy/i.test(name)) continue
          const candidate = join(root, name, 'WorkBuddy.exe')
          if (existsSync(candidate)) return candidate
        }
      }
    } catch {
      // ignore
    }
    return undefined
  }

  private ensureHelper(): string {
    const dir = join(this.deps.store.dataDir, 'runtime')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'wb-decrypt.cjs')
    try {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== HELPER) {
        writeFileSync(path, HELPER, 'utf8')
      }
    } catch {
      // ignore, spawn will fail with a clear message
    }
    return path
  }

  private async decryptViaClient(file: string): Promise<Credential> {
    const exe = this.findExecutable()
    if (!exe) throw new Error('未找到 WorkBuddy 客户端安装目录')
    const helper = this.ensureHelper()
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(exe, [helper, file], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('读取 WorkBuddy 登录态超时'))
      }, 15_000)
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
        if (code !== 0 && !stdout) {
          reject(new Error(stderr.trim() || `WorkBuddy helper exited with ${code}`))
          return
        }
        resolve(stdout)
      })
    })
    const parsed = asRecord(JSON.parse(output.trim()))
    if (!parsed) throw new Error('WorkBuddy 登录态解析失败')
    if (parsed.error) throw new Error(String(parsed.error))
    const token = pickString(parsed, ['token'])
    if (!token) throw new Error('WorkBuddy 登录态中没有可用的访问令牌')
    return {
      token,
      uid: pickString(parsed, ['uid']) || '',
      domain: pickString(parsed, ['domain']) || 'www.codebuddy.cn',
      expiresAt: pickNumber(parsed, ['expiresAt']),
      source: file,
    }
  }

  private async readCredential(force = false): Promise<Credential | undefined> {
    const file = this.findCredentialFile()
    if (!file) return undefined
    const mtimeMs = statSync(file).mtimeMs
    if (
      !force &&
      this.cache &&
      this.cache.mtimeMs === mtimeMs &&
      Date.now() - this.cache.at < 10 * 60 * 1000
    ) {
      return this.cache.credential
    }

    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const auth = asRecord(doc.auth) ?? {}
    const account = asRecord(doc.account) ?? doc.account
    const uid = pickString(account, ['uid', 'id']) || ''
    const domain = pickString(auth, ['domain']) || 'www.codebuddy.cn'
    const expiresAt = pickNumber(auth, ['expiresAt'])
    const rawToken = auth.accessToken

    let credential: Credential
    if (typeof rawToken === 'string' && rawToken) {
      credential = { token: rawToken, uid, domain, expiresAt, source: file }
    } else {
      credential = await this.decryptViaClient(file)
    }
    this.cache = { credential, at: Date.now(), mtimeMs }
    return credential
  }

  private headers(credential: Credential): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${credential.token}`,
      'x-user-id': credential.uid,
      'x-domain': credential.domain,
      'User-Agent': 'AutoCredit/1.0',
    }
  }

  private api(credential: Credential, path: string): string {
    return `https://${credential.domain}${path}`
  }

  private async status(credential: Credential): Promise<{ ok: boolean; checkedIn: boolean; credits?: number; unauthorized: boolean; message: string }> {
    const response = await request(
      this.api(credential, '/v2/billing/meter/checkin-activity-status'),
      { method: 'POST', headers: this.headers(credential), body: '{}' },
      15_000,
    )
    const body = asRecord(response.json)
    if (response.status === 401 || response.status === 403) {
      return { ok: false, checkedIn: false, unauthorized: true, message: 'WorkBuddy 登录态已失效' }
    }
    if (!response.ok || !body) {
      return {
        ok: false,
        checkedIn: false,
        unauthorized: false,
        message:
          pickString(body, ['message', 'msg']) || `WorkBuddy 状态读取失败（HTTP ${response.status}）`,
      }
    }
    if (body.code !== undefined && body.code !== 0 && body.code !== '0') {
      return {
        ok: false,
        checkedIn: false,
        unauthorized: false,
        message: pickString(body, ['message', 'msg']) || 'WorkBuddy 状态读取失败',
      }
    }
    const data = asRecord(body.data) ?? body
    const checkedIn =
      data.today_checked_in === true ||
      data.checked_in === true ||
      data.checkedIn === true ||
      data.todayCheckedIn === true
    return {
      ok: true,
      checkedIn,
      credits: pickNumber(data, ['daily_credit', 'today_credit', 'credit', 'credits']),
      unauthorized: false,
      message: checkedIn ? '今日已签到' : '今日待签到',
    }
  }

  readiness(): Readiness {
    const file = this.findCredentialFile()
    if (!file) {
      return { ready: false, message: '未找到 WorkBuddy 登录态，请先打开并登录 WorkBuddy' }
    }
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const auth = asRecord(doc.auth) ?? {}
      const domain = pickString(auth, ['domain']) || 'www.codebuddy.cn'
      if (isInternationalDomain(domain)) {
        return { ready: false, status: 'unavailable', message: INTERNATIONAL_MESSAGE }
      }
      const expiresAt = pickNumber(auth, ['expiresAt'])
      if (expiresAt && expiresAt < Date.now()) {
        return { ready: false, message: 'WorkBuddy 登录态已过期，请重新打开客户端' }
      }
    } catch {
      // decrypt step below will report the real error
    }
    return { ready: true, message: '已连接本机 WorkBuddy 登录态' }
  }

  async detect(): Promise<DetectResult> {
    try {
      const credential = await this.readCredential(true)
      if (!credential) {
        return { ok: false, message: '未找到 WorkBuddy 登录态，请先打开并登录 WorkBuddy' }
      }
      if (isInternationalDomain(credential.domain)) {
        return { ok: true, message: INTERNATIONAL_MESSAGE }
      }
      if (credential.expiresAt && credential.expiresAt < Date.now()) {
        return { ok: false, message: 'WorkBuddy 登录态已过期，请重新打开客户端' }
      }
      const status = await this.status(credential)
      if (status.unauthorized) return { ok: false, message: status.message }
      return {
        ok: true,
        message: status.ok
          ? status.checkedIn
            ? '登录态有效，今日已签到'
            : '登录态有效，今日待签到'
          : '登录态已读取，稍后自动签到',
        userLabel: credential.uid ? `用户 ${credential.uid.slice(-6)}` : undefined,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取 WorkBuddy 登录态失败' }
    }
  }

  async probe(): Promise<ProbeResult> {
    try {
      const credential = await this.readCredential()
      if (!credential) {
        return { checkedIn: false, status: 'needs-setup', message: '未找到 WorkBuddy 登录态' }
      }
      if (isInternationalDomain(credential.domain)) {
        return { checkedIn: false, status: 'unavailable', message: INTERNATIONAL_MESSAGE }
      }
      if (credential.expiresAt && credential.expiresAt < Date.now()) {
        return {
          checkedIn: false,
          status: 'needs-auth',
          message: 'WorkBuddy 登录态已过期，请重新打开客户端',
        }
      }
      const status = await this.status(credential)
      if (status.unauthorized) {
        return { checkedIn: false, status: 'needs-auth', message: status.message }
      }
      if (!status.ok) {
        return { checkedIn: false, status: 'failed', message: status.message }
      }
      return {
        checkedIn: status.checkedIn,
        status: status.checkedIn ? 'already' : 'pending',
        message: status.message,
        credits: status.credits,
      }
    } catch (error) {
      return {
        checkedIn: false,
        status: 'needs-setup',
        message: error instanceof Error ? error.message : '读取 WorkBuddy 登录态失败',
      }
    }
  }

  async checkIn(): Promise<Outcome> {
    try {
      const credential = await this.readCredential()
      if (!credential) {
        return { status: 'needs-setup', message: '未找到 WorkBuddy 登录态，请先登录 WorkBuddy 客户端' }
      }
      if (isInternationalDomain(credential.domain)) {
        return { status: 'unavailable', message: INTERNATIONAL_MESSAGE }
      }
      if (credential.expiresAt && credential.expiresAt < Date.now()) {
        return { status: 'needs-auth', message: 'WorkBuddy 登录态已过期，请重新打开客户端' }
      }

      const status = await this.status(credential)
      if (status.unauthorized) {
        return { status: 'needs-auth', message: status.message }
      }
      if (status.ok && status.checkedIn) {
        return {
          status: 'already',
          message: '今日已签到，已自动跳过',
          credits: status.credits,
        }
      }

      const response = await request(
        this.api(credential, '/v2/billing/meter/daily-checkin'),
        { method: 'POST', headers: this.headers(credential), body: '{}' },
        20_000,
      )
      if (response.status === 401 || response.status === 403) {
        return { status: 'needs-auth', message: 'WorkBuddy 登录态已失效，请重新打开客户端' }
      }
      const body = asRecord(response.json)
      const data = asRecord(body?.data) ?? body
      const message = pickString(body, ['message', 'msg']) || ''
      if (message && /已签到|已经签到|already/i.test(message)) {
        return { status: 'already', message: '今日已签到，已自动跳过' }
      }
      const success =
        response.ok &&
        body &&
        (body.code === 0 || body.code === '0' || body.success === true || body.ret === 0)
      if (!success) {
        return {
          status: 'failed',
          message: message || `WorkBuddy 签到失败（HTTP ${response.status}）`,
        }
      }
      const credits = pickNumber(data, ['daily_credit', 'credit', 'credits', 'reward_amount', 'amount'])
      return {
        status: 'success',
        message: credits ? `签到成功，+${credits} 积分` : '签到成功',
        credits,
      }
    } catch (error) {
      return {
        status: 'failed',
        message: `WorkBuddy 签到失败：${error instanceof Error ? error.message : '未知错误'}`,
      }
    }
  }
}
