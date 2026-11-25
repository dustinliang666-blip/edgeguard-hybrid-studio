import { InferenceMode, InferenceSource } from 'firebase/ai'
import type { InferenceResult } from './firebaseAiAdapter'
import type { RunDecision, TaskKind } from './hybridRouter'

export function simulateInference(decision: RunDecision, task: TaskKind, nanoAvailable: boolean): InferenceResult {
  const source = decision.mode === InferenceMode.ONLY_ON_DEVICE
    || (decision.mode === InferenceMode.PREFER_ON_DEVICE && nanoAvailable)
    ? InferenceSource.ON_DEVICE
    : InferenceSource.IN_CLOUD

  const lines = decision.outboundText.trim().split(/\r?\n|(?<=[.!?])\s+/).filter((line) => line.trim())
  const first = lines[0]?.slice(0, 220) ?? ''
  const urgency = /\b(urgent|outage|blocked|injury|escalat\w*)\b/i.test(decision.outboundText) ? 'Elevated' : 'Review'
  const next = 'Confirm the details before taking action.'
  const responses = {
    triage: ['• Issue: ' + first, '• Urgency: ' + urgency, '• Next action: ' + next].join('\n'),
    'redact-summarize': lines.slice(0, 3).join(' ').slice(0, 600),
    'json-extract': JSON.stringify({ issue: first, urgency, next_action: next }, null, 2),
    'deep-synthesis': 'Evidence\n' + lines.slice(0, 3).join('\n').slice(0, 600)
      + '\n\nOpen question\nWhich details need independent confirmation?\n\nNext step\n' + next,
  }
  return { text: responses[task], source }
}
