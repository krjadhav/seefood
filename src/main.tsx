import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// Warm up the serverless backend the moment the page loads, before the user
// picks a photo. Cloud Run scales to zero, so the first scan otherwise pays a
// cold start; this fire-and-forget ping to the unguarded health endpoint boots
// the container (~5s) while the user is still choosing, hiding the delay.
const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
void fetch(`${apiBase}/api/health`, { cache: 'no-store' }).catch(() => {})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Offline mode could not be enabled.', error)
    })
  })
}
