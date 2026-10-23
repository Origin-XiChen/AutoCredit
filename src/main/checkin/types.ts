import type { AppId, DetectResult } from '@shared/types'
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
}

export interface Adapter {
  readonly id: AppId
  readiness(): Readiness
  detect(): Promise<DetectResult>
  probe(): Promise<ProbeResult>
  checkIn(): Promise<Outcome>
}

export interface AdapterDeps {
  store: Store
}
