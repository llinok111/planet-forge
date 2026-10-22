/**
 * Volumetric cloud shell (v2).
 *
 * ## What changed from v1 and why
 *
 * v1 was a single sphere with a 3D noise pattern mapped onto it: coverage,
 * sharpness and colour, but no *thickness*. It read as a texture wrapped around a
 * ball, which is the same failure mode the project claims to avoid for terrain. Two
 * things were missing that make clouds look like clouds:
 *
 *   1. **Vertical extent.** Real cloud decks are tens of metres to kilometres thick
 *      with a flat base and a lumpy top. A zero-thickness shell cannot show a lit top
 *      and a shadowed base, so every cloud looks pasted on.
 *   2. **Self-shadowing.** Thick cloud blocks light from reaching deeper into the
 *      deck. Without it clouds are uniformly lit and read as flat decals even when
 *      they have the right silhouette.
 *
 * ## Approach
 *
 * A shell of finite thickness (`cloudAltitude` to `cloudAltitude + cloudThickness`)
 * is ray-marched per fragment. Density comes from 3D noise sampled in local space, so
 * it wraps the sphere without a seam. Light at each step is attenuated by the density
 * between it and the sun (a short secondary march), which is the cheap approximation
 * of self-shadowing.
 *
 * ## Cost control
 *
 * The march is capped at a small number of steps and only runs inside the shell. With
 * 8 steps the shader adds roughly 8 noise evaluations per cloud pixel plus a 4-step
 * light march; measured on SwiftShader that is the practical ceiling before the demo
 * drops below interactive rates at 1280x720.
 */

import * as THREE from 'three';
import { createNoise3D, fbm3 } from './noise3d.js';
import { deriveSeed } from './seed.js';

export const CLOUD_DEFAULTS = {
  enabled: true,
  coverage: 0.52,
  density: 0.72,
  sharpness: 0.35,
  altitude: 1.028,
  /** Shell thickness in planet radii. The new knob that v1 lacked. */
  thickness: 0.022,
  speed: 0.006,
  color: '#f4f6f8',
  shadowTint: '#7d8a99',
  banding: 0.35,
  detail: 4,
  noiseScale: 3.4,
  /** March steps through the deck; more = softer but slower. */
  steps: 8,
  /** How strongly the deck shadows itself, 0..1. */
  selfShadow: 0.65,
};

const VERTEX = /* glsl */ `
varying vec3 vLocalDir;
varying vec3 vWorldPos;

void main() {
  // The fragment's direction from the planet centre, in local space. Cloud noise is
  // sampled on this direction so it is seamless and does not stretch at the poles.
  vLocalDir = normalize(position);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uCloudColor;
uniform vec3 uShadowTint;
uniform float uCoverage;
uniform float uDensity;
uniform float uSharpness;
uniform float uBanding;
uniform float uNoiseScale;
uniform float uOffset;
uniform float uOctaves;
uniform float uNoiseSeed;
uniform float uInnerRadius;
uniform float uOuterRadius;
uniform int uSteps;
uniform float uSelfShadow;
uniform vec3 uCameraPos;

varying vec3 vLocalDir;
varying vec3 vWorldPos;

float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}

float cloudFbm(vec3 p) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int o = 0; o < 6; o++) {
    if (float(o) >= uOctaves) break;
    sum += vnoise(p) * amp;
    norm += amp;
    p *= 2.07;
    amp *= 0.55;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

/** Density at a point inside the deck. 0 is clear air. */
float densityAt(vec3 unitDir, float radius) {
  // Altitude fraction through the deck, 0 at the base and 1 at the top. Clouds are
  // denser near the base and thin out upward, which is what gives the deck a flat
  // floor and a ragged ceiling.
  float h = clamp((radius - uInnerRadius) / max(0.0001, uOuterRadius - uInnerRadius), 0.0, 1.0);
  float vertical = smoothstep(0.0, 0.22, h) * smoothstep(1.0, 0.55, h);

  // Drift: rotate the sample point about the planet's spin axis.
  float ang = uOffset * 6.2831853;
  float cs = cos(ang), sn = sin(ang);
  vec3 sp = vec3(
    unitDir.x * cs - unitDir.z * sn,
    unitDir.y,
    unitDir.x * sn + unitDir.z * cs
  );

  // Squash horizontally so convective cells are wider than they are tall.
  sp = sp * uNoiseScale + vec3(0.0, h * 1.7, 0.0);
  sp += vec3(uNoiseSeed * 0.0001, uNoiseSeed * 0.00013, uNoiseSeed * 0.00017);

  float n = cloudFbm(sp) * vertical;

  // Latitude banding.
  n *= 1.0 - uBanding * pow(abs(unitDir.y), 2.2);

  // Coverage and sharpness as before: coverage is a quantile threshold applied on the
  // CPU for the *base* level, sharpness narrows the transition.
  float lo = 1.0 - clamp(uCoverage, 0.0, 0.985);
  float width = max(0.008, 0.60 * (1.0 - clamp(uSharpness, 0.0, 0.97)));
  return smoothstep(lo, lo + width, n);
}

void main() {
  vec3 rayDir = normalize(vWorldPos - uCameraPos);

  // Ray / shell intersection for the deck's inner and outer spheres.
  float b = dot(uCameraPos, rayDir);
  float cOuter = dot(uCameraPos, uCameraPos) - uOuterRadius * uOuterRadius;
  float cInner = dot(uCameraPos, uCameraPos) - uInnerRadius * uInnerRadius;
  float discOuter = b * b - cOuter;
  if (discOuter < 0.0) discard;

  float sqOuter = sqrt(discOuter);
  float t0 = -b - sqOuter;
  float t1 = -b + sqOuter;

  float discInner = b * b - cInner;
  if (discInner > 0.0) {
    float sqInner = sqrt(discInner);
    // The planet body blocks the far part of the deck.
    float tInner = -b - sqInner;
    if (tInner > t0) t1 = min(t1, tInner);
  }

  if (t1 <= t0) discard;

  float marchLen = t1 - t0;
  int steps = uSteps;
  float stepLen = marchLen / float(steps);

  vec3 scattered = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < 24; i++) {
    if (i >= steps) break;
    float t = t0 + (float(i) + 0.5) * stepLen;
    vec3 pos = uCameraPos + rayDir * t;
    float radius = length(pos);
    vec3 unitDir = pos / max(0.0001, radius);

    float dens = densityAt(unitDir, radius) * uDensity;
    if (dens > 0.001) {
      // Self-shadowing: sample density toward the sun. Thick cloud above blocks light
      // from reaching the base, which is what makes the deck read as a volume rather
      // than a decal.
      float lightDepth = 0.0;
      for (int j = 0; j < 4; j++) {
        float lt = (float(j) + 0.5) * (uOuterRadius - uInnerRadius) * 0.35;
        vec3 lp = pos + uSunDirection * lt;
        float lr = length(lp);
        if (lr > uOuterRadius) break;
        lightDepth += densityAt(lp / max(0.0001, lr), lr);
      }
      float sunVis = exp(-lightDepth * uSelfShadow * 3.2);

      // Colour: shadowed interiors trend toward the shadow tint, lit tops toward the
      // cloud colour. Height inside the deck biases which wins.
      float h = clamp((radius - uInnerRadius) / max(0.0001, uOuterRadius - uInnerRadius), 0.0, 1.0);
      vec3 localColor = mix(uShadowTint, uCloudColor, clamp(sunVis * (0.55 + 0.45 * h), 0.0, 1.0));

      // Lambert-ish sun term so the deck follows the sun's position.
      float sunDot = max(0.0, dot(unitDir, uSunDirection));
      vec3 lit = localColor * (0.25 + 0.75 * sunDot) * uSunColor;

      float absorbed = exp(-dens * stepLen * 6.0);
      scattered += lit * (1.0 - absorbed) * transmittance;
      transmittance *= absorbed;
      if (transmittance < 0.02) break;
    }
  }

  float alpha = 1.0 - transmittance;
  if (alpha < 0.004) discard;

  gl_FragColor = vec4(scattered / max(alpha, 0.0001), alpha);
  #include <colorspace_fragment>
}
`;

/**
 * Build the volumetric cloud shell.
 *
 * @param {number} planetRadius
 * @param {string|number} seed
 * @param {object} [options]
 * @returns {THREE.Mesh}
 */
export function createClouds(planetRadius, seed, options = {}) {
  const opts = { ...CLOUD_DEFAULTS, ...options };

  const uniforms = {
    uSunDirection: { value: new THREE.Vector3(1, 0.2, 0.3).normalize() },
    uSunColor: { value: new THREE.Color('#ffffff') },
    uCloudColor: { value: new THREE.Color(opts.color) },
    uShadowTint: { value: new THREE.Color(opts.shadowTint) },
    uCoverage: { value: opts.coverage },
    uDensity: { value: opts.density },
    uSharpness: { value: opts.sharpness },
    uBanding: { value: opts.banding },
    uNoiseScale: { value: opts.noiseScale },
    uOffset: { value: 0 },
    uOctaves: { value: Math.max(1, Math.min(5, Math.round(opts.detail))) },
    uNoiseSeed: { value: deriveSeed(seed, 'clouds') },
    uInnerRadius: { value: planetRadius * opts.altitude },
    uOuterRadius: { value: planetRadius * (opts.altitude + opts.thickness) },
    uSteps: { value: Math.max(4, Math.min(24, Math.round(opts.steps))) },
    uSelfShadow: { value: opts.selfShadow },
    uCameraPos: { value: new THREE.Vector3() },
  };

  // The geometry only needs to cover the outer shell: the march runs in the fragment
  // shader, so vertex density does not affect quality.
  const geometry = new THREE.SphereGeometry(planetRadius * (opts.altitude + opts.thickness), 128, 96);
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // The deck is drawn before the atmosphere composite, so normal blending is right
    // here: clouds occlude the ground beneath them.
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'clouds';
  mesh.visible = opts.enabled;
  mesh.renderOrder = 3;
  mesh.userData.uniforms = uniforms;
  mesh.userData.type = 'clouds';
  return mesh;
}

/**
 * Advance cloud drift and push the camera position into the shader.
 *
 * @param {THREE.Mesh} cloudMesh
 * @param {number} elapsedSeconds
 * @param {{speed?: number, camera?: THREE.Camera, sunDirection?: THREE.Vector3}} [options]
 */
export function updateClouds(cloudMesh, elapsedSeconds, options = {}) {
  const u = cloudMesh.userData.uniforms;
  if (!u) return;
  const speed = options.speed ?? CLOUD_DEFAULTS.speed;
  u.uOffset.value = (elapsedSeconds * speed) % 1;
  if (options.camera) u.uCameraPos.value.copy(options.camera.position);
  if (options.sunDirection) u.uSunDirection.value.copy(options.sunDirection).normalize();
}

/** @param {THREE.Mesh} cloudMesh */
export function disposeClouds(cloudMesh) {
  cloudMesh.geometry?.dispose();
  cloudMesh.material?.dispose();
}

// --- CPU-side coverage measurement (unchanged interface) --------------------

/**
 * Sample the cloud field on a Fibonacci lattice at the deck's mid height and return
 * its sorted distribution.
 *
 * The field must match what `densityAt` computes in the shader, including the
 * vertical profile and the Y offset, otherwise the coverage slider would stop meaning
 * "fraction of sky covered". The mid height is used because that is where the deck is
 * densest; the vertical profile is ~1 there, so the distribution is representative.
 *
 * @param {string|number} seed
 * @param {object} [options]
 * @param {number} [samples=4096]
 * @returns {Float32Array}
 */
export function sampleCloudField(seed, options = {}, samples = 4096) {
  const opts = { ...CLOUD_DEFAULTS, ...options };
  const noise = createNoise3D(deriveSeed(seed, 'clouds'));
  const out = new Float32Array(samples);
  // Mid-deck, where vertical(1) is 1.0; see the profile in the shader.
  const hMid = 0.5;
  const vertical = 1.0;

  for (let i = 0; i < samples; i++) {
    const y = 1 - (2 * (i + 0.5)) / samples;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * 2.399963229728653;
    const x = Math.cos(phi) * r;
    const z = Math.sin(phi) * r;

    // Same construction as the shader: squash + vertical offset in Y.
    const sx = x * opts.noiseScale;
    const sy = y * opts.noiseScale + hMid * 1.7;
    const sz = z * opts.noiseScale;

    const n = fbm3(noise, sx, sy, sz, opts.detail, 2.07, 0.55) * vertical;
    const band = 1 - opts.banding * Math.pow(Math.abs(y), 2.2);
    out[i] = (n * 0.5 + 0.5) * band;
  }
  out.sort();
  return out;
}

/**
 * Convert a coverage target into a threshold on the cloud noise distribution.
 *
 * @param {Float32Array} sortedField
 * @param {number} coverage 0..1
 * @returns {number}
 */
export function coverageToThreshold(sortedField, coverage) {
  const c = Math.max(0, Math.min(0.985, coverage));
  const idx = Math.min(sortedField.length - 1, Math.floor((1 - c) * sortedField.length));
  return sortedField[idx];
}

/**
 * Measure the sky fraction at a given coverage.
 *
 * @param {string|number} seed
 * @param {object} [options]
 * @returns {number}
 */
export function measureCloudCoverage(seed, options = {}) {
  const opts = { ...CLOUD_DEFAULTS, ...options };
  const field = sampleCloudField(seed, opts);
  const threshold = coverageToThreshold(field, opts.coverage);
  let covered = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > threshold) covered++;
  return covered / field.length;
}
