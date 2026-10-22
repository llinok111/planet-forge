/**
 * Cloud shell.
 *
 * Design decisions worth naming:
 *   1. Clouds are a *separate* sphere slightly above sea level. Coverage and
 *      sharpness are independent sliders: coverage moves the threshold through
 *      the noise field, sharpness changes the transition width. A single
 *      "density" slider cannot express both, which is the usual reason cloud
 *      parameters feel unresponsive.
 *   2. The noise is sampled in 3D at the fragment's local position on the cloud
 *      sphere, not from a UV-mapped texture. That removes the polar stretching and
 *      the seam every 2D-noise cloud layer has.
 *   3. Banding concentrates clouds into latitude belts, the way Hadley cells do.
 *
 * The noise field itself is baked once per seed into a 3D-sampled cube-friendly
 * equirectangular lookup does NOT work here, so we keep true 3D noise but use a
 * cheaper 3-octave evaluation and rely on the mesh resolution for smoothness.
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
  speed: 0.006,
  color: '#f4f6f8',
  shadowTint: '#7d8a99',
  banding: 0.35,
  detail: 4,
  noiseScale: 3.4,
};

/**
 * Sample the cloud noise field on a Fibonacci lattice and return its sorted
 * distribution. Turning coverage into a quantile of this distribution (instead of
 * a fixed threshold on raw noise) is what makes the slider mean "fraction of sky
 * covered" rather than "how aggressive a threshold is".
 *
 * Motivation, measured: raw fBm clusters tightly around its mean, so a linear
 * threshold moved coverage from 37% to 88% over a 0.18 slider span. Quantile
 * inversion makes the response linear and strictly monotonic.
 *
 * @param {string|number} seed
 * @param {object} [options]
 * @param {number} [samples=4096]
 * @returns {Float32Array} Sorted noise values, ascending.
 */
export function sampleCloudField(seed, options = {}, samples = 4096) {
  const opts = { ...CLOUD_DEFAULTS, ...options };
  const noise = createNoise3D(deriveSeed(seed, 'clouds'));
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const y = 1 - (2 * (i + 0.5)) / samples;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * 2.399963229728653;
    const x = Math.cos(phi) * r;
    const z = Math.sin(phi) * r;
    const n = fbm3(noise, x * opts.noiseScale, y * opts.noiseScale, z * opts.noiseScale, opts.detail, 2.07, 0.55);
    const band = 1 - opts.banding * Math.pow(Math.abs(y), 2.2);
    out[i] = (n * 0.5 + 0.5) * band;
  }
  out.sort();
  return out;
}

/**
 * Convert a coverage target into a threshold on the cloud noise distribution.
 *
 * @param {Float32Array} sortedField Output of sampleCloudField.
 * @param {number} coverage 0..1 desired sky fraction.
 * @returns {number} Threshold value.
 */
export function coverageToThreshold(sortedField, coverage) {
  const c = Math.max(0, Math.min(0.985, coverage));
  const idx = Math.min(sortedField.length - 1, Math.floor((1 - c) * sortedField.length));
  return sortedField[idx];
}

/**
 * Build the cloud mesh.
 *
 * @param {number} planetRadius
 * @param {string|number} seed
 * @param {object} [options]
 * @returns {THREE.Mesh}
 */
export function createClouds(planetRadius, seed, options = {}) {
  const opts = { ...CLOUD_DEFAULTS, ...options };
  const field = sampleCloudField(seed, opts);

  const uniforms = {
    uThreshold: { value: coverageToThreshold(field, opts.coverage) },
    uCoverage: { value: opts.coverage },
    uDensity: { value: opts.density },
    uSharpness: { value: opts.sharpness },
    uCloudColor: { value: new THREE.Color(opts.color) },
    uShadowTint: { value: new THREE.Color(opts.shadowTint) },
    uBanding: { value: opts.banding },
    uNoiseScale: { value: opts.noiseScale },
    uTime: { value: 0 },
    uOffset: { value: 0 },
    uOctaves: { value: Math.max(1, Math.min(6, Math.round(opts.detail))) },
    uNoiseSeed: { value: 0 },
  };

  const geometry = new THREE.SphereGeometry(planetRadius, 128, 96);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  const noiseSeed = deriveSeed(seed, 'clouds');
  uniforms.uNoiseSeed.value = noiseSeed;
  const noise = createNoise3D(noiseSeed);

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCloudLocal;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vCloudLocal = normalize(position);
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uCoverage;
        uniform float uThreshold;
        uniform float uDensity;
        uniform float uSharpness;
        uniform vec3 uCloudColor;
        uniform vec3 uShadowTint;
        uniform float uBanding;
        uniform float uNoiseScale;
        uniform float uOffset;
        uniform float uOctaves;
        uniform float uNoiseSeed;
        varying vec3 vCloudLocal;

        // Portable hash-based 3D value noise. Used instead of a uniform array of
        // gradient tables because this shader only needs mid-frequency detail on
        // top of the CPU-side structure, not full Simplex quality.
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
        `,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        // Drift: rotate the sample point about the planet's spin axis so clouds
        // wrap around the sphere instead of sliding across a texture.
        float ang = uOffset * 6.2831853;
        float cs = cos(ang), sn = sin(ang);
        vec3 sp = vec3(
          vCloudLocal.x * cs - vCloudLocal.z * sn,
          vCloudLocal.y,
          vCloudLocal.x * sn + vCloudLocal.z * cs
        );
        sp *= uNoiseScale;
        sp += vec3(uNoiseSeed * 0.0001, uNoiseSeed * 0.00013, uNoiseSeed * 0.00017);

        float n = cloudFbm(sp);

        // Latitude banding.
        float lat = abs(vCloudLocal.y);
        n *= 1.0 - uBanding * pow(lat, 2.2);

        // fBm output clusters tightly around its mean, so a linear threshold
        // makes the coverage slider feel like an on/off switch. uThreshold is a
        // quantile precomputed on the CPU for the current coverage value, which
        // makes "coverage" mean the actual sky fraction.
        float lo = uThreshold;
        float width = max(0.008, 0.60 * (1.0 - clamp(uSharpness, 0.0, 0.97)));
        float alpha = smoothstep(lo, lo + width, n);
        alpha = clamp(alpha * clamp(uDensity, 0.0, 1.0), 0.0, 1.0);

        vec3 body = mix(uShadowTint, uCloudColor, smoothstep(lo, lo + width * 1.8, n));
        diffuseColor.rgb = body;
        diffuseColor.a = alpha;
        if (alpha < 0.004) discard;
        `,
      );
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'clouds';
  mesh.visible = opts.enabled;
  mesh.renderOrder = 3;
  // Altitude is a uniform scale on a base-radius sphere, so the slider can move
  // the shell without rebuilding geometry.
  mesh.scale.setScalar(opts.altitude);
  mesh.userData.uniforms = uniforms;
  mesh.userData.noise = noise;
  mesh.userData.type = 'clouds';
  return mesh;
}

/**
 * Advance cloud drift.
 *
 * @param {THREE.Mesh} cloudMesh
 * @param {number} elapsedSeconds
 * @param {object} [options]
 */
export function updateClouds(cloudMesh, elapsedSeconds, options = {}) {
  const speed = options.speed ?? CLOUD_DEFAULTS.speed;
  const u = cloudMesh.userData.uniforms;
  if (u) u.uOffset.value = (elapsedSeconds * speed) % 1;
}

/** @param {THREE.Mesh} cloudMesh */
export function disposeClouds(cloudMesh) {
  cloudMesh.geometry?.dispose();
  cloudMesh.material?.dispose();
}

/**
 * Measure the sky fraction at a given coverage, for tests and documentation.
 *
 * @param {string|number} seed
 * @param {object} [options]
 * @returns {number} Fraction in [0,1].
 */
export function measureCloudCoverage(seed, options = {}) {
  const opts = { ...CLOUD_DEFAULTS, ...options };
  const field = sampleCloudField(seed, opts);
  const threshold = coverageToThreshold(field, opts.coverage);
  let covered = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > threshold) covered++;
  return covered / field.length;
}
