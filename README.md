# SeeFood

A mobile-first PWA recreating the SeeFood interface from _Silicon Valley_, now
wired to a real classifier. Instead of only "Hotdog / Not Hotdog", it names the
food it sees (or says **Not Food**) using a local **EmbeddingGemma 2** model.
Built with React, TypeScript, and Vite, with a small FastAPI backend.

The main screen follows the supplied reference: a bright red logo header, black-outlined white lettering, a white tagline strip, stacked salmon/pasta photography, and large text over the photos. Evaluation uses a ring of red dots and outlined lettering; results use a green top banner (food name) or red bottom banner (Not Food) with a large check or cross, plus a side panel showing the model's top label matches and metadata.

## How recognition works

The image and the candidate labels share one multimodal embedding space. The
backend embeds the pasted image, cosine-ranks a list of food and non-food
labels against it, and returns the top food name — or `Not Food` when a non-food
label wins. See [`server/README.md`](server/README.md).

## Run locally

Requires Node.js 20.19+ or 22.12+, Python 3.11+, and the model weights in
`google_embeddinggemma_2/`.

Start the backend (first run downloads Python deps and is slow to warm up):

```sh
pip install -r server/requirements.txt
uvicorn main:app --app-dir server --port 8000
```

Then the frontend (Vite proxies `/api` to the backend on port 8000):

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite, then paste, drop, upload, or scan a photo.
To test the production build and offline behavior:

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
- Send the image to the local backend, show an `Evaluating...` state, then the recognized food name or `Not Food`.
- Read the side panel: the top label matches with cosine scores and the full model metadata (device, dtype, embedding dimension and norm, image tokens, inference time, image and upload size).
- Try three sample photos routed through the same classifier.
- Install through a supported browser’s PWA prompt or follow the built-in home-screen instructions.
- Reload offline after the production service worker has installed. The app shell, sample images, and fonts are cached locally.
- Keyboard focus states, accessible controls, screen reader announcements, and reduced-motion support.

## Scope and privacy

Recognition runs against the **local** FastAPI backend — images are posted to
`/api/classify` on your own machine, not to any third-party service. There are
no API keys, accounts, or analytics. If the backend isn't running, the UI shows
a clear error instead of a result.

Clipboard button access requires HTTPS or localhost and browser permission. Standard keyboard paste is the fallback. Camera capture is a browser/device capability; the frontend does not directly request a live camera stream.

## Checks

```sh
npm run build
npm test
```

Tests use locally installed Google Chrome. In CI, they use Playwright Chromium; install it with `npx playwright install --with-deps chromium`. Playwright starts the production preview server automatically and **mocks `/api/classify`**, so the model backend is not needed to run tests. Tests cover desktop and mobile viewports, the Evaluating → result flow, the Not Food verdict, the metadata panel, backend-outage errors, paste, drag-and-drop, invalid files, camera chooser wiring, and offline reloads.

```sh
npm run format
```

## Deploy

Deploy `dist/` to any HTTPS static host **at the domain root**. The manifest, service worker, and asset URLs use `/`; subdirectory hosting such as `/seefood/` needs base-path changes first. No server-side runtime or environment variables are needed. Serve `sw.js` with revalidation (`Cache-Control: no-cache`), and use long-lived caching for Vite’s content-hashed assets. Service workers register only in production. Updates activate when existing app tabs close, avoiding a forced refresh mid-upload.

The GitHub repository stores source code; pushing it does not deploy a public website.

## Assets

All UI icons are Lucide icons (ISC license). The hotdog illustration and app icons are custom SVG artwork. Fonts are self-hosted under the SIL Open Font License, included in `public/fonts/licenses/`:

- [DM Sans](https://fonts.google.com/specimen/DM+Sans)
- [Titan One](https://fonts.google.com/specimen/Titan+One)

Sample photography is downloaded from Unsplash and bundled for offline use:

- [Hotdog, Jessica Loaiza](https://unsplash.com/photos/glqTtszXfM0)
- [Pizza](https://images.unsplash.com/photo-1513104890138-7c749659a591)
- [Burger](https://images.unsplash.com/photo-1551782450-a2132b4ba21d)
- [Salmon, Anna Volkova](https://unsplash.com/photos/LeU-Tdabc5E)
- [Shrimp pasta, Eduardo Gonzalez](https://unsplash.com/photos/rqnK9xwDg5c)

See the [Unsplash license](https://unsplash.com/license).
