/**
 * Мост в окно. Наружу уезжает ровно один объект, собранный по контракту.
 *
 * `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — окно
 * показывает содержимое домашних каталогов пользователя, и давать ему доступ к
 * `require` незачем. Из-за песочницы этот файл собирается в CommonJS отдельной
 * сборкой: ESM-preload в песочнице Electron не поддерживается.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { createClient } from './client.ts'

const client = createClient(
  (channel, arg) => ipcRenderer.invoke(channel, arg),
  (channel, listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      listener(payload)
    }
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.off(channel, wrapped)
    }
  },
)

contextBridge.exposeInMainWorld('agentmeter', client)
