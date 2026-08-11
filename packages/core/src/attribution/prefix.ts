import { PREFIX_BYTES_PER_TOKEN } from './calibration.ts'
import type { PrefixBlock, PrefixCategory, Request, Session } from '../sources/types.ts'

export interface PrefixOptions {
  bytesPerToken?: Partial<Record<PrefixCategory, number>>
}

const CATEGORY_ORDER: PrefixCategory[] = [
  'system',
  'toolSchemas',
  'deferredTools',
  'mcpTools',
  'mcpInstructions',
  'skills',
  'agents',
  'memory',
  'userTurn',
]

/**
 * Раскладывает измеренный первый контекст. Видимые блоки оцениваются по
 * байтам, а всё не попавшее в лог остаётся честным измеренным остатком.
 */
export function attributePrefix(
  session: Session,
  requests: Request[],
  options: PrefixOptions = {},
): PrefixBlock[] {
  const firstRequest = requests.find((request) => request.origin === 'log')
  session.prefixTokens = firstRequest?.contextTokens ?? 0

  const ratios = { ...PREFIX_BYTES_PER_TOKEN, ...options.bytesPerToken }
  const visible = session.prefixBlocks.filter((block) => block.basis === 'estimated')
  const estimated = visible.some((block) => block.tokens !== 0)
    ? aggregateEstimated(visible)
    : estimateRawBlocks(visible, ratios)
  const estimatedTokens = estimated.reduce((sum, block) => sum + block.tokens, 0)
  const residualCategory = session.provider === 'codex' ? 'toolSchemas' : 'system'
  const residual: PrefixBlock = {
    category: residualCategory,
    bytes: 0,
    tokens: session.prefixTokens - estimatedTokens,
    basis: 'residual',
    // Ноль, а не единица: остаток — это системный промпт и схемы вшитых тулов,
    // он не состоит из перечислимых штук, и «1 штука» была бы утверждением.
    items: 0,
  }

  session.prefixBlocks = sortBlocks([...estimated, residual])
  return session.prefixBlocks
}

function estimateRawBlocks(
  blocks: PrefixBlock[],
  ratios: Record<PrefixCategory, number>,
): PrefixBlock[] {
  const names = blocks.filter(
    (block) => block.category === 'deferredTools' || block.category === 'mcpTools',
  )
  const instructions = blocks.filter((block) => block.category === 'mcpInstructions')
  const ordinary = blocks.filter(
    (block) =>
      block.category !== 'deferredTools' &&
      block.category !== 'mcpTools' &&
      block.category !== 'mcpInstructions',
  )

  const result = aggregateEstimated(ordinary).map((block) => ({
    ...block,
    tokens: Math.round(block.bytes / ratios[block.category]),
  }))
  result.push(...estimateJoined(names, 1, ratios.deferredTools))
  result.push(...estimateJoined(instructions, 2, ratios.mcpInstructions))
  return aggregateEstimated(result)
}

/** Разделители влияют на цену блока, но не приписываются отдельному серверу. */
function estimateJoined(
  blocks: PrefixBlock[],
  separatorBytes: number,
  ratio: number,
): PrefixBlock[] {
  if (blocks.length === 0) return []
  const bytes = blocks.reduce((sum, block) => sum + block.bytes, 0)
  const renderedBytes = bytes + separatorBytes * (blocks.length - 1)
  const tokens = Math.round(renderedBytes / ratio)
  const shares = splitByLargestRemainder(
    blocks.map((block) => block.bytes),
    tokens,
  )
  return blocks.map((block, index) => ({ ...block, tokens: shares[index] ?? 0 }))
}

function splitByLargestRemainder(weights: number[], total: number): number[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const effective = totalWeight === 0 ? weights.map(() => 1) : weights
  const divisor = totalWeight === 0 ? effective.length : totalWeight
  const shares = effective.map((weight, index) => {
    const exact = divisor === 0 ? 0 : (total * weight) / divisor
    const tokens = Math.floor(exact)
    return { index, tokens, fraction: exact - tokens }
  })
  const remaining = total - shares.reduce((sum, share) => sum + share.tokens, 0)
  const byRemainder = [...shares].sort(
    (left, right) => right.fraction - left.fraction || left.index - right.index,
  )
  for (let index = 0; index < remaining; index += 1) {
    const share = byRemainder[index]
    if (share) share.tokens += 1
  }
  return shares.map((share) => share.tokens)
}

/**
 * Схлопывание блоков одной статьи. Имена при этом склеиваются, а не теряются
 * (4.9): отложенные тулы приезжают по блоку на имя, файлы памяти — по блоку на
 * файл, и после агрегации других носителей состава не остаётся.
 *
 * Отсутствие имён заразно: блок без них, слитый с блоком с ними, дал бы список,
 * который выглядит полным, не будучи им. Поэтому имена остаются только тогда,
 * когда их назвали **все** слагаемые.
 */
function aggregateEstimated(blocks: PrefixBlock[]): PrefixBlock[] {
  const aggregated = new Map<string, PrefixBlock>()
  for (const block of blocks) {
    const key = `${block.category}\u0000${block.source ?? ''}`
    const current = aggregated.get(key)
    if (current) {
      current.bytes += block.bytes
      current.tokens += block.tokens
      current.items += block.items
      if (current.names && block.names) current.names = [...current.names, ...block.names]
      else delete current.names
    } else {
      aggregated.set(key, { ...block, basis: 'estimated' })
    }
  }
  return [...aggregated.values()]
}

function sortBlocks(blocks: PrefixBlock[]): PrefixBlock[] {
  return blocks.sort((left, right) => {
    const category = CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category)
    return category || (left.source ?? '').localeCompare(right.source ?? '')
  })
}
