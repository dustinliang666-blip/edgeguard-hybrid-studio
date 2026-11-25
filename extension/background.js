const maxCaptureLength = 16_000

async function enableSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  } catch {
    // Chrome can shut down the worker while the browser is closing.
  }
}

chrome.runtime.onInstalled.addListener(enableSidePanel)
chrome.runtime.onStartup.addListener(enableSidePanel)

async function captureActiveTab(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId })
  if (tab?.id === undefined) return { ok: false, error: 'No active tab was found.' }

  const inject = (allFrames) => chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames },
    args: [maxCaptureLength, allFrames],
    func: (maxLength, allFrames) => {
      let source = window
      const iframeFocused = document.activeElement?.tagName === 'IFRAME'
      const inTopFrame = window === window.top
      if (!allFrames && iframeFocused) {
        // Chrome can reject an all-frames injection if a frame is inaccessible.
        // Follow the focused frame from the top document where same-origin access permits.
        try {
          while (source.document.activeElement?.tagName === 'IFRAME') {
            source = source.document.activeElement.contentWindow
            if (!source) return { iframeFocused }
          }
        } catch {
          return { iframeFocused }
        }
      }
      const selection = (allFrames && iframeFocused) ? '' : source.getSelection()?.toString().trim()
      const pageFallback = inTopFrame && !iframeFocused
      const text = selection || (pageFallback ? document.body?.innerText.trim() : '') || ''
      if (!selection && !pageFallback) return { iframeFocused }

      let end = Math.min(text.length, maxLength)
      if (text.length > maxLength) {
        const newline = text.lastIndexOf('\n', maxLength - 1)
        if (newline >= 0) {
          end = newline
        } else if (/\S/.test(text[end])) {
          while (end > 0 && /\S/.test(text[end - 1])) end--
        }
        // Card, SSN, and phone groups can span spaces, punctuation, or line breaks.
        // Roll back trailing numeric groups on single-line cuts OR when a newline cut
        // sits immediately before a numeric-group continuation in the dropped tail.
        let probe = end
        while (probe < text.length && /\s/.test(text[probe])) probe++
        const droppedStartsNumericGroup = /^[+().-]*\d/.test(text.slice(probe, probe + 16))
        if (newline < 0 || droppedStartsNumericGroup) {
          let groupStart = end
          while (groupStart > 0 && /[\s\d()+.-]/.test(text[groupStart - 1])) groupStart--
          if (/\d/.test(text.slice(groupStart, end))) {
            // If the numeric run was attached to a non-whitespace prefix (e.g. `card_4111`),
            // back up over that prefix token too; do NOT back up across whitespace into prior prose.
            if (groupStart < end && /\S/.test(text[groupStart])) {
              while (groupStart > 0 && /\S/.test(text[groupStart - 1])) groupStart--
            }
            end = groupStart
          }
        }
      }
      return {
        iframeFocused,
        focused: source.document.hasFocus(),
        capture: {
          text: text.slice(0, end).trimEnd(),
          from: selection ? 'selection' : 'page',
          truncated: text.length > maxLength,
        },
      }
    },
  })

  const injections = await inject(true).catch(() => inject(false))
  const main = injections.find(({ frameId }) => frameId === 0)?.result
  const selections = injections.map(({ result }) => result).filter((result) => result?.capture?.from === 'selection')
  const focusedSelection = selections.find(({ focused }) => focused === true)
  if (!focusedSelection && selections.length > 1) {
    return { ok: false, error: 'Multiple frames have selected text. Paste the intended snippet or refocus its frame and try again.' }
  }
  const selection = focusedSelection ?? selections[0]
  if (!selection && main?.iframeFocused) {
    return { ok: false, error: 'Chrome could not read a selection in the focused frame. Copy it manually or select text in the main page.' }
  }
  const capture = selection?.capture ?? main?.capture
  if (capture?.truncated && !capture.text) {
    return { ok: false, error: 'No complete token fits within the 16,000-character capture limit. Select a shorter excerpt.' }
  }
  if (!capture?.text) return { ok: false, error: 'There is no selectable text on this page.' }
  return { ok: true, ...capture }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sidepanel.html')
    || message?.type !== 'edgeguard:capture-active-tab' || !Number.isInteger(message.windowId)
    || message.windowId < 0) return false

  captureActiveTab(message.windowId).then(respond, () => {
    respond({ ok: false, error: 'Chrome could not read this tab. Click the EdgeGuard toolbar icon on a regular web page and try again.' })
  })
  return true
})
