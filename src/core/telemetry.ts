import { InferenceMode } from 'firebase/ai'
import { AppCheckVerificationError } from './appCheckBootstrap'
import { InferenceResponseTextError, JsonExtractionSchemaError, LocalInferenceUnavailableError } from './firebaseAiAdapter'
import type { InferenceResult } from './firebaseAiAdapter'
import type { RoutingDecision, TaskKind } from './hybridRouter'
import type { Sensitivity } from './piiGuard'

export type RuntimeMode = 'sandbox' | 'live'
export type RunOutcome = 'on_device' | 'in_cloud' | 'blocked' | 'failed' | 'unknown'

interface PrivacyMetrics {
  piiRedactedInCloudPayload: number
  piiBlockedBeforeSend: number
  piiUnverifiedOnError: number
}

export interface TelemetryEvent extends PrivacyMetrics {
  id: number
  runtime: RuntimeMode
  task: TaskKind
  outcome: RunOutcome
  inferenceSource?: InferenceResult['source']
  mode?: InferenceMode
  sensitivity: Sensitivity
  latencyMs: number
  estimatedCloudTokensSaved: number
}

export function inferenceFailure(error: unknown): {
  outcome: 'blocked' | 'failed'
  inferenceSource?: InferenceResult['source']
  message?: string
} {
  if (error instanceof AppCheckVerificationError || error instanceof LocalInferenceUnavailableError) {
    return { outcome: 'blocked', message: error.message }
  }
  if (error instanceof JsonExtractionSchemaError) {
    return { outcome: 'failed', inferenceSource: error.source, message: error.message }
  }
  if (error instanceof InferenceResponseTextError) {
    return { outcome: 'failed', inferenceSource: error.inferenceSource, message: error.message }
  }
  return { outcome: 'failed' }
}

export function privacyMetrics(
  decision: RoutingDecision,
  outcome: RunOutcome,
  confirmedSource?: InferenceResult['source'],
): PrivacyMetrics {
  const source = confirmedSource ?? outcome
  const cloudFirstFallback = source === 'on_device' && decision.kind === 'run'
    && decision.mode === InferenceMode.PREFER_IN_CLOUD
  return {
    piiRedactedInCloudPayload: source === 'in_cloud' && decision.kind === 'run' ? decision.redaction?.findings.length ?? 0 : 0,
    piiBlockedBeforeSend: outcome === 'blocked' ? decision.findingsCount : 0,
    piiUnverifiedOnError: source === 'failed' || source === 'unknown' || cloudFirstFallback ? decision.findingsCount : 0,
  }
}

export function summarizeTelemetry(events: readonly TelemetryEvent[]) {
  const successful = events.filter(({ outcome }) => outcome === 'on_device' || outcome === 'in_cloud' || outcome === 'unknown')
  return {
    totalRuns: events.length,
    onDeviceRuns: events.filter(({ outcome }) => outcome === 'on_device').length,
    inCloudRuns: events.filter(({ outcome }) => outcome === 'in_cloud').length,
    blockedEgressRuns: events.filter(({ outcome }) => outcome === 'blocked').length,
    failedRuns: events.filter(({ outcome }) => outcome === 'failed').length,
    unknownSourceRuns: events.filter(({ outcome }) => outcome === 'unknown').length,
    piiRedactedInCloudPayload: events.reduce((total, event) => total + event.piiRedactedInCloudPayload, 0),
    piiBlockedBeforeSend: events.reduce((total, event) => total + event.piiBlockedBeforeSend, 0),
    piiUnverifiedOnError: events.reduce((total, event) => total + event.piiUnverifiedOnError, 0),
    avgLatencyMs: successful.length
      ? Math.round(successful.reduce((total, event) => total + event.latencyMs, 0) / successful.length)
      : 0,
    estimatedCloudTokensSaved: events.reduce((total, event) => total + event.estimatedCloudTokensSaved, 0),
  }
}

export function exportTelemetry(events: readonly TelemetryEvent[]): string {
  const runs = events.map(({
    id, runtime, task, outcome, inferenceSource, mode, sensitivity, latencyMs,
    piiRedactedInCloudPayload, piiBlockedBeforeSend, piiUnverifiedOnError, estimatedCloudTokensSaved,
  }) => ({
    id, runtime, task, outcome, inferenceSource, mode, sensitivity, latencyMs,
    piiRedactedInCloudPayload, piiBlockedBeforeSend, piiUnverifiedOnError, estimatedCloudTokensSaved,
  }))
  return JSON.stringify({
    schemaVersion: 2,
    live: summarizeTelemetry(runs.filter(({ runtime }) => runtime === 'live')),
    sandbox: summarizeTelemetry(runs.filter(({ runtime }) => runtime === 'sandbox')),
    runs,
  }, null, 2)
}
