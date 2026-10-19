import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  Check,
  Download,
  Info,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react'

type Photo = { url: string; name: string; kind?: 'hotdog' | 'not-hotdog' }
type InstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: string }>
}
const samples: Photo[] = [
  { url: '/images/hotdog.jpg', name: 'The classic hotdog', kind: 'hotdog' },
  {
    url: '/images/pizza.jpg',
    name: 'A slice of possibility',
    kind: 'not-hotdog',
  },
  {
    url: '/images/burger.jpg',
    name: 'A very good imposter',
    kind: 'not-hotdog',
  },
]

export default function App() {
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [stage, setStage] = useState<
    'empty' | 'loading' | 'result' | 'preview'
  >('empty')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [help, setHelp] = useState(false)
  const [installHelp, setInstallHelp] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null)
  const [installed, setInstalled] = useState(
    () => window.matchMedia('(display-mode: standalone)').matches,
  )
  const [offline, setOffline] = useState(!navigator.onLine)
  const [clipboardBusy, setClipboardBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const objectUrl = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const operation = useRef(0)
  const dragDepth = useRef(0)
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  const cleanup = useCallback(() => {
    operation.current += 1
    if (timer.current) clearTimeout(timer.current)
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
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
        setPhoto({ url, name: file.name || 'Your pasted image' })
        setStage('preview')
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
    [cleanup],
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
    const prompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPrompt)
    }
    const onInstalled = () => {
      setInstalled(true)
      setInstallPrompt(null)
      setInstallHelp(false)
    }
    window.addEventListener('paste', paste)
    window.addEventListener('online', online)
    window.addEventListener('offline', online)
    window.addEventListener('beforeinstallprompt', prompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('paste', paste)
      window.removeEventListener('online', online)
      window.removeEventListener('offline', online)
      window.removeEventListener('beforeinstallprompt', prompt)
      window.removeEventListener('appinstalled', onInstalled)
      cleanup()
    }
  }, [receiveFile, cleanup])

  useEffect(() => {
    if (stage === 'result' || stage === 'preview')
      resultHeading.current?.focus({ preventScroll: true })
  }, [stage])

  const reset = () => {
    cleanup()
    setPhoto(null)
    setStage('empty')
    setError('')
    input.current && (input.current.value = '')
    camera.current && (camera.current.value = '')
  }
  const sample = (item: Photo) => {
    cleanup()
    setError('')
    setPhoto(item)
    setStage('loading')
    timer.current = setTimeout(() => setStage('result'), 1200)
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
  const install = async () => {
    if (!installPrompt) {
      setInstallHelp((value) => !value)
      return
    }
    try {
      await installPrompt.prompt()
      await installPrompt.userChoice
      setInstallPrompt(null)
    } catch {
      setInstallPrompt(null)
      setInstallHelp(true)
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a href="/" className="site-wordmark" aria-label="SeeFood home">
          SEEFOOD
        </a>
        <nav aria-label="App information">
          <button
            onClick={() => {
              setHelp((value) => !value)
              setInstallHelp(false)
            }}
            aria-expanded={help}
            aria-controls="how-it-works"
          >
            How it works
          </button>
          <button
            onClick={() => {
              void install()
              setHelp(false)
            }}
            disabled={installed}
            aria-expanded={installHelp}
          >
            <Download size={15} />
            {installed ? 'Installed' : 'Get the app'}
          </button>
        </nav>
      </header>
      {offline && (
        <div className="offline-banner" role="status">
          You’re offline. Photos and the sample demo still work on this device.
        </div>
      )}
      {help && (
        <section
          className="info-panel"
          id="how-it-works"
          aria-label="How it works"
        >
          <div>
            <strong>The Shazam for food.</strong>
            <p>
              Paste an image, drop a file, or use your camera. Your photo stays
              in your browser. Try the sample photos to see the hotdog and
              not-hotdog demo results. Recognition for your own photos isn’t
              connected yet.
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close how it works"
            onClick={() => setHelp(false)}
          >
            <X size={20} />
          </button>
        </section>
      )}
      {installHelp && (
        <section className="info-panel" aria-label="Install SeeFood">
          <div>
            <strong>Take SeeFood with you.</strong>
            <p>
              On iPhone, open this page in Safari, tap Share, then “Add to Home
              Screen.” On Android, use your browser’s menu and choose “Install
              app” or “Add to Home screen.” On desktop, look for the install
              icon in your browser’s address bar.
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close install instructions"
            onClick={() => setInstallHelp(false)}
          >
            <X size={20} />
          </button>
        </section>
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
                  ) : stage === 'result' ? (
                    <div
                      className={`result-banner ${photo.kind === 'hotdog' ? 'hotdog' : 'not-hotdog'}`}
                    >
                      <h2 ref={resultHeading} tabIndex={-1}>
                        {photo.kind === 'hotdog' ? 'Hotdog' : 'Not hotdog'}
                      </h2>
                      <span className="verdict-icon">
                        {photo.kind === 'hotdog' ? (
                          <Check size={86} strokeWidth={3} />
                        ) : (
                          <X size={78} strokeWidth={3} />
                        )}
                      </span>
                    </div>
                  ) : (
                    <div className="preview-message">
                      <h2 ref={resultHeading} tabIndex={-1}>
                        Nice shot.
                      </h2>
                      <p>
                        Your photo is ready. Food recognition isn’t connected
                        yet. Try a sample below to see the demo in action.
                      </p>
                    </div>
                  )}
                </div>
                <span className="demo-label">
                  {photo.kind
                    ? stage === 'result'
                      ? 'SAMPLE DEMO RESULT'
                      : 'SAMPLE DEMO'
                    : 'PHOTO PREVIEW'}
                </span>
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
              {stage === 'preview'
                ? 'Choose another photo'
                : 'Try another photo'}
            </button>
          )}
        </section>
        <section className="samples" aria-labelledby="sample-heading">
          <h2 id="sample-heading">Hotdog. Or not hotdog.</h2>
          <p>Try a sample and see for yourself.</p>
          <div className="sample-list">
            {samples.map((item) => (
              <button
                key={item.url}
                className={`sample-card ${photo?.url === item.url ? 'selected' : ''}`}
                onClick={() => sample(item)}
                aria-label={`Try sample: ${item.name}`}
              >
                <img src={item.url} alt={item.name} />
                <span>
                  {item.kind === 'hotdog'
                    ? 'Hotdog'
                    : item.url.includes('pizza')
                      ? 'Pizza'
                      : 'Burger'}
                </span>
              </button>
            ))}
          </div>
        </section>
      </main>
      <footer>
        <p>
          A tribute to SeeFood from <em>Silicon Valley.</em>
        </p>
        <span>Frontend demo · Photos stay on your device</span>
      </footer>
    </div>
  )
}
