import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { InferenceMode } from 'firebase/ai'
import { createFirebaseSession, DEBUG_TOKEN_STORAGE_KEY, readRuntimeConfig } from './core/appCheckBootstrap'
import { CLOUD_MODEL, createFirebaseAiAdapter, formatPrompt, probeCapabilities } from './core/firebaseAiAdapter'
import type { InferenceResult, NanoStatus } from './core/firebaseAiAdapter'
import { routePrompt } from './core/hybridRouter'
import type { TaskKind } from './core/hybridRouter'
import { restoreRedactedOutput, scanSensitiveData } from './core/piiGuard'
import type { PiiFinding, Redaction } from './core/piiGuard'
import { simulateInference } from './core/simulation'
import { exportTelemetry, inferenceFailure, privacyMetrics, summarizeTelemetry } from './core/telemetry'
import type { RuntimeMode, TelemetryEvent } from './core/telemetry'
import {
  captureTab, cloudPreviewPayload, MAX_INPUT_LENGTH, piiLabels, requiresCloudConfirmation, samples, sdkModes, taskKinds, taskLabels,
} from './studio'

const isExtension = window.location.protocol === 'chrome-extension:'
const config = readRuntimeConfig({
  VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY,
  VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID,
  VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY,
  VITE_FIREBASE_APPCHECK_DEBUG_TOKEN: import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN,
}, readStoredToken())
const firebaseSession = createFirebaseSession(config, isExtension)

function readStoredToken(): string | undefined {
  try {
    return sessionStorage.getItem(DEBUG_TOKEN_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

const nanoLabels: Record<NanoStatus, string> = {
  available: 'Nano ready',
  downloadable: 'Nano downloadable',
  downloading: 'Nano downloading',
  unavailable: 'Nano unavailable',
  'legacy-unsupported-by-sdk': 'Legacy Nano API unsupported',
}

const outcomeLabels = {
  on_device: 'On device',
  in_cloud: 'In cloud',
  blocked: 'Blocked',
  failed: 'Failed',
  unknown: 'Source unknown',
} satisfies Record<TelemetryEvent['outcome'], string>

interface StudioResult {
  runtime: RuntimeMode
  task: TaskKind
  inference?: InferenceResult
  message?: string
  redaction?: Redaction
}

function Toggle({ label, detail, checked, onChange }: {
  label: string
  detail: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="toggle">
      <span><strong>{label}</strong><small>{detail}</small></span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'mint' | 'amber' | 'neutral' }) {
  return <span className={'badge badge-' + tone}>{children}</span>
}

function HighlightedInput({ text, findings }: { text: string; findings: PiiFinding[] }) {
  return (
    <pre className="payload">
      {findings.map(({ start, end, kind }, index) => (
        <Fragment key={start}>
          {text.slice(findings[index - 1]?.end ?? 0, start)}
          <mark title={piiLabels[kind]}>{text.slice(start, end)}</mark>
        </Fragment>
      ))}
      {text.slice(findings.at(-1)?.end ?? 0)}
    </pre>
  )
}

function DeveloperSettings() {
  const [token, setToken] = useState('')
  const [storageError, setStorageError] = useState(false)

  function updateToken(value: string) {
    try {
      if (value) sessionStorage.setItem(DEBUG_TOKEN_STORAGE_KEY, value)
      else sessionStorage.removeItem(DEBUG_TOKEN_STORAGE_KEY)
      window.location.reload()
    } catch {
      setStorageError(true)
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (token.trim()) updateToken(token.trim())
  }

  return (
    <details className="card developer">
      <summary>Developer settings</summary>
      <div className="details-body">
        <p>Use a registered App Check debug token from a test project. Firebase logs the token to the local developer console in debug mode.</p>
        <form onSubmit={save}>
          <label htmlFor="debug-token">App Check debug token</label>
          <input id="debug-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
          <div className="button-row">
            <button type="submit" className="secondary" disabled={!token.trim()}>Apply and reload</button>
            {readStoredToken() && <button type="button" className="secondary" onClick={() => updateToken('')}>Clear and reload</button>}
          </div>
        </form>
        {storageError && <p role="alert">This browser blocked session storage.</p>}
      </div>
    </details>
  )
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeMode>('sandbox')
  const [input, setInput] = useState(samples[0].text)
  const [task, setTask] = useState<TaskKind>(samples[0].task)
  const [strict, setStrict] = useState(true)
  const [redact, setRedact] = useState(true)
  const [allowCloud, setAllowCloud] = useState(true)
  const [offline, setOffline] = useState(false)
  const [sandboxNano, setSandboxNano] = useState(true)
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine)
  const [liveNano, setLiveNano] = useState<NanoStatus>('unavailable')
  const [appCheckVerified, setAppCheckVerified] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prepareProgress, setPrepareProgress] = useState<number | null>(null)
  const [capabilityNote, setCapabilityNote] = useState('')
  const [captureStatus, setCaptureStatus] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [result, setResult] = useState<StudioResult | null>(null)
  const [events, setEvents] = useState<TelemetryEvent[]>([])
  const [showRestored, setShowRestored] = useState(true)
  const [preview, setPreview] = useState<'input' | 'payload' | 'compare'>('payload')
  const [pendingCloudPayload, setPendingCloudPayload] = useState<string | null>(null)
  const previewPanel = useRef<HTMLDetailsElement>(null)
  const nextId = useRef(0)
  const runInProgress = useRef(false)
  const capabilityProbeId = useRef(0)

  const sandbox = runtime === 'sandbox'
  const online = !offline && (sandbox || browserOnline)
  const nano = sandbox ? (sandboxNano ? 'available' : 'unavailable') : liveNano
  const policy = useMemo(() => ({
    strictPrivacy: strict, autoRedactBeforeCloud: redact, networkOnline: online,
    onDeviceAvailable: nano === 'available', cloudFallbackAllowed: allowCloud,
    cloudConfigurationIssue: sandbox ? null : firebaseSession.cloudIssue,
  }), [strict, redact, online, nano, allowCloud, sandbox])
  const decision = useMemo(() => routePrompt(task, input, policy), [task, input, policy])
  const cloudPayload = cloudPreviewPayload(decision, task)
  const confirmingCloud = !sandbox && pendingCloudPayload !== null && pendingCloudPayload === cloudPayload
  const scan = useMemo(() => scanSensitiveData(input), [input])
  const scopeEvents = events.filter((event) => event.runtime === runtime)
  const metrics = summarizeTelemetry(scopeEvents)
  const findingsByKind = new Map<PiiFinding['kind'], number>()
  for (const { kind } of scan.findings) findingsByKind.set(kind, (findingsByKind.get(kind) ?? 0) + 1)

  const appCheckLabel = sandbox ? 'App Check idle'
    : firebaseSession.cloudIssue ? 'App Check unavailable'
      : appCheckVerified ? (config.debugToken ? 'App Check debug verified' : 'App Check verified')
        : (config.debugToken ? 'App Check debug configured' : 'App Check configured')

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      if (!mounted) return
      setBrowserOnline(navigator.onLine)
      if (runInProgress.current) return
      const id = ++capabilityProbeId.current
      void probeCapabilities(Boolean(config.firebase)).then(({ nano: availability }) => {
        if (mounted && id === capabilityProbeId.current) setLiveNano(availability)
      })
    }
    refresh()
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      mounted = false
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  async function prepareNano() {
    setPrepareProgress(0)
    setCapabilityNote('')
    try {
      const adapter = createFirebaseAiAdapter(firebaseSession.getLocalApp())
      await adapter.prepareNano((progress) => setPrepareProgress(Math.round(progress * 100)))
      const { nano: refreshedNano } = await probeCapabilities(Boolean(config.firebase))
      setLiveNano(refreshedNano)
      setCapabilityNote(refreshedNano === 'available' ? 'Gemini Nano is ready.' : 'Chrome has yet to report the model ready.')
    } catch {
      setCapabilityNote('Chrome could not prepare Gemini Nano. Check the Prompt API and model download in Chrome.')
    } finally {
      setPrepareProgress(null)
    }
  }

  async function capture() {
    setCapturing(true)
    setCaptureStatus('')
    try {
      const response = await captureTab()
      if (response.ok) {
        setInput(response.text)
        setCaptureStatus((response.from === 'selection' ? 'Selection' : 'Page text') + ' captured'
          + (response.truncated ? ' and capped at 16,000 characters.' : '.'))
      } else {
        setCaptureStatus(response.error)
      }
    } catch {
      setCaptureStatus('The extension could not capture this tab. Open a web page and click the EdgeGuard toolbar icon first.')
    } finally {
      setCapturing(false)
    }
  }

  async function run() {
    if (runInProgress.current || capturing) return
    runInProgress.current = true
    setBusy(true)

    const started = performance.now()
    let final = decision
    let outcome: TelemetryEvent['outcome'] = 'failed'
    let confirmedSource: InferenceResult['source'] | undefined
    let estimatedCloudTokensSaved = 0
    let cloudStarted = false
    let awaitingConfirmation = false
    let message = 'Inference failed. Check model availability and Firebase AI Logic setup, then retry.'

    try {
      if (!sandbox) {
        capabilityProbeId.current++
        const capabilities = await probeCapabilities(Boolean(config.firebase))
        setBrowserOnline(capabilities.networkOnline)
        setLiveNano(capabilities.nano)
        final = routePrompt(task, input, {
          ...policy,
          networkOnline: !offline && capabilities.networkOnline,
          onDeviceAvailable: capabilities.onDeviceAvailable,
        })
        const nextPayload = cloudPreviewPayload(final, task)
        if (requiresCloudConfirmation(cloudPayload, nextPayload)) {
          awaitingConfirmation = true
          setPendingCloudPayload(nextPayload)
          setPreview('payload')
          if (previewPanel.current) previewPanel.current.open = true
          return
        }
      }
      setPendingCloudPayload(null)
      setResult(null)
      if (final.kind === 'blocked') {
        outcome = 'blocked'
        setResult({ runtime, task, message: final.detail })
        return
      }

      let inference: InferenceResult
      if (sandbox) {
        inference = simulateInference(final, task, policy.onDeviceAvailable)
      } else {
        let app
        if (final.mode === InferenceMode.ONLY_ON_DEVICE) {
          app = firebaseSession.getLocalApp()
        } else {
          message = 'App Check could not verify this session. Check the project, site key, and debug token registration.'
          setAppCheckVerified(false)
          cloudStarted = true
          app = await firebaseSession.getCloudApp()
          setAppCheckVerified(true)
          if (!navigator.onLine) {
            outcome = 'blocked'
            setResult({ runtime, task, message: 'The connection went offline. Run again to evaluate the on-device route.' })
            return
          }
          message = 'Firebase AI Logic could not complete the request. Check the Firebase project and model availability.'
        }
        inference = await createFirebaseAiAdapter(app).generate(final, task)
      }

      outcome = inference.source
      if (outcome === 'on_device' && final.mode !== InferenceMode.PREFER_IN_CLOUD) {
        estimatedCloudTokensSaved = Math.ceil(formatPrompt(task, final.outboundText).length / 4)
      }
      setResult({ runtime, task, inference, redaction: final.redaction })
    } catch (error) {
      const failure = inferenceFailure(error)
      outcome = failure.outcome
      confirmedSource = failure.inferenceSource
      setResult({ runtime, task, message: failure.message ?? message })
    } finally {
      if (cloudStarted) firebaseSession.pauseCloudRefresh()
      if (!awaitingConfirmation) {
        const event: TelemetryEvent = {
          id: ++nextId.current, runtime, task, outcome, inferenceSource: confirmedSource, estimatedCloudTokensSaved,
          ...privacyMetrics(final, outcome, confirmedSource),
          mode: final.kind === 'run' ? final.mode : undefined,
          sensitivity: final.sensitivity,
          latencyMs: Math.round(performance.now() - started),
        }
        setEvents((previous) => [...previous, event])
      }
      setBusy(false)
      runInProgress.current = false
    }
  }

  function downloadTelemetry() {
    const blob = new Blob([exportTelemetry(events)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'edgeguard-telemetry.json'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const localOnly = decision.kind === 'run' && decision.mode === InferenceMode.ONLY_ON_DEVICE
  const activePreview = preview === 'compare' && !cloudPayload ? 'payload' : preview
  const inference = result?.inference
  const output = inference && result.redaction && showRestored
    ? restoreRedactedOutput(inference.text, result.redaction.placeholders, (kind) => (
      kind === 'EMAIL' || kind === 'PHONE' || kind === 'IP'
    ))
    : inference?.text

  return (
    <>
      <header className="topbar">
        <div className="shell topbar-inner">
          <div className="brand"><span className="brand-icon" aria-hidden="true">E</span> EdgeGuard <span className="brand-divider" /><span className="brand-product">Hybrid Studio</span></div>
          <div className="segments runtime-selector" role="group" aria-label="Runtime">
            <button type="button" disabled={busy || prepareProgress !== null} aria-pressed={sandbox} onClick={() => setRuntime('sandbox')}>Sandbox Simulation</button>
            <button type="button" disabled={busy || prepareProgress !== null} aria-pressed={!sandbox} onClick={() => setRuntime('live')}>Live Firebase AI Logic</button>
          </div>
        </div>
      </header>

      <main className="shell">
        <section className="intro" aria-labelledby="workspace-title">
          <div>
            <h1 id="workspace-title">Privacy workspace</h1>
            <p>Inspect text and control where Gemini processes it.</p>
          </div>
          <div className="status-row" aria-label="Runtime status">
            <Badge tone={online ? 'mint' : 'amber'}>{online ? 'Online' : 'Offline'}</Badge>
            <Badge tone={nano === 'available' ? 'mint' : 'neutral'}>{nanoLabels[nano]}</Badge>
            <Badge tone={appCheckVerified && !sandbox ? 'mint' : 'neutral'}>{appCheckLabel}</Badge>
            <select className="privacy-select" aria-label="Privacy mode" disabled={busy} value={strict ? 'strict' : 'standard'} onChange={(event) => setStrict(event.target.value === 'strict')}>
              <option value="strict">Strict privacy</option>
              <option value="standard">Standard privacy</option>
            </select>
          </div>
        </section>

        <div className="workspace">
          <aside className="column controls" aria-label="Examples and policy">
            <section className="card">
              <h2>Examples</h2>
              <div className="sample-list">
                {samples.map((sample) => (
                  <button className="sample" type="button" key={sample.name} disabled={busy || capturing} aria-pressed={input === sample.text} onClick={() => {
                    setInput(sample.text)
                    setTask(sample.task)
                    setCaptureStatus('')
                  }}>
                    <span><strong>{sample.name}</strong><small>{sample.description}</small></span>
                    <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="card">
              <h2>Routing controls</h2>
              <fieldset disabled={busy || prepareProgress !== null}>
                <legend className="sr-only">Privacy policy and runtime conditions</legend>
                <Toggle label="Redact before cloud" detail="Mask detected identifiers on every cloud-eligible route." checked={redact} onChange={setRedact} />
                <Toggle label="Allow cloud inference" detail="Permit cloud-first inference and hybrid fallback." checked={allowCloud} onChange={setAllowCloud} />
                <Toggle label="Offline routing" detail={sandbox ? 'Simulate a disconnected browser.' : 'Restrict new runs to the local model.'} checked={offline} onChange={setOffline} />
                {sandbox && <Toggle label="Simulate Nano ready" detail="Set local model availability for this scenario." checked={sandboxNano} onChange={setSandboxNano} />}
              </fieldset>

              {!sandbox && (nano === 'downloadable' || nano === 'downloading' || prepareProgress !== null) && (
                <button className="secondary prepare" type="button" disabled={busy || prepareProgress !== null || !online} onClick={() => void prepareNano()}>
                  {prepareProgress === null ? 'Prepare Gemini Nano' : 'Preparing Nano · ' + prepareProgress + '%'}
                </button>
              )}
              {capabilityNote && !sandbox && <p className="note" role="status">{capabilityNote}</p>}
            </section>
            <DeveloperSettings />
          </aside>

          <div className="column workbench">
            <section className="card editor">
              <div className="section-heading">
                <h2><label htmlFor="studio-input">Input</label></h2>
                {isExtension && <button className="secondary" type="button" disabled={busy || capturing} onClick={() => void capture()}>{capturing ? 'Capturing…' : 'Capture tab text'}</button>}
              </div>
              <textarea id="studio-input" spellCheck={false} maxLength={MAX_INPUT_LENGTH} value={input} readOnly={busy || capturing} onChange={(event) => {
                setInput(event.target.value)
                setCaptureStatus('')
              }} placeholder="Paste a note, support ticket, or excerpt…" />
              {captureStatus && <p className="note" role="status">{captureStatus}</p>}
              <div className="scan-row" aria-live="polite">
                <div className="tags">
                  {findingsByKind.size
                    ? [...findingsByKind].map(([kind, count]) => <span className="tag" key={kind}>{piiLabels[kind]} <b>{count}</b></span>)
                    : <span className="muted">No patterns detected</span>}
                </div>
                <span className="muted count">{input.length.toLocaleString()} / 16,000</span>
              </div>

              <h3>Task</h3>
              <div className="segments task-selector" role="group" aria-label="Task">
                {taskKinds.map((kind) => <button type="button" disabled={busy} aria-pressed={task === kind} key={kind} onClick={() => setTask(kind)}>{taskLabels[kind]}</button>)}
              </div>
              <div className="run-row">
                <button type="button" className="primary" disabled={busy || capturing || prepareProgress !== null || !input.trim()} onClick={() => void run()}>
                  {busy ? 'Running…' : sandbox ? 'Run simulation' : confirmingCloud ? 'Confirm cloud-eligible run' : 'Run inference'} <span aria-hidden="true">→</span>
                </button>
                <span className="note">{sandbox ? 'Deterministic preview. No network calls.' : 'Uses live Firebase AI Logic.'}</span>
              </div>
            </section>

            <details className="card" ref={previewPanel} open>
              <summary>Preview redacted egress payload</summary>
              <div className="details-body">
                {confirmingCloud && <p className="callout" role="alert">Runtime conditions changed. This request can now send text to Firebase. Review the redacted cloud payload and confirm the run.</p>}
                <div className="segments" role="group" aria-label="Payload preview">
                  <button type="button" aria-pressed={activePreview === 'payload'} onClick={() => setPreview('payload')}>Cloud payload</button>
                  <button type="button" aria-pressed={activePreview === 'input'} onClick={() => setPreview('input')}>Inspected input</button>
                  {cloudPayload && <button type="button" aria-pressed={activePreview === 'compare'} onClick={() => setPreview('compare')}>Compare</button>}
                </div>
                {activePreview === 'compare' && cloudPayload ? (
                  <div className="compare">
                    <div><h3>Inspected input</h3><HighlightedInput text={input} findings={scan.findings} /></div>
                    <div><h3>Cloud payload</h3><pre className="payload">{cloudPayload}</pre></div>
                  </div>
                ) : activePreview === 'input' ? <HighlightedInput text={input} findings={scan.findings} />
                  : cloudPayload ? <pre className="payload">{cloudPayload}</pre>
                    : <p className="note">{localOnly ? 'No cloud payload for this route.' : decision.detail}</p>}
              </div>
            </details>

            <section className="card response" aria-live="polite" aria-busy={busy}>
              <div className="section-heading">
                <h2>Last response</h2>
                {inference && result && <Badge tone={inference.source === 'on_device' ? 'mint' : 'amber'}>
                  {result.runtime === 'sandbox' ? 'Simulated · ' : ''}{outcomeLabels[inference.source]}
                </Badge>}
              </div>
              {result && <p className="note">{taskLabels[result.task]} · {result.runtime === 'sandbox' ? 'Sandbox Simulation' : 'Live Firebase AI Logic'}</p>}
              {busy ? <p className="note">Waiting for inference…</p>
                : result?.message ? <p className="callout">{result.message}</p>
                  : output !== undefined ? <pre className="payload">{output || 'The model returned an empty response.'}</pre>
                    : <p className="note">Run a task to see its response here.</p>}
              {result?.redaction && inference && (
                <Toggle label="Restore contact details locally" detail="Email, phone, and IP only. Secrets, payment cards, and national IDs stay masked." checked={showRestored} onChange={setShowRestored} />
              )}
            </section>
          </div>

          <aside className="column diagnostics" aria-label="Routing diagnostics and telemetry">
            <section className="card">
              <div className="section-heading">
                <h2>Routing decision</h2>
                <Badge tone={scan.sensitivity === 'high' ? 'amber' : 'neutral'}>{scan.sensitivity} risk</Badge>
              </div>
              <div className={'mode ' + (localOnly ? 'mode-local' : '')}>
                {decision.kind === 'run' ? sdkModes[decision.mode] : 'BLOCKED'}
              </div>
              <p className="note">{decision.detail}</p>
              <h3>Session trace</h3>
              {scopeEvents.length
                ? <ol className="trace">
                    {scopeEvents.slice(-5).reverse().map((event) => (
                      <li key={event.id}>
                        <span className={event.outcome === 'on_device' ? 'trace-local' : ''}>{outcomeLabels[event.outcome]}</span>
                        <small>{taskLabels[event.task]} · {event.latencyMs} ms</small>
                      </li>
                    ))}
                  </ol>
                : <p className="note">No runs in this runtime.</p>}
            </section>

            <section className="card">
              <div className="section-heading">
                <h2>Session telemetry</h2>
                <Badge>{sandbox ? 'Simulated' : 'Live'}</Badge>
              </div>
              <dl className="metrics">
                <div><dt>Runs</dt><dd>{metrics.totalRuns}</dd></div>
                <div><dt>On device</dt><dd>{metrics.onDeviceRuns}</dd></div>
                <div><dt>In cloud</dt><dd>{metrics.inCloudRuns}</dd></div>
                <div><dt>Blocked</dt><dd>{metrics.blockedEgressRuns}</dd></div>
                <div><dt>PII redacted in cloud payload</dt><dd>{metrics.piiRedactedInCloudPayload}</dd></div>
                <div><dt>PII blocked before send</dt><dd>{metrics.piiBlockedBeforeSend}</dd></div>
                <div><dt>PII outcome unverified</dt><dd>{metrics.piiUnverifiedOnError}</dd></div>
                <div><dt>Mean latency</dt><dd>{metrics.avgLatencyMs} <small>ms</small></dd></div>
                <div><dt>Est. cloud tokens saved</dt><dd>{metrics.estimatedCloudTokensSaved}</dd></div>
                <div><dt>Errors / unknown</dt><dd>{metrics.failedRuns} / {metrics.unknownSourceRuns}</dd></div>
              </dl>
              <button className="secondary export" type="button" onClick={downloadTelemetry}>Export telemetry JSON <span aria-hidden="true">↓</span></button>
            </section>

            <details className="card">
              <summary>Firebase SDK request</summary>
              <div className="details-body">
                {decision.kind === 'run' && !sandbox
                  ? <pre className="payload sdk-code">{
                    'getGenerativeModel(ai, {\n  mode: InferenceMode.' + sdkModes[decision.mode]
                    + ',\n  onDeviceParams: { createOptions },\n  inCloudParams: {\n    model: "' + CLOUD_MODEL
                    + '",\n    generationConfig: {\n      temperature: 0.2,\n      maxOutputTokens: 1024\n    }\n  }\n})'
                  }</pre>
                  : <p className="note">{sandbox ? 'Switch to Live Firebase AI Logic to inspect its model configuration.' : 'The router blocked this request.'}</p>}
              </div>
            </details>
          </aside>
        </div>
      </main>
    </>
  )
}
