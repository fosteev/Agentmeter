/**
 * Регистрация обработчиков по списку контракта.
 *
 * Ни одного строкового имени канала здесь нет: имена приходят из `IPC_CALLS`,
 * а тип `Handlers` требует обработчик на каждое. Забыть канал нельзя — не
 * соберётся; добавить лишний нельзя — его нет в списке. Незарегистрированный
 * канал давал бы в рендерере повисший `invoke` без ответа и без ошибки, то есть
 * худшую из возможных заглушек.
 *
 * `ipcMain` приходит параметром, а не импортом: так проверка «обслужены все
 * каналы» выполняется обычным тестом, без запуска Electron.
 */
import { IPC_CALLS, type IpcCallName, type IpcCalls } from '@agentmeter/ipc'

export type IpcHandlers = {
  [K in IpcCallName]: (
    arg: IpcCalls[K]['arg'],
  ) => IpcCalls[K]['result'] | Promise<IpcCalls[K]['result']>
}

/**
 * Ровно та часть `ipcMain`, которой пользуется этот модуль. `any` здесь не
 * лень: у самого Electron обработчик объявлен как
 * `(event: IpcMainInvokeEvent, ...args: any[]) => any`, и любая попытка сузить
 * тип на границе делает настоящий `ipcMain` неприсваиваемым. Типизация,
 * ради которой этот файл существует, живёт не тут, а в `IpcHandlers`.
 */
export interface IpcMainLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, listener: (...args: any[]) => unknown): void
}

export function registerIpc(ipcMain: IpcMainLike, handlers: IpcHandlers): void {
  for (const name of IPC_CALLS) {
    ipcMain.handle(name, (_event: unknown, arg: never) => handlers[name](arg))
  }
}
