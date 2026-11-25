import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, setTokenAutoRefreshEnabled } from 'firebase/app-check'
import { initializeApp } from 'firebase/app'
import type { AppCheck } from 'firebase/app-check'
import type { FirebaseApp, FirebaseOptions } from 'firebase/app'

export const DEBUG_TOKEN_STORAGE_KEY = 'edgeguard.app-check-debug-token'
const APP_CHECK_TIMEOUT_MS = 15_000

export interface RuntimeConfig {
  firebase?: FirebaseOptions
  recaptchaSiteKey?: string
  debugToken?: string | true
}

type ConfigEnvironment = Record<string, string | boolean | undefined>

export function readRuntimeConfig(env: ConfigEnvironment, runtimeDebugToken?: string): RuntimeConfig {
  const read = (key: string) => {
    const value = env[key]
    return typeof value === 'string' ? value.trim() || undefined : undefined
  }

  const apiKey = read('VITE_FIREBASE_API_KEY')
  const projectId = read('VITE_FIREBASE_PROJECT_ID')
  const appId = read('VITE_FIREBASE_APP_ID')
  const environmentToken = read('VITE_FIREBASE_APPCHECK_DEBUG_TOKEN')
  return {
    firebase: apiKey && projectId && appId
      ? { apiKey, projectId, appId, authDomain: read('VITE_FIREBASE_AUTH_DOMAIN') }
      : undefined,
    recaptchaSiteKey: read('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY'),
    debugToken: runtimeDebugToken?.trim() || (environmentToken === 'true' ? true : environmentToken),
  }
}

export interface DebugTokenTarget {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean
}

interface AppCheckSdk {
  initializeApp: typeof initializeApp
  initializeAppCheck: typeof initializeAppCheck
  ReCaptchaEnterpriseProvider: typeof ReCaptchaEnterpriseProvider
}

const firebaseSdk: AppCheckSdk = { initializeApp, initializeAppCheck, ReCaptchaEnterpriseProvider }

export type AppCheckBootstrap =
  | { status: 'unconfigured' }
  | { status: 'active' | 'debug-token'; app: FirebaseApp; appCheck: AppCheck }

export class AppCheckVerificationError extends Error {
  constructor(cause: unknown) {
    super('App Check could not verify this session. Check the project, site key, and debug token registration.', { cause })
  }
}

export function bootstrapAppCheck(
  config: RuntimeConfig,
  sdk: AppCheckSdk = firebaseSdk,
  debugTarget: DebugTokenTarget = globalThis as DebugTokenTarget,
): AppCheckBootstrap {
  if (!config.firebase || !config.recaptchaSiteKey) return { status: 'unconfigured' }

  if (config.debugToken) debugTarget.FIREBASE_APPCHECK_DEBUG_TOKEN = config.debugToken
  else delete debugTarget.FIREBASE_APPCHECK_DEBUG_TOKEN

  const app = sdk.initializeApp(config.firebase, {
    name: config.debugToken ? 'edgeguard-cloud-debug' : 'edgeguard-cloud',
    automaticDataCollectionEnabled: true,
  })
  const appCheck = sdk.initializeAppCheck(app, {
    provider: new sdk.ReCaptchaEnterpriseProvider(config.recaptchaSiteKey),
    isTokenAutoRefreshEnabled: true,
  })
  return { status: config.debugToken ? 'debug-token' : 'active', app, appCheck }
}

async function verifyAppCheck(appCheck: AppCheck, forceRefresh: boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      getToken(appCheck, forceRefresh),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('App Check verification timed out.')), APP_CHECK_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    throw new AppCheckVerificationError(error)
  } finally {
    clearTimeout(timer)
  }
}

export function createFirebaseSession(config: RuntimeConfig, isExtension: boolean) {
  let localApp: FirebaseApp | undefined
  let cloud: Extract<AppCheckBootstrap, { app: FirebaseApp }> | undefined
  let cloudVerified = false
  const cloudIssue = !config.firebase || !config.recaptchaSiteKey
    ? 'Set the Firebase web config and reCAPTCHA Enterprise site key to enable live cloud inference.'
    : isExtension && !config.debugToken
      ? 'Cloud inference in the side panel requires a registered App Check debug token. Set one in Developer settings.'
      : null

  return {
    cloudIssue,
    getLocalApp() {
      // The SDK requires three nonempty fields even for Nano. These placeholders have no cloud project.
      localApp ??= initializeApp(config.firebase ?? {
        apiKey: 'unused-local-only', projectId: 'edgeguard-local-only', appId: 'unused-local-only',
      }, { name: 'edgeguard-local', automaticDataCollectionEnabled: false })
      return localApp
    },
    async getCloudApp() {
      if (cloudIssue) throw new Error(cloudIssue)
      if (cloud) {
        setTokenAutoRefreshEnabled(cloud.appCheck, true)
      } else {
        const initialized = bootstrapAppCheck(config)
        if (initialized.status === 'unconfigured') throw new Error('App Check must be configured.')
        cloud = initialized
      }
      // App Check enforcement stays meaningful even if a test project allows unattested traffic.
      await verifyAppCheck(cloud.appCheck, Boolean(config.debugToken && !cloudVerified))
      cloudVerified = true
      return cloud.app
    },
    pauseCloudRefresh() {
      if (cloud) setTokenAutoRefreshEnabled(cloud.appCheck, false)
    },
  }
}
