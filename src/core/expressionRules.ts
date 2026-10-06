/**
 * Declarative facial-expression rules over MediaPipe Face Landmarker blendshapes.
 * Authored in src/content/expressions.yaml; validated by expressionLibrary.ts.
 *
 * Every rule evaluates to pass | fail | unknown (missing blendshape => unknown).
 * Score is the fraction of top-level rules that pass (unknowns excluded from denom
 * when any measured rule exists; else 0).
 */
export type RuleStatus = 'pass' | 'fail' | 'unknown';

/** ARKit-style blendshape name as emitted by Face Landmarker. */
export type BlendshapeName = string;

/** Flat map of blendshape categoryName -> score [0,1]. */
export type BlendshapeMap = Record<string, number>;

interface RuleBase {
  id: string;
}

export interface BlendshapeRule extends RuleBase {
  type: 'blendshape';
  name: BlendshapeName;
  min?: number;
  max?: number;
}

export interface AnyOfExprRule extends RuleBase {
  type: 'any_of';
  rules: ExpressionRule[];
}

export interface AllOfExprRule extends RuleBase {
  type: 'all_of';
  rules: ExpressionRule[];
}

export interface NotExprRule extends RuleBase {
  type: 'not';
  rule: ExpressionRule;
}

export type ExpressionRule = BlendshapeRule | AnyOfExprRule | AllOfExprRule | NotExprRule;

export const EXPR_RULE_TYPES = ['blendshape', 'any_of', 'all_of', 'not'] as const;

export interface ExpressionDefinition {
  id: string;
  rules: ExpressionRule[];
}

export interface RuleResult {
  id: string;
  status: RuleStatus;
  /** Measured blendshape score when type=blendshape; else NaN. */
  value: number;
}

export interface ExpressionEvaluation {
  expressionId: string;
  status: RuleStatus;
  /** 0..1 confidence: passCount / measuredCount (unknowns ignored). */
  score: number;
  passCount: number;
  failCount: number;
  unknownCount: number;
  rules: RuleResult[];
}

function inRange(v: number, min?: number, max?: number): boolean {
  if (min !== undefined && v < min) return false;
  if (max !== undefined && v > max) return false;
  return true;
}

export function evaluateRule(shapes: BlendshapeMap, rule: ExpressionRule): RuleResult {
  switch (rule.type) {
    case 'blendshape': {
      const v = shapes[rule.name];
      if (v === undefined || !Number.isFinite(v)) return { id: rule.id, status: 'unknown', value: NaN };
      return { id: rule.id, status: inRange(v, rule.min, rule.max) ? 'pass' : 'fail', value: v };
    }
    case 'all_of': {
      const kids = rule.rules.map((r) => evaluateRule(shapes, r));
      if (kids.some((k) => k.status === 'fail')) return { id: rule.id, status: 'fail', value: NaN };
      if (kids.every((k) => k.status === 'pass')) return { id: rule.id, status: 'pass', value: NaN };
      return { id: rule.id, status: 'unknown', value: NaN };
    }
    case 'any_of': {
      const kids = rule.rules.map((r) => evaluateRule(shapes, r));
      if (kids.some((k) => k.status === 'pass')) return { id: rule.id, status: 'pass', value: NaN };
      if (kids.every((k) => k.status === 'unknown')) return { id: rule.id, status: 'unknown', value: NaN };
      return { id: rule.id, status: 'fail', value: NaN };
    }
    case 'not': {
      const inner = evaluateRule(shapes, rule.rule);
      if (inner.status === 'unknown') return { id: rule.id, status: 'unknown', value: NaN };
      return { id: rule.id, status: inner.status === 'pass' ? 'fail' : 'pass', value: NaN };
    }
  }
}

/** Aggregate top-level rules: any fail => fail; else any unknown => unknown; else pass. */
export function evaluateExpression(shapes: BlendshapeMap, def: ExpressionDefinition): ExpressionEvaluation {
  const rules = def.rules.map((r) => evaluateRule(shapes, r));
  let passCount = 0;
  let failCount = 0;
  let unknownCount = 0;
  for (const r of rules) {
    if (r.status === 'pass') passCount++;
    else if (r.status === 'fail') failCount++;
    else unknownCount++;
  }
  const measured = passCount + failCount;
  const score = measured > 0 ? passCount / measured : 0;
  let status: RuleStatus;
  if (failCount > 0) status = 'fail';
  else if (unknownCount > 0 && passCount === 0) status = 'unknown';
  else if (unknownCount > 0) status = 'unknown';
  else status = 'pass';
  // Match pose semantics: unknown among otherwise-passing rules => overall unknown
  // (cannot claim full pass). Fail dominates.
  if (failCount === 0 && unknownCount > 0) status = 'unknown';
  if (failCount === 0 && unknownCount === 0) status = 'pass';
  return { expressionId: def.id, status, score, passCount, failCount, unknownCount, rules };
}

export function firstFailingRule(ev: ExpressionEvaluation): string | null {
  return ev.rules.find((r) => r.status === 'fail')?.id ?? null;
}

/** Build a BlendshapeMap from Classifications.categories. */
export function blendshapesFromCategories(
  categories: ReadonlyArray<{ categoryName: string; score: number }>,
): BlendshapeMap {
  const out: BlendshapeMap = {};
  for (const c of categories) {
    if (c.categoryName) out[c.categoryName] = c.score;
  }
  return out;
}

/** Top-N blendshapes by score (descending). Skips empty names / non-finite. */
export function topBlendshapes(
  shapes: BlendshapeMap,
  n = 5,
): Array<{ name: string; score: number }> {
  return Object.entries(shapes)
    .filter(([name, score]) => !!name && Number.isFinite(score))
    .map(([name, score]) => ({ name, score: score as number }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, n));
}

export interface BlendshapeGateDetail {
  id: string;
  name: string;
  value: number;
  min?: number;
  max?: number;
  status: RuleStatus;
}

/** Flatten blendshape leaf rules with measured values (for HUD / DiagLog). */
export function collectBlendshapeDetails(
  shapes: BlendshapeMap,
  rules: ExpressionRule[],
): BlendshapeGateDetail[] {
  const out: BlendshapeGateDetail[] = [];
  const walk = (rule: ExpressionRule): void => {
    if (rule.type === 'blendshape') {
      const r = evaluateRule(shapes, rule);
      out.push({
        id: rule.id,
        name: rule.name,
        value: r.value,
        min: rule.min,
        max: rule.max,
        status: r.status,
      });
      return;
    }
    if (rule.type === 'not') {
      walk(rule.rule);
      return;
    }
    for (const child of rule.rules) walk(child);
  };
  for (const r of rules) walk(r);
  return out;
}

/** Compact pass/fail reason for DiagLog / HUD (e.g. smile_left=0.08<0.12). */
export function formatExpressionGateReason(
  shapes: BlendshapeMap,
  def: ExpressionDefinition,
  ev: ExpressionEvaluation,
): string {
  if (ev.status === 'pass') return 'pass';
  if (ev.status === 'unknown' && ev.failCount === 0) return 'unknown(missing blendshapes)';
  const details = collectBlendshapeDetails(shapes, def.rules);
  const failing = details.filter((d) => d.status === 'fail');
  if (!failing.length) {
    const topFail = firstFailingRule(ev);
    return topFail ? `fail:${topFail}` : `fail score=${ev.score.toFixed(2)}`;
  }
  return failing
    .slice(0, 4)
    .map((d) => {
      const v = Number.isFinite(d.value) ? d.value.toFixed(2) : '?';
      if (d.min !== undefined && Number.isFinite(d.value) && d.value < d.min) {
        return `${d.id}=${v}<${d.min}`;
      }
      if (d.max !== undefined && Number.isFinite(d.value) && d.value > d.max) {
        return `${d.id}=${v}>${d.max}`;
      }
      return `${d.id}=${v}`;
    })
    .join(' ');
}
