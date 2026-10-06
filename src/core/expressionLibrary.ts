/**
 * Validates the raw object parsed from src/content/expressions.yaml.
 */
import {
  EXPR_RULE_TYPES,
  type ExpressionDefinition,
  type ExpressionRule,
} from './expressionRules';

export class ExpressionLibraryError extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(path: string, msg: string): never {
  throw new ExpressionLibraryError(`expressions.yaml ${path}: ${msg}`);
}

function num(o: Obj, key: string, path: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || Number.isNaN(v)) fail(`${path}.${key}`, 'must be a number');
  return v;
}

function range(o: Obj, path: string): { min?: number; max?: number } {
  const min = num(o, 'min', path);
  const max = num(o, 'max', path);
  if (min === undefined && max === undefined) fail(path, 'needs min and/or max');
  if (min !== undefined && (min < 0 || min > 1)) fail(`${path}.min`, 'must be 0..1');
  if (max !== undefined && (max < 0 || max > 1)) fail(`${path}.max`, 'must be 0..1');
  if (min !== undefined && max !== undefined && min > max) fail(path, 'min > max');
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

export function parseExpressionRule(raw: unknown, path: string): ExpressionRule {
  if (!isObj(raw)) fail(path, 'rule must be a mapping');
  const id = raw.id;
  if (typeof id !== 'string' || !id) fail(path, 'rule needs a string id');
  const type = raw.type;
  if (typeof type !== 'string' || !(EXPR_RULE_TYPES as readonly string[]).includes(type)) {
    fail(`${path}(${id})`, `type must be one of ${EXPR_RULE_TYPES.join(', ')}`);
  }
  const p = `${path}(${id})`;
  switch (type) {
    case 'blendshape': {
      if (typeof raw.name !== 'string' || !raw.name) fail(`${p}.name`, 'needs blendshape name');
      return { id, type, name: raw.name, ...range(raw, p) };
    }
    case 'any_of':
    case 'all_of': {
      if (!Array.isArray(raw.rules) || !raw.rules.length) fail(`${p}.rules`, 'needs a non-empty list');
      return { id, type, rules: raw.rules.map((r, i) => parseExpressionRule(r, `${p}.rules[${i}]`)) };
    }
    case 'not':
      return { id, type, rule: parseExpressionRule(raw.rule, `${p}.rule`) };
  }
  fail(p, 'unreachable');
}

export function parseExpressionLibrary(raw: unknown): ExpressionDefinition[] {
  if (!isObj(raw) || !Array.isArray(raw.expressions)) fail('root', 'expected { expressions: [...] }');
  const seen = new Set<string>();
  return raw.expressions.map((e, i) => {
    const path = `expressions[${i}]`;
    if (!isObj(e)) fail(path, 'expression must be a mapping');
    if (typeof e.id !== 'string' || !/^[a-z0-9_]+$/.test(e.id)) fail(path, 'id must be snake_case');
    if (seen.has(e.id)) fail(path, `duplicate id "${e.id}"`);
    seen.add(e.id);
    const extra = Object.keys(e).filter((k) => k !== 'id' && k !== 'rules');
    if (extra.length) fail(`${path}(${e.id})`, `only id + rules allowed (names/copy go in i18n). Found: ${extra.join(', ')}`);
    if (!Array.isArray(e.rules) || !e.rules.length) fail(`${path}(${e.id})`, 'needs rules');
    const ruleIds = new Set<string>();
    const rules = e.rules.map((r, j) => {
      const rule = parseExpressionRule(r, `${path}(${e.id}).rules[${j}]`);
      if (ruleIds.has(rule.id)) fail(`${path}(${e.id})`, `duplicate rule id "${rule.id}"`);
      ruleIds.add(rule.id);
      return rule;
    });
    return { id: e.id, rules };
  });
}

export function collectExpressionRuleIds(defs: ExpressionDefinition[], topLevelOnly = true): string[] {
  const ids = new Set<string>();
  const walk = (r: ExpressionRule) => {
    ids.add(r.id);
    if (topLevelOnly) return;
    if (r.type === 'any_of' || r.type === 'all_of') r.rules.forEach(walk);
    if (r.type === 'not') walk(r.rule);
  };
  defs.forEach((d) => d.rules.forEach(walk));
  return [...ids];
}
