import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface NotificationState {
  suppressed: boolean
  state: number
  reason: string
}

let cached: { value: NotificationState; at: number } | undefined

const REASONS: Record<number, string> = {
  1: '屏幕已锁定或暂无前台用户',
  2: '系统处于忙碌状态',
  3: '检测到全屏应用或游戏',
  4: '检测到演示模式',
  6: '系统处于静音时间',
  7: '检测到全屏应用',
}

export async function getNotificationState(force = false): Promise<NotificationState> {
  if (!force && cached && Date.now() - cached.at < 2500) {
    return cached.value
  }

  const fallback: NotificationState = { suppressed: false, state: 0, reason: '' }
  if (process.platform !== 'win32') {
    return fallback
  }

  const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  const script = [
    "Add-Type -Namespace AutoCredit -Name Native -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern int SHQueryUserNotificationState(out int state);';",
    '$s = 0;',
    '[AutoCredit.Native]::SHQueryUserNotificationState([ref]$s) | Out-Null;',
    'Write-Output $s',
  ].join(' ')

  try {
    const { stdout } = await execFileAsync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 4000, windowsHide: true, encoding: 'utf8' },
    )
    const state = Number.parseInt(String(stdout).trim(), 10)
    if (!Number.isFinite(state)) return fallback
    const value: NotificationState = {
      suppressed: state === 1 || state === 2 || state === 3 || state === 4 || state === 6 || state === 7,
      state,
      reason: REASONS[state] ?? '',
    }
    cached = { value, at: Date.now() }
    return value
  } catch {
    return fallback
  }
}
