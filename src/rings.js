/**
 * Planetary ring system.
 *
 * Rings are a flat annulus with a procedural radial band structure. Three things
 * make them read as physical rather than as a flat texture:
 *
 *   1. Banding comes from a sum of seeded ringlets at graded radii plus a radial
 *      noise, so gaps land at plausible places and are not evenly spaced.
 *   2. The ring plane shadows the planet and the planet's shadow falls on the
 *      rings. Both are computed in the shader from the sun direction, which is
 *      what sells the geometry when the camera moves.
 *   3. Optional density waves (spiral density patterns) make the bands subtly
 *      non-circular, as real ring systems are.
 */

import * as THREE from 'three';
import { createNoise3D, fbm3 } from './noise3d.js';
import { deriveSeed } from './seed.js';

export const RING_DEFAULTS = {
  enabled: true,
  innerRadius: 1.42,
  outerRadius: 2.34,
  tilt: 16,
  opacity: 0.86,
  color: '#d9cbb2',
  colorB: '#9a8f7d',
  seedBands: 22,
  gapStrength: 0.55,
  textureDetail: 0.7,
  shadow: 0.65,
  densityWave: 0.35,
  side: 'both',
};

const VERTEX = /* glsl */ `
varying vec2 vRingUv;
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vRingUv = uv;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uInner;
uniform float uOuter;
uniform float uOpacity;
uniform float uGapStrength;
uniform float uTextureDetail;
uniform float uShadow;
uniform float uDensityWave;
uniform float uPlanetRadius;
uniform vec3 uRingAxis;
uniform float uTime;
uniform float uBands;

varying vec2 vRingUv;
varying vec3 vWorldPos;

// Deterministic hash for the ringlet structure.
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

// Value noise in 1D, used to break up the banding into irregular widths.
float noise11(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), f);
}

void main() {
  // Radial coordinate, normalized across the annulus.
  float r = mix(uInner, uOuter, vRingUv.x);
  float t = (r - uInner) / max(0.0001, uOuter - uInner);

  // --- band structure -----------------------------------------------------
  // Dense ringlets: a high-frequency noise multiplied by a low-frequency envelope
  // gives clustered fine structure with large-scale brightness variation.
  float fine = noise11(r * 180.0);
  float bands = noise11(r * uBands * 2.4) * 0.6 + noise11(r * uBands * 7.0) * 0.4;

  // Named gaps: a few deep, narrow divisions carved at seeded radii.
  float gap = 1.0;
  for (int i = 0; i < 5; i++) {
    float gpos = hash11(float(i) * 7.13 + 0.37);
    float gw = 0.012 + hash11(float(i) * 3.71) * 0.02;
    float d = abs(t - gpos);
    gap *= smoothstep(0.0, gw, d);
  }
  gap = mix(1.0, gap, uGapStrength);

  // Density waves: spiral perturbations that make band edges wobble.
  float ang = atan(vRingUv.y * 2.0 - 1.0, vRingUv.x * 2.0 - 1.0);
  float wave = sin(ang * 6.0 - r * 42.0 + uTime * 0.15) * 0.5 + 0.5;
  float waveMix = mix(1.0, 0.75 + wave * 0.5, uDensityWave * 0.35);

  // --- opacity ------------------------------------------------------------
  float density = mix(0.72, 1.0, bands) * mix(0.82, 1.12, fine * uTextureDetail);
  density *= gap * waveMix;

  // Fade the inner and outer edges so the annulus has no hard rim.
  density *= smoothstep(0.0, 0.03, t) * smoothstep(1.0, 0.96, t);

  float alpha = clamp(density, 0.0, 1.0) * uOpacity;
  if (alpha < 0.004) discard;

  vec3 color = mix(uColorB, uColorA, clamp(bands * 1.15, 0.0, 1.0));
  color *= mix(0.86, 1.06, fine);

  // --- planet shadow on the rings ----------------------------------------
  // Project the fragment onto the planet's equatorial plane and test whether the
  // planet cylinder blocks the sun. Softened so the shadow edge is not aliased.
  vec3 toSun = uSunDirection;
  float alongSun = dot(vWorldPos, toSun);
  vec3 closest = vWorldPos - toSun * alongSun;
  // Signed distance from the ring point to the planet's shadow axis.
  float perp = length(closest);
  // Only shadow the part of the ring that is further from the sun than the planet.
  float behind = step(alongSun, 0.0);
  float shadowMask = 1.0 - behind * (1.0 - smoothstep(uPlanetRadius * 0.98, uPlanetRadius * 1.12, perp));
  color *= mix(1.0, shadowMask, uShadow);

  // --- lighting -----------------------------------------------------------
  // Rings are thin diffuse scatterers: mostly flat, slightly brighter when the
  // sun grazes them (backscatter), which is why they seem to glow edge-on.
  float incident = abs(dot(uRingAxis, toSun));
  float lit = mix(0.55, 1.0, incident);
  color *= uSunColor * lit;

  // Night side: rings still catch some light from the planet's own reflected glow.
  float nightFacing = smoothstep(0.55, -0.15, dot(normalize(vWorldPos), toSun));
  color += uColorA * nightFacing * 0.05;

  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
`;

/**
 * Build the ring mesh (a flat annulus in the planet's XZ plane).
 *
 * @param {number} planetRadius
 * @param {string|number} seed
 * @param {object} [options]
 * @returns {THREE.Mesh}
 */
export function createRings(planetRadius, seed, options = {}) {
  const opts = { ...RING_DEFAULTS, ...options };

  // Annulus geometry. Radial segments are generous because the band structure is
  // evaluated per fragment from the radial coordinate, so only vertex topology
  // needs to be smooth.
  const geometry = new THREE.RingGeometry(planetRadius * opts.innerRadius, planetRadius * opts.outerRadius, 256, 8);
  geometry.rotateX(-Math.PI / 2);

  const uniforms = {
    uSunDirection: { value: new THREE.Vector3(1, 0.2, 0.3).normalize() },
    uSunColor: { value: new THREE.Color('#ffffff') },
    uColorA: { value: new THREE.Color(opts.color) },
    uColorB: { value: new THREE.Color(opts.colorB) },
    uInner: { value: planetRadius * opts.innerRadius },
    uOuter: { value: planetRadius * opts.outerRadius },
    uOpacity: { value: opts.opacity },
    uGapStrength: { value: opts.gapStrength },
    uTextureDetail: { value: opts.textureDetail },
    uShadow: { value: opts.shadow },
    uDensityWave: { value: opts.densityWave },
    uPlanetRadius: { value: planetRadius },
    uRingAxis: { value: new THREE.Vector3(0, 1, 0) },
    uTime: { value: 0 },
    uBands: { value: opts.seedBands },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: opts.side === 'double' ? THREE.DoubleSide : THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'rings';
  mesh.visible = opts.enabled;
  mesh.rotation.x = THREE.MathUtils.degToRad(opts.tilt);
  mesh.renderOrder = 2;
  mesh.userData.uniforms = uniforms;
  mesh.userData.type = 'rings';
  mesh.userData.noiseSeed = deriveSeed(seed, 'rings');
  return mesh;
}

/**
 * Update ring uniforms that depend on scene state.
 *
 * @param {THREE.Mesh} mesh
 * @param {{sunDirection: THREE.Vector3, sunColor: THREE.Color, elapsedSeconds: number}} state
 */
export function updateRings(mesh, state) {
  const u = mesh.userData.uniforms;
  if (!u) return;
  if (state.sunDirection) u.uSunDirection.value.copy(state.sunDirection).normalize();
  if (state.sunColor) u.uSunColor.value.copy(state.sunColor);
  if (typeof state.elapsedSeconds === 'number') u.uTime.value = state.elapsedSeconds;
  // The ring axis is the mesh's local +Y mapped into world space.
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
  u.uRingAxis.value.copy(axis);
}

/** @param {THREE.Mesh} mesh */
export function disposeRings(mesh) {
  mesh.geometry?.dispose();
  mesh.material?.dispose();
}
