import type { AutoCreditApi } from '@shared/types'

declare global {
  interface Window {
    autoCredit: AutoCreditApi
  }
}

export {}
