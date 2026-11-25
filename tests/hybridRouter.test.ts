import { InferenceMode } from 'firebase/ai'
import { describe, expect, it } from 'vitest'
import { routePrompt } from '../src/core/hybridRouter'
import type { RoutingPolicy, TaskKind } from '../src/core/hybridRouter'
import { simulateInference } from '../src/core/simulation'

const defaults: RoutingPolicy = {
  strictPrivacy: true, autoRedactBeforeCloud: true, networkOnline: true,
  onDeviceAvailable: true, cloudFallbackAllowed: true,
}
const input = 'Escalated billing issue. Contact test@example.test. Bearer SYNTHETIC_TEST_TOKEN.'

describe('privacy routing', () => {
  it('blocks disconnected runs without ready Nano even when cloud is enabled', () => {
    expect(routePrompt('triage', input, { ...defaults, networkOnline: false, onDeviceAvailable: false }))
      .toMatchObject({ kind: 'blocked', reason: 'offline-unavailable', sensitivity: 'high' })
  })

  it('locks offline synthesis to Nano and retains the original input locally', () => {
    expect(routePrompt('deep-synthesis', input, { ...defaults, networkOnline: false }))
      .toMatchObject({ kind: 'run', mode: InferenceMode.ONLY_ON_DEVICE, reason: 'offline', outboundText: input })
  })

  it('locks high-sensitivity input to ready Nano in strict privacy', () => {
    expect(routePrompt('deep-synthesis', input, defaults))
      .toMatchObject({ kind: 'run', mode: InferenceMode.ONLY_ON_DEVICE, reason: 'privacy-local' })
  })

  it('lets strict high-sensitivity text fall back only after redaction', () => {
    const result = routePrompt('deep-synthesis', input, { ...defaults, onDeviceAvailable: false })
    expect(result).toMatchObject({
      mode: InferenceMode.PREFER_ON_DEVICE,
      reason: 'privacy-redacted',
      outboundText: 'Escalated billing issue. Contact [REDACTED_EMAIL_1]. [REDACTED_SECRET_1].',
    })
  })

  it('blocks high-sensitivity egress when redaction and Nano are unavailable', () => {
    expect(routePrompt('triage', input, { ...defaults, onDeviceAvailable: false, autoRedactBeforeCloud: false }))
      .toMatchObject({ kind: 'blocked', reason: 'redaction-required' })
  })

  it('protects medium-sensitivity egress even with strict privacy turned off', () => {
    const policy = { ...defaults, strictPrivacy: false, autoRedactBeforeCloud: false }
    expect(routePrompt('deep-synthesis', 'Email test@example.test', policy)).toMatchObject({ mode: InferenceMode.ONLY_ON_DEVICE })
    expect(routePrompt('deep-synthesis', 'Email test@example.test', { ...policy, onDeviceAvailable: false }))
      .toMatchObject({ kind: 'blocked', reason: 'redaction-required' })
  })

  it('honors the cloud switch on both cloud-first and hybrid routes', () => {
    const policy = { ...defaults, cloudFallbackAllowed: false }
    expect(routePrompt('deep-synthesis', 'No identifiers.', policy)).toMatchObject({ mode: InferenceMode.ONLY_ON_DEVICE })
    expect(routePrompt('triage', 'No identifiers.', { ...policy, onDeviceAvailable: false }))
      .toMatchObject({ kind: 'blocked', reason: 'cloud-disabled' })
  })

  it.each<TaskKind>(['triage', 'redact-summarize', 'json-extract'])('prefers the local model for %s', (task) => {
    expect(routePrompt(task, 'Contact test@example.test.', defaults))
      .toMatchObject({ mode: InferenceMode.PREFER_ON_DEVICE, outboundText: 'Contact [REDACTED_EMAIL_1].' })
  })

  it.each<TaskKind>(['triage', 'redact-summarize', 'json-extract'])('restricts standard %s to Nano when live cloud is unconfigured', (task) => {
    const policy = { ...defaults, strictPrivacy: false, cloudConfigurationIssue: 'Configure App Check.' }
    expect(routePrompt(task, input, policy))
      .toMatchObject({ mode: InferenceMode.ONLY_ON_DEVICE, outboundText: input })
    expect(routePrompt(task, input, { ...policy, onDeviceAvailable: false }))
      .toMatchObject({ kind: 'blocked', detail: 'Configure App Check.' })
  })

  it('allows redacted cloud synthesis when strict privacy is turned off', () => {
    expect(routePrompt('deep-synthesis', input, { ...defaults, strictPrivacy: false }))
      .toMatchObject({ mode: InferenceMode.PREFER_IN_CLOUD, outboundText: expect.not.stringContaining('SYNTHETIC_TEST_TOKEN') })
  })

  it('blocks empty text before considering model availability', () => {
    expect(routePrompt('triage', ' \n ', defaults)).toMatchObject({ kind: 'blocked', reason: 'empty-input' })
  })

  it('simulates device preference and masked cloud fallback deterministically', () => {
    const route = routePrompt('json-extract', 'Email test@example.test about the outage.', defaults)
    if (route.kind !== 'run') throw new Error('Expected a runnable route.')
    const cloud = simulateInference(route, 'json-extract', false)
    expect(cloud).toEqual(simulateInference(route, 'json-extract', false))
    expect(cloud.source).toBe('in_cloud')
    expect(JSON.parse(cloud.text).issue).toContain('[REDACTED_EMAIL_1]')
    expect(simulateInference(route, 'json-extract', true).source).toBe('on_device')
  })
})
