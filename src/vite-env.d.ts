/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_REAL_BACKEND?: string;
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
