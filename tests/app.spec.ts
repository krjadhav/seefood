import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('responsive layout and native mobile camera input', async ({
  page,
}, testInfo) => {
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
    await expect(
      page.getByRole('heading', { name: 'Nice shot.' }),
    ).toBeVisible()
  } else {
    await expect(
      page.getByRole('button', { name: 'Paste an image' }),
    ).toBeVisible()
  }
})

test('upload stays local, previews the image, and resets', async ({ page }) => {
  const outgoingUploads: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') outgoingUploads.push(request.url())
  })
  await page.goto('/')
  await page
    .getByLabel('Upload a food image')
    .setInputFiles('public/images/burger.jpg')
  await expect(page.getByRole('heading', { name: 'Nice shot.' })).toBeVisible()
  await expect(page.locator('.uploaded-photo')).toHaveAttribute('src', /^blob:/)
  await expect(
    page.getByText('Food recognition isn’t connected yet.', { exact: false }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Choose another photo' }).click()
  await expect(
    page.getByRole('heading', { name: 'Let’s Get Started' }),
  ).toBeVisible()
  expect(outgoingUploads).toEqual([])
})

test('clipboard paste creates an image preview', async ({ page }) => {
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
  await expect(page.getByRole('heading', { name: 'Nice shot.' })).toBeVisible()
})

test('paste button reads an image from the browser clipboard', async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile',
    'Mobile uses the native camera action instead.',
  )
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
  await expect(page.getByRole('heading', { name: 'Nice shot.' })).toBeVisible()
})

test('small phones fit without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/')
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  )
})

test('drag and drop previews an image', async ({ page }) => {
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
  await expect(page.getByRole('heading', { name: 'Nice shot.' })).toBeVisible()
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

test('samples show distinct, clearly marked demo results', async ({ page }) => {
  await page.goto('/')
  await page
    .getByRole('button', { name: 'Try sample: The classic hotdog' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Evaluating...' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Hotdog', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('SAMPLE DEMO RESULT')).toBeVisible()
  await page
    .getByRole('button', { name: 'Try sample: A slice of possibility' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Not hotdog', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Try another photo' }).click()
  await expect(
    page.getByRole('heading', { name: 'Let’s Get Started' }),
  ).toBeVisible()
})

test('a replaced sample cannot overwrite a new photo', async ({ page }) => {
  await page.goto('/')
  await page
    .getByRole('button', { name: 'Try sample: The classic hotdog' })
    .click()
  await page
    .getByLabel('Upload a food image')
    .setInputFiles('public/images/pizza.jpg')
  await expect(page.getByRole('heading', { name: 'Nice shot.' })).toBeVisible()
  await page.waitForTimeout(1300)
  await expect(page.getByRole('heading', { name: 'Nice shot.' })).toBeVisible()
})

test('help and installation instructions are dismissible', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'How it works' }).click()
  await expect(
    page.getByRole('region', { name: 'How it works' }),
  ).toContainText('Recognition for your own photos isn’t connected yet')
  await page.getByRole('button', { name: 'Close how it works' }).click()
  await expect(
    page.getByRole('region', { name: 'How it works' }),
  ).not.toBeVisible()
  // Keep this deterministic whether Chrome exposes its native install prompt or not.
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.getByRole('button', { name: 'Installed' })).toBeDisabled()
})

test('production PWA reloads offline with samples and local fonts', async ({
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
  await page
    .getByRole('button', { name: 'Try sample: The classic hotdog' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Hotdog', exact: true }),
  ).toBeVisible()
  expect(
    await page
      .locator('.uploaded-photo')
      .evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0)
  expect(
    await page.evaluate(() => document.fonts.check('16px "Titan One"')),
  ).toBe(true)
  await context.setOffline(false)
})
