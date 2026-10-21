import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

type Overrides = {
  isFood?: boolean
  name?: string
  topLabel?: string
  source?: 'text' | 'prototype'
  prototypeDish?: string
}

// Deterministic stand-in for the EmbeddingGemma 2 backend so the UI can be
// tested without loading the model. Every test that uploads an image installs
// one of these before acting.
function verdict({
  isFood = true,
  name = 'Pizza',
  topLabel = 'pizza',
  source = 'prototype',
  prototypeDish = 'biryani',
}: Overrides = {}) {
  return {
    isFood,
    name,
    source,
    topLabel,
    foodProbability: isFood ? 0.9 : 0.4,
    topSimilarity: 0.671,
    top: [
      { label: topLabel, similarity: 0.671, probability: 0.02, isFood },
      {
        label: 'bruschetta',
        similarity: 0.66,
        probability: 0.018,
        isFood: true,
      },
      { label: 'a dog', similarity: 0.59, probability: 0.01, isFood: false },
    ],
    prototype: {
      dish: prototypeDish,
      similarity: 0.22,
      margin: 0.03,
      fromKhana: true,
      used: source === 'prototype',
      top: [
        { dish: prototypeDish, similarity: 0.22 },
        { dish: 'pulao', similarity: 0.19 },
      ],
    },
    dish: isFood
      ? {
          name,
          course: 'snack',
          flavor: 'spicy',
          diet: 'vegetarian',
          region: 'South',
          state: '',
          ingredients: 'rice, lentils',
        }
      : null,
    rankedDishes: isFood
      ? {
          Dosa: {
            course: 'snack',
            flavor: 'spicy',
            diet: 'vegetarian',
            region: 'South',
            state: '',
            ingredients: 'rice, lentils',
          },
          [name]: {
            course: 'snack',
            flavor: 'spicy',
            diet: 'vegetarian',
            region: 'South',
            state: '',
            ingredients: 'rice, lentils',
          },
        }
      : {},
    described: isFood
      ? [
          {
            name: 'Dosa',
            similarity: 0.74,
            course: 'snack',
            flavor: 'spicy',
            region: 'South',
            hasPhoto: false,
          },
          {
            name: prototypeDish,
            similarity: 0.73,
            course: 'snack',
            flavor: 'spicy',
            region: 'South',
            hasPhoto: true,
          },
        ]
      : [],
    metadata: {
      model: 'google/embeddinggemma-2',
      architecture: 'EmbeddingGemma2Model',
      device: 'cpu',
      dtype: 'float32',
      embeddingDim: 768,
      embeddingNorm: 1.0,
      imageTokens: 280,
      candidateLabels: 7400,
      catalogDishes: 7100,
      dishPrototypes: 6900,
      khanaPrototypes: 80,
      protoScoring: 'mean-centered cosine',
      softmaxTemperature: 0.05,
      inferenceMs: 12,
      imageSize: { width: 10, height: 10 },
      uploadBytes: 100,
      backend: 'multimodalembedding@001 d1408 (vertex)',
      host: 'test',
    },
  }
}

async function mockClassify(page: Page, overrides?: Overrides) {
  await page.route('**/api/classify', async (route) => {
    // Hold briefly so the transient "Evaluating..." state is observable.
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.fulfill({ json: verdict(overrides) })
  })
}

test('responsive layout and native mobile camera input', async ({
  page,
}, testInfo) => {
  await mockClassify(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'SEEFOOD' })).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  if (testInfo.project.name === 'mobile') {
    await expect(page.getByRole('button', { name: 'Scan food' })).toBeVisible()
    await expect(page.getByLabel('Take a food photo')).toHaveAttribute(
      'capture',
      'environment',
    )
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Scan food' }).click()
    await (await chooser).setFiles('public/images/burger.jpg')
    await expect(page.locator('.result-banner h2')).toHaveText('Pizza')
  } else {
    await expect(
      page.getByRole('button', { name: 'Paste an image' }),
    ).toBeVisible()
  }
})

test('upload shows Evaluating, posts to the classifier, then a result', async ({
  page,
}) => {
  const posted: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') posted.push(new URL(request.url()).pathname)
  })
  await mockClassify(page)
  await page.goto('/')
  await page
    .getByLabel('Upload a food image')
    .setInputFiles('public/images/burger.jpg')
  await expect(
    page.getByRole('heading', { name: 'Evaluating...' }),
  ).toBeVisible()
  await expect(page.locator('.result-banner h2')).toHaveText('Pizza')
  await expect(page.locator('.uploaded-photo')).toHaveAttribute('src', /^blob:/)
  expect(posted).toEqual(['/api/classify'])
  await page.getByRole('button', { name: 'Try another photo' }).click()
  await expect(
    page.getByRole('heading', { name: 'Let’s Get Started' }),
  ).toBeVisible()
})

test('non-food images report Not Food', async ({ page }) => {
  await mockClassify(page, {
    isFood: false,
    name: 'Not Food',
    topLabel: 'a dog',
    source: 'text',
  })
  await page.goto('/')
  await page
    .getByLabel('Upload a food image')
    .setInputFiles('public/images/pizza.jpg')
  await expect(page.locator('.result-banner h2')).toHaveText('Not Food')
  await expect(page.locator('.result-banner.not-food')).toBeVisible()
})

test('clipboard paste classifies an image', async ({ page }) => {
  await mockClassify(page)
  await page.goto('/')
  const bytes = Array.from(readFileSync('public/images/hotdog.jpg'))
  await page.evaluate((data) => {
    const clipboardData = new DataTransfer()
    clipboardData.items.add(
      new File([new Uint8Array(data)], 'clipboard.jpg', { type: 'image/jpeg' }),
    )
    document.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true }),
    )
  }, bytes)
  await expect(page.locator('.result-banner h2')).toHaveText('Pizza')
})

test('paste button reads an image from the browser clipboard', async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile',
    'Mobile uses the native camera action instead.',
  )
  await mockClassify(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await page.evaluate(async () => {
    const image = new Image()
    image.src = '/images/hotdog.jpg'
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    canvas.getContext('2d')!.drawImage(image, 0, 0)
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((value) => resolve(value!), 'image/png'),
    )
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
  await page.getByRole('button', { name: 'Paste an image' }).click()
  await expect(page.locator('.result-banner h2')).toHaveText('Pizza')
})

test('small phones fit without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/')
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  )
})

test('drag and drop classifies an image', async ({ page }) => {
  await mockClassify(page)
  await page.goto('/')
  const bytes = Array.from(readFileSync('public/images/pizza.jpg'))
  const dataTransfer = await page.evaluateHandle((data) => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([new Uint8Array(data)], 'pizza.jpg', { type: 'image/jpeg' }),
    )
    return transfer
  }, bytes)
  await page.locator('.dropzone').dispatchEvent('drop', { dataTransfer })
  await expect(page.locator('.result-banner h2')).toHaveText('Pizza')
})

test('rejects unsupported, corrupt, and oversized images', async ({ page }) => {
  await page.goto('/')
  const input = page.getByLabel('Upload a food image')
  await input.setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  })
  await expect(page.getByRole('alert')).toContainText('isn’t a supported image')
  await input.setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('broken image'),
  })
  await expect(page.getByRole('alert')).toContainText(
    'couldn’t open that image',
  )
  await input.setInputFiles({
    name: 'large.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
  })
  await expect(page.getByRole('alert')).toContainText('smaller than 20 MB')
})

test('a backend outage surfaces a clear error', async ({ page }) => {
  await page.route('**/api/classify', (route) => route.abort())
  await page.goto('/')
  await page
    .getByLabel('Upload a food image')
    .setInputFiles('public/images/pizza.jpg')
  await expect(page.getByRole('alert')).toContainText(
    'Couldn’t reach the recognition service',
  )
})

test('samples run through the classifier', async ({ page }) => {
  await mockClassify(page, { name: 'Biryani', prototypeDish: 'biryani' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Try sample: Biryani' }).click()
  await expect(page.locator('.result-banner h2')).toHaveText('Biryani')
  await page.getByRole('button', { name: 'Try another photo' }).click()
  await expect(
    page.getByRole('heading', { name: 'Let’s Get Started' }),
  ).toBeVisible()
})

test('production PWA reloads offline with the app shell and local fonts', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'SEEFOOD' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('You’re offline')
  expect(
    await page.evaluate(() => document.fonts.check('16px "Titan One"')),
  ).toBe(true)
  await context.setOffline(false)
})
