import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrPanel, sessionPrs } from '../src/renderer/src/components/SessionHeader'
import type { LinearIssue, PrLink } from '../src/shared/types'

const pr = (number: number, repo = 'acme/api'): PrLink => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`
})
const issue = (identifier: string, prs: PrLink[]): LinearIssue =>
  ({ identifier, title: 't', url: 'u', state: { id: 's', name: 'Done', type: 'completed', color: '#000' }, prs }) as unknown as LinearIssue

const text = (prs: PrLink[]) => renderToStaticMarkup(<PrPanel prs={prs} sessionId="s" />).replace(/<[^>]+>/g, ' ')

describe('sessionPrs', () => {
  it("adds the ticket's Linear-attached PRs a fresh session never opened", () => {
    // Opening a Done card starts a new session; its PR lives on the ticket.
    const shown = sessionPrs([], issue('ENG-8814', [pr(9198)]))
    expect(shown.map((p) => [p.number, p.ticketOnly])).toEqual([[9198, 'ENG-8814']])
    expect(text(shown)).toContain('via ticket')
  })

  it("keeps the session's own copy (with its local and deploy state) when both have it", () => {
    const own = { ...pr(9198), local: { worktree: 'w', ahead: 0, behind: 0 } }
    const shown = sessionPrs([own, pr(812, 'acme/web')], issue('ENG-8814', [pr(9198)]))
    expect(shown).toHaveLength(2)
    expect(shown[0]).toBe(own)
    expect(shown.some((p) => p.ticketOnly)).toBe(false)
  })

  it('is just the session PRs without a ticket', () => {
    expect(sessionPrs([pr(1)], null)).toEqual([pr(1)])
    expect(text([])).toContain('No PRs from this session or its ticket')
  })
})

describe('PrPanel focus (opened from a card through another session)', () => {
  const merged = (n: number): PrLink => ({ ...pr(n), info: { title: `PR ${n}`, state: 'MERGED', draft: false, headRef: `b${n}` } })
  const open = (n: number): PrLink => ({ ...pr(n), info: { title: `PR ${n}`, state: 'OPEN', draft: false, headRef: `b${n}` } })
  const html = (prs: PrLink[], urls: string[]) =>
    renderToStaticMarkup(<PrPanel prs={prs} sessionId="s" focus={urls.length ? { ticket: 'ENG-8814', prUrls: urls } : undefined} />)

  it("puts the card's PR first and marks it, even when merged", () => {
    const prs = [open(9201), merged(9144), merged(9198)]
    expect(html(prs, [])).toContain('Show 2 merged and closed')
    const focused = html(prs, [pr(9198).url])
    expect(focused.match(/class="pr-focus"/g)).toHaveLength(1)
    // First row, labelled with the card's ticket; the other merged PR stays folded.
    expect(focused.indexOf('pull/9198')).toBeLessThan(focused.indexOf('pull/9201'))
    expect(focused).toMatch(/class="pr-focus".*pull\/9198.*ENG-8814/s)
    expect(focused).toContain('Show 1 merged and closed')
  })

  it('without a focus, the order is unchanged', () => {
    const plain = html([open(9201), merged(9144)], [])
    expect(plain).not.toContain('pr-focus')
    expect(plain).toContain('Show 1 merged and closed')
})
})

describe('PrPanel refresh', () => {
  it('offers a Refresh while there are PRs to re-read, and none otherwise', () => {
    expect(renderToStaticMarkup(<PrPanel prs={[pr(1)]} sessionId="s" />)).toContain('Refresh</button>')
    expect(renderToStaticMarkup(<PrPanel prs={[]} sessionId="s" />)).not.toContain('pr-refresh')
  })
})

describe('related PRs in the session view', () => {
  const banner: PrLink = { ...pr(9207), info: { title: 'Remove old banner', state: 'MERGED', draft: false, headRef: 'sam/remove-banner', mentions: [] } }

  it("marks a ticket PR that doesn't name the ticket as related, with no state chip", () => {
    const shown = sessionPrs([], issue('ENG-8825', [banner]))
    expect(shown[0].related).toBe(true)
    const out = text(shown)
    expect(out).toContain('related, merged')
    expect(out).not.toContain('Merged')
    expect(out).not.toContain('via ticket')
  })

  it('a ticket PR that names it stays "via ticket"', () => {
    const fix: PrLink = { ...banner, number: 9300, url: pr(9300).url, info: { ...banner.info!, mentions: ['ENG-8825'] } }
    const shown = sessionPrs([], issue('ENG-8825', [fix]))
    expect(shown[0].related).toBe(false)
    expect(text(shown)).toContain('via ticket')
  })
})

