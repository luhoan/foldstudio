import { describe, expect, it } from 'vitest'
import { analysisLink, designLink, explorerLink, historyLink, libraryLink, parseHighlight, parseRanges } from './links'

describe('page links', () => {
  it('round-trips a highlight through the address', () => {
    const highlight = { chain: 'H', ranges: [{ start: 26, end: 33 }, { start: 52, end: 52 }, { start: -3, end: -1 }] }
    const link = explorerLink('st_1', highlight)
    expect(link).toBe('/explorer?structure=st_1&chain=H&ranges=26-33%2C52%2C-3--1')
    const params = new URL(link, 'http://x').searchParams
    expect(params.get('structure')).toBe('st_1')
    expect(parseHighlight(params)).toEqual(highlight)
  })

  it('links to a structure with no highlight', () => {
    expect(explorerLink('st_1')).toBe('/explorer?structure=st_1')
    expect(explorerLink('st_1', { chain: 'A', ranges: [] })).toBe('/explorer?structure=st_1')
  })

  it('ignores ranges it cannot read instead of guessing', () => {
    expect(parseRanges('10-20,abc,30')).toEqual([{ start: 10, end: 20 }, { start: 30, end: 30 }])
    expect(parseRanges('20-10')).toEqual([])
    expect(parseRanges('')).toEqual([])
    expect(parseRanges(null)).toEqual([])
    expect(parseHighlight(new URLSearchParams('ranges=1-2'))).toBeNull()
    expect(parseHighlight(new URLSearchParams('chain=A'))).toBeNull()
  })

  it('builds the other pages\' addresses', () => {
    expect(analysisLink('m 1', 'r')).toBe('/analysis?mobile=m+1&reference=r')
    expect(historyLink('run/1')).toBe('/history?experiment=run%2F1')
    expect(designLink('run_1')).toBe('/design?run=run_1')
    expect(libraryLink('st_9')).toBe('/library?structure=st_9')
  })
})
