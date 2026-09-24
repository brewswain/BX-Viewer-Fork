import { describe, expect, it } from 'bun:test'

import * as Q from './queue'

const v = (folder: string) => ({ folder })
function build(...folders: string[]): Q.Queue {
  return folders.reduce((q, f) => Q.append(q, v(f), f), Q.EMPTY_QUEUE)
}

describe('queue', () => {
  it('appends in order and allows the same video twice', () => {
    const q = Q.append(build('a', 'b'), v('a'), 'a2')
    expect(q.items.map((i) => i.folder)).toEqual(['a', 'b', 'a'])
  })

  it('play next goes after the playing item, or first when nothing played', () => {
    expect(Q.playNext(build('a', 'b'), v('x'), 'x').items.map((i) => i.uid)).toEqual([
      'x',
      'a',
      'b',
    ])
    const playing = Q.setCurrent(build('a', 'b', 'c'), 'a')
    expect(Q.playNext(playing, v('x'), 'x').items.map((i) => i.uid)).toEqual([
      'a',
      'x',
      'b',
      'c',
    ])
  })

  it('upcoming is everything after the playing item and survives running dry', () => {
    const q = build('a', 'b', 'c')
    expect(Q.upcoming(q).map((i) => i.uid)).toEqual(['a', 'b', 'c'])
    expect(Q.upcoming(Q.setCurrent(q, 'b')).map((i) => i.uid)).toEqual(['c'])
    const done = Q.setCurrent(q, 'c')
    expect(Q.upcoming(done)).toEqual([])
    expect(done.items).toHaveLength(3)
  })

  it('never removes the playing item', () => {
    const q = Q.setCurrent(build('a', 'b'), 'a')
    expect(Q.remove(q, 'a')).toBe(q)
    expect(Q.remove(q, 'b').items.map((i) => i.uid)).toEqual(['a'])
  })

  it('moves an item to a new index', () => {
    const q = build('a', 'b', 'c', 'd')
    expect(Q.move(q, 'a', 2).items.map((i) => i.uid)).toEqual(['b', 'c', 'a', 'd'])
    expect(Q.move(q, 'd', 0).items.map((i) => i.uid)).toEqual(['d', 'a', 'b', 'c'])
    expect(Q.move(q, 'b', 99).items.map((i) => i.uid)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('parses junk to an empty queue and drops a dangling current', () => {
    expect(Q.parseQueue(null)).toEqual(Q.EMPTY_QUEUE)
    expect(Q.parseQueue('{nope')).toEqual(Q.EMPTY_QUEUE)
    const parsed = Q.parseQueue(
      JSON.stringify({ items: [{ uid: 'a', folder: 'x' }, { folder: 'y' }, null], current: 'gone' }),
    )
    expect(parsed).toEqual({ items: [{ uid: 'a', folder: 'x' }], current: null })
  })
})
