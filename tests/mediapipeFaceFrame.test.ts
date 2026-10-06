import { describe, expect, it } from 'vitest';
import { toFaceFrame } from '../src/adapters/mediapipeFace';

describe('toFaceFrame', () => {
  it('returns null when MediaPipe reports no face landmarks', () => {
    expect(toFaceFrame({ faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] }, 1)).toBeNull();
  });

  it('marks present and counts faces when landmarks exist', () => {
    const landmarks = Array.from({ length: 3 }, () => ({ x: 0.1, y: 0.2, z: 0, visibility: 1 }));
    const frame = toFaceFrame(
      {
        faceLandmarks: [landmarks],
        faceBlendshapes: [{ categories: [{ categoryName: 'mouthSmileLeft', score: 0.4, index: 0, displayName: '' }], headIndex: 0, headName: '' }],
        facialTransformationMatrixes: [],
      },
      42,
    );
    expect(frame).not.toBeNull();
    expect(frame!.present).toBe(true);
    expect(frame!.faceCount).toBe(1);
    expect(frame!.landmarks).toHaveLength(3);
    expect(frame!.blendshapes.mouthSmileLeft).toBeCloseTo(0.4);
  });
});
