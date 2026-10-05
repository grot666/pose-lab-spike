/**
 * Declarative pose rules + evaluator. Rules are authored in
 * src/content/poses.yaml and validated by poseLibrary.ts.
 *
 * Every rule evaluates to:
 *   pass    - measured and within range
 *   fail    - measured and out of range
 *   unknown - required joints not visible enough to judge (NOT a failure)
 *
 * All geometry uses WORLD landmarks (metres, y up, z toward camera) and
 * ratio references (shoulder width, torso length...) to be body-size independent.
 */
import {
  type AngleName,
  type ReferenceName,
  angleJoints,
  headPitch,
  jointAngle,
  referenceJoints,
  referenceLength,
  torsoTilt,
} from './geometry';
import { type Landmark, type PointName, CORE_JOINTS, J, getPoint, pointJoints } from './landmarks';

export type RuleStatus = 'pass' | 'fail' | 'unknown';
export type Axis = 'x' | 'y' | 'z';

interface RuleBase {
  id: string;
  /** Per-rule visibility gate override (e.g. lower for often-occluded ankles). */
  minVisibility?: number;
}
interface Range {
  min?: number;
  max?: number;
}

export interface AngleRule extends RuleBase, Range {
  type: 'angle';
  /** All listed angles must be in range. */
  angles: AngleName[];
}
export interface TorsoTiltRule extends RuleBase, Range {
  type: 'torso_tilt';
}
export interface HeadPitchRule extends RuleBase, Range {
  type: 'head_pitch';
}
export interface DistanceRule extends RuleBase, Range {
  type: 'distance';
  a: PointName;
  b: PointName;
  ref: ReferenceName;
  /** Subset of axes to measure on, e.g. "xz" = horizontal-plane distance. Default "xyz". */
  axes?: string;
}
export interface OffsetRule extends RuleBase, Range {
  type: 'offset';
  /** (a.axis - b.axis) / ref. Arrays are evaluated pairwise; all pairs must be in range. */
  a: PointName | PointName[];
  b: PointName | PointName[];
  axis: Axis;
  ref: ReferenceName;
}
export interface VisibilityRule extends RuleBase, Range {
  type: 'visibility';
  joints: PointName[];
  /** all (default): every joint satisfies the range; any: at least one does. */
  mode?: 'all' | 'any';
}
export interface AnyOfRule extends RuleBase {
  type: 'any_of';
  rules: PoseRule[];
}
export interface AllOfRule extends RuleBase {
  type: 'all_of';
  rules: PoseRule[];
}
export interface NotRule extends RuleBase {
  type: 'not';
  rule: PoseRule;
}

export type PoseRule =
  | AngleRule
  | TorsoTiltRule
  | HeadPitchRule
  | DistanceRule
  | OffsetRule
  | VisibilityRule
  | AnyOfRule
  | AllOfRule
  | NotRule;

export const RULE_TYPES = [
  'angle',
  'torso_tilt',
  'head_pitch',
  'distance',
  'offset',
  'visibility',
  'any_of',
  'all_of',
  'not',
] as const;

export interface PoseDefinition {
  id: string;
  rules: PoseRule[];
}

export interface RuleResult {
  id: string;
  type: PoseRule['type'];
  status: RuleStatus;
  /** Measured values (degrees / ratios / visibility); NaN when unknown. */
  values: number[];
  children?: RuleResult[];
}

export interface PoseEvaluation {
  poseId: string;
  status: RuleStatus;
  rules: RuleResult[];
  passCount: number;
  failCount: number;
  unknownCount: number;
  /** passCount / rules.length, 0..1 - a soft "closeness" signal for UI. */
  score: number;
}

export interface EvalOptions {
  visibilityThreshold: number;
}

const DEFAULT_OPTS: EvalOptions = { visibilityThreshold: 0.5 };

function inRange(v: number, r: Range): boolean {
  if (Number.isNaN(v)) return false;
  if (r.min !== undefined && v < r.min) return false;
  if (r.max !== undefined && v > r.max) return false;
  return true;
}

function visible(lms: readonly Landmark[], joints: number[], thr: number): boolean {
  for (const j of joints) if (!(lms[j].visibility >= thr)) return false;
  return true;
}

function combine(children: RuleResult[], mode: 'all' | 'any'): RuleStatus {
  const statuses = children.map((c) => c.status);
  if (mode === 'all') {
    if (statuses.includes('fail')) return 'fail';
    if (statuses.includes('unknown')) return 'unknown';
    return 'pass';
  }
  if (statuses.includes('pass')) return 'pass';
  if (statuses.includes('unknown')) return 'unknown';
  return 'fail';
}

function axisDist(a: Landmark, b: Landmark, axes: string): number {
  let s = 0;
  if (axes.includes('x')) s += (a.x - b.x) ** 2;
  if (axes.includes('y')) s += (a.y - b.y) ** 2;
  if (axes.includes('z')) s += (a.z - b.z) ** 2;
  return Math.sqrt(s);
}

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

export function evaluateRule(lms: readonly Landmark[], rule: PoseRule, opts: EvalOptions = DEFAULT_OPTS): RuleResult {
  const thr = rule.minVisibility ?? opts.visibilityThreshold;
  const base = { id: rule.id, type: rule.type };
  const unknown = (): RuleResult => ({ ...base, status: 'unknown', values: [NaN] });
  const coreVisible = visible(lms, [...CORE_JOINTS], opts.visibilityThreshold);

  switch (rule.type) {
    case 'angle': {
      const values: number[] = [];
      for (const a of rule.angles) {
        if (!visible(lms, angleJoints(a), thr)) return unknown();
        values.push(jointAngle(lms, a));
      }
      return { ...base, status: values.every((v) => inRange(v, rule)) ? 'pass' : 'fail', values };
    }
    case 'torso_tilt': {
      if (!coreVisible) return unknown();
      const v = torsoTilt(lms);
      return { ...base, status: inRange(v, rule) ? 'pass' : 'fail', values: [v] };
    }
    case 'head_pitch': {
      if (!visible(lms, [J.nose, J.left_ear, J.right_ear], thr)) return unknown();
      const v = headPitch(lms);
      return { ...base, status: inRange(v, rule) ? 'pass' : 'fail', values: [v] };
    }
    case 'distance': {
      const joints = [...pointJoints(rule.a), ...pointJoints(rule.b)];
      if (!visible(lms, joints, thr) || !visible(lms, referenceJoints(rule.ref), opts.visibilityThreshold)) {
        return unknown();
      }
      const ref = referenceLength(lms, rule.ref);
      if (!(ref > 1e-6)) return unknown();
      const v = axisDist(getPoint(lms, rule.a), getPoint(lms, rule.b), rule.axes ?? 'xyz') / ref;
      return { ...base, status: inRange(v, rule) ? 'pass' : 'fail', values: [v] };
    }
    case 'offset': {
      const as = asArray(rule.a);
      const bs = asArray(rule.b);
      if (!visible(lms, referenceJoints(rule.ref), opts.visibilityThreshold)) return unknown();
      const ref = referenceLength(lms, rule.ref);
      if (!(ref > 1e-6)) return unknown();
      const values: number[] = [];
      for (let i = 0; i < as.length; i++) {
        const a = as[i];
        const b = bs[Math.min(i, bs.length - 1)];
        if (!visible(lms, [...pointJoints(a), ...pointJoints(b)], thr)) return unknown();
        values.push((getPoint(lms, a)[rule.axis] - getPoint(lms, b)[rule.axis]) / ref);
      }
      return { ...base, status: values.every((v) => inRange(v, rule)) ? 'pass' : 'fail', values };
    }
    case 'visibility': {
      const values = rule.joints.map((p) => getPoint(lms, p).visibility);
      const ok = (rule.mode ?? 'all') === 'all' ? values.every((v) => inRange(v, rule)) : values.some((v) => inRange(v, rule));
      return { ...base, status: ok ? 'pass' : 'fail', values };
    }
    case 'any_of':
    case 'all_of': {
      const children = rule.rules.map((r) => evaluateRule(lms, r, opts));
      const status = combine(children, rule.type === 'any_of' ? 'any' : 'all');
      return { ...base, status, values: [], children };
    }
    case 'not': {
      const child = evaluateRule(lms, rule.rule, opts);
      const status: RuleStatus = child.status === 'unknown' ? 'unknown' : child.status === 'pass' ? 'fail' : 'pass';
      return { ...base, status, values: child.values, children: [child] };
    }
  }
}

export function evaluatePose(
  lms: readonly Landmark[],
  pose: PoseDefinition,
  opts: EvalOptions = DEFAULT_OPTS,
): PoseEvaluation {
  const rules = pose.rules.map((r) => evaluateRule(lms, r, opts));
  const passCount = rules.filter((r) => r.status === 'pass').length;
  const failCount = rules.filter((r) => r.status === 'fail').length;
  const unknownCount = rules.length - passCount - failCount;
  return {
    poseId: pose.id,
    status: combine(rules, 'all'),
    rules,
    passCount,
    failCount,
    unknownCount,
    score: rules.length ? passCount / rules.length : 0,
  };
}

/** First failing top-level rule id (for in-character correction hints). */
export function firstFailingRule(ev: PoseEvaluation): string | null {
  return ev.rules.find((r) => r.status === 'fail')?.id ?? null;
}
