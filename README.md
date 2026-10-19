# SeeFood

A playful, mobile-first frontend PWA inspired by the “hotdog / not hotdog” SeeFood reference. Built with React, TypeScript, and Vite.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. To test the installable production build and offline behavior:

```sh
npm run build
npm run preview
```

## What works

- Paste images anywhere with Cmd/Ctrl + V, or use the desktop Paste button.
- Drag and drop images or select a file.
- On mobile, Scan food opens the device’s camera-capable file picker using `capture="environment"`. The exact chooser depends on the device and browser.
- Preview local images, replace them, and reset. Uploads never leave the browser and aren’t persisted.
- Validate file type, 20 MB size limit, and image decoding. Supported formats: JPEG, PNG, WebP, GIF, AVIF. Convert HEIC images to JPEG or PNG first.
- Try three sample photos with loading, hotdog, and not-hotdog demo states.
- Install through a supported browser’s PWA prompt or follow the built-in home-screen instructions.
- Reload offline after the production service worker has installed. The app shell, sample images, and fonts are cached locally.
- Keyboard focus states, accessible controls, screen reader announcements, and reduced-motion support.

## Frontend scope

**Food recognition is not connected.** Sample results are predetermined and explicitly marked as demos. User-provided images show a preview and explain the missing classifier. There are no arbitrary predictions, API keys, accounts, analytics, or backend services.

Clipboard button access requires HTTPS or localhost and browser permission. Standard keyboard paste is the fallback. Camera capture is a browser/device capability; the frontend does not directly request a live camera stream.

## Checks

```sh
npm run build
npm test
```

Tests use locally installed Google Chrome. In CI, they use Playwright Chromium; install it with `npx playwright install --with-deps chromium`. Playwright starts the production preview server automatically. Tests cover desktop and mobile viewports, local upload privacy, paste, drag-and-drop, invalid files, sample state transitions, camera chooser wiring, install UI, and offline reloads.

```sh
npm run format
```

## Deploy

Deploy `dist/` to any HTTPS static host **at the domain root**. The manifest, service worker, and asset URLs use `/`; subdirectory hosting such as `/seefood/` needs base-path changes first. No server-side runtime or environment variables are needed. Serve `sw.js` with revalidation (`Cache-Control: no-cache`), and use long-lived caching for Vite’s content-hashed assets. Service workers register only in production. Updates activate when existing app tabs close, avoiding a forced refresh mid-upload.

The GitHub repository stores source code; pushing it does not deploy a public website.

## Assets

All UI icons are Lucide icons (ISC license). The hotdog illustration and app icons are custom SVG artwork. Fonts are self-hosted under the SIL Open Font License, included in `public/fonts/licenses/`:

- [DM Sans](https://fonts.google.com/specimen/DM+Sans)
- [Lilita One](https://fonts.google.com/specimen/Lilita+One)

Sample photography is downloaded from Unsplash and bundled for offline use:

- [Hotdog, Jessica Loaiza](https://unsplash.com/photos/glqTtszXfM0)
- [Pizza](https://images.unsplash.com/photo-1513104890138-7c749659a591)
- [Burger](https://images.unsplash.com/photo-1551782450-a2132b4ba21d)

See the [Unsplash license](https://unsplash.com/license).
