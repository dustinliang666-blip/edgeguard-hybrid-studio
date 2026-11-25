import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const parentDir = resolve('dist-extension')
const tokenSentinel = 'DEBUG_TOKEN_MUST_NOT_APPEAR_IN_PRODUCTION_ARTIFACTS'
let testDir: string
let extensionDir: string
let webDir: string

beforeAll(async () => {
  mkdirSync(parentDir, { recursive: true })
  testDir = mkdtempSync(resolve(parentDir, '.verification-'))
  extensionDir = resolve(testDir, 'extension')
  webDir = resolve(testDir, 'web')
  vi.stubEnv('VITE_FIREBASE_APPCHECK_DEBUG_TOKEN', tokenSentinel)
  try {
    for (const [mode, outDir] of [['extension', extensionDir], ['production', webDir]]) {
      await build({ mode, logLevel: 'silent', build: { outDir, emptyOutDir: true } })
    }
  } finally {
    vi.unstubAllEnvs()
  }
}, 30_000)

afterAll(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true })
})

function readBundle(directory: string, entry: string) {
  const html = readFileSync(resolve(directory, entry), 'utf8')
  const script = html.match(/<script[^>]+src="(\.\/assets\/[^"]+\.js)"/)?.[1]
  const style = html.match(/<link[^>]+href="(\.\/assets\/[^"]+\.css)"/)?.[1]
  if (!script || !style) throw new Error('Missing local JS or CSS bundle.')
  return {
    html,
    js: readFileSync(resolve(directory, script), 'utf8'),
    css: readFileSync(resolve(directory, style), 'utf8'),
  }
}

interface MockFrame {
  selection?: string
  page?: string
  iframeFocused?: boolean
  focused?: boolean
}

function mockWorker(main: MockFrame = { selection: '   Selected text.  ' }, subframes: MockFrame[] = []) {
  const onInstalled = vi.fn()
  const onStartup = vi.fn()
  const onMessage = vi.fn()
  const setPanelBehavior = vi.fn()
  const query = vi.fn(async () => [{ id: 42 }])
  const chrome = {
    runtime: {
      id: 'fixture',
      onInstalled: { addListener: onInstalled },
      onStartup: { addListener: onStartup },
      onMessage: { addListener: onMessage },
      getURL: (file: string) => 'chrome-extension://fixture/' + file,
    },
    sidePanel: { setPanelBehavior },
    tabs: { query },
    scripting: {
      executeScript: vi.fn(async ({ target, func, args }: {
        target: { tabId: number; allFrames: boolean }
        func: (maxLength: number, allFrames: boolean) => object
        args: [number, boolean]
      }) => (target.allFrames ? [main, ...subframes] : [main]).map((frame, frameId) => {
        const document = {
          body: { innerText: frame.page ?? 'fallback page' },
          activeElement: frame.iframeFocused ? {
            tagName: 'IFRAME',
            get contentWindow() { throw new Error('Cross-origin frame') },
          } : null,
          hasFocus: () => frame.focused ?? false,
        }
        const window = { getSelection: () => frame.selection ?? '', document, top: {} }
        if (frameId === 0) window.top = window
        const call = '(' + func.toString() + ')(...args)'
        return { frameId, result: runInNewContext(call, { args, window, document }) }
      })),
    },
  }
  runInNewContext(readFileSync(resolve(extensionDir, 'background.js'), 'utf8'), { chrome })
  return { ...chrome, onInstalled, onStartup, onMessage, setPanelBehavior, query }
}

async function capture(worker: ReturnType<typeof mockWorker>) {
  const listener = worker.onMessage.mock.calls[0][0]
  return new Promise((respond) => {
    expect(listener({ type: 'edgeguard:capture-active-tab', windowId: 9 }, {
      id: 'fixture', url: 'chrome-extension://fixture/sidepanel.html',
    }, respond)).toBe(true)
  })
}

describe('packaged Chrome side panel', () => {
  it('ships a valid least-privilege MV3 manifest and its declared worker and entry', () => {
    const manifest = JSON.parse(readFileSync(resolve(extensionDir, 'manifest.json'), 'utf8'))
    expect(manifest).toEqual(JSON.parse(readFileSync(resolve('extension', 'manifest.json'), 'utf8')))
    expect(manifest).toMatchObject({
      manifest_version: 3,
      minimum_chrome_version: '116',
      permissions: ['sidePanel', 'activeTab', 'scripting'],
      action: { default_title: expect.any(String) },
      side_panel: { default_path: 'sidepanel.html' },
      background: { service_worker: 'background.js' },
      content_security_policy: { extension_pages: "script-src 'self'; object-src 'self';" },
    })
    expect(manifest).not.toHaveProperty('host_permissions')
    expect(manifest).not.toHaveProperty('content_scripts')
    expect(readFileSync(resolve(extensionDir, manifest.background.service_worker), 'utf8')).toContain('chrome.sidePanel')
    for (const icon of Object.values<string>(manifest.icons ?? {})) {
      expect(readFileSync(resolve(extensionDir, icon)).length).toBeGreaterThan(0)
    }
  })

  it('resolves the extension and Web app HTML, JS and CSS and keeps debug env values out', () => {
    for (const [directory, entry] of [[extensionDir, 'sidepanel.html'], [webDir, 'index.html']]) {
      const { html, js, css } = readBundle(directory, entry)
      expect(html).toContain('<div id="root"></div>')
      expect(html).not.toMatch(/https?:\/\/|<script[^>]*>[^<]+/)
      expect(css).toContain('.workspace')
      expect(js).toContain('gemini-2.5-flash')
      expect(js).toContain('prefer_on_device')
      expect(js).toContain('prefer_in_cloud')
      expect(js).toContain('Sandbox Simulation')
      expect(js).toContain('Local LanguageModel API not available in this environment.')
      expect(js).not.toContain(tokenSentinel)
    }
  })

  it('registers toolbar behavior and captures a selection on a verified side-panel request', async () => {
    const worker = mockWorker()
    await worker.onInstalled.mock.calls[0][0]()
    await worker.onStartup.mock.calls[0][0]()
    expect(worker.setPanelBehavior).toHaveBeenCalledTimes(2)
    expect(worker.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true })
    expect(worker.query).not.toHaveBeenCalled()

    const listener = worker.onMessage.mock.calls[0][0]
    const request = { type: 'edgeguard:capture-active-tab', windowId: 9 }
    const result = await new Promise((respond) => {
      expect(listener(request, { id: 'fixture', url: 'chrome-extension://fixture/sidepanel.html' }, respond)).toBe(true)
    })
    expect(worker.query).toHaveBeenCalledExactlyOnceWith({ active: true, windowId: 9 })
    expect(worker.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 42, allFrames: true } }))
    expect(result).toEqual({ ok: true, text: 'Selected text.', from: 'selection', truncated: false })
  })

  it('rejects untrusted senders', () => {
    const worker = mockWorker()
    const listener = worker.onMessage.mock.calls[0][0]
    const request = { type: 'edgeguard:capture-active-tab', windowId: 9 }
    expect(listener(request, { id: 'fixture', url: 'https://example.test' }, vi.fn())).toBe(false)
    expect(listener({ ...request, windowId: -1 }, { id: 'fixture', url: 'chrome-extension://fixture/sidepanel.html' }, vi.fn())).toBe(false)
    expect(worker.query).not.toHaveBeenCalled()
  })

  it('drops an entire synthetic SSN that straddles the capture limit', async () => {
    const prefix = 'a'.repeat(15_993)
    const worker = mockWorker({ page: prefix + '\n000-12-3456 trailing text' })
    expect(await capture(worker)).toEqual({ ok: true, text: prefix, from: 'page', truncated: true })
  })

  it('drops the entire line when a space-grouped card straddles the capture limit', async () => {
    const prefix = 'a'.repeat(15_980)
    const page = prefix + '\nCard 4111 1111 1111 1111 trailing text'
    expect(await capture(mockWorker({ page })))
      .toEqual({ ok: true, text: prefix, from: 'page', truncated: true })
  })

  it.each([
    ['4111 1111 1111 1111', 12],
    ['4111 1111 1111 1111', 14],
    ['4111-1111 1111-1111', 12],
    ['+1 (415) 555-0136', 12],
  ])('drops all trailing groups of %s in a single line cut after %s characters', async (identifier, cutoff) => {
    const prefix = 'a'.repeat(15_999 - cutoff)
    expect(await capture(mockWorker({ page: prefix + ' ' + identifier + ' trailing text' })))
      .toEqual({ ok: true, text: prefix, from: 'page', truncated: true })
  })

  it('drops the leading 12 digits when a newline separates group 3 and group 4 of a grouped card at the limit', async () => {
    const prefix = 'a'.repeat(15_980)
    const result = await capture(mockWorker({ page: prefix + '\n4111 1111 1111\n1111 trailing text' })) as {
      ok: boolean
      text?: string
      truncated?: boolean
    }
    expect(result).toEqual({ ok: true, text: prefix, from: 'page', truncated: true })
    expect(result.text).not.toContain('4111')
  })

  it('drops labeled cross-line grouped card digits before the newline cutoff', async () => {
    const prefix = 'a'.repeat(15_974)
    const result = await capture(mockWorker({ page: prefix + '\nCard: 4111 1111 1111\n1111 trailing text' })) as {
      ok: boolean
      text?: string
      truncated?: boolean
    }
    expect(result).toEqual({ ok: true, text: prefix + '\nCard:', from: 'page', truncated: true })
    expect(result.text).not.toContain('4111')
  })

  it('drops underscore-prefixed cross-line grouped card tokens completely at the newline cutoff', async () => {
    const prefix = 'a'.repeat(15_975)
    const result = await capture(mockWorker({ page: prefix + '\ncard_4111 1111 1111\n1111 trailing text' })) as {
      ok: boolean
      text?: string
      truncated?: boolean
    }
    expect(result).toEqual({ ok: true, text: prefix, from: 'page', truncated: true })
    expect(result.text).not.toContain('4111')
  })

  it('drops vertically wrapped newline-delimited card groups straddling the limit', async () => {
    const prefix = 'a'.repeat(15_980)
    const result = await capture(mockWorker({ page: prefix + '\n4111\n1111\n1111\n1111 trailing text' })) as {
      ok: boolean
      text?: string
      truncated?: boolean
    }
    expect(result).toEqual({ ok: true, text: prefix, from: 'page', truncated: true })
    expect(result.text).not.toContain('4111')
  })

  it('preserves benign multi-line prose ending with a number before non-numeric next line', async () => {
    const prefix = 'a'.repeat(15_985)
    const expected = prefix + '\nCount: 42'
    expect(await capture(mockWorker({ page: prefix + '\nCount: 42\nSummary next line trailing' })))
      .toEqual({ ok: true, text: expected, from: 'page', truncated: true })
  })

  it('keeps a complete token ending at the capture limit', async () => {
    const prefix = 'a'.repeat(16_000)
    expect(await capture(mockWorker({ page: prefix + ' extra' })))
      .toEqual({ ok: true, text: prefix, from: 'page', truncated: true })
  })

  it('reports an overlong single-token selection without importing fallback page text', async () => {
    expect(await capture(mockWorker({ selection: 'a'.repeat(16_010) })))
      .toEqual({ ok: false, error: expect.stringMatching(/No complete token fits/) })
  })

  it('captures text selected in an accessible focused iframe', async () => {
    const worker = mockWorker(
      { iframeFocused: true, selection: 'stale selection in the outer page' },
      [{ selection: 'stale sibling selection' }, { selection: '  selected in iframe  ', focused: true }],
    )
    expect(await capture(worker)).toEqual({ ok: true, text: 'selected in iframe', from: 'selection', truncated: false })
  })

  it('reports ambiguous selections when neither frame has focus', async () => {
    const worker = mockWorker(
      { iframeFocused: true, page: 'private outer-page text' },
      [{ selection: 'first selection', focused: false }, { selection: 'second selection', focused: false }],
    )
    expect(await capture(worker)).toEqual({
      ok: false,
      error: expect.stringMatching(/Paste the intended snippet or refocus its frame/),
    })
  })

  it.each([false, true])('does not import the outer page when the focused iframe is unreadable (injection rejects: %s)', async (rejects) => {
    const worker = mockWorker({ iframeFocused: true, page: 'private outer-page text' })
    if (rejects) worker.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access a frame'))
    expect(await capture(worker)).toEqual({ ok: false, error: expect.stringMatching(/could not read a selection in the focused frame/) })
    if (rejects) {
      expect(worker.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ target: { tabId: 42, allFrames: false } }))
    }
  })

  it('reports restricted-tab errors without exposing browser error details', async () => {
    const worker = mockWorker()
    worker.scripting.executeScript.mockRejectedValue(new Error('Sensitive browser error detail'))
    const listener = worker.onMessage.mock.calls[0][0]
    const result = await new Promise((respond) => {
      listener({ type: 'edgeguard:capture-active-tab', windowId: 9 }, {
        id: 'fixture', url: 'chrome-extension://fixture/sidepanel.html',
      }, respond)
    })
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Chrome could not read this tab/) })
  })
})
