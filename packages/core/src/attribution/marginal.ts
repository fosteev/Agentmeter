import type { Provider, Request, ToolCall } from '../sources/types.ts'

export interface MarginalOptions {
  /** Байт результата на токен промпта. Claude 2.7, Codex 3.7. */
  bytesPerToken?: number
  /** Вес картинки в дележе, в токенах. По умолчанию 400. */
  imageTokens?: number
}

export interface MarginalStats {
  measured: number
  split: number
  unknown: number
  attributed: number
}

const DEFAULT_BYTES_PER_TOKEN: Record<Provider, number> = {
  claude: 2.7,
  codex: 3.7,
}

/** Проставляет `marginalTokens` и `marginalBasis` на месте. */
export function attributeMarginal(
  requests: Request[],
  provider: Provider,
  options: MarginalOptions = {},
): MarginalStats {
  const stats: MarginalStats = { measured: 0, split: 0, unknown: 0, attributed: 0 }
  const bytesPerToken = options.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN[provider]
  const imageTokens = options.imageTokens ?? 400
  let nextLogged: Request | undefined

  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index]
    if (!request) continue

    for (const tool of request.tools) {
      tool.marginalTokens = 0
      tool.marginalBasis = 'unknown'
    }

    if (request.tools.length > 0) {
      if (!nextLogged || nextLogged.compacted || request.interjectedBytes !== 0) {
        stats.unknown += request.tools.length
      } else {
        const residual = Math.max(
          0,
          nextLogged.contextTokens - request.contextTokens - request.output,
        )
        if (request.tools.length === 1) {
          const tool = request.tools[0]
          if (tool) {
            tool.marginalTokens = residual
            tool.marginalBasis = 'measured'
            stats.measured += 1
            stats.attributed += residual
          }
        } else {
          splitResidual(request.tools, residual, bytesPerToken, imageTokens)
          stats.split += request.tools.length
          stats.attributed += residual
        }
      }
    }

    if (request.origin === 'log') nextLogged = request
  }

  return stats
}

function splitResidual(
  tools: ToolCall[],
  residual: number,
  bytesPerToken: number,
  imageTokens: number,
): void {
  let weights = tools.map((tool) =>
    tool.hasImage ? imageTokens : tool.resultBytes / bytesPerToken,
  )
  let totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  if (totalWeight === 0) {
    weights = tools.map(() => 1)
    totalWeight = tools.length
  }

  const shares = weights.map((weight, index) => {
    const exact = (residual * weight) / totalWeight
    return { index, tokens: Math.floor(exact), fraction: exact - Math.floor(exact) }
  })
  const remaining = residual - shares.reduce((sum, share) => sum + share.tokens, 0)
  const byRemainder = [...shares].sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let index = 0; index < remaining; index += 1) {
    const share = byRemainder[index]
    if (share) share.tokens += 1
  }

  for (const share of shares) {
    const tool = tools[share.index]
    if (!tool) continue
    tool.marginalTokens = share.tokens
    tool.marginalBasis = 'split'
  }
}
