import { InferenceMode } from 'firebase/ai'
import { redactSensitiveData } from './piiGuard'
import type { Redaction, Sensitivity } from './piiGuard'

export const jsonExtractionFields = ['issue', 'urgency', 'next_action'] as const

export const taskInstructions = {
  triage: 'Identify the issue, urgency, and next action. Use three short bullets.',
  'redact-summarize': 'Write a concise plain-language summary with the key facts and any open questions.',
  'json-extract': 'Extract the issue, urgency, and next_action into a single JSON object. Use null when a field cannot be inferred. Return valid JSON with no code fences.',
  'deep-synthesis': 'Synthesize the evidence, tradeoffs, and recommended next steps. Clearly distinguish facts from inferences.',
} as const

export type TaskKind = keyof typeof taskInstructions

export interface RoutingPolicy {
  strictPrivacy: boolean
  autoRedactBeforeCloud: boolean
  networkOnline: boolean
  onDeviceAvailable: boolean
  cloudFallbackAllowed: boolean
  cloudConfigurationIssue?: string | null
}

export type BlockReason = 'empty-input' | 'offline-unavailable' | 'cloud-disabled' | 'redaction-required'
export type RouteReason = 'offline' | 'cloud-disabled' | 'privacy-local' | 'privacy-redacted' | 'prefer-local' | 'prefer-cloud'

export type RoutingDecision =
  | { kind: 'blocked'; reason: BlockReason; detail: string; sensitivity: Sensitivity; findingsCount: number }
  | {
      kind: 'run'
      reason: RouteReason
      detail: string
      mode: InferenceMode
      sensitivity: Sensitivity
      findingsCount: number
      outboundText: string
      redaction?: Redaction
    }

export type RunDecision = Extract<RoutingDecision, { kind: 'run' }>

export function routePrompt(task: TaskKind, text: string, policy: RoutingPolicy): RoutingDecision {
  const redaction = redactSensitiveData(text)
  const { sensitivity, findings } = redaction
  const summary = { sensitivity, findingsCount: findings.length }
  const block = (reason: BlockReason, detail: string): RoutingDecision => ({ ...summary, kind: 'blocked', reason, detail })
  const local = (reason: RouteReason, detail: string): RunDecision => ({
    ...summary, kind: 'run', reason, detail, mode: InferenceMode.ONLY_ON_DEVICE, outboundText: text,
  })
  const cloudEligible = (mode: InferenceMode, reason: RouteReason, detail: string): RunDecision => ({
    ...summary,
    kind: 'run',
    mode,
    reason,
    detail,
    outboundText: redaction.redactedText,
    redaction: findings.length ? redaction : undefined,
  })

  if (!text.trim()) return block('empty-input', 'Enter or capture text to run a task.')
  if (!policy.networkOnline) {
    return policy.onDeviceAvailable
      ? local('offline', 'Offline. Inference is restricted to Gemini Nano.')
      : block('offline-unavailable', 'Gemini Nano is unavailable offline. Connect and prepare the local model, or select Sandbox Simulation.')
  }
  if (!policy.cloudFallbackAllowed) {
    return policy.onDeviceAvailable
      ? local('cloud-disabled', 'Cloud inference is disabled by policy.')
      : block('cloud-disabled', 'Cloud inference is disabled and Gemini Nano is unavailable.')
  }
  if (policy.cloudConfigurationIssue) {
    return policy.onDeviceAvailable
      ? local('cloud-disabled', 'Live cloud inference is unconfigured. This run is restricted to Gemini Nano.')
      : block('cloud-disabled', policy.cloudConfigurationIssue)
  }
  if (findings.length && !policy.autoRedactBeforeCloud) {
    return policy.onDeviceAvailable
      ? local('privacy-local', 'Detected identifiers require on-device inference while redaction is off.')
      : block('redaction-required', 'Enable cloud redaction or prepare Gemini Nano to process detected identifiers.')
  }
  if (policy.strictPrivacy && sensitivity === 'high') {
    return policy.onDeviceAvailable
      ? local('privacy-local', 'Strict privacy keeps high-sensitivity input on this device.')
      : cloudEligible(InferenceMode.PREFER_ON_DEVICE, 'privacy-redacted', 'Nano is unavailable. Only the redacted payload is eligible for cloud fallback.')
  }
  return task === 'deep-synthesis'
    ? cloudEligible(InferenceMode.PREFER_IN_CLOUD, 'prefer-cloud', 'Cloud is preferred for synthesis. Detected identifiers are masked before submission.')
    : cloudEligible(InferenceMode.PREFER_ON_DEVICE, 'prefer-local', 'Nano is preferred. If the SDK falls back to cloud, it receives the same inspected payload.')
}
