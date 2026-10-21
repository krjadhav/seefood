import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Check, Info, RotateCcw, Upload, X } from 'lucide-react'

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
  softmaxTemperature: number
  inferenceMs: number
  imageSize: { width: number; height: number }
  uploadBytes: number
  torch: string
  host: string
}
type Verdict = {
  isFood: boolean
  name: string
  topLabel: string
  foodProbability: number
  topSimilarity: number
  top: Label[]
  metadata: Meta
}

const samples: Photo[] = [
  { url: '/images/hotdog.jpg', name: 'The classic hotdog' },
  { url: '/images/pizza.jpg', name: 'A slice of possibility' },
  { url: '/images/burger.jpg', name: 'A very good imposter' },
]

export default function App() {
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [stage, setStage] = useState<'empty' | 'loading' | 'result' | 'error'>(
    'empty',
  )
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [clipboardBusy, setClipboardBusy] = useState(false)
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
      const response = await fetch('/api/classify', {
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
                  <button
                    className="paste-prompt mobile-camera"
                    onClick={() => camera.current?.click()}
                    aria-label="Scan food"
                  >
                    <Camera size={30} />
                    <span>
                      Scan food
                      <br />
                      <small>to get started</small>
                    </span>
                  </button>
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
                  {stage === 'loading' ? (
                    <div className="evaluating">
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
                {verdict && stage === 'result' && (
                  <span className="demo-label">
                    {verdict.metadata.model} · {verdict.metadata.device}
                  </span>
                )}
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
          {photo && stage !== 'loading' && (
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
                Top match <strong>{verdict.topLabel}</strong> · cosine{' '}
                {verdict.topSimilarity.toFixed(3)} · food probability{' '}
                {(verdict.foodProbability * 100).toFixed(1)}%
              </p>
            </header>
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
            <div className="readout-block">
              <h3>Model metadata</h3>
              <dl className="meta-grid">
                <dt>model</dt>
                <dd>{verdict.metadata.model}</dd>
                <dt>architecture</dt>
                <dd>{verdict.metadata.architecture}</dd>
                <dt>device</dt>
                <dd>{verdict.metadata.device}</dd>
                <dt>dtype</dt>
                <dd>{verdict.metadata.dtype}</dd>
                <dt>embedding dim</dt>
                <dd>{verdict.metadata.embeddingDim}</dd>
                <dt>embedding L2 norm</dt>
                <dd>{verdict.metadata.embeddingNorm}</dd>
                <dt>image tokens</dt>
                <dd>{verdict.metadata.imageTokens}</dd>
                <dt>candidate labels</dt>
                <dd>{verdict.metadata.candidateLabels}</dd>
                <dt>softmax temp</dt>
                <dd>{verdict.metadata.softmaxTemperature}</dd>
                <dt>inference</dt>
                <dd>{verdict.metadata.inferenceMs} ms</dd>
                <dt>image size</dt>
                <dd>
                  {verdict.metadata.imageSize.width}×
                  {verdict.metadata.imageSize.height}
                </dd>
                <dt>upload size</dt>
                <dd>{(verdict.metadata.uploadBytes / 1024).toFixed(1)} KB</dd>
                <dt>torch</dt>
                <dd>{verdict.metadata.torch}</dd>
                <dt>host</dt>
                <dd>{verdict.metadata.host}</dd>
              </dl>
            </div>
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
