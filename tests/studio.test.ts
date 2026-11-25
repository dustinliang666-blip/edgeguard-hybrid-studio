import { describe, expect, it } from 'vitest'
import { routePrompt } from '../src/core/hybridRouter'
import { cloudPreviewPayload, requiresCloudConfirmation } from '../src/studio'

const task = 'triage'
const text = 'Contact agent@example.test. Synthetic ID 000-12-3456.'
const policy = {
  strictPrivacy: true, autoRedactBeforeCloud: true, networkOnline: true,
  onDeviceAvailable: false, cloudFallbackAllowed: true,
}

describe('cloud preview confirmation', () => {
  it.each([
    { networkOnline: true, onDeviceAvailable: true },
    { networkOnline: false, onDeviceAvailable: false },
  ])('requires a second click when a no-egress preview becomes cloud-eligible (%o)', (previewConditions) => {
    const before = cloudPreviewPayload(routePrompt(task, text, { ...policy, ...previewConditions }), task)
    const refreshed = cloudPreviewPayload(routePrompt(task, text, policy), task)
    expect(before).toBeNull()
    expect(refreshed).toContain('[REDACTED_EMAIL_1]')
    expect(refreshed).toContain('[REDACTED_NATIONAL_ID_1]')
    expect(refreshed).not.toMatch(/agent@example.test|000-12-3456/)
    expect(requiresCloudConfirmation(before, refreshed)).toBe(true)
    expect(requiresCloudConfirmation(refreshed, refreshed)).toBe(false)
  })

  it('requires a new preview for a changed payload and allows a less permissive route immediately', () => {
    const preview = cloudPreviewPayload(routePrompt(task, text, policy), task)
    const changed = cloudPreviewPayload(routePrompt(task, text + ' Additional details.', policy), task)
    expect(requiresCloudConfirmation(preview, changed)).toBe(true)
    expect(requiresCloudConfirmation(preview, null)).toBe(false)
    expect(requiresCloudConfirmation(null, null)).toBe(false)
  })
})
