/**
 * Resolve a public/ asset path against Vite BASE_URL and the current page URL.
 *
 * GitHub project Pages serves under `/pose-lab-spike/`. With relative base `./`
 * (or when the bundler normalizes it to `/`), resolving a root-absolute URL
 * against the origin would escape the project and 404 models/wasm. Always prefer
 * the page's directory unless BASE_URL is an explicit non-root absolute path.
 */
export function assetUrl(
  path: string,
  baseHref: string = typeof window !== 'undefined' ? window.location.href : 'http://local/',
): string {
  const rel = path.replace(/^\//, '');
  const envBase = String((typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || './');

  const page = new URL(baseHref);
  page.search = '';
  page.hash = '';
  if (!page.pathname.endsWith('/')) {
    const last = page.pathname.split('/').pop() || '';
    // Only strip when the last segment looks like a file (has a dot). Bare
    // `/pose-lab-spike` is a directory and must keep its name.
    if (last.includes('.')) {
      page.pathname = page.pathname.replace(/[^/]+$/, '');
    }
    if (!page.pathname.endsWith('/')) page.pathname += '/';
  }

  if (/^https?:\/\//i.test(envBase)) {
    return new URL(rel, envBase.replace(/\/?$/, '/')).href;
  }
  // Explicit project base, e.g. BASE_PATH=/pose-lab-spike/
  if (envBase.startsWith('/') && envBase !== '/') {
    return new URL(envBase.replace(/\/?$/, '/') + rel, page.origin).href;
  }

  // Relative `./` or root `/`: keep assets under the current page directory.
  return new URL(rel, page).href;
}

/** MediaPipe FilesetResolver joins `${wasmPath}/vision_wasm_…`; avoid a trailing slash. */
export function wasmAssetDir(wasmPath: string, baseHref?: string): string {
  return assetUrl(wasmPath, baseHref).replace(/\/+$/, '');
}
