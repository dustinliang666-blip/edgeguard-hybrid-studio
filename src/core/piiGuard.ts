export type PiiKind = 'EMAIL' | 'PHONE' | 'NATIONAL_ID' | 'CARD' | 'SECRET' | 'IP'
export type Sensitivity = 'low' | 'medium' | 'high'

export interface PiiFinding {
  kind: PiiKind
  start: number
  end: number
}

export interface PiiScan {
  findings: PiiFinding[]
  sensitivity: Sensitivity
}

interface Pattern {
  kind: PiiKind
  expression: RegExp
  validate?: (value: string) => boolean
}

export function passesLuhn(value: string): boolean {
  if (!/^\d(?:[ -]?\d){12,18}$/.test(value)) return false
  const digits = value.replace(/\D/g, '')
  if (/^(\d)\1+$/.test(digits)) return false

  let sum = 0
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index])
    if ((digits.length - 1 - index) % 2 === 1) digit *= 2
    sum += digit > 9 ? digit - 9 : digit
  }
  return sum % 10 === 0
}

function hasValidIdDate(value: string): boolean {
  const year = Number(value.slice(6, 10))
  const month = Number(value.slice(10, 12))
  const day = Number(value.slice(12, 14))
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const patterns: Pattern[] = [
  { kind: 'SECRET', expression: /(?<=\bAuthorization["']?[ \t]*:[ \t]*["']?Bearer[ \t]+)[^\s,;"'}\]\)<>]+/gi },
  { kind: 'SECRET', expression: /(?<!\bAuthorization["']?[ \t]*:[ \t]*["']?)\bBearer[ \t]+[A-Za-z0-9._~+\/-]*[A-Za-z0-9_~+\/-]=*/gi },
  { kind: 'SECRET', expression: /\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{35}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})(?![\w-])/g },
  { kind: 'EMAIL', expression: /(?<![A-Z0-9!#$%&'*+/=?^_\x60{|}~.-])[A-Z0-9!#$%&'*+/=?^_\x60{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_\x60{|}~-]+)*@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)*\.[A-Z]{2,}(?![A-Z0-9-])/gi },
  { kind: 'NATIONAL_ID', expression: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
  { kind: 'NATIONAL_ID', expression: /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{9}[\dXx](?![\dXx])/g, validate: hasValidIdDate },
  { kind: 'CARD', expression: /(?<![\d-])(?:\d{4}[ -]){3}\d{4}(?!\d|-\d)/g, validate: passesLuhn },
  { kind: 'CARD', expression: /(?<![\d-])\d{4}[ -]\d{6}[ -]\d{5}(?!\d|-\d)/g, validate: passesLuhn },
  { kind: 'CARD', expression: /(?<!\d)\d{13,19}(?!\d)/g, validate: passesLuhn },
  { kind: 'CARD', expression: /(?<![\w-])(?=\d{1,12}[ -]\d)(?:\d[ -]?){12,18}\d(?!\d|-\d)/g, validate: passesLuhn },
  {
    kind: 'IP',
    expression: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g,
    validate: (value) => value.split('.').every((octet) => Number(octet) <= 255),
  },
  {
    kind: 'PHONE',
    expression: /(?<![\w+\d-])(?:\+86[ .-]?)?1[3-9]\d{9}(?!\d|-\d)/g,
  },
  {
    kind: 'PHONE',
    expression: /(?<![\w+\d-])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-]?)\d{3}[ .-]?\d{4}(?!\d|-\d)/g,
  },
  {
    kind: 'PHONE',
    expression: /(?<![\w+])\+[1-9]\d{0,2}[ .-]?(?:\(\d{1,4}\)[ .-]?)?(?:\d[ .-]?){5,13}\d(?!\d|-\d)/g,
    validate: (value) => {
      const length = value.replace(/\D/g, '').length
      return length >= 8 && length <= 15
    },
  },
]

export function scanSensitiveData(text: string): PiiScan {
  const candidates: PiiFinding[] = []
  for (const { kind, expression, validate } of patterns) {
    for (const match of text.matchAll(expression)) {
      if (validate && !validate(match[0])) continue
      candidates.push({ kind, start: match.index, end: match.index + match[0].length })
    }
  }

  // Longer matches take precedence at the same offset. Nested matches are discarded.
  candidates.sort((first, second) => first.start - second.start || second.end - first.end)
  const findings: PiiFinding[] = []
  for (const candidate of candidates) {
    const previous = findings.at(-1)
    if (!previous || candidate.start >= previous.end) {
      findings.push(candidate)
    } else {
      // Mask the entire overlapping span and retain its highest risk.
      previous.end = Math.max(previous.end, candidate.end)
      if (!isHighRisk(previous.kind) && isHighRisk(candidate.kind)) previous.kind = candidate.kind
    }
  }
  return {
    findings,
    sensitivity: findings.some(({ kind }) => isHighRisk(kind)) ? 'high'
      : findings.length > 0 ? 'medium' : 'low',
  }
}

function isHighRisk(kind: PiiKind): boolean {
  return kind === 'SECRET' || kind === 'CARD' || kind === 'NATIONAL_ID'
}

export interface Redaction extends PiiScan {
  redactedText: string
  placeholders: ReadonlyMap<string, { value: string; kind: PiiKind }>
}

const placeholderExpression = /\[REDACTED_[A-Z_]+_\d+\]/g

export function redactSensitiveData(text: string): Redaction {
  const scan = scanSensitiveData(text)
  const reserved = new Set(text.match(placeholderExpression))
  const counters = new Map<PiiKind, number>()
  const placeholders = new Map<string, { value: string; kind: PiiKind }>()
  let redactedText = ''
  let offset = 0

  for (const { kind, start, end } of scan.findings) {
    let index = counters.get(kind) ?? 0
    let placeholder: string
    do {
      placeholder = '[REDACTED_' + kind + '_' + ++index + ']'
    } while (reserved.has(placeholder))

    counters.set(kind, index)
    placeholders.set(placeholder, { value: text.slice(start, end), kind })
    redactedText += text.slice(offset, start) + placeholder
    offset = end
  }
  return { ...scan, placeholders, redactedText: redactedText + text.slice(offset) }
}

export function restoreRedactedOutput(
  output: string,
  placeholders: Redaction['placeholders'],
  allow: (kind: PiiKind) => boolean = () => true,
): string {
  return output.replace(placeholderExpression, (placeholder) => {
    const original = placeholders.get(placeholder)
    return original && allow(original.kind) ? original.value : placeholder
  })
}
