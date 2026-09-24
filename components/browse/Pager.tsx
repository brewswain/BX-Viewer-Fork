'use client'

type Props = {
  page: number
  pageCount: number
  onPage: (page: number) => void
}

/** Numbered pages, with the long middle folded to an ellipsis. */
export default function Pager({ page, pageCount, onPage }: Props) {
  if (pageCount <= 1) return null

  const shown = new Set([1, pageCount, page - 1, page, page + 1])
  let nums = [...shown].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b)
  // An ellipsis standing in for a single page is no shorter than the page.
  nums = nums.flatMap((n, i) => (i > 0 && n - nums[i - 1] === 2 ? [n - 1, n] : [n]))

  const items: (number | 'gap')[] = []
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) items.push('gap')
    items.push(n)
  })

  return (
    <nav className="pager" aria-label="Pages">
      <button className="pager-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Prev
      </button>
      {items.map((it, i) =>
        it === 'gap' ? (
          <span className="pager-gap" key={`gap${i}`}>
            …
          </span>
        ) : (
          <button
            key={it}
            className={`pager-btn${it === page ? ' active' : ''}`}
            aria-current={it === page ? 'page' : undefined}
            onClick={() => onPage(it)}
          >
            {it}
          </button>
        ),
      )}
      <button
        className="pager-btn"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </nav>
  )
}
