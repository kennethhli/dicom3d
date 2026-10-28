export const MAX_STEPS = 1024

export const volumeVertexShader = /* glsl */ `
uniform vec3 uCameraLocal;
out vec3 vOrigin;
out vec3 vDirection;

void main() {
  vOrigin = uCameraLocal;
  vDirection = position - uCameraLocal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/**
 * Single-pass ray marcher over a unit cube in texture space ([0,1]^3).
 * Clipping is applied by intersecting the ray with the clip sub-box rather than
 * testing every sample, so cutting into the volume also speeds up rendering.
 */
export const volumeFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;

uniform sampler3D uVolume;
uniform vec3 uDims;
uniform vec3 uScale;
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform vec2 uWindow;      // normalised [low, high]
uniform vec2 uThreshold;   // normalised [low, high]
uniform float uOpacity;
uniform float uBrightness;
uniform float uSteps;
uniform int uMode;         // 0 DVR, 1 MIP, 2 MinIP, 3 isosurface
uniform int uColormap;
uniform bool uShading;

in vec3 vOrigin;
in vec3 vDirection;
out vec4 outColor;

const int MAX_STEPS = ${MAX_STEPS};
const float REF_STEPS = 512.0;

vec2 hitBox(vec3 orig, vec3 dir, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / dir;
  vec3 t0 = (bmin - orig) * inv;
  vec3 t1 = (bmax - orig) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

float sampleVolume(vec3 p) {
  return texture(uVolume, p).r;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 rampColor(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  if (t < 0.33) return mix(a, b, t / 0.33);
  if (t < 0.66) return mix(b, c, (t - 0.33) / 0.33);
  return mix(c, d, (t - 0.66) / 0.34);
}

vec3 colormap(float t) {
  t = clamp(t, 0.0, 1.0);
  if (uColormap == 1) return rampColor(t, vec3(0.16, 0.12, 0.09), vec3(0.55, 0.45, 0.33), vec3(0.86, 0.78, 0.62), vec3(1.0, 0.98, 0.93));
  if (uColormap == 2) return rampColor(t, vec3(0.23, 0.04, 0.04), vec3(0.78, 0.27, 0.23), vec3(0.95, 0.72, 0.6), vec3(1.0));
  if (uColormap == 3) return rampColor(t, vec3(0.0), vec3(0.75, 0.0, 0.0), vec3(1.0, 0.6, 0.0), vec3(1.0, 1.0, 0.85));
  if (uColormap == 4) return rampColor(t, vec3(0.02, 0.1, 0.23), vec3(0.12, 0.44, 0.7), vec3(0.44, 0.83, 0.93), vec3(0.92, 1.0, 1.0));
  return vec3(t);
}

float windowed(float v) {
  return clamp((v - uWindow.x) / max(uWindow.y - uWindow.x, 1e-6), 0.0, 1.0);
}

float inThreshold(float v) {
  const float e = 0.0015;
  return smoothstep(uThreshold.x - e, uThreshold.x + e, v) * (1.0 - smoothstep(uThreshold.y - e, uThreshold.y + e, v));
}

vec3 gradientAt(vec3 p) {
  vec3 e = 1.0 / uDims;
  vec3 g = vec3(
    sampleVolume(p + vec3(e.x, 0.0, 0.0)) - sampleVolume(p - vec3(e.x, 0.0, 0.0)),
    sampleVolume(p + vec3(0.0, e.y, 0.0)) - sampleVolume(p - vec3(0.0, e.y, 0.0)),
    sampleVolume(p + vec3(0.0, 0.0, e.z)) - sampleVolume(p - vec3(0.0, 0.0, e.z))
  );
  // Convert from texture space to physical space so normals respect voxel spacing.
  return g * uDims / uScale;
}

vec3 shade(vec3 color, vec3 p, vec3 viewDir) {
  vec3 g = gradientAt(p);
  float len = length(g);
  if (len < 1e-4) return color * 0.85;
  vec3 n = g / len;
  vec3 l = normalize(-viewDir * uScale);
  float ndl = abs(dot(n, l));
  float spec = pow(ndl, 48.0) * 0.35;
  return color * (0.28 + 0.78 * ndl) + vec3(spec);
}

void main() {
  vec3 dir = normalize(vDirection);
  vec2 bounds = hitBox(vOrigin, dir, uClipMin - 0.5, uClipMax - 0.5);
  if (bounds.x >= bounds.y) discard;
  bounds.x = max(bounds.x, 0.0);

  float delta = 1.7320508 / uSteps;
  float jitter = hash(gl_FragCoord.xy);
  vec3 p = vOrigin + 0.5 + dir * (bounds.x + delta * jitter);
  vec3 stepVec = dir * delta;
  int n = int((bounds.y - bounds.x) / delta);
  float opacityCorrection = REF_STEPS / uSteps;

  if (uMode == 1 || uMode == 2) {
    bool isMin = uMode == 2;
    float best = isMin ? 2.0 : -1.0;
    bool hit = false;
    for (int i = 0; i < MAX_STEPS; i++) {
      if (i >= n) break;
      float v = sampleVolume(p);
      if (inThreshold(v) > 0.5) {
        best = isMin ? min(best, v) : max(best, v);
        hit = true;
      }
      p += stepVec;
    }
    if (!hit) discard;
    float w = windowed(best);
    vec3 c = colormap(w) * uBrightness;
    float a = clamp(uOpacity * (isMin ? 1.0 - w * 0.6 : 0.15 + w), 0.0, 1.0);
    outColor = vec4(c * a, a);
    return;
  }

  if (uMode == 3) {
    for (int i = 0; i < MAX_STEPS; i++) {
      if (i >= n) break;
      vec3 next = p + stepVec;
      float v = sampleVolume(next);
      if (v >= uThreshold.x && v <= uThreshold.y) {
        vec3 lo = p;
        vec3 hi = next;
        for (int j = 0; j < 5; j++) {
          vec3 mid = 0.5 * (lo + hi);
          if (sampleVolume(mid) >= uThreshold.x) hi = mid; else lo = mid;
        }
        vec3 base = colormap(max(windowed(sampleVolume(hi)), 0.65)) * uBrightness;
        vec3 c = uShading ? shade(base, hi, dir) : base;
        outColor = vec4(c, 1.0);
        return;
      }
      p = next;
    }
    discard;
  }

  vec4 acc = vec4(0.0);
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= n) break;
    float v = sampleVolume(p);
    float mask = inThreshold(v);
    if (mask > 0.0) {
      float w = windowed(v);
      float a = w * uOpacity * mask;
      if (a > 0.001) {
        a = 1.0 - pow(1.0 - min(a, 0.999), opacityCorrection);
        vec3 c = colormap(w) * uBrightness;
        if (uShading) c = shade(c, p, dir);
        acc.rgb += (1.0 - acc.a) * a * c;
        acc.a += (1.0 - acc.a) * a;
        if (acc.a > 0.98) break;
      }
    }
    p += stepVec;
  }
  if (acc.a < 0.002) discard;
  outColor = acc;
}
`
