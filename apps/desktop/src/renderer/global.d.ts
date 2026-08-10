import type { AgentmeterApi } from '../preload/client.ts'

// Единственный мост в окно. Всё, что не в контракте, до рендерера не доезжает.

declare global {
  interface Window {
    agentmeter: AgentmeterApi
  }
}

export {}
