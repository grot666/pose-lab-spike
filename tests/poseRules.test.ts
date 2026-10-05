import { describe, expect, it } from 'vitest';
import posesYaml from '../src/content/poses.yaml';
import { parsePoseLibrary, PoseLibraryError } from '../src/core/poseLibrary';
import { evaluatePose, evaluateRule, firstFailingRule, type PoseRule } from '../src/core/poseRules';
import { headPitch, jointAngle, torsoTilt } from '../src/core/geometry';
import { J, cloneLandmarks } from '../src/core/landmarks';
import { FIXTURES, type FixtureName } from './fixtures/skeletons';

const poses = parsePoseLibrary(posesYaml);
const byId = Object.fromEntries(poses.map((p) => [p.id, p]));
const EXPECTED_IDS = ['attention', 'at_your_service', 'inspection', 'wait', 'kneel', 'nadu', 'collar_me'];

describe('poses.yaml', () => {
  it('defines exactly the 7 spike poses with id + rules only', () => {
    expect(poses.map((p) => p.id)).toEqual(EXPECTED_IDS);
    for (const p of poses) expect(p.rules.length).toBeGreaterThan(2);
  });

  it('has a synthetic fixture for every pose', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...EXPECTED_IDS].sort());
  });
});

describe('geometry', () => {
  it('measures straight legs, upright torso and neutral head on the attention fixture', () => {
    const l = FIXTURES.attention;
    expect(jointAngle(l, 'knee_left')).toBeGreaterThan(170);
    expect(torsoTilt(l)).toBeLessThan(1);
    expect(headPitch(l)).toBeGreaterThan(-15);
    expect(headPitch(l)).toBeLessThan(-8);
  });
  it('detects a bowed and a raised head', () => {
    expect(headPitch(FIXTURES.wait)).toBeLessThan(-40);
    expect(headPitch(FIXTURES.collar_me)).toBeGreaterThan(15);
  });
});

describe('pose rules: confusion matrix on synthetic fixtures', () => {
  for (const fixture of Object.keys(FIXTURES) as FixtureName[]) {
    it(`fixture "${fixture}" matches only its own pose`, () => {
      const matched = poses.filter((p) => evaluatePose(FIXTURES[fixture], p).status === 'pass').map((p) => p.id);
      expect(matched).toEqual([fixture]);
    });
  }
});

describe('pose rules: visibility semantics', () => {
  it('hidden wrists make wrist rules UNKNOWN (not fail) for attention', () => {
    const l = cloneLandmarks(FIXTURES.attention);
    l[J.left_wrist].visibility = 0.1;
    const ev = evaluatePose(l, byId.attention);
    expect(ev.status).toBe('unknown');
    expect(ev.failCount).toBe(0);
    expect(ev.rules.find((r) => r.id === 'hands_at_sides')?.status).toBe('unknown');
  });

  it('at_your_service passes with hidden wrists (expected behind the back)', () => {
    expect(evaluatePose(FIXTURES.at_your_service, byId.at_your_service).status).toBe('pass');
  });

  it('at_your_service also passes with visible wrists clasped behind the hips', () => {
    const l = cloneLandmarks(FIXTURES.at_your_service);
    l[J.left_wrist].visibility = 0.9;
    l[J.right_wrist].visibility = 0.9;
    expect(evaluatePose(l, byId.at_your_service).status).toBe('pass');
  });

  it('at_your_service fails when wrists are visible and in front', () => {
    const l = cloneLandmarks(FIXTURES.at_your_service);
    for (const j of [J.left_wrist, J.right_wrist]) {
      l[j].visibility = 0.9;
      l[j].z = 0.2;
    }
    const ev = evaluatePose(l, byId.at_your_service);
    expect(ev.status).toBe('fail');
    expect(firstFailingRule(ev)).toBe('hands_behind_back');
  });

  it('reports the first failing rule for hints', () => {
    const l = cloneLandmarks(FIXTURES.attention);
    l[J.left_ankle].x = 0.3;
    l[J.right_ankle].x = -0.3;
    const ev = evaluatePose(l, byId.attention);
    expect(ev.status).toBe('fail');
    expect(firstFailingRule(ev)).toBe('feet_together');
  });

  it('a whole-body disappearance yields unknown, never fail', () => {
    const l = cloneLandmarks(FIXTURES.kneel).map((p) => ({ ...p, visibility: 0 }));
    for (const p of poses) {
      const ev = evaluatePose(l, p);
      // visibility rules can still fail (they measure visibility itself); all geometric ones are unknown
      const geometric = ev.rules.filter((r) => r.type !== 'visibility' && r.type !== 'any_of');
      expect(geometric.every((r) => r.status === 'unknown')).toBe(true);
    }
  });
});

describe('rule combinators', () => {
  const l = FIXTURES.attention;
  const pass: PoseRule = { id: 'p', type: 'torso_tilt', max: 10 };
  const failR: PoseRule = { id: 'f', type: 'torso_tilt', min: 45 };
  it('any_of / all_of / not', () => {
    expect(evaluateRule(l, { id: 'a', type: 'any_of', rules: [failR, pass] }).status).toBe('pass');
    expect(evaluateRule(l, { id: 'b', type: 'all_of', rules: [failR, pass] }).status).toBe('fail');
    expect(evaluateRule(l, { id: 'c', type: 'not', rule: failR }).status).toBe('pass');
  });
  it('offset rule evaluates list pairs', () => {
    const r: PoseRule = {
      id: 'o',
      type: 'offset',
      a: ['left_wrist', 'right_wrist'],
      b: ['left_hip', 'right_hip'],
      axis: 'y',
      ref: 'torso',
      max: 0,
    };
    const res = evaluateRule(l, r);
    expect(res.status).toBe('pass');
    expect(res.values).toHaveLength(2);
  });
});

describe('poseLibrary validation', () => {
  it('rejects unknown rule types, points and extra pose keys', () => {
    expect(() => parsePoseLibrary({ poses: [{ id: 'x', rules: [{ id: 'r', type: 'nope' }] }] })).toThrow(PoseLibraryError);
    expect(() =>
      parsePoseLibrary({ poses: [{ id: 'x', rules: [{ id: 'r', type: 'distance', a: 'elbow', b: 'nose', ref: 'torso', max: 1 }] }] }),
    ).toThrow(/unknown point/);
    expect(() => parsePoseLibrary({ poses: [{ id: 'x', name: 'X', rules: [{ id: 'r', type: 'torso_tilt', max: 1 }] }] })).toThrow(
      /only id \+ rules/,
    );
    expect(() => parsePoseLibrary({ poses: [{ id: 'x', rules: [{ id: 'r', type: 'torso_tilt' }] }] })).toThrow(/min and\/or max/);
  });
  it('rejects duplicate pose ids', () => {
    const p = { id: 'x', rules: [{ id: 'r', type: 'torso_tilt', max: 1 }] };
    expect(() => parsePoseLibrary({ poses: [p, p] })).toThrow(/duplicate/);
  });
});
