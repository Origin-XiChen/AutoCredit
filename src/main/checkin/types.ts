import type { AppId, DetectResult, LocateResult, RunStatus } from '@shared/types'
import type { Store } from '../store'

export type OutcomeStatus =
  | 'success'
  | 'already'
  | 'pending'
  | 'failed'
  | 'needs-auth'
  | 'needs-setup'
  | 'unavailable'

export interface Outcome {
  status: OutcomeStatus
  message: string
  credits?: number
}

export interface ProbeResult extends Outcome {
  checkedIn: boolean
}

export interface Readiness {
  ready: boolean
  message: string
  status?: RunStatus
}

export interface Adapter {
  readonly id: AppId
  readiness(): Readiness
  detect(): Promise<DetectResult>
  probe(): Promise<ProbeResult>
  checkIn(): Promise<Outcome>
  /** 自动搜索本机程序或登录态路径，供设置页手动修正。 */
  locate?(): LocateResult
}

export interface AdapterDeps {
  store: Store
}
