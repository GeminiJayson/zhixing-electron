import type { ZhixingApi } from './index'

declare global {
  interface Window {
    zhixing: ZhixingApi
  }
}

export {}
