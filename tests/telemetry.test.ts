import { InferenceMode, InferenceSource } from 'firebase/ai'
import { getToken } from 'firebase/app-check'
import { describe, expect, it, vi } from 'vitest'
import { createFirebaseSession } from '../src/core/appCheckBootstrap'
import { InferenceResponseTextError } from '../src/core/firebaseAiAdapter'
import { routePrompt } from '../src/core/hybridRouter'
import { exportTelemetry, inferenceFailure, privacyMetrics, summarizeTelemetry } from '../src/core/telemetry'
import type { TelemetryEvent } from '../src/core/telemetry'

vi.mock('firebase/app-check', async (importOriginal) => ({
  ...await importOriginal<typeof import('firebase/app-check')>(),
  getToken: vi.fn(),
  initializeAppCheck: vi.fn(),
}))

const base = {
  task: 'triage',
  sensitivity: 'high',
  latencyMs: 10,
  estimatedCloudTokensSaved: 0,
  runtime: 'live',
} as const
const input = 'Synthetic incident for agent@example.test with ID 000-12-3456'
const policy = {
  strictPrivacy: true, autoRedactBeforeCloud: true, networkOnline: true,
  onDeviceAvailable: true, cloudFallbackAllowed: true,
}
const local = routePrompt('triage', input, policy)
const cloud = routePrompt('triage', input, { ...policy, onDeviceAvailable: false })
const blocked = routePrompt('triage', input, { ...policy, onDeviceAvailable: false, networkOnline: false })
const noPrivacyClaims = { piiRedactedInCloudPayload: 0, piiBlockedBeforeSend: 0, piiUnverifiedOnError: 0 }

const events: TelemetryEvent[] = [
  { ...base, ...privacyMetrics(local, 'on_device'), id: 1, outcome: 'on_device', mode: InferenceMode.ONLY_ON_DEVICE, estimatedCloudTokensSaved: 40 },
  { ...base, ...privacyMetrics(cloud, 'in_cloud'), id: 2, outcome: 'in_cloud', mode: InferenceMode.PREFER_ON_DEVICE, latencyMs: 100 },
  { ...base, ...privacyMetrics(blocked, 'blocked'), id: 3, outcome: 'blocked', latencyMs: 2 },
  { ...base, ...privacyMetrics(cloud, 'failed'), id: 4, outcome: 'failed', latencyMs: 70 },
  { ...base, ...privacyMetrics(cloud, 'unknown'), id: 5, outcome: 'unknown', latencyMs: 10 },
]

describe('local session telemetry', () => {
  it('calculates counts and successful-inference mean latency', () => {
    expect(summarizeTelemetry(events)).toEqual({
      totalRuns: 5, onDeviceRuns: 1, inCloudRuns: 1, blockedEgressRuns: 1, failedRuns: 1,
      unknownSourceRuns: 1, piiRedactedInCloudPayload: 2, piiBlockedBeforeSend: 2, piiUnverifiedOnError: 4,
      avgLatencyMs: 40, estimatedCloudTokensSaved: 40,
    })
  })

  it('returns numeric zero for an empty session', () => {
    expect(Object.values(summarizeTelemetry([]))).toEqual(Array(11).fill(0))
  })

  it('credits only redactions in a confirmed cloud response or spans in an intentional pre-dispatch block', () => {
    expect(privacyMetrics(cloud, 'in_cloud')).toEqual({ ...noPrivacyClaims, piiRedactedInCloudPayload: 2 })
    expect(privacyMetrics(cloud, 'blocked')).toEqual({ ...noPrivacyClaims, piiBlockedBeforeSend: 2 })
    expect(privacyMetrics(cloud, 'on_device')).toEqual(noPrivacyClaims)
    expect(privacyMetrics(local, 'on_device')).toEqual(noPrivacyClaims)
  })

  it.each(['failed', 'unknown'] as const)('records %s as unverified without pre-crediting a redaction or block', (outcome) => {
    expect(privacyMetrics(cloud, outcome)).toEqual({ ...noPrivacyClaims, piiUnverifiedOnError: 2 })
    expect(privacyMetrics(local, outcome)).toEqual({ ...noPrivacyClaims, piiUnverifiedOnError: 2 })
  })

  it('counts a rejected App Check token as a pre-send block', async () => {
    vi.mocked(getToken).mockRejectedValueOnce(new Error('Token rejected'))
    const session = createFirebaseSession({
      firebase: { apiKey: 'fixture', projectId: 'fixture', appId: 'fixture' },
      recaptchaSiteKey: 'fixture',
    }, false)
    const failure = await session.getCloudApp().then(() => {
      throw new Error('Expected App Check verification to reject.')
    }, inferenceFailure)

    expect(getToken).toHaveBeenCalledOnce()
    expect(failure.outcome).toBe('blocked')
    expect(privacyMetrics(cloud, failure.outcome, failure.inferenceSource))
      .toEqual({ ...noPrivacyClaims, piiBlockedBeforeSend: 2 })
  })

  it('exports the confirmed cloud source and redaction on a response text failure', () => {
    const { outcome, inferenceSource } = inferenceFailure(new InferenceResponseTextError(InferenceSource.IN_CLOUD, new Error()))
    const event = { ...base, id: 1, outcome, inferenceSource, ...privacyMetrics(cloud, outcome, inferenceSource) }
    const exported = JSON.parse(exportTelemetry([event]))
    expect(exported.runs[0]).toMatchObject({
      outcome: 'failed', inferenceSource: InferenceSource.IN_CLOUD,
      ...noPrivacyClaims, piiRedactedInCloudPayload: 2,
    })
  })

  it('retains verified cloud redaction when a returned extraction fails schema validation', () => {
    expect(privacyMetrics(cloud, 'failed', 'in_cloud')).toEqual({ ...noPrivacyClaims, piiRedactedInCloudPayload: 2 })
  })

  it('leaves cloud egress unverified after cloud-first inference falls back to Nano', () => {
    const fallback = routePrompt('deep-synthesis', input, { ...policy, strictPrivacy: false })
    expect(privacyMetrics(fallback, 'on_device')).toEqual({ ...noPrivacyClaims, piiUnverifiedOnError: 2 })
  })

  it('exports separate live and sandbox counters with an allowlist of fields', () => {
    const sandboxEvent = {
      ...events[0], id: 6, runtime: 'sandbox' as const, prompt: 'private example',
      response: 'private output', token: 'private credential',
    }
    const serialized = exportTelemetry([...events, sandboxEvent])
    const exported = JSON.parse(serialized)
    expect(exported).toMatchObject({
      schemaVersion: 2, live: { totalRuns: 5 }, sandbox: { totalRuns: 1, onDeviceRuns: 1 },
    })
    expect(exported.runs).toHaveLength(6)
    expect(exported.runs.at(-1)).toEqual({
      id: 6, runtime: 'sandbox', task: 'triage', outcome: 'on_device', mode: InferenceMode.ONLY_ON_DEVICE,
      sensitivity: 'high', latencyMs: 10, ...noPrivacyClaims, estimatedCloudTokensSaved: 40,
    })
    expect(serialized).not.toMatch(/private example|private output|private credential|piiTokensProtected/)
  })
})
