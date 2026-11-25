import { defineConfig } from 'vitest/config'

export default defineConfig(({ command, mode }) => {
  const extension = mode === 'extension'
  return {
    base: './',
    envPrefix: [
      'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_APP_ID', 'VITE_RECAPTCHA_ENTERPRISE_SITE_KEY',
      ...(command === 'serve' ? ['VITE_FIREBASE_APPCHECK_DEBUG_TOKEN'] : []),
    ],
    publicDir: extension ? 'extension' : false,
    build: {
      outDir: extension ? 'dist-extension' : 'dist',
      rolldownOptions: { input: extension ? 'sidepanel.html' : 'index.html' },
    },
    test: { maxWorkers: 2 },
  }
})
