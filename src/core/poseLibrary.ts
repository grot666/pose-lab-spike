/**
 * Validates the raw object parsed from src/content/poses.yaml into typed
 * PoseDefinitions. Throws PoseLibraryError with a readable path on bad input,
 * so YAML typos surface immediately (also on HMR).
 */
import { REFERENCES, isAngleName, type ReferenceName } from './geometry';
import { isPointName, type PointName } from './landmarks';
import { RULE_TYPES, type Axis, type PoseDefinition, type PoseRule } from './poseRules';

export class PoseLibraryError extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(path: string, msg: string): never {
  throw new PoseLibraryError(`poses.yaml ${path}: ${msg}`);
}

function num(o: Obj, key: string, path: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || Number.isNaN(v)) fail(`${path}.${key}`, 'must be a number');
  return v;
}

function point(v: unknown, path: string): PointName {
  if (typeof v !== 'string' || !isPointName(v)) fail(path, `unknown point "${String(v)}"`);
  return v;
}

function points(v: unknown, path: string): PointName | PointName[] {
  if (Array.isArray(v)) {
    if (!v.length) fail(path, 'empty list');
    return v.map((p, i) => point(p, `${path}[${i}]`));
  }
  return point(v, path);
}

function ref(v: unknown, path: string): ReferenceName {
  if (typeof v !== 'string' || !(REFERENCES as readonly string[]).includes(v)) {
    fail(path, `ref must be one of ${REFERENCES.join(', ')}`);
  }
  return v as ReferenceName;
}

function range(o: Obj, path: string, required = true): { min?: number; max?: number } {
  const min = num(o, 'min', path);
  const max = num(o, 'max', path);
  if (required && min === undefined && max === undefined) fail(path, 'needs min and/or max');
  if (min !== undefined && max !== undefined && min > max) fail(path, 'min > max');
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

export function parseRule(raw: unknown, path: string): PoseRule {
  if (!isObj(raw)) fail(path, 'rule must be a mapping');
  const id = raw.id;
  if (typeof id !== 'string' || !id) fail(path, 'rule needs a string id');
  const type = raw.type;
  if (typeof type !== 'string' || !(RULE_TYPES as readonly string[]).includes(type)) {
    fail(`${path}(${id})`, `type must be one of ${RULE_TYPES.join(', ')}`);
  }
  const p = `${path}(${id})`;
  const minVisibility = num(raw, 'minVisibility', p);
  const common = { id, ...(minVisibility !== undefined ? { minVisibility } : {}) };

  switch (type) {
    case 'angle': {
      const angles = Array.isArray(raw.angles) ? raw.angles : [raw.angles];
      for (const a of angles) if (typeof a !== 'string' || !isAngleName(a)) fail(`${p}.angles`, `unknown angle "${String(a)}"`);
      return { ...common, type, angles: angles as never, ...range(raw, p) };
    }
    case 'torso_tilt':
    case 'head_pitch':
      return { ...common, type, ...range(raw, p) };
    case 'distance': {
      const axes = raw.axes;
      if (axes !== undefined && (typeof axes !== 'string' || !/^[xyz]{1,3}$/.test(axes))) fail(`${p}.axes`, 'must be like "xz"');
      return {
        ...common,
        type,
        a: point(raw.a, `${p}.a`),
        b: point(raw.b, `${p}.b`),
        ref: ref(raw.ref, `${p}.ref`),
        ...(axes ? { axes: axes as string } : {}),
        ...range(raw, p),
      };
    }
    case 'offset': {
      const axis = raw.axis;
      if (axis !== 'x' && axis !== 'y' && axis !== 'z') fail(`${p}.axis`, 'must be x, y or z');
      const a = points(raw.a, `${p}.a`);
      const b = points(raw.b, `${p}.b`);
      if (Array.isArray(a) && Array.isArray(b) && b.length !== 1 && b.length !== a.length) {
        fail(p, 'a/b lists must have equal length (or b of length 1)');
      }
      return { ...common, type, a, b, axis: axis as Axis, ref: ref(raw.ref, `${p}.ref`), ...range(raw, p) };
    }
    case 'visibility': {
      const joints = points(raw.joints, `${p}.joints`);
      const mode = raw.mode ?? 'all';
      if (mode !== 'all' && mode !== 'any') fail(`${p}.mode`, 'must be all or any');
      return { ...common, type, joints: Array.isArray(joints) ? joints : [joints], mode, ...range(raw, p) };
    }
    case 'any_of':
    case 'all_of': {
      if (!Array.isArray(raw.rules) || !raw.rules.length) fail(`${p}.rules`, 'needs a non-empty list');
      return { ...common, type, rules: raw.rules.map((r, i) => parseRule(r, `${p}.rules[${i}]`)) };
    }
    case 'not':
      return { ...common, type, rule: parseRule(raw.rule, `${p}.rule`) };
  }
  fail(p, 'unreachable');
}

export function parsePoseLibrary(raw: unknown): PoseDefinition[] {
  if (!isObj(raw) || !Array.isArray(raw.poses)) fail('root', 'expected { poses: [...] }');
  const seen = new Set<string>();
  return raw.poses.map((p, i) => {
    const path = `poses[${i}]`;
    if (!isObj(p)) fail(path, 'pose must be a mapping');
    if (typeof p.id !== 'string' || !/^[a-z0-9_]+$/.test(p.id)) fail(path, 'id must be snake_case');
    if (seen.has(p.id)) fail(path, `duplicate id "${p.id}"`);
    seen.add(p.id);
    const extra = Object.keys(p).filter((k) => k !== 'id' && k !== 'rules');
    if (extra.length) fail(`${path}(${p.id})`, `only id + rules allowed (names/copy go in i18n). Found: ${extra.join(', ')}`);
    if (!Array.isArray(p.rules) || !p.rules.length) fail(`${path}(${p.id})`, 'needs rules');
    const ruleIds = new Set<string>();
    const rules = p.rules.map((r, j) => {
      const rule = parseRule(r, `${path}(${p.id}).rules[${j}]`);
      if (ruleIds.has(rule.id)) fail(`${path}(${p.id})`, `duplicate rule id "${rule.id}"`);
      ruleIds.add(rule.id);
      return rule;
    });
    return { id: p.id, rules };
  });
}

/** Collect every rule id (including nested) - used to check i18n hint coverage. */
export function collectRuleIds(poses: PoseDefinition[], topLevelOnly = true): string[] {
  const ids = new Set<string>();
  const walk = (r: PoseRule) => {
    ids.add(r.id);
    if (topLevelOnly) return;
    if (r.type === 'any_of' || r.type === 'all_of') r.rules.forEach(walk);
    if (r.type === 'not') walk(r.rule);
  };
  poses.forEach((p) => p.rules.forEach(walk));
  return [...ids];
}
