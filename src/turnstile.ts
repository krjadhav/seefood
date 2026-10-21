// Cloudflare Turnstile: mint a fresh, single-use token per classify so the
// backend can prove the request came from a real browser on our domain.
// The site key is public; the secret lives server-side (Secret Manager).

const SITE_KEY =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '0x4AAAAAAFfGQ3n6ANsQ2AAZ'
const ACTION = 'classify'

type Turnstile = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  execute: (id: string, opts?: Record<string, unknown>) => void
  reset: (id: string) => void
}
const ts = () => (window as unknown as { turnstile?: Turnstile }).turnstile

let widgetId: string | null = null
let resolver: ((token: string) => void) | null = null

function ensureWidget(): boolean {
  const api = ts()
  if (!api || !SITE_KEY) return false
  if (widgetId === null) {
    const el = document.createElement('div')
    // Rendered but out of the way; interaction-only keeps it invisible unless a
    // challenge is actually required (then it appears bottom-left).
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999'
    document.body.appendChild(el)
    widgetId = api.render(el, {
      sitekey: SITE_KEY,
      action: ACTION,
      execution: 'execute',
      appearance: 'interaction-only', // invisible unless a challenge is needed
      callback: (token: string) => {
        resolver?.(token)
        resolver = null
      },
      'error-callback': () => {
        resolver?.('')
        resolver = null
      },
    })
  }
  return true
}

// Wait up to ~6s for the async-loaded Turnstile script to define window.turnstile.
function waitForApi(): Promise<Turnstile | null> {
  if (ts()) return Promise.resolve(ts() ?? null)
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (ts() || Date.now() - started > 6000) {
        clearInterval(timer)
        resolve(ts() ?? null)
      }
    }, 100)
  })
}

// Resolves to a token, or '' if Turnstile isn't available (dev) or times out —
// the caller sends it as the cf-turnstile-response header.
export async function getTurnstileToken(timeoutMs = 8000): Promise<string> {
  const api = await waitForApi()
  if (!api || !ensureWidget() || widgetId === null) return ''
  return new Promise<string>((resolve) => {
    let done = false
    const finish = (t: string) => {
      if (done) return
      done = true
      resolver = null
      try {
        api.reset(widgetId as string)
      } catch {
        /* ignore */
      }
      resolve(t)
    }
    const id = widgetId as string
    resolver = finish
    setTimeout(() => finish(''), timeoutMs)
    try {
      api.execute(id, { action: ACTION })
    } catch {
      finish('')
    }
  })
}
