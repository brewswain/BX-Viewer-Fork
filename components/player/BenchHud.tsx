'use client'

import { useEffect, useRef, useState } from 'react'
import { deviceManager } from '@/lib/device/manager'
import { useDeviceState } from '@/lib/device/useDevice'

/**
 * The driver's counters, on screen, during a bench run.
 *
 * Third of the three additions the machine bench test asks for
 * (`BX-Studio/docs/plans/machine-bench-test.md`), and it exists so that a
 * command storm, a fall-behind or a re-anchor is visible **in the video itself**
 * rather than only in a file that has to be trusted afterwards. The camera films
 * the rail and the screen in one frame, so anything the analysis needs has to be
 * in that frame too.
 *
 * Three things follow from being read off a video still rather than off a
 * monitor. It is **fixed and over the picture**, because the card is what the
 * camera is aimed at. It is **large, monospace and high contrast**, because a
 * phone camera pointed at a screen at an angle loses small text first. And the
 * numbers are **updated from rAF straight into the DOM**, not through React
 * state: the driver's counters change on every issued move and re-rendering a
 * component at that rate during the one run that matters would be adding a
 * confound to the instrument.
 *
 * It is off by default and nothing else in the app mounts it.
 */
export default function BenchHud({ onClose }: { onClose: () => void }) {
  const state = useDeviceState()
  const ref = useRef<HTMLDivElement>(null)
  const [saved, setSaved] = useState('')

  useEffect(() => {
    let raf = 0
    const cells: Record<string, HTMLElement | null> = {}
    const root = ref.current
    if (root) {
      for (const k of ['sent', 'skipped', 'seeks', 'merged', 'late', 'pos', 'dur', 'rec']) {
        cells[k] = root.querySelector<HTMLElement>(`[data-bench="${k}"]`)
      }
    }
    const tick = () => {
      const s = deviceManager.stats
      if (cells.sent) cells.sent.textContent = String(s.sent)
      if (cells.skipped) cells.skipped.textContent = String(s.skipped)
      if (cells.seeks) cells.seeks.textContent = String(s.seeks)
      if (cells.merged) cells.merged.textContent = String(s.lastMerged)
      if (cells.late) cells.late.textContent = s.lastLateMs.toFixed(0)
      if (cells.pos) cells.pos.textContent = s.lastPos.toFixed(3)
      if (cells.dur) cells.dur.textContent = s.lastDur.toFixed(0)
      if (cells.rec) cells.rec.textContent = String(deviceManager.benchCount())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  function download() {
    const csv = deviceManager.benchCsv()
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    a.download = `bench-${stamp}-min${state.config.minCmdMs}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setSaved(a.download)
  }

  return (
    <div className="bench-hud" ref={ref}>
      <div className="bench-hud-head">
        <span>BENCH</span>
        {/* The threshold is on screen for the same reason it is in the log
            header: segments 4, 5 and 7 are run twice, at 100 and at 20, and a
            still that does not say which run it is from is not readable. */}
        <span className="bench-hud-min">minCmdMs {state.config.minCmdMs}</span>
        <button type="button" className="bench-hud-x" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="bench-hud-grid">
        <span>sent</span>
        <b data-bench="sent">0</b>
        <span>skipped</span>
        <b data-bench="skipped">0</b>
        <span>seeks</span>
        <b data-bench="seeks">0</b>
        <span>merged</span>
        <b data-bench="merged">0</b>
        <span>late ms</span>
        <b data-bench="late">0</b>
        <span>pos</span>
        <b data-bench="pos">0.000</b>
        <span>dur ms</span>
        <b data-bench="dur">0</b>
        <span>logged</span>
        <b data-bench="rec">0</b>
      </div>
      <div className="bench-hud-actions">
        {state.recording ? (
          <button
            type="button"
            className="bench-hud-btn bench-hud-rec"
            onClick={() => deviceManager.stopBench()}
          >
            Stop recording
          </button>
        ) : (
          <button
            type="button"
            className="bench-hud-btn"
            onClick={() => deviceManager.startBench(document.title)}
          >
            Record
          </button>
        )}
        <button type="button" className="bench-hud-btn" onClick={download}>
          Save CSV
        </button>
      </div>
      {saved && <div className="bench-hud-saved">{saved}</div>}
    </div>
  )
}
