/// <reference types="vite/client" />

interface ImportMetaEnv {
  // 1 = run on bundled fixtures, no backend. Development only —
  // `src/env.ts` ignores it in a production build on purpose.
  readonly VITE_MOCK?: string
  // API base for the daemon, relative to the app origin.
  readonly VITE_API_BASE?: string
  // State-feed poll interval in ms.
  readonly VITE_POLL_MS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
