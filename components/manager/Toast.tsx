'use client'

export type ToastLine = {
  count: number
  label: string
  ids: string[]
  dim?: boolean
}

export type ToastData = {
  type: 'success' | 'error'
  title: string
  body: string | ToastLine[]
}

export default function Toast({
  data,
  visible,
}: {
  data: ToastData | null
  visible: boolean
}) {
  return (
    <div id="toast" className={visible ? 'visible' : undefined}>
      <div
        id="toastTitle"
        className={'toast-title' + (data?.type === 'error' ? ' error' : '')}
      >
        {data?.title ?? ''}
      </div>
      <div id="toastBody">
        {data == null ? null : typeof data.body === 'string' ? (
          <div className="toast-row">
            <span>{data.body}</span>
          </div>
        ) : (
          data.body.map((line, i) => (
            <div
              className="toast-row"
              key={i}
              style={line.dim ? { opacity: 0.6 } : undefined}
            >
              <span className="toast-count">{line.count}</span>
              <span>{line.label}</span>
              <span className="toast-ids">{line.ids.join(', ')}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
