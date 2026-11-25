import { InferenceMode } from 'firebase/ai'
import { formatPrompt } from './core/firebaseAiAdapter'
import type { RoutingDecision, TaskKind } from './core/hybridRouter'
import type { PiiKind } from './core/piiGuard'

export const MAX_INPUT_LENGTH = 16_000

export function cloudPreviewPayload(decision: RoutingDecision, task: TaskKind): string | null {
  return decision.kind === 'run' && decision.mode !== InferenceMode.ONLY_ON_DEVICE
    ? formatPrompt(task, decision.outboundText)
    : null
}

export function requiresCloudConfirmation(previewedPayload: string | null, actualPayload: string | null): boolean {
  return actualPayload !== null && actualPayload !== previewedPayload
}

export const taskLabels: Record<TaskKind, string> = {
  triage: 'Triage',
  'redact-summarize': 'Summarize',
  'json-extract': 'Extract JSON',
  'deep-synthesis': 'Deep synthesis',
}

export const taskKinds = Object.keys(taskLabels) as TaskKind[]

export const piiLabels: Record<PiiKind, string> = {
  EMAIL: 'Email',
  PHONE: 'Phone',
  NATIONAL_ID: 'National ID',
  CARD: 'Payment card',
  SECRET: 'Secret',
  IP: 'IP address',
}

export const sdkModes: Record<InferenceMode, string> = {
  [InferenceMode.ONLY_ON_DEVICE]: 'ONLY_ON_DEVICE',
  [InferenceMode.PREFER_ON_DEVICE]: 'PREFER_ON_DEVICE',
  [InferenceMode.PREFER_IN_CLOUD]: 'PREFER_IN_CLOUD',
  [InferenceMode.ONLY_IN_CLOUD]: 'ONLY_IN_CLOUD',
}

export const samples: { name: string; description: string; task: TaskKind; text: string }[] = [
  {
    name: 'Customer ticket',
    description: 'A support escalation with identifiers',
    task: 'triage',
    text: 'Customer alex.rivera@example.com cannot access the billing portal after a password reset.\n\nCall +1 (415) 555-0136 for account verification.\nA test callback included 192.0.2.24 and Bearer DEMO_ONLY_INVALID_TOKEN.\n\nPlease identify the issue, urgency, and next action.',
  },
  {
    name: 'Legal clause',
    description: 'A contract renewal and notice window',
    task: 'deep-synthesis',
    text: 'The service renews automatically for successive 12-month periods. Either party may decline renewal by providing written notice at least 60 days before the end of the current term.\n\nThe supplier may adjust fees by up to 5% at renewal with 90 days of notice. Fees stay fixed for the remainder of the current term.',
  },
  {
    name: 'Field incident',
    description: 'An incident report from a remote site',
    task: 'json-extract',
    text: 'At 08:22, a water pressure drop was reported at pump station 14. The intake valve was closed and the area secured.\n\nThere were no injuries. Cellular service is unavailable. A maintenance inspection is pending.',
  },
]

export type CaptureResult =
  | { ok: false; error: string }
  | { ok: true; text: string; from: 'selection' | 'page'; truncated: boolean }

export async function captureTab(): Promise<CaptureResult> {
  const currentWindow = await chrome.windows.getCurrent()
  if (currentWindow.id === undefined) return { ok: false, error: 'Chrome did not report the current window.' }

  return chrome.runtime.sendMessage({ type: 'edgeguard:capture-active-tab', windowId: currentWindow.id })
}
