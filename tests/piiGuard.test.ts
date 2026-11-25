import { describe, expect, it } from 'vitest'
import { passesLuhn, redactSensitiveData, restoreRedactedOutput, scanSensitiveData } from '../src/core/piiGuard'

describe('local PII guard', () => {
  it('returns low sensitivity without findings for ordinary text', () => {
    expect(scanSensitiveData('Renewal notice is due in 60 days.')).toEqual({ findings: [], sensitivity: 'low' })
  })

  it('detects emails and US, Chinese and international phones', () => {
    const text = "o'neill@example.test, +1 (415) 555-0136, +86 13800138000, and +44 20 7946 0958."
    const { findings, sensitivity } = scanSensitiveData(text)
    expect(sensitivity).toBe('medium')
    expect(findings.map(({ kind, start, end }) => [kind, text.slice(start, end)])).toEqual([
      ['EMAIL', "o'neill@example.test"], ['PHONE', '+1 (415) 555-0136'],
      ['PHONE', '+86 13800138000'], ['PHONE', '+44 20 7946 0958'],
    ])
  })

  it('detects SSN and Chinese resident ID formats', () => {
    const text = 'Synthetic identifiers 000-12-3456 and 11010519900307001X.'
    const { sensitivity, findings } = scanSensitiveData(text)
    expect(sensitivity).toBe('high')
    expect(findings.map(({ kind, start, end }) => [kind, text.slice(start, end)])).toEqual([
      ['NATIONAL_ID', '000-12-3456'], ['NATIONAL_ID', '11010519900307001X'],
    ])
  })

  it('masks private and public IPv4 and leaves invalid ones unchanged', () => {
    const redacted = redactSensitiveData('From 192.168.1.20 to 8.8.4.4. Invalid: 300.1.2.3.')
    expect(redacted.redactedText).toBe('From [REDACTED_IP_1] to [REDACTED_IP_2]. Invalid: 300.1.2.3.')
  })

  it('matches illustrative JWT, Bearer and provider key formats without double-counting', () => {
    const jwt = 'eyJDEMO.header.signature'
    const testKey = 'AIza' + 'Z'.repeat(35)
    const openAiShapedFixture = 'sk-' + 'fixture_'.repeat(3)
    const text = [jwt, 'Bearer ' + jwt, testKey, openAiShapedFixture].join(', ')
    const { findings, redactedText, sensitivity } = redactSensitiveData(text)
    expect(findings.map(({ kind }) => kind)).toEqual(['SECRET', 'SECRET', 'SECRET', 'SECRET'])
    expect(sensitivity).toBe('high')
    expect(redactedText).toBe('[REDACTED_SECRET_1], [REDACTED_SECRET_2], [REDACTED_SECRET_3], [REDACTED_SECRET_4]')
  })

  it.each(['4111111111111111', '4111 1111 1111 1111', '3782-822463-10005'])('validates Luhn test number %s', (number) => {
    expect(passesLuhn(number)).toBe(true)
    expect(scanSensitiveData(number).findings[0]?.kind).toBe('CARD')
  })

  it.each(['4111111111111112', '0000000000000000', '4111-1111 1111-a111', '1234'])('rejects non-card input %s', (number) => {
    expect(passesLuhn(number)).toBe(false)
    expect(scanSensitiveData(number).findings.some(({ kind }) => kind === 'CARD')).toBe(false)
  })

  it('protects a formatted card followed by a separate short number', () => {
    expect(redactSensitiveData('Card 4111 1111 1111 1111 123.').redactedText).toBe('Card [REDACTED_CARD_1] 123.')
  })

  it('redacts a contiguous card without absorbing the adjacent quantity', () => {
    expect(redactSensitiveData('Card 4111111111111111 1 item')).toMatchObject({
      sensitivity: 'high',
      redactedText: 'Card [REDACTED_CARD_1] 1 item',
    })
  })

  it('redacts a contiguous card after an underscore and retains the prefix', () => {
    expect(redactSensitiveData('card_4111111111111111')).toMatchObject({
      sensitivity: 'high',
      redactedText: 'card_[REDACTED_CARD_1]',
    })
  })

  it.each(['abc123', 'x', 'a!%'])('redacts a nonempty Authorization Bearer token %s', (token) => {
    expect(redactSensitiveData('Authorization: Bearer ' + token)).toMatchObject({
      sensitivity: 'high',
      redactedText: 'Authorization: Bearer [REDACTED_SECRET_1]',
    })
  })

  it.each([
    ['{"Authorization":"Bearer ', '","role":"admin"}'],
    ['Authorization: Bearer ', ',admin'],
    ['Authorization: Bearer ', ';role=admin'],
    ['Authorization: Bearer ', '}'],
    ['Authorization: Bearer ', ']'],
    ['Authorization: Bearer ', ')'],
    ['Authorization: Bearer ', '<role>'],
    ["Authorization: Bearer ", "'"],
  ])('preserves the Authorization prefix and the delimiter %s%s', (prefix, suffix) => {
    const redaction = redactSensitiveData(prefix + 'abc123' + suffix)
    expect(redaction.sensitivity).toBe('high')
    expect(redaction.redactedText).toBe(prefix + '[REDACTED_SECRET_1]' + suffix)
    expect(redaction.placeholders.get('[REDACTED_SECRET_1]')?.value).toBe('abc123')
  })

  it('keeps literal markers distinct and supports selective local restoration', () => {
    const text = '[REDACTED_EMAIL_1] alex@example.test and Bearer SYNTHETIC_DEMO_TOKEN.'
    const redaction = redactSensitiveData(text)
    expect(redaction.redactedText).toBe('[REDACTED_EMAIL_1] [REDACTED_EMAIL_2] and [REDACTED_SECRET_1].')
    expect(restoreRedactedOutput(redaction.redactedText, redaction.placeholders)).toBe(text)
    expect(restoreRedactedOutput(redaction.redactedText, redaction.placeholders, (kind) => kind === 'EMAIL'))
      .toBe('[REDACTED_EMAIL_1] alex@example.test and [REDACTED_SECRET_1].')
  })
})
