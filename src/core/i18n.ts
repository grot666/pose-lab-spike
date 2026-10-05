/**
 * Tiny i18n: nested YAML dictionaries, dotted keys, {placeholder} interpolation,
 * array values = random variant (keeps the lab voice from repeating itself),
 * missing key -> fallback language -> key itself, with a one-time console.warn.
 * Dictionaries can be hot-swapped (Vite YAML HMR).
 */
export type Dict = { [k: string]: string | string[] | Dict };
export type Params = Record<string, string | number>;

export function resolveLang<L extends string>(search: string, defaultLang: L, available: readonly L[]): L {
  const q = new URLSearchParams(search).get('lang');
  if (!q) return defaultLang;
  const exact = available.find((l) => l.toLowerCase() === q.toLowerCase());
  if (exact) return exact;
  const prefix = available.find((l) => l.toLowerCase().split('-')[0] === q.toLowerCase().split('-')[0]);
  if (prefix) return prefix;
  console.warn(`[i18n] unsupported ?lang=${q}, using ${defaultLang}`);
  return defaultLang;
}

export function interpolate(template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function lookup(dict: Dict | undefined, key: string): string | string[] | undefined {
  let node: unknown = dict;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Dict)[part];
  }
  if (typeof node === 'string') return node;
  if (Array.isArray(node) && node.every((v) => typeof v === 'string')) return node as string[];
  return undefined;
}

/** All leaf keys of a dictionary (for parity tests). */
export function flattenKeys(dict: Dict, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(dict)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || Array.isArray(v)) out.push(key);
    else out.push(...flattenKeys(v, key));
  }
  return out;
}

export class I18n<L extends string = string> {
  private warned = new Set<string>();
  private listeners = new Set<() => void>();
  /** Global params merged into every call (e.g. subjectId). */
  globals: Params = {};

  constructor(
    private dicts: Record<L, Dict>,
    public lang: L,
    public fallbackLang: L,
    private random: () => number = Math.random,
  ) {}

  setDict(lang: L, dict: Dict): void {
    this.dicts[lang] = dict;
    this.warned.clear();
    this.listeners.forEach((l) => l());
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  has(key: string): boolean {
    return lookup(this.dicts[this.lang], key) !== undefined || lookup(this.dicts[this.fallbackLang], key) !== undefined;
  }

  private raw(key: string): string | string[] | undefined {
    const v = lookup(this.dicts[this.lang], key);
    if (v !== undefined) return v;
    const fb = lookup(this.dicts[this.fallbackLang], key);
    if (!this.warned.has(key)) {
      this.warned.add(key);
      if (fb !== undefined) console.warn(`[i18n] missing "${key}" in ${this.lang}; using ${this.fallbackLang}`);
      else console.warn(`[i18n] missing "${key}" in ${this.lang} and ${this.fallbackLang}`);
    }
    return fb;
  }

  /** Translate a plain string key in a specific language (no fallback warning), e.g. language names. */
  tIn(lang: L, key: string): string {
    const v = lookup(this.dicts[lang], key);
    return typeof v === 'string' ? v : Array.isArray(v) && v.length ? v[0] : key;
  }

  /** Translate. Arrays pick a random variant unless `variant` is given. */
  t(key: string, params: Params = {}, variant?: number): string {
    const v = this.raw(key);
    if (v === undefined) return key;
    let s: string;
    if (Array.isArray(v)) {
      if (!v.length) return key;
      const i = variant !== undefined ? variant % v.length : Math.floor(this.random() * v.length);
      s = v[i];
    } else s = v;
    return interpolate(s, { ...this.globals, ...params });
  }
}
