import { closeSync, openSync, readSync } from 'node:fs'

export interface JsonlReadResult {
  lines: string[]
  offset: number
}

/**
 * Читает JSONL без квадратичного пересканирования длинной строки.
 *
 * Хвост без `\n` включается только для полного разбора файла: живой лог может
 * быть оборван на последней записи, но уже закрытый однострочный роллаут надо
 * отдать парсеру целиком.
 */
export function readJsonlLines(path: string, includeTrailingLine: boolean): JsonlReadResult {
  const fd = openSync(path, 'r')
  const lines: string[] = []
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const carry: Buffer[] = []
  let carryBytes = 0
  let fileOffset = 0
  let completeOffset = 0

  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, fileOffset)
      if (bytesRead === 0) break

      const chunk = Buffer.from(buffer.subarray(0, bytesRead))
      fileOffset += bytesRead
      let start = 0

      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] !== 0x0a) continue
        const segment = chunk.subarray(start, i)
        lines.push(lineToString(carry, carryBytes, segment))
        carry.length = 0
        carryBytes = 0
        completeOffset = fileOffset - chunk.length + i + 1
        start = i + 1
      }

      if (start < chunk.length) {
        const tail = chunk.subarray(start)
        carry.push(tail)
        carryBytes += tail.length
      }
    }

    if (includeTrailingLine && carryBytes > 0) {
      lines.push(stripCr(Buffer.concat(carry, carryBytes).toString('utf8')))
      completeOffset = fileOffset
    }
  } finally {
    closeSync(fd)
  }

  return { lines, offset: completeOffset }
}

function lineToString(carry: Buffer[], carryBytes: number, segment: Buffer): string {
  if (carryBytes === 0) return stripCr(segment.toString('utf8'))
  if (segment.length > 0) carry.push(segment)
  const line = Buffer.concat(carry, carryBytes + segment.length).toString('utf8')
  if (segment.length > 0) carry.pop()
  return stripCr(line)
}

/**
 * `\r` снимается со всей строки, а не сравнением с предыдущим байтом куска:
 * при чтении по 64 КБ пара `\r\n` может разъехаться по границе куска, и тогда
 * `\r` остаётся в переносе, а не в текущем куске. Для CR перед `\n` это
 * равносильно, а перепутать с началом UTF-8 нельзя — 0x0d чисто ASCII.
 */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
