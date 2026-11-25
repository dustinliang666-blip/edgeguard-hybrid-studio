import { ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import type { AppCheck, initializeAppCheck } from 'firebase/app-check'
import type { FirebaseApp, initializeApp } from 'firebase/app'
import { describe, expect, it, vi } from 'vitest'
import { bootstrapAppCheck, createFirebaseSession, readRuntimeConfig } from '../src/core/appCheckBootstrap'
import type { DebugTokenTarget } from '../src/core/appCheckBootstrap'

const environment = {
  VITE_FIREBASE_API_KEY: 'test-api-value',
  VITE_FIREBASE_PROJECT_ID: 'test-project',
  VITE_FIREBASE_APP_ID: 'test-app-id',
  VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: 'test-site-id',
}

function fakeSdk(debugTarget: DebugTokenTarget) {
  const app = { name: 'test' } as FirebaseApp
  const appCheck = { app } as AppCheck
  let debugValueOnInit: string | boolean | undefined
  return {
    app, appCheck,
    sdk: {
      initializeApp: vi.fn<typeof initializeApp>(() => app),
      initializeAppCheck: vi.fn<typeof initializeAppCheck>(() => {
        debugValueOnInit = debugTarget.FIREBASE_APPCHECK_DEBUG_TOKEN
        return appCheck
      }),
      ReCaptchaEnterpriseProvider,
    },
    observedToken: () => debugValueOnInit,
  }
}

describe('Firebase App Check bootstrap', () => {
  it('does not initialize Firebase without complete web config and reCAPTCHA site key', () => {
    const target: DebugTokenTarget = {}
    const { sdk } = fakeSdk(target)
    expect(bootstrapAppCheck(readRuntimeConfig({}), sdk, target)).toEqual({ status: 'unconfigured' })
    expect(bootstrapAppCheck(readRuntimeConfig({ ...environment, VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: '  ' }), sdk, target))
      .toEqual({ status: 'unconfigured' })
    expect(sdk.initializeApp).not.toHaveBeenCalled()
    expect(sdk.initializeAppCheck).not.toHaveBeenCalled()
  })

  it('instantiates a genuine reCAPTCHA Enterprise provider and enables token refresh', () => {
    const target: DebugTokenTarget = { FIREBASE_APPCHECK_DEBUG_TOKEN: 'previous-fixture' }
    const { sdk, app, appCheck, observedToken } = fakeSdk(target)
    expect(bootstrapAppCheck(readRuntimeConfig(environment), sdk, target)).toEqual({ status: 'active', app, appCheck })
    expect(sdk.initializeApp).toHaveBeenCalledWith(
      { apiKey: 'test-api-value', authDomain: undefined, projectId: 'test-project', appId: 'test-app-id' },
      { name: 'edgeguard-cloud', automaticDataCollectionEnabled: true },
    )
    expect(sdk.initializeAppCheck).toHaveBeenCalledWith(app, {
      provider: expect.any(ReCaptchaEnterpriseProvider), isTokenAutoRefreshEnabled: true,
    })
    expect(observedToken()).toBeUndefined()
  })

  it('sets the runtime debug token before SDK initialization and isolates debug cache', () => {
    const target: DebugTokenTarget = {}
    const { sdk, observedToken } = fakeSdk(target)
    const config = readRuntimeConfig({ ...environment, VITE_FIREBASE_APPCHECK_DEBUG_TOKEN: 'env-fixture' }, ' runtime-fixture ')
    expect(bootstrapAppCheck(config, sdk, target).status).toBe('debug-token')
    expect(sdk.initializeApp).toHaveBeenCalledWith(config.firebase, expect.objectContaining({ name: 'edgeguard-cloud-debug' }))
    expect(observedToken()).toBe('runtime-fixture')
  })

  it('supports the SDK boolean debug flag and trimmed literal environment values', () => {
    expect(readRuntimeConfig({ VITE_FIREBASE_APPCHECK_DEBUG_TOKEN: ' true ' }).debugToken).toBe(true)
    expect(readRuntimeConfig({ VITE_FIREBASE_APPCHECK_DEBUG_TOKEN: ' env-fixture ' }, ' ').debugToken).toBe('env-fixture')
  })

  it('requires a debug token for side-panel cloud use before any SDK calls', async () => {
    const config = readRuntimeConfig(environment)
    const extension = createFirebaseSession(config, true)
    await expect(extension.getCloudApp()).rejects.toThrow(/registered App Check debug token/)
    expect(createFirebaseSession(config, false).cloudIssue).toBeNull()
  })

  it('can configure the isolated Nano app without a cloud project or App Check', async () => {
    const session = createFirebaseSession(readRuntimeConfig({}), false)
    expect(session.getLocalApp()).toMatchObject({
      name: 'edgeguard-local',
      automaticDataCollectionEnabled: false,
      options: { apiKey: 'unused-local-only', projectId: 'edgeguard-local-only', appId: 'unused-local-only' },
    })
    expect(session.getLocalApp()).toBe(session.getLocalApp())
    await expect(session.getCloudApp()).rejects.toThrow(/enable live cloud inference/)
  })
})
