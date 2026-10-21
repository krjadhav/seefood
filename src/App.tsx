import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Check, Copy, Info, RotateCcw, Upload, X } from 'lucide-react'

type Photo = { url: string; name: string }
type Label = {
  label: string
  similarity: number
  probability: number
  isFood: boolean
}
type Meta = {
  model: string
  architecture: string
  device: string
  dtype: string
  embeddingDim: number
  embeddingNorm: number
  imageTokens: number
  candidateLabels: number
  catalogDishes: number
  dishPrototypes: number
  khanaPrototypes: number
  protoScoring: string
  softmaxTemperature: number
  inferenceMs: number
  imageSize: { width: number; height: number }
  uploadBytes: number
  backend: string
  host: string
}
type Prototype = {
  dish: string
  similarity: number
  margin: number
  fromKhana: boolean
  used: boolean
  top: { dish: string; similarity: number }[]
}
type DishFacts = {
  name: string
  course: string
  flavor: string
  diet: string
  region: string
  state: string
  ingredients: string
}
type Described = {
  name: string
  similarity: number
  course: string
  flavor: string
  region: string
  hasPhoto: boolean
}
type RankedMeta = {
  course: string
  flavor: string
  diet: string
  region: string
  state: string
  ingredients: string
}
type Verdict = {
  isFood: boolean
  name: string
  source: 'text' | 'prototype'
  topLabel: string
  foodProbability: number
  topSimilarity: number
  top: Label[]
  prototype: Prototype | null
  dish: DishFacts | null
  described: Described[]
  rankedDishes: Record<string, RankedMeta>
  metadata: Meta
}

// Backend base URL. Empty in dev (Vite proxies /api); set VITE_API_BASE_URL at
// build time for the deployed PWA to reach a public backend. No trailing slash.
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

const samples: Photo[] = [
  { url: '/images/hotdog.jpg', name: 'Hot dog' },
  { url: '/images/pizza.jpg', name: 'Pizza' },
  { url: '/images/biryani.jpg', name: 'Biryani' },
  { url: '/images/samosa.jpg', name: 'Samosa' },
  { url: '/images/gulabjamun.jpg', name: 'Gulab jamun' },
  { url: '/images/dosa.jpg', name: 'Masala dosa' },
]

export default function App() {
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [stage, setStage] = useState<
    'empty' | 'loading' | 'retrieved' | 'result' | 'error'
  >('empty')
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [clipboardBusy, setClipboardBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dishes, setDishes] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const objectUrl = useRef<string | null>(null)
  const operation = useRef(0)
  const dragDepth = useRef(0)
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  const cleanup = useCallback(() => {
    operation.current += 1
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
  }, [])

  const analyze = useCallback(async (blob: Blob, display: Photo) => {
    const currentOperation = operation.current
    setPhoto(display)
    setVerdict(null)
    setError('')
    setStage('loading')
    try {
      const form = new FormData()
      form.append('image', blob, display.name || 'image')
      const response = await fetch(`${API_BASE}/api/classify`, {
        method: 'POST',
        body: form,
      })
      if (!response.ok) throw new Error(String(response.status))
      const data: Verdict = await response.json()
      if (currentOperation !== operation.current) return
      setVerdict(data)
      setStage('result')
    } catch {
      if (currentOperation !== operation.current) return
      setStage('error')
      setError(
        'Couldn’t reach the recognition service. Start the backend (see server/README.md) and try again.',
      )
    }
  }, [])

  const receiveFile = useCallback(
    async (file?: File) => {
      if (!file) return
      setError('')
      if (
        ![
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/gif',
          'image/avif',
        ].includes(file.type)
      ) {
        setError(
          'That file isn’t a supported image. Try a JPG, PNG, WebP, GIF, or AVIF.',
        )
        return
      }
      if (file.size > 20 * 1024 * 1024) {
        setError(
          'That image is a little too big. Choose one smaller than 20 MB.',
        )
        return
      }
      cleanup()
      const currentOperation = operation.current
      const url = URL.createObjectURL(file)
      objectUrl.current = url
      const image = new Image()
      image.src = url
      try {
        await image.decode()
        if (currentOperation !== operation.current) return
        void analyze(file, { url, name: file.name || 'Your pasted image' })
      } catch {
        if (currentOperation !== operation.current) return
        URL.revokeObjectURL(url)
        objectUrl.current = null
        setPhoto(null)
        setStage('empty')
        setError(
          'We couldn’t open that image. Try saving it as a JPG or PNG first.',
        )
      }
    },
    [cleanup, analyze],
  )

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.items || [])
      const image = files
        .find((item) => item.type.startsWith('image/'))
        ?.getAsFile()
      if (image) {
        event.preventDefault()
        void receiveFile(image)
      }
    }
    const online = () => setOffline(!navigator.onLine)
    window.addEventListener('paste', paste)
    window.addEventListener('online', online)
    window.addEventListener('offline', online)
    return () => {
      window.removeEventListener('paste', paste)
      window.removeEventListener('online', online)
      window.removeEventListener('offline', online)
      cleanup()
    }
  }, [receiveFile, cleanup])

  useEffect(() => {
    if (stage === 'result' || stage === 'error')
      resultHeading.current?.focus({ preventScroll: true })
  }, [stage])

  useEffect(() => {
    let active = true
    fetch(`${API_BASE}/api/dishes`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data?.names) setDishes(data.names)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  // Fast scrolling columns during evaluation. Once retrieval returns, show the
  // actual ranked dishes (in order); before that, a shuffled sample. Three
  // columns at different speeds, each doubled for a seamless loop, to convey a
  // lot of dishes being parsed very quickly.
  const tickerCols = useMemo(() => {
    let base: string[]
    if (stage === 'retrieved' && verdict) {
      base = Object.keys(verdict.rankedDishes).slice(0, 72)
    } else {
      base = [...dishes]
      for (let i = base.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[base[i], base[j]] = [base[j], base[i]]
      }
      base = base.slice(0, 72)
    }
    if (!base.length) return []
    return [0, 1, 2].map((c) => {
      const off = (c * 11) % base.length
      const rot = [...base.slice(off), ...base.slice(0, off)]
      return [...rot, ...rot]
    })
  }, [stage, verdict, dishes])

  const copyRanked = async () => {
    if (!verdict) return
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(verdict.rankedDishes, null, 2),
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Couldn’t copy to clipboard. Select the JSON and copy manually.')
    }
  }

  const reset = () => {
    cleanup()
    setPhoto(null)
    setVerdict(null)
    setStage('empty')
    setError('')
    input.current && (input.current.value = '')
    camera.current && (camera.current.value = '')
  }

  const sample = async (item: Photo) => {
    cleanup()
    try {
      const blob = await (await fetch(item.url)).blob()
      void analyze(blob, item)
    } catch {
      setPhoto(item)
      setStage('error')
      setError('Couldn’t load that sample image.')
    }
  }

  const pasteImage = async () => {
    setError('')
    setClipboardBusy(true)
    try {
      if (!navigator.clipboard?.read) throw new Error('unsupported')
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find((type) => type.startsWith('image/'))
        if (type) {
          await receiveFile(
            new File([await item.getType(type)], 'Pasted image', { type }),
          )
          return
        }
      }
      setError(
        `No image found on your clipboard. Copy an image, then paste with ${isMac ? '⌘' : 'Ctrl'} + V.`,
      )
    } catch {
      setError(
        `Use ${isMac ? '⌘' : 'Ctrl'} + V to paste an image, or choose Upload image below.`,
      )
    } finally {
      setClipboardBusy(false)
    }
  }

  return (
    <div className="app-shell">
      {offline && (
        <div className="offline-banner" role="status">
          You’re offline. Recognition needs the local backend running.
        </div>
      )}
      <main>
        <section className="workspace" aria-label="Food image scanner">
          <div
            className={`app-screen dropzone ${photo ? 'has-photo' : ''} ${dragging ? 'dragging' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault()
              dragDepth.current += 1
              setDragging(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }}
            onDragLeave={(event) => {
              event.preventDefault()
              dragDepth.current -= 1
              if (dragDepth.current <= 0) setDragging(false)
            }}
            onDrop={(event) => {
              event.preventDefault()
              dragDepth.current = 0
              setDragging(false)
              void receiveFile(event.dataTransfer.files[0])
            }}
          >
            {!photo ? (
              <>
                <div className="app-brand">
                  <h1>SEEFOOD</h1>
                </div>
                <div className="app-tagline">“The Shazam for Food”</div>
                <div className="welcome-screen">
                  <div className="food-background" aria-hidden="true">
                    <img src="/images/salmon.jpg" alt="" />
                    <img src="/images/pasta.jpg" alt="" />
                  </div>
                  <h2>Let’s Get Started</h2>
                  <button
                    className="paste-prompt desktop-paste"
                    aria-label="Paste an image"
                    onClick={() => void pasteImage()}
                    disabled={clipboardBusy}
                  >
                    {clipboardBusy ? (
                      'Opening clipboard…'
                    ) : (
                      <>
                        Paste an image
                        <br />
                        to get started
                      </>
                    )}
                  </button>
                  <div className="mobile-scan">
                    <button
                      className="scan-button"
                      onClick={() => camera.current?.click()}
                      aria-label="Scan food"
                    >
                      <Camera size={40} strokeWidth={2.5} />
                    </button>
                    <span className="scan-caption">
                      Scan food to get started
                    </span>
                  </div>
                  <div className="screen-bottom">
                    <span className="keyboard-hint">
                      {isMac ? '⌘' : 'Ctrl'} + V · or drop a photo here
                    </span>
                    <button
                      className="upload-button"
                      onClick={() => input.current?.click()}
                    >
                      <Upload size={15} />
                      Upload image
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <img
                  className="uploaded-photo"
                  src={photo.url}
                  alt={photo.name}
                />
                <div
                  className={`photo-state ${stage}`}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {stage === 'loading' || stage === 'retrieved' ? (
                    <div className="evaluating">
                      {tickerCols.length > 0 && (
                        <div className="dish-ticker" aria-hidden="true">
                          {tickerCols.map((col, ci) => (
                            <div className="dish-ticker-col" key={ci}>
                              <div
                                className="dish-ticker-track"
                                style={{ animationDuration: `${4 + ci * 1.5}s` }}
                              >
                                {col.map((name, i) => (
                                  <span key={`${name}-${i}`}>{name}</span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="dot-loader" aria-hidden="true">
                        {Array.from({ length: 12 }, (_, i) => (
                          <i
                            key={i}
                            style={{
                              transform: `rotate(${i * 30}deg) translateY(-59px)`,
                              animationDelay: `${i * 0.1}s`,
                            }}
                          />
                        ))}
                      </div>
                      <h2>Evaluating...</h2>
                    </div>
                  ) : stage === 'result' && verdict ? (
                    <div
                      className={`result-banner ${verdict.isFood ? 'food' : 'not-food'}`}
                    >
                      <h2
                        ref={resultHeading}
                        tabIndex={-1}
                        className={verdict.name.length > 10 ? 'long' : ''}
                      >
                        {verdict.name}
                      </h2>
                      <span className="verdict-icon">
                        {verdict.isFood ? (
                          <Check size={86} strokeWidth={3} />
                        ) : (
                          <X size={78} strokeWidth={3} />
                        )}
                      </span>
                    </div>
                  ) : stage === 'error' ? (
                    <div className="preview-message">
                      <h2 ref={resultHeading} tabIndex={-1}>
                        Hmm.
                      </h2>
                      <p>
                        The recognition service didn’t answer. Make sure the
                        backend is running, then try again.
                      </p>
                    </div>
                  ) : null}
                </div>
                <button
                  className="remove-photo icon-button"
                  aria-label="Remove photo"
                  onClick={reset}
                >
                  <X size={18} />
                </button>
              </>
            )}
            {dragging && (
              <div className="drag-overlay">
                <Upload size={35} />
                <span>
                  Drop an image
                  <br />
                  to get started
                </span>
              </div>
            )}
          </div>
          <input
            ref={input}
            type="file"
            tabIndex={-1}
            className="visually-hidden"
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            aria-label="Upload a food image"
            onChange={(event) => {
              void receiveFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <input
            ref={camera}
            type="file"
            tabIndex={-1}
            className="visually-hidden"
            accept="image/*"
            capture="environment"
            aria-label="Take a food photo"
            onChange={(event) => {
              void receiveFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          {error && (
            <div className="error-message" role="alert">
              <Info size={18} />
              <span>{error}</span>
              <button
                aria-label="Dismiss error"
                className="icon-button"
                onClick={() => setError('')}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {photo && stage !== 'loading' && stage !== 'retrieved' && (
            <button className="reset-button" onClick={reset}>
              <RotateCcw size={15} />
              Try another photo
            </button>
          )}
        </section>
        {verdict && stage === 'result' ? (
          <aside className="readout" aria-label="Model output">
            <header className="readout-head">
              <span className={`readout-tag ${verdict.isFood ? '' : 'not'}`}>
                {verdict.isFood ? 'FOOD' : 'NOT FOOD'}
              </span>
              <h2>{verdict.name}</h2>
              <p>
                Named by{' '}
                <strong>
                  {verdict.source === 'prototype'
                    ? 'dish photo prototype'
                    : 'text label'}
                </strong>{' '}
                · text top <strong>{verdict.topLabel}</strong> cosine{' '}
                {verdict.topSimilarity.toFixed(3)} · food probability{' '}
                {(verdict.foodProbability * 100).toFixed(1)}%
              </p>
            </header>
            {verdict.dish && (
              <div className="readout-block">
                <h3>Dish info</h3>
                <dl className="meta-grid">
                  {verdict.dish.course && (
                    <>
                      <dt>course</dt>
                      <dd>{verdict.dish.course}</dd>
                    </>
                  )}
                  {verdict.dish.flavor && (
                    <>
                      <dt>flavor</dt>
                      <dd>{verdict.dish.flavor}</dd>
                    </>
                  )}
                  {verdict.dish.diet && (
                    <>
                      <dt>diet</dt>
                      <dd>{verdict.dish.diet}</dd>
                    </>
                  )}
                  {(verdict.dish.region || verdict.dish.state) && (
                    <>
                      <dt>origin</dt>
                      <dd>
                        {[verdict.dish.state, verdict.dish.region]
                          .filter(Boolean)
                          .join(', ')}
                      </dd>
                    </>
                  )}
                  {verdict.dish.ingredients && (
                    <>
                      <dt>ingredients</dt>
                      <dd>{verdict.dish.ingredients}</dd>
                    </>
                  )}
                </dl>
              </div>
            )}
            {verdict.described.length > 0 && (
              <div className="readout-block">
                <h3>Closest described dishes</h3>
                <p className="proto-note">
                  Image matched to CSV dish descriptions · ● = has photo
                  prototype
                </p>
                <ul className="label-list">
                  {verdict.described.slice(0, 6).map((row) => (
                    <li key={row.name}>
                      <span className="label-row">
                        <span
                          className={row.hasPhoto ? 'photo-dot' : 'nophoto-dot'}
                        />
                        <span className="label-name">{row.name}</span>
                        <span className="label-score">
                          {row.similarity.toFixed(3)}
                        </span>
                      </span>
                      {(row.flavor || row.course || row.region) && (
                        <span className="described-meta">
                          {[row.flavor, row.course, row.region]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {verdict.prototype && (
              <div className="readout-block">
                <h3>Dish photo prototypes</h3>
                <p className="proto-note">
                  Nearest dish <strong>{verdict.prototype.dish}</strong> (
                  {verdict.prototype.fromKhana
                    ? 'multi-photo'
                    : 'single-photo'}{' '}
                  anchor) · centered score{' '}
                  {verdict.prototype.similarity.toFixed(3)} · margin{' '}
                  {verdict.prototype.margin.toFixed(3)} ·{' '}
                  <span
                    className={
                      verdict.prototype.used ? 'proto-used' : 'proto-unused'
                    }
                  >
                    {verdict.prototype.used ? 'used for name' : 'not used'}
                  </span>
                </p>
                <ul className="label-list">
                  {verdict.prototype.top.slice(0, 5).map((row) => (
                    <li key={row.dish}>
                      <span className="label-row">
                        <span className="food-dot" />
                        <span className="label-name">{row.dish}</span>
                        <span className="label-score">
                          {row.similarity.toFixed(3)}
                        </span>
                      </span>
                      <span className="label-bar">
                        <span
                          style={{
                            width: `${Math.round(Math.max(0, row.similarity / (verdict.prototype!.top[0].similarity || 1)) * 100)}%`,
                          }}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="readout-block">
              <h3>Top label matches</h3>
              <ul className="label-list">
                {verdict.top.map((row) => (
                  <li key={row.label}>
                    <span className="label-row">
                      <span className={row.isFood ? 'food-dot' : 'not-dot'} />
                      <span className="label-name">{row.label}</span>
                      <span className="label-score">
                        {row.similarity.toFixed(3)}
                      </span>
                    </span>
                    <span className="label-bar">
                      <span
                        style={{
                          width: `${Math.round(row.probability * 100)}%`,
                        }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {Object.keys(verdict.rankedDishes).length > 0 && (
              <div className="readout-block">
                <div className="ranked-head">
                  <h3>Ranked dishes (JSON)</h3>
                  <button
                    className="copy-button"
                    onClick={() => void copyRanked()}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy JSON'}
                  </button>
                </div>
                <p className="proto-note">
                  Top {Object.keys(verdict.rankedDishes).length} dishes by
                  description match, each with its metadata (no scores).
                </p>
                <pre className="ranked-json">
                  {JSON.stringify(verdict.rankedDishes, null, 2)}
                </pre>
              </div>
            )}
          </aside>
        ) : (
          <section className="samples" aria-labelledby="sample-heading">
            <p>Try a sample and see for yourself.</p>
            <div className="sample-list">
              {samples.map((item) => (
                <button
                  key={item.url}
                  className={`sample-card ${photo?.url === item.url ? 'selected' : ''}`}
                  onClick={() => void sample(item)}
                  aria-label={`Try sample: ${item.name}`}
                >
                  <img src={item.url} alt={item.name} />
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
      <footer></footer>
    </div>
  )
}
