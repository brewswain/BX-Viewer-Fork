'use client'

import { useEffect, useRef, useState } from 'react'

// Card boxes are 16:9, but a chunk of the library (BounceX and BX Studio art)
// is ~2.25:1. Covering those crops ~10% off each side, which eats left-aligned
// titles, so anything noticeably wider is shown whole over a blurred fill.
const WIDE_RATIO = (16 / 9) * 1.05

export default function CardThumbImg({
  src,
  alt,
  onError,
}: {
  src: string
  alt: string
  onError: () => void
}) {
  const ref = useRef<HTMLImageElement>(null)
  const [wide, setWide] = useState(false)

  const measure = (img: HTMLImageElement) => {
    if (img.naturalHeight) setWide(img.naturalWidth / img.naturalHeight > WIDE_RATIO)
  }

  // A cached image can finish before onLoad is attached.
  useEffect(() => {
    if (ref.current?.complete) measure(ref.current)
  }, [src])

  return (
    <>
      {wide && (
        <div className="card-thumb-fill" style={{ backgroundImage: `url("${src}")` }} aria-hidden />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={ref}
        src={src}
        alt={alt}
        loading="lazy"
        className={wide ? 'card-thumb-wide' : undefined}
        onLoad={(e) => measure(e.currentTarget)}
        onError={onError}
      />
    </>
  )
}
