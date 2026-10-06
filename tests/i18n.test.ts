import { describe, expect, it, vi } from 'vitest';
import zh from '../src/content/i18n/zh-CN.yaml';
import en from '../src/content/i18n/en.yaml';
import posesYaml from '../src/content/poses.yaml';
import expressionsYaml from '../src/content/expressions.yaml';
import { I18n, flattenKeys, interpolate, resolveLang, type Dict } from '../src/core/i18n';
import { collectExpressionRuleIds, parseExpressionLibrary } from '../src/core/expressionLibrary';
import { collectRuleIds, parsePoseLibrary } from '../src/core/poseLibrary';

describe('i18n core', () => {
  it('interpolates placeholders and leaves unknown ones', () => {
    expect(interpolate('Sample {subjectId}: {n}s {x}', { subjectId: 'S-1', n: 3 })).toBe('Sample S-1: 3s {x}');
  });

  it('resolves ?lang= with exact, prefix and fallback', () => {
    const langs = ['zh-CN', 'en'] as const;
    expect(resolveLang('?lang=en', 'zh-CN', langs)).toBe('en');
    expect(resolveLang('?lang=zh', 'en', langs)).toBe('zh-CN');
    expect(resolveLang('', 'zh-CN', langs)).toBe('zh-CN');
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveLang('?lang=fr', 'zh-CN', langs)).toBe('zh-CN');
    w.mockRestore();
  });

  it('falls back to fallback language then key, warning once per key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const i = new I18n<'a' | 'b'>({ a: { x: 'A' }, b: { x: 'B', y: 'BY {v}' } }, 'a', 'b');
    expect(i.t('x')).toBe('A');
    expect(i.t('y', { v: 1 })).toBe('BY 1');
    expect(i.t('y', { v: 2 })).toBe('BY 2');
    expect(i.t('nope.key')).toBe('nope.key');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('array values pick a variant; globals are merged', () => {
    const i = new I18n<'a'>({ a: { v: ['one {g}', 'two {g}'] } }, 'a', 'a', () => 0.99);
    i.globals.g = 'G';
    expect(i.t('v')).toBe('two G');
    expect(i.t('v', {}, 0)).toBe('one G');
  });

  it('hot-swapping a dictionary notifies listeners', () => {
    const i = new I18n<'a'>({ a: { x: 'old' } }, 'a', 'a');
    const spy = vi.fn();
    i.onChange(spy);
    i.setDict('a', { x: 'new' });
    expect(i.t('x')).toBe('new');
    expect(spy).toHaveBeenCalled();
  });
});

describe('content yaml', () => {
  const zhKeys = flattenKeys(zh as Dict).sort();
  const enKeys = flattenKeys(en as Dict).sort();

  it('zh-CN and en have identical key sets', () => {
    expect(zhKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !zhKeys.includes(k))).toEqual([]);
  });

  it('every pose has a name/command/instruction and every top-level rule has a hint', () => {
    const poses = parsePoseLibrary(posesYaml);
    for (const lang of [zh, en] as Dict[]) {
      const i = new I18n<'x'>({ x: lang }, 'x', 'x');
      for (const p of poses) {
        for (const k of ['name', 'command', 'instruction']) expect(i.has(`poses.${p.id}.${k}`), `${p.id}.${k}`).toBe(true);
      }
      for (const r of collectRuleIds(poses)) expect(i.has(`hints.${r}`), `hints.${r}`).toBe(true);
    }
  });

  it('every expression has name/command/instruction and every top-level rule has a hint', () => {
    const exprs = parseExpressionLibrary(expressionsYaml);
    for (const lang of [zh, en] as Dict[]) {
      const i = new I18n<'x'>({ x: lang }, 'x', 'x');
      for (const e of exprs) {
        for (const k of ['name', 'command', 'instruction']) expect(i.has(`expressions.${e.id}.${k}`), `${e.id}.${k}`).toBe(true);
      }
      for (const r of collectExpressionRuleIds(exprs)) expect(i.has(`hints.${r}`), `hints.${r}`).toBe(true);
    }
  });
});
