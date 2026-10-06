/**
 * MediaPipe VIDEO-mode detectForVideo timestamps must be strictly increasing
 * integer milliseconds. Passing the same ms twice (or a decreasing value)
 * throws and — critically — wedges the calculator graph until the task is
 * recreated. Floats from performance.now() are floored so two frames in the
 * same wall-clock ms still advance via lastTs+1.
 */
export function nextVideoTimestampMs(nowMs: number, lastTs: number): number {
  let ts = Math.floor(Number.isFinite(nowMs) ? nowMs : 0);
  if (ts <= lastTs) ts = lastTs + 1;
  return ts;
}
