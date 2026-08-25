/**
 * The color system. Hue carries exactly one meaning — which domain family a
 * node belongs to — assigned by golden angle so any number of domains stay
 * maximally separated, with subdomains shifted a few degrees around their
 * family hue: related reads as related, siblings still tell apart.
 * Lightness carries the other axis: observed-under-test glows, static-only
 * stays ember. Colors are computed in OKLCH so every family sits at the
 * same perceived lightness, then converted to sRGB — tuples for the WebGL
 * attribute arrays, hex for CSS.
 */

export const GOLDEN_ANGLE = 137.508;

export function familyHue(index: number): number {
  return (index * GOLDEN_ANGLE) % 360;
}

export function subdomainHue(base: number, index: number, count: number): number {
  const offset = (index - (count - 1) / 2) * 14;
  return (((base + offset) % 360) + 360) % 360;
}

/** OKLCH → gamma-encoded sRGB, each channel clamped to [0, 1]. */
export function oklchToRgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const lw = l_ ** 3;
  const mw = m_ ** 3;
  const sw = s_ ** 3;

  const r = 4.0767416621 * lw - 3.3077115913 * mw + 0.2309699292 * sw;
  const g = -1.2684380046 * lw + 2.6097574011 * mw - 0.3413193965 * sw;
  const bl = -0.0041960863 * lw - 0.7034186147 * mw + 1.707614701 * sw;

  const gamma = (x: number): number =>
    x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(x, 0), 1 / 2.4) - 0.055;
  const clamp = (x: number): number => Math.max(0, Math.min(1, gamma(x)));
  return [clamp(r), clamp(g), clamp(bl)];
}

export function oklch(l: number, c: number, hDeg: number): string {
  const channel = (x: number): string =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  const [r, g, b] = oklchToRgb(l, c, hDeg);
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}
