// Настоящий клик мышью по экранным координатам (в точках, начало отсчёта слева сверху).
// Нужен потому, что System Events «click at» на этой macOS молча не работает, а системные
// диалоги выбора файла живут в отдельном процессе и кликабельны только настоящим событием.
// Использование: clicker <x> <y> [1|2]   где 2 = двойной клик
import CoreGraphics
import Foundation
let a = CommandLine.arguments
guard a.count >= 3, let x = Double(a[1]), let y = Double(a[2]) else { print("нужны x y"); exit(1) }
let clicks = a.count > 3 ? Int(a[3]) ?? 1 : 1
let p = CGPoint(x: x, y: y)
let src = CGEventSource(stateID: .hidSystemState)
CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(200_000)
for i in 1...clicks {
  let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)
  let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)
  down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
  up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
  down?.post(tap: .cghidEventTap); usleep(60_000)
  up?.post(tap: .cghidEventTap); usleep(60_000)
}
print("клик \(clicks)x в (\(Int(x)), \(Int(y)))")
