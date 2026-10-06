import './style.css';
import posesRaw from './content/poses.yaml';
import expressionsRaw from './content/expressions.yaml';
import zhCN from './content/i18n/zh-CN.yaml';
import en from './content/i18n/en.yaml';
import { App } from './app';
import { FaceApp } from './faceApp';
import { config, type Lang } from './config';
import { I18n, resolveLang, type Dict } from './core/i18n';
import { parseExpressionLibrary } from './core/expressionLibrary';
import { parsePoseLibrary } from './core/poseLibrary';

const LANGS: readonly Lang[] = ['zh-CN', 'en'];
const i18n = new I18n<Lang>({ 'zh-CN': zhCN as Dict, en: en as Dict }, resolveLang(location.search, config.defaultLang, LANGS), config.fallbackLang);

const mode = new URLSearchParams(location.search).get('mode');
const faceMode = mode === 'face';

if (faceMode) {
  // Wire back link (preserve lang / other params except mode)
  const back = document.getElementById('face-back-link') as HTMLAnchorElement | null;
  if (back) {
    const u = new URL(location.href);
    u.searchParams.delete('mode');
    back.href = u.toString();
  }
  const faceApp = new FaceApp(parseExpressionLibrary(expressionsRaw), i18n);
  if (import.meta.hot) {
    import.meta.hot.accept('./content/expressions.yaml', (mod) => {
      if (!mod) return;
      try {
        faceApp.setExpressions(parseExpressionLibrary(mod.default));
      } catch (err) {
        console.error('[pose-lab] expressions.yaml rejected, keeping previous version:', (err as Error).message);
      }
    });
    import.meta.hot.accept('./content/i18n/zh-CN.yaml', (mod) => {
      if (mod) i18n.setDict('zh-CN', mod.default as Dict);
    });
    import.meta.hot.accept('./content/i18n/en.yaml', (mod) => {
      if (mod) i18n.setDict('en', mod.default as Dict);
    });
  }
} else {
  const app = new App(parsePoseLibrary(posesRaw), i18n);
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
}
