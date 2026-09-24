import { describe, expect, it } from 'bun:test'

import * as Q from './queue'

const v = (folder: string) => ({ folder })
function build(...folders: string[]): Q.Queue {
  return folders.reduce((q, f) => Q.append(q, v(f), f), Q.EMPTY_QUEUE)
}

describe('next in queue', () => {
  const folders = (q: Q.Queue) => q.items.map((i) => i.folder)
  let n = 0
  const uid = () => `u${n++}`

  it('adds cut in after the playing video, in the order added', () => {
    let q = Q.replace(['a', 'b', 'c', 'd', 'e'].map(v), 'Liked', uid)
    expect(q.current).toBe(q.items[0].uid)
    expect(q.source).toBe('Liked')
    q = Q.enqueue(q, [v('l')], uid)
    q = Q.enqueue(q, [v('m'), v('n')], uid)
    expect(folders(q)).toEqual(['a', 'l', 'm', 'n', 'b', 'c', 'd', 'e'])
    expect(q.items.filter((i) => i.added).map((i) => i.folder)).toEqual(['l', 'm', 'n'])
  })

  it('once the adds have played, a new one leads again', () => {
    let q = Q.enqueue(Q.replace([v('a'), v('b')], undefined, uid), [v('l')], uid)
    q = Q.setCurrent(q, q.items[1].uid) // playing l
    q = Q.enqueue(q, [v('m')], uid)
    expect(folders(q)).toEqual(['a', 'l', 'm', 'b'])
  })

  it('add to end drops a waiting radio pick but keeps the rest', () => {
    let q = Q.replace([v('a')], undefined, uid)
    q = Q.append(q, { folder: 'r', radio: { phase: 'build', level: 0, step: 0 } })
    expect(Q.hasPending(q)).toBe(false)
    q = Q.appendAll(q, [v('x')], uid)
    expect(folders(q)).toEqual(['a', 'x'])
    expect(Q.hasPending(q)).toBe(true)
  })

  it('source survives a round trip through storage', () => {
    const q = Q.replace([v('a')], 'Mix', uid)
    expect(Q.parseQueue(JSON.stringify(q)).source).toBe('Mix')
  })
})

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
