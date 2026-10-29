import { describe, expect, it } from 'vitest'
import { loadedTerminals } from '../src/renderer/src/App'

const term = (id: string, addedAt = 0) => ({ id, addedAt })
const NOW = 1_000_000

describe('which terminals stay loaded', () => {
  const terms = Array.from({ length: 12 }, (_, i) => term(`t${i}`))
  const recent = terms.map((t) => t.id)

  it('the one on screen and the 8 most recently viewed', () => {
    const ids = loadedTerminals(terms, 't11', recent, NOW).map((t) => t.id)
    expect(ids).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't11'])
  })

  it('a just-started one stays loaded until its start-up grace ends', () => {
    const started = [...terms, term('new', NOW - 5_000)]
    expect(loadedTerminals(started, null, recent, NOW).map((t) => t.id)).toContain('new')
    expect(loadedTerminals(started, null, recent, NOW + 30_000).map((t) => t.id)).not.toContain('new')
  })
})
