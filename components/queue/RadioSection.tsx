'use client'

/**
 * Radio controls in the queue panel: the on switch, the taste picker, and the
 * wave it will follow.
 *
 * The taste is tag buttons only, with no counts and no videos, so it is picked
 * blind. Difficulty buttons set the wave's range rather than filtering.
 */

import { useEffect, useState } from 'react'

import { FACETS, tagLabel } from '@/lib/browse/facets'
import { LEVELS, radioPool, waveCycle, type Phase, type RadioCandidate } from '@/lib/queue/radio'
import { radioTopUp, setRadio, useRadio } from '@/lib/queue/radioStore'
import { upcoming } from '@/lib/queue/queue'
import { useQueue } from '@/lib/queue/store'

const PHASE_LABEL: Record<Phase, string> = {
  build: 'Build',
  plateau: 'Plateau',
  rest: 'Rest',
  explosion: 'Explosion',
}

/** The difficulty facet without `multi-difficulty`, which is no level. */
const TASTE_FACETS = FACETS.map((f) =>
  f.key === 'difficulty' ? { ...f, label: 'Difficulty (wave range)', tags: [...LEVELS] } : f,
)

type Props = { play: (uid: string) => void; isPlayer: boolean }

export default function RadioSection({ play, isPlayer }: Props) {
  const radio = useRadio()
  const queue = useQueue()
  const [picking, setPicking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [noMatch, setNoMatch] = useState(false)
  const [library, setLibrary] = useState<RadioCandidate[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/library')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { videos: RadioCandidate[] } | null) => !cancelled && d && setLibrary(d.videos))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  // A count, never the videos themselves, so the taste stays picked blind.
  const matches = library ? radioPool(radio.tags, library).length : null

  const cycle = waveCycle(radio.tags)
  // The step of the newest radio row, so the strip shows where the wave is.
  const lastMark = [...queue.items].reverse().find((i) => i.radio)?.radio
  const onStep = lastMark ? lastMark.step % cycle.length : -1
  const dry = upcoming(queue).length === 0

  function toggle(tag: string) {
    const tags = radio.tags.includes(tag)
      ? radio.tags.filter((t) => t !== tag)
      : [...radio.tags, tag]
    setRadio({ tags })
    setNoMatch(false)
  }

  async function start() {
    setStarting(true)
    const uid = await radioTopUp()
    setStarting(false)
    if (uid) play(uid)
    else setNoMatch(true)
  }

  return (
    <div className={`radio-section${radio.enabled ? ' on' : ''}`}>
      <div className="radio-head">
        <button
          className={`radio-switch${radio.enabled ? ' on' : ''}`}
          role="switch"
          aria-checked={radio.enabled}
          onClick={() => setRadio({ enabled: !radio.enabled })}
          title="When the queue runs out, keep playing picks from your taste"
        >
          <span className="radio-switch-knob" />
          Radio
        </button>
        <span className="radio-summary">
          {radio.tags.length ? radio.tags.map(tagLabel).join(' · ') : 'Any tags'}
          {matches != null && (
            <span className={`radio-matches${matches === 0 ? ' none' : ''}`}>
              {' '}
              ({matches} {matches === 1 ? 'video' : 'videos'})
            </span>
          )}
        </span>
        <button className="queue-btn" onClick={() => setPicking((p) => !p)}>
          {picking ? 'Done' : 'Taste'}
        </button>
      </div>

      {picking && (
        <div className="radio-taste">
          {TASTE_FACETS.map((f) => (
            <div className="tag-facet" key={f.key}>
              <div className="tag-facet-label">{f.label}</div>
              <div className="tag-facet-btns">
                {f.tags.map((t) => {
                  const on = radio.tags.includes(t)
                  return (
                    <button
                      key={t}
                      className={`tag-btn${on ? ' active' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggle(t)}
                    >
                      {tagLabel(t)}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          {radio.tags.length > 0 && (
            <button className="queue-btn" onClick={() => setRadio({ tags: [] })}>
              Clear taste
            </button>
          )}
        </div>
      )}

      {radio.enabled && (
        <>
          <ol className="radio-wave" aria-label="Wave">
            {cycle.map((s, i) => (
              <li
                key={i}
                className={`radio-step phase-${s.phase}${i === onStep ? ' current' : ''}`}
                title={`${PHASE_LABEL[s.phase]}: ${tagLabel(LEVELS[s.level])}`}
              >
                <span className="radio-step-phase">{PHASE_LABEL[s.phase]}</span>
                <span className={`queue-diff diff-${LEVELS[s.level]}`}>
                  {tagLabel(LEVELS[s.level])}
                </span>
              </li>
            ))}
          </ol>
          {!isPlayer && dry && (
            <button className="queue-btn primary" disabled={starting} onClick={() => void start()}>
              {starting ? 'Picking…' : 'Start radio'}
            </button>
          )}
          {noMatch && <div className="queue-save-error">No video matches this taste.</div>}
        </>
      )}
    </div>
  )
}
