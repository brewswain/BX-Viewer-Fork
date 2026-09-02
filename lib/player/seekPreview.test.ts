import { describe, expect, test } from 'bun:test'

import {
  completePreviewSeek,
  idlePreviewSeek,
  previewThumbBox,
  requestPreviewSeek,
} from './seekPreview'

/** One track pixel of a 100-minute video, the gap the engine actually passes. */
const MIN_DELTA = 10

describe('requestPreviewSeek', () => {
  test('serves the first ask straight away', () => {
    const { state, seekTo } = requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA)
    expect(seekTo).toBe(120)
    expect(state.inFlight).toBe(120)
    expect(state.pending).toBeNull()
  })

  test('queues an ask that arrives mid-seek instead of stacking seeks', () => {
    const first = requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA)
    const second = requestPreviewSeek(first.state, 300, MIN_DELTA)
    expect(second.seekTo).toBeNull()
    expect(second.state.inFlight).toBe(120)
    expect(second.state.pending).toBe(300)
  })

  test('keeps only the latest of the positions swept past', () => {
    let s = requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA).state
    for (const t of [200, 340, 610]) s = requestPreviewSeek(s, t, MIN_DELTA).state
    expect(s.pending).toBe(610)
  })

  test('ignores a re-ask for the frame already on screen', () => {
    const drawn = completePreviewSeek(
      requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA).state,
      MIN_DELTA,
    ).state
    // Under a pixel of travel: same frame, so no seek.
    const jitter = requestPreviewSeek(drawn, 124, MIN_DELTA)
    expect(jitter.seekTo).toBeNull()
    expect(jitter.state).toEqual(drawn)
    // A pixel further along is a different frame.
    expect(requestPreviewSeek(drawn, 131, MIN_DELTA).seekTo).toBe(131)
  })
})

describe('completePreviewSeek', () => {
  test('goes idle when nothing was asked for during the seek', () => {
    const flying = requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA).state
    const { state, seekTo } = completePreviewSeek(flying, MIN_DELTA)
    expect(seekTo).toBeNull()
    expect(state).toEqual({ inFlight: null, pending: null, drawn: 120 })
  })

  test('chases the pending position as soon as the seek lands', () => {
    let s = requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA).state
    s = requestPreviewSeek(s, 610, MIN_DELTA).state
    const { state, seekTo } = completePreviewSeek(s, MIN_DELTA)
    expect(seekTo).toBe(610)
    expect(state.inFlight).toBe(610)
    expect(state.drawn).toBe(120)
    expect(state.pending).toBeNull()
  })

  test('drops a pending position that the landed frame already covers', () => {
    // The pointer came back to where the in-flight seek was heading anyway.
    let s = requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA).state
    s = requestPreviewSeek(s, 122, MIN_DELTA).state
    const { state, seekTo } = completePreviewSeek(s, MIN_DELTA)
    expect(seekTo).toBeNull()
    expect(state.drawn).toBe(120)
  })

  test('an abandoned seek releases the slot without claiming a frame', () => {
    const flying = requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA).state
    const { state } = completePreviewSeek(flying, MIN_DELTA, false)
    expect(state.inFlight).toBeNull()
    expect(state.drawn).toBeNull()
    // And the position it gave up on can be asked for again.
    expect(requestPreviewSeek(state, 120, MIN_DELTA).seekTo).toBe(120)
  })

  test('an abandoned seek still serves what was queued behind it', () => {
    let s = requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA).state
    s = requestPreviewSeek(s, 610, MIN_DELTA).state
    expect(completePreviewSeek(s, MIN_DELTA, false).seekTo).toBe(610)
  })

  test('a stall cannot wedge the preview shut', () => {
    // Abandon, re-ask, land: the sequence a watchdog timeout produces.
    const flying = requestPreviewSeek(idlePreviewSeek(), 120, MIN_DELTA).state
    const freed = completePreviewSeek(flying, MIN_DELTA, false).state
    const retry = requestPreviewSeek(freed, 400, MIN_DELTA)
    expect(retry.seekTo).toBe(400)
    expect(completePreviewSeek(retry.state, MIN_DELTA).state.drawn).toBe(400)
  })
})

describe('previewThumbBox', () => {
  test('gives every landscape frame the same width', () => {
    expect(previewThumbBox(1920, 1080, 160, 120)).toEqual({ width: 160, height: 90 })
    expect(previewThumbBox(1280, 720, 160, 120)).toEqual({ width: 160, height: 90 })
  })

  test('lets height lead once the frame is tall enough to overflow', () => {
    // 9:16 at 160 wide would be 284 tall, well past the cap.
    expect(previewThumbBox(1080, 1920, 160, 120)).toEqual({ width: 68, height: 120 })
  })

  test('falls back to 16:9 before the video reports its size', () => {
    expect(previewThumbBox(0, 0, 160, 120)).toEqual({ width: 160, height: 90 })
    expect(previewThumbBox(NaN, NaN, 160, 120)).toEqual({ width: 160, height: 90 })
  })

  test('returns whole pixels, so the canvas needs no rounding of its own', () => {
    const box = previewThumbBox(640, 483, 160, 120)
    expect(box.width).toBe(Math.round(box.width))
    expect(box.height).toBe(Math.round(box.height))
  })
})
