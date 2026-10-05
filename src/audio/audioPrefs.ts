/** Mute / volume persistence (localStorage). Fails soft (private mode, quota, bad JSON). */
export interface AudioPrefs {
  muted: boolean;
  volume: number;
}

type ReadStore = Pick<Storage, 'getItem'>;
type WriteStore = Pick<Storage, 'setItem'>;

export function loadAudioPrefs(store: ReadStore | null | undefined, key: string, defaults: AudioPrefs): AudioPrefs {
  try {
    const raw = store?.getItem(key);
    if (!raw) return { ...defaults };
    const p = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      muted: typeof p.muted === 'boolean' ? p.muted : defaults.muted,
      volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? Math.min(1, Math.max(0, p.volume)) : defaults.volume,
    };
  } catch {
    return { ...defaults };
  }
}

export function saveAudioPrefs(store: WriteStore | null | undefined, key: string, prefs: AudioPrefs): void {
  try {
    store?.setItem(key, JSON.stringify({ muted: prefs.muted, volume: prefs.volume }));
  } catch {
    /* storage unavailable - preference just won't persist */
  }
}

export function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
