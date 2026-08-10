/**
 * Клиент контракта для окна — собирается по спискам, а не пишется руками.
 *
 * В рендерере не должно остаться ни одного строкового литерала канала: имена
 * живут в `IPC_CALLS`/`IPC_EVENTS`, и всё, что не оттуда, попросту не
 * существует. Строка, набранная в компоненте, обнаружилась бы через полгода
 * повисшим `invoke` без ответа.
 *
 * Функция чистая и от Electron не зависит — `invoke` и `on` приходят снаружи.
 * Так проверка «клиент обслуживает ровно контракт» выполняется тестом, а не
 * запуском приложения.
 */
import {
  IPC_CALLS,
  IPC_EVENTS,
  type IpcCallName,
  type IpcCalls,
  type IpcEventName,
  type IpcEvents,
} from '@agentmeter/ipc'

export type AgentmeterApi = {
  [K in IpcCallName]: (arg: IpcCalls[K]['arg']) => Promise<IpcCalls[K]['result']>
} & {
  [K in IpcEventName as `on:${K}`]: (listener: (payload: IpcEvents[K]) => void) => () => void
}

export function createClient(
  invoke: (channel: string, arg: unknown) => Promise<unknown>,
  on: (channel: string, listener: (payload: unknown) => void) => () => void,
): AgentmeterApi {
  const api: Record<string, unknown> = {}
  for (const name of IPC_CALLS) {
    api[name] = (arg: unknown) => invoke(name, arg)
  }
  for (const name of IPC_EVENTS) {
    api[`on:${name}`] = (listener: (payload: unknown) => void) => on(name, listener)
  }
  return api as AgentmeterApi
}
