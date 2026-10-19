import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowRight,
  Camera,
  Check,
  ChevronRight,
  Clipboard,
  Download,
  ImagePlus,
  Info,
  LoaderCircle,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Sparkles,
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

function Hotdog({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 160 120"
      fill="none"
      aria-hidden="true"
    >
      <g transform="rotate(-28 80 60)">
        <rect
          x="22"
          y="32"
          width="120"
          height="62"
          rx="31"
          fill="#F3BB67"
          stroke="#30251F"
          strokeWidth="3.5"
        />
        <path
          d="M43 41C24 47 26 77 45 83H119C140 78 143 48 123 41"
          fill="#F8D59A"
        />
        <rect
          x="29"
          y="43"
          width="107"
          height="35"
          rx="17.5"
          fill="#D8462D"
          stroke="#30251F"
          strokeWidth="3.5"
        />
        <path
          d="M45 56C51 45 56 72 63 60S72 48 78 61S89 71 96 58S107 48 113 61S122 66 124 60"
          stroke="#FFD563"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M47 86H116"
          stroke="#DEA04B"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>
      <path
        d="M134 15L137 7M145 25L153 23M22 94L16 102"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

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
      <header className="header">
        <a className="wordmark" href="/" aria-label="SeeFood home">
          SEEFOOD<span className="logo-dot">®</span>
        </a>
        <div className="header-actions">
          <button
            className="text-button"
            onClick={() => {
              setHelp((value) => !value)
              setInstallHelp(false)
            }}
            aria-expanded={help}
            aria-controls="how-it-works"
          >
            How it works <Info size={15} />
          </button>
          <button
            className="install-button"
            onClick={() => {
              void install()
              setHelp(false)
            }}
            disabled={installed}
            aria-expanded={installHelp}
          >
            <Download size={16} />
            {installed ? 'Installed' : 'Get the app'}
            <ArrowRight size={15} />
          </button>
        </div>
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
            <strong>A little curiosity. A photo of food.</strong>
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
            <strong>A little SeeFood, to go.</strong>
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
        <section className="intro" aria-labelledby="main-heading">
          <div className="eyebrow">
            <span />
            THE SHAZAM FOR FOOD
          </div>
          <h1 id="main-heading">
            See food.
            <br />
            <span>Know food.</span>
            <svg
              className="heading-spark"
              viewBox="0 0 58 61"
              aria-hidden="true"
            >
              <path
                d="M7 25L18 30M24 7L28 21M47 14L38 25M49 40L39 38"
                fill="none"
                stroke="currentColor"
                strokeWidth="5"
                strokeLinecap="round"
              />
            </svg>
          </h1>
          <p>
            Is it a hotdog? Is it not a hotdog?
            <br className="mobile-break" /> Let’s settle this.
          </p>
          <div className="hero-sticker">
            <Hotdog />
            <span>
              BIG QUESTIONS.
              <br />
              SIMPLE ANSWERS.
            </span>
          </div>
        </section>

        <section className="workspace" aria-label="Food image scanner">
          <div className="scanner-top">
            <span>
              <span className="status-dot" />
              {stage === 'loading'
                ? 'TAKING A LOOK'
                : stage === 'empty'
                  ? 'READY WHEN YOU ARE'
                  : 'FRESH OFF THE CAMERA'}
            </span>
            <span className="scanner-number">
              NO. 001 <ScanLine size={16} />
            </span>
          </div>
          <div
            className={`dropzone ${dragging ? 'dragging' : ''} ${photo ? 'has-photo' : ''}`}
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
            <i className="corner top-left" />
            <i className="corner top-right" />
            <i className="corner bottom-left" />
            <i className="corner bottom-right" />
            {photo ? (
              <div className="photo-layout">
                <div className="photo-frame">
                  <img
                    className="uploaded-photo"
                    src={photo.url}
                    alt={photo.name}
                  />
                  {stage === 'loading' && <div className="scan-beam" />}
                  <span className="photo-label">
                    {photo.kind ? 'SAMPLE PHOTO' : 'YOUR PHOTO'}
                  </span>
                </div>
                <div
                  className="photo-content"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {stage === 'loading' ? (
                    <>
                      <LoaderCircle className="spinner" size={38} />
                      <h2>Taking a look…</h2>
                      <p>One very important question.</p>
                      <span className="demo-label">SAMPLE DEMO</span>
                    </>
                  ) : stage === 'result' ? (
                    <>
                      <span
                        className={`result-symbol ${photo.kind === 'hotdog' ? 'positive' : 'negative'}`}
                      >
                        {photo.kind === 'hotdog' ? (
                          <Check size={38} strokeWidth={3} />
                        ) : (
                          <X size={38} strokeWidth={3} />
                        )}
                      </span>
                      <span className="demo-label">SAMPLE DEMO RESULT</span>
                      <h2 ref={resultHeading} tabIndex={-1}>
                        {photo.kind === 'hotdog' ? 'Hotdog!' : 'Not hotdog.'}
                      </h2>
                      <p>
                        {photo.kind === 'hotdog'
                          ? 'A bun. A sausage. A beautiful thing.'
                          : 'Still looks delicious, though.'}
                      </p>
                      <button className="primary-button" onClick={reset}>
                        <RotateCcw size={17} />
                        Try another photo
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="result-symbol preview-symbol">
                        <ImagePlus size={30} />
                      </span>
                      <span className="demo-label">PHOTO PREVIEW</span>
                      <h2 ref={resultHeading} tabIndex={-1}>
                        Nice shot.
                      </h2>
                      <p>
                        Your photo is ready. Food recognition isn’t connected
                        yet. Try a sample below to see the demo in action.
                      </p>
                      <button className="primary-button" onClick={reset}>
                        <RotateCcw size={17} />
                        Choose another photo
                      </button>
                    </>
                  )}
                </div>
                <button
                  className="remove-photo icon-button"
                  aria-label="Remove photo"
                  onClick={reset}
                >
                  <X size={19} />
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <div className="image-icon">
                  <ImagePlus size={33} strokeWidth={1.5} />
                  <span>
                    <Sparkles size={16} />
                  </span>
                </div>
                <h2>
                  {dragging
                    ? 'Drop it like it’s hot.'
                    : 'What’s on your plate?'}
                </h2>
                <p className="desktop-hint">
                  Paste an image or drop it right here.
                </p>
                <p className="mobile-hint">
                  Point. Snap. Satisfy your curiosity.
                </p>
                <div className="upload-actions">
                  <button
                    className="primary-button desktop-paste"
                    onClick={() => void pasteImage()}
                    disabled={clipboardBusy}
                  >
                    {clipboardBusy ? (
                      <LoaderCircle size={18} className="spinner" />
                    ) : (
                      <Clipboard size={18} />
                    )}
                    Paste an image
                    <span className="key-hint">{isMac ? '⌘' : 'Ctrl'} V</span>
                  </button>
                  <button
                    className="primary-button mobile-camera"
                    onClick={() => camera.current?.click()}
                  >
                    <Camera size={20} />
                    Scan food
                  </button>
                  <span className="action-or">or</span>
                  <button
                    className="upload-button"
                    onClick={() => input.current?.click()}
                  >
                    <Upload size={16} />
                    Upload image
                  </button>
                </div>
                <span className="file-hint">
                  JPG, PNG, WebP, GIF or AVIF · Up to 20 MB
                </span>
              </div>
            )}
            {dragging && photo && (
              <div className="drag-overlay">
                <ImagePlus size={35} />
                Drop a new photo here
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
          <div className="scanner-bottom">
            <span>
              <ShieldCheck size={15} />
              Your photos stay yours. Nothing is uploaded.
            </span>
            <span>100% curious.</span>
          </div>
        </section>

        <section className="samples" aria-labelledby="sample-heading">
          <div className="sample-intro">
            <span className="tiny-label">JUST LOOKING?</span>
            <h2 id="sample-heading">
              Take a little <br />
              taste test.
            </h2>
            <p>Try a sample. You know you want to.</p>
            <svg
              className="sample-arrow"
              viewBox="0 0 90 34"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3 5C20 27 46 29 80 18M70 10L82 18L74 29"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="sample-list">
            {samples.map((item, index) => (
              <button
                className={`sample-card ${photo?.url === item.url ? 'selected' : ''}`}
                key={item.url}
                onClick={() => sample(item)}
                aria-label={`Try sample: ${item.name}`}
              >
                <div className="sample-image">
                  <img
                    src={item.url}
                    alt={
                      index === 0
                        ? 'Hotdog with mustard and ketchup'
                        : index === 1
                          ? 'Pizza with fresh toppings'
                          : 'Cheeseburger with lettuce and tomato'
                    }
                  />
                  <span className="sample-index">0{index + 1}</span>
                  <span className="sample-go">
                    <ArrowRight size={18} />
                  </span>
                </div>
                <span className="sample-caption">
                  {item.name}
                  <ChevronRight size={14} />
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="manifesto">
          <span>ONE PHOTO.</span>
          <span>TWO POSSIBILITIES.</span>
          <span>ZERO OVERTHINKING.</span>
          <Hotdog />
        </section>
      </main>
      <footer>
        <a className="footer-logo" href="/">
          SEEFOOD
        </a>
        <p>Made for the love of food. And a little bit of nonsense.</p>
        <span className="footer-note">
          A deliciously simple demo <ArrowDown size={13} />
        </span>
      </footer>
      <div className="checkerboard" aria-hidden="true" />
    </div>
  )
}
