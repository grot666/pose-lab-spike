/// <reference types="vite/client" />

/** Injected at build time via Vite `define` (see vite.config.ts). */
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;

declare module '*.yaml' {
  const data: unknown;
  export default data;
}
declare module '*.yml' {
  const data: unknown;
  export default data;
}
