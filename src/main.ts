import './style.css';
import posesRaw from './content/poses.yaml';
import zhCN from './content/i18n/zh-CN.yaml';
import en from './content/i18n/en.yaml';
import { App } from './app';
import { config, type Lang } from './config';
import { I18n, resolveLang, type Dict } from './core/i18n';
import { parsePoseLibrary } from './core/poseLibrary';

const LANGS: readonly Lang[] = ['zh-CN', 'en'];
const i18n = new I18n<Lang>({ 'zh-CN': zhCN as Dict, en: en as Dict }, resolveLang(location.search, config.defaultLang, LANGS), config.fallbackLang);

const app = new App(parsePoseLibrary(posesRaw), i18n);

// Vite YAML HMR: copy and pose rules update live without losing the session.
if (import.meta.hot) {
  import.meta.hot.accept('./content/poses.yaml', (mod) => {
    if (!mod) return;
    try {
      app.setPoses(parsePoseLibrary(mod.default));
    } catch (err) {
      console.error('[pose-lab] poses.yaml rejected, keeping previous version:', (err as Error).message);
    }
  });
  import.meta.hot.accept('./content/i18n/zh-CN.yaml', (mod) => {
    if (mod) i18n.setDict('zh-CN', mod.default as Dict);
  });
  import.meta.hot.accept('./content/i18n/en.yaml', (mod) => {
    if (mod) i18n.setDict('en', mod.default as Dict);
  });
}
