/** Build-time version + short git SHA injected via Vite `define`. */
export function appVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
}

export function gitSha(): string {
  return typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__ : 'dev';
}

/** e.g. "v0.1.1 · 8e62913" */
export function buildLabel(): string {
  return `v${appVersion()} · ${gitSha()}`;
}
