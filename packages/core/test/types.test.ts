import { describe, expect, it } from 'vitest'
import { emptyDiagnostics } from '../src/index.ts'

describe('контракт нормализованной модели', () => {
  it('пустые диагностики не переиспользуют один объект', () => {
    const a = emptyDiagnostics()
    const b = emptyDiagnostics()
    a.unknownRecordTypes['queue-operation'] = 1
    expect(b.unknownRecordTypes).toEqual({})
    expect(b.malformedLines).toBe(0)
    expect(b.cliVersions).toEqual([])
  })
})
