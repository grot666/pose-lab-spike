/** Visibility -> colour ramp shared by the 2D skeleton and the 3D figure. */
export function visibilityHue(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return c * 175; // 0 = red (hidden) ... 175 = cyan (clearly visible)
}

export function visibilityCss(v: number, alpha = 1): string {
  return `hsla(${visibilityHue(v).toFixed(0)}, 100%, ${v < 0.5 ? 55 : 60}%, ${alpha})`;
}
