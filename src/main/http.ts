export interface HttpResult {
  status: number
  ok: boolean
  text: string
  json: unknown
}

export async function request(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<HttpResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let json: unknown = undefined
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    return { status: response.status, ok: response.ok, text, json }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function pickNumber(value: unknown, keys: string[]): number | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw))) return Number(raw)
  }
  return undefined
}

export function pickString(value: unknown, keys: string[]): string | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim()) return raw
  }
  return undefined
}

export function describeHttpError(result: HttpResult, fallback: string): string {
  const record = asRecord(result.json)
  const message =
    pickString(record, ['message', 'msg', 'error', 'detail']) ||
    pickString(asRecord(record?.data), ['message', 'msg', 'error']) ||
    result.text.slice(0, 160)
  return `${fallback}（HTTP ${result.status}）${message ? `：${message}` : ''}`
}
