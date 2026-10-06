import { describe, expect, it } from 'vitest';
import expressionsYaml from '../src/content/expressions.yaml';
import {
  collectExpressionRuleIds,
  ExpressionLibraryError,
  parseExpressionLibrary,
} from '../src/core/expressionLibrary';
import {
  evaluateExpression,
  evaluateRule,
  firstFailingRule,
  formatExpressionGateReason,
  topBlendshapes,
  type BlendshapeMap,
  type ExpressionRule,
} from '../src/core/expressionRules';
import { EnterLeaveDebouncer } from '../src/core/debounce';

const defs = parseExpressionLibrary(expressionsYaml);
const byId = Object.fromEntries(defs.map((d) => [d.id, d]));
const EXPECTED = ['neutral', 'smile', 'frown', 'surprise', 'mouth_open', 'eyes_closed', 'tongue_out'];

function shapes(partial: BlendshapeMap): BlendshapeMap {
  // Sparse map is fine — missing keys => unknown for those rules.
  return { ...partial };
}

describe('expressions.yaml', () => {
  it('defines the solid detectable set with id + rules only', () => {
    expect(defs.map((d) => d.id)).toEqual(EXPECTED);
    for (const d of defs) expect(d.rules.length).toBeGreaterThan(0);
  });

  it('rejects non-snake ids and unknown rule types', () => {
    expect(() => parseExpressionLibrary({ expressions: [{ id: 'Bad', rules: [{ id: 'x', type: 'blendshape', name: 'jawOpen', min: 0.5 }] }] })).toThrow(
      ExpressionLibraryError,
    );
    expect(() =>
      parseExpressionLibrary({
        expressions: [{ id: 'x', rules: [{ id: 'r', type: 'angle', name: 'jawOpen', min: 0.5 }] }],
      }),
    ).toThrow(ExpressionLibraryError);
  });
});

describe('blendshape scoring', () => {
  it('smile passes when either smile blendshape is high', () => {
    const ev = evaluateExpression(
      shapes({ mouthSmileLeft: 0.7, mouthSmileRight: 0.05, mouthFrownLeft: 0.05 }),
      byId.smile,
    );
    expect(ev.status).toBe('pass');
    expect(ev.score).toBe(1);
  });

  it('smile passes at loosened mobile-friendly threshold (~0.12 either side)', () => {
    const ev = evaluateExpression(
      shapes({ mouthSmileLeft: 0.13, mouthSmileRight: 0.02, mouthFrownLeft: 0.05 }),
      byId.smile,
    );
    expect(ev.status).toBe('pass');
  });

  it('smile fails when both sides are too weak', () => {
    const ev = evaluateExpression(
      shapes({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05, mouthFrownLeft: 0.05 }),
      byId.smile,
    );
    expect(ev.status).toBe('fail');
    expect(firstFailingRule(ev)).toBe('smile_either');
  });

  it('missing blendshapes yield unknown (not fail)', () => {
    const ev = evaluateExpression(shapes({}), byId.mouth_open);
    expect(ev.status).toBe('unknown');
    expect(ev.failCount).toBe(0);
    expect(ev.score).toBe(0);
  });

  it('mouth_open requires jawOpen above loosened threshold', () => {
    expect(evaluateExpression(shapes({ jawOpen: 0.55, tongueOut: 0.05 }), byId.mouth_open).status).toBe('pass');
    expect(evaluateExpression(shapes({ jawOpen: 0.16, tongueOut: 0.05 }), byId.mouth_open).status).toBe('pass');
    expect(evaluateExpression(shapes({ jawOpen: 0.08, tongueOut: 0.05 }), byId.mouth_open).status).toBe('fail');
  });

  it('eyes_closed needs both blinks (mobile-loosened)', () => {
    expect(evaluateExpression(shapes({ eyeBlinkLeft: 0.8, eyeBlinkRight: 0.8 }), byId.eyes_closed).status).toBe('pass');
    expect(evaluateExpression(shapes({ eyeBlinkLeft: 0.25, eyeBlinkRight: 0.25 }), byId.eyes_closed).status).toBe('pass');
    expect(evaluateExpression(shapes({ eyeBlinkLeft: 0.8, eyeBlinkRight: 0.1 }), byId.eyes_closed).status).toBe('fail');
  });

  it('surprise any_of eyes_wide passes with one side', () => {
    const ev = evaluateExpression(
      shapes({ browInnerUp: 0.5, jawOpen: 0.4, eyeWideLeft: 0.4, eyeWideRight: 0.05 }),
      byId.surprise,
    );
    expect(ev.status).toBe('pass');
  });

  it('neutral fails when smiling', () => {
    const base = {
      mouthSmileLeft: 0.05,
      mouthSmileRight: 0.05,
      mouthFrownLeft: 0.05,
      mouthFrownRight: 0.05,
      jawOpen: 0.05,
      browInnerUp: 0.1,
      eyeBlinkLeft: 0.1,
      eyeBlinkRight: 0.1,
      tongueOut: 0.0,
    };
    expect(evaluateExpression(shapes(base), byId.neutral).status).toBe('pass');
    expect(evaluateExpression(shapes({ ...base, mouthSmileLeft: 0.6 }), byId.neutral).status).toBe('fail');
  });

  it('not rule inverts pass/fail', () => {
    const rule: ExpressionRule = {
      id: 'n',
      type: 'not',
      rule: { id: 'j', type: 'blendshape', name: 'jawOpen', min: 0.5 },
    };
    expect(evaluateRule(shapes({ jawOpen: 0.8 }), rule).status).toBe('fail');
    expect(evaluateRule(shapes({ jawOpen: 0.1 }), rule).status).toBe('pass');
  });
});

describe('scoring + debounce integration', () => {
  it('debounces enter only after N consecutive pass frames', () => {
    const d = new EnterLeaveDebouncer(5, 8);
    const pass = () => evaluateExpression(shapes({ jawOpen: 0.6, tongueOut: 0 }), byId.mouth_open).status === 'pass';
    expect(pass()).toBe(true);
    let ev = null as ReturnType<EnterLeaveDebouncer['update']>;
    for (let i = 0; i < 4; i++) {
      ev = d.update(true);
      expect(ev).toBeNull();
      expect(d.isIn).toBe(false);
    }
    ev = d.update(true);
    expect(ev).toBe('enter');
    expect(d.isIn).toBe(true);
  });

  it('unknown samples freeze debounce counters', () => {
    const d = new EnterLeaveDebouncer(3, 3);
    d.update(true);
    d.update(true);
    expect(d.progress).toBeCloseTo(2 / 3);
    d.update(null); // unknown
    expect(d.progress).toBeCloseTo(2 / 3);
    expect(d.update(true)).toBe('enter');
  });

  it('leave after M consecutive fails resets hold readiness', () => {
    const d = new EnterLeaveDebouncer(2, 3);
    d.update(true);
    d.update(true);
    expect(d.isIn).toBe(true);
    d.update(false);
    d.update(false);
    expect(d.update(false)).toBe('leave');
    expect(d.isIn).toBe(false);
  });
});

describe('collectExpressionRuleIds', () => {
  it('returns top-level rule ids used for hint coverage', () => {
    const ids = collectExpressionRuleIds(defs);
    expect(ids).toContain('smile_either');
    expect(ids).toContain('frown_either');
    expect(ids).toContain('eyes_wide'); // any_of parent, not nested eye_wide_l when topLevelOnly
    expect(ids).not.toContain('eye_wide_l');
    expect(ids).not.toContain('smile_left');
  });
});

describe('topBlendshapes + formatExpressionGateReason', () => {
  it('ranks blendshapes by score', () => {
    const top = topBlendshapes({ jawOpen: 0.2, mouthSmileLeft: 0.9, _neutral: 0.01 }, 2);
    expect(top.map((t) => t.name)).toEqual(['mouthSmileLeft', 'jawOpen']);
  });

  it('formats fail reasons with value vs threshold', () => {
    const shapes = { mouthSmileLeft: 0.05, mouthSmileRight: 0.04, mouthFrownLeft: 0.05 };
    const ev = evaluateExpression(shapes, byId.smile);
    expect(ev.status).toBe('fail');
    const reason = formatExpressionGateReason(shapes, byId.smile, ev);
    expect(reason).toMatch(/smile_left=0\.05<0\.12|smile_right=0\.04<0\.12/);
  });

  it('formats pass as pass', () => {
    const shapes = { mouthSmileLeft: 0.4, mouthSmileRight: 0.1, mouthFrownLeft: 0.05 };
    const ev = evaluateExpression(shapes, byId.smile);
    expect(formatExpressionGateReason(shapes, byId.smile, ev)).toBe('pass');
  });
});
