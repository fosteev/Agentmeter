// Значок в menu bar на macOS — нативным пунктом, а не `Tray` из Electron.
//
// Почему отдельный процесс на Swift, хотя в Electron ровно для этого есть
// `Tray`. На macOS 26 пункт, созданный Electron 43, в панель не встаёт: система
// паркует его за нижней кромкой экрана. Замерено тремя способами — `getBounds()`
// у Electron отдаёт `y = 1117` при высоте экрана 1117, Accessibility показывает
// ту же координату у процесса, и там же оказываются пункты **всех** Electron-
// приложений на машине (Cursor, Docker Desktop), тогда как нативные соседи
// стоят на панели. Дело не в картинке: пункт без картинки вовсе, одним текстом,
// уезжает туда же. Нативный `NSStatusItem` в тех же условиях встаёт нормально —
// с этого спайка всё и началось.
//
// **Рисование сюда не переехало.** Растр по-прежнему считает `tray-icon.ts`,
// где он сверен с токенами макета юнит-тестами; хелпер получает готовый PNG.
// Иначе геометрия иконки жила бы в двух местах на двух языках и разъехалась бы
// на первой же правке макета.
//
// Протокол — JSON построчно: stdin команды, stdout события. Ни сокета, ни
// файла: процесс запущен родителем, и его же каналы — самый короткий путь,
// который заодно умирает вместе с приложением.
import Cocoa

// MARK: - Протокол

/// Команда от приложения. Поле `t` — тип, остальные по типу.
struct Command: Decodable {
  let t: String
  /// PNG иконки в base64. Растр отрисован под ретину, поэтому размер в точках
  /// задаётся отдельно — иначе AppKit покажет 32-точечную картинку 32 точками.
  let png: String?
  let points: Double?
  let template: Bool?
  let tooltip: String?
  let items: [MenuItem]?
}

struct MenuItem: Decodable {
  /// `id` пункта; `nil` — разделитель.
  let id: String?
  let title: String?
}

/// Событие приложению. Пишется одной строкой и сразу сбрасывается.
private func emit(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload),
    let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

// MARK: - Пункт в панели

final class Bar: NSObject {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var menuItems: [MenuItem] = []

  override init() {
    super.init()
    guard let button = item.button else { return }
    button.target = self
    button.action = #selector(clicked)
    // Оба клика на одну кнопку: правым открывается меню, левым — попап.
    // `item.menu` не заводится намеренно — он перехватывает и левый тоже, а
    // левым открывается главное, ради чего значок в панели и стоит.
    button.sendAction(on: [.leftMouseUp, .rightMouseUp])
  }

  /// Рамка пункта в координатах Electron: начало в левом верхнем углу главного
  /// экрана, `y` растёт вниз. AppKit считает снизу вверх, и без перевода попап
  /// открывался бы у нижней кромки экрана.
  private func frame() -> [String: Double] {
    guard let window = item.button?.window else { return [:] }
    let rect = window.frame
    let top = NSScreen.screens.first?.frame.maxY ?? rect.maxY
    return [
      "x": rect.origin.x,
      "y": top - rect.maxY,
      "width": rect.width,
      "height": rect.height,
    ]
  }

  @objc private func clicked() {
    let right = NSApp.currentEvent?.type == .rightMouseUp
    if right {
      showMenu()
      return
    }
    emit(["t": "click", "frame": frame()])
  }

  private func showMenu() {
    let menu = NSMenu()
    for entry in menuItems {
      guard let id = entry.id, let title = entry.title else {
        menu.addItem(.separator())
        continue
      }
      let item = NSMenuItem(title: title, action: #selector(chose(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = id
      menu.addItem(item)
    }
    // Меню показывается кнопке, а не через `item.menu`: так пункт подсвечивается
    // на время показа и гаснет сам, без ручного снятия выделения.
    item.menu = menu
    item.button?.performClick(nil)
    item.menu = nil
  }

  @objc private func chose(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    emit(["t": "menu", "id": id])
  }

  func apply(_ command: Command) {
    switch command.t {
    case "icon":
      if let base64 = command.png, let data = Data(base64Encoded: base64),
        let image = NSImage(data: data)
      {
        let points = command.points ?? 16
        image.size = NSSize(width: points, height: points)
        image.isTemplate = command.template ?? true
        item.button?.image = image
      }
      if let tooltip = command.tooltip { item.button?.toolTip = tooltip }
      // Рамка пересылается после каждой иконки, и это не избыточность: до
      // первой картинки кнопка нулевой высоты, система пункт не размещает, и
      // рамка на старте бессмысленна. Попапу же якорь нужен до первого клика —
      // открыться его могут попросить и с другой стороны (второй запуск
      // приложения). Дать разметке дойти до конца — отсюда шаг очереди.
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        emit(["t": "frame", "frame": self.frame()])
      }
    case "menu":
      menuItems = command.items ?? []
    case "quit":
      NSApp.terminate(nil)
    default:
      break
    }
  }

  func ready() {
    emit(["t": "ready", "frame": frame()])
  }
}

// MARK: - Запуск

let app = NSApplication.shared
// Ни иконки в доке, ни меню приложения: процесс — деталь чужого приложения, и
// вторая иконка в доке у него означала бы, что запущено два.
app.setActivationPolicy(.accessory)

let bar = Bar()

// stdin читается по строкам в фоне, применяется на главном потоке: AppKit
// трогать из чужого потока нельзя, а закрытый канал означает, что родитель
// умер — тогда уходим и мы, иначе значок пережил бы приложение.
let input = FileHandle.standardInput
var pending = Data()
input.readabilityHandler = { handle in
  let chunk = handle.availableData
  if chunk.isEmpty {
    DispatchQueue.main.async { NSApp.terminate(nil) }
    return
  }
  pending.append(chunk)
  while let end = pending.firstIndex(of: UInt8(ascii: "\n")) {
    let line = pending.subdata(in: pending.startIndex..<end)
    pending = pending.subdata(in: pending.index(after: end)..<pending.endIndex)
    guard let command = try? JSONDecoder().decode(Command.self, from: line) else { continue }
    DispatchQueue.main.async { bar.apply(command) }
  }
}

DispatchQueue.main.async { bar.ready() }
app.run()
