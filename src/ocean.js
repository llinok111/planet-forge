/**
 * Ocean shell.
 *
 * The ocean is a separate sphere mesh at exactly radius = sea level, not a tint
 * on the terrain. That matters for three reasons:
 *   1. Coastlines are the terrain/ocean intersection, so they move correctly when
 *      land parameters change — no repainted shoreline.
 *   2. Waves can be animated without touching terrain geometry.
 *   3. Depth tint can be driven by the real depth buffer relationship (here
 *      approximated from a depth texture of the terrain) rather than a guessed
 *      coastline distance.
 *
 * Transparency note: shallow water has to be visibly lighter than the deep ocean.
 * Rather than sampling the depth buffer (which needs a second render pass and
 * breaks the demo's single-pass simplicity), the ocean shader derives depth from
 * a per-vertex bathymetry attribute copied from the terrain field: the terrain's
 * elevation under each ocean vertex. That attribute is cheap and exact.
 */

import * as THREE from 'three';

export const OCEAN_DEFAULTS = {
  color: '#0a2a4a',
  shallowColor: '#2f7fa8',
  opacity: 0.88,
  waveHeight: 0.0022,
  waveSpeed: 0.55,
  waveScale: 26,
  roughness: 0.08,
  metalness: 0.0,
  specular: 0.9,
};

/**
 * Build the ocean mesh.
 *
 * @param {object} geometry Icosphere geometry used for the planet (same topology).
 * @param {Float32Array} bathymetry Per-vertex terrain elevation, used for depth.
 * @param {number} seaLevelRadius Planet radius at sea level (1 + 0 in normalized units).
 * @param {object} [options]
 * @returns {THREE.Mesh}
 */
export function createOcean(geometry, bathymetry, seaLevelRadius, options = {}) {
  const opts = { ...OCEAN_DEFAULTS, ...options };

  const positions = new Float32Array(geometry.vertexCount * 3);
  for (let v = 0; v < geometry.vertexCount; v++) {
    positions[v * 3] = geometry.positions[v * 3] * seaLevelRadius;
    positions[v * 3 + 1] = geometry.positions[v * 3 + 1] * seaLevelRadius;
    positions[v * 3 + 2] = geometry.positions[v * 3 + 2] * seaLevelRadius;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aElevation', new THREE.BufferAttribute(bathymetry.slice(), 1));
  geo.setIndex(new THREE.BufferAttribute(geometry.indices, 1));
  geo.computeVertexNormals();
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), seaLevelRadius * 1.05);

  const uniforms = {
    uTime: { value: 0 },
    uDeepColor: { value: new THREE.Color(opts.color) },
    uShallowColor: { value: new THREE.Color(opts.shallowColor) },
    uWaveHeight: { value: opts.waveHeight },
    uWaveSpeed: { value: opts.waveSpeed },
    uWaveScale: { value: opts.waveScale },
    uSpecularStrength: { value: opts.specular },
    uSeaLevel: { value: seaLevelRadius },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: opts.opacity < 1,
    opacity: opts.opacity,
    roughness: opts.roughness,
    metalness: opts.metalness,
    side: THREE.FrontSide,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aElevation;
        uniform float uTime;
        uniform float uWaveHeight;
        uniform float uWaveSpeed;
        uniform float uWaveScale;
        varying float vDepth;
        varying vec3 vWaveNormal;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // Three crossing gravity waves. Frequencies are incommensurate so the
        // pattern does not visibly repeat as the planet rotates.
        float w1 = sin(position.x * uWaveScale + uTime * uWaveSpeed * 1.0)
                 * cos(position.z * uWaveScale * 0.83 + uTime * uWaveSpeed * 0.7);
        float w2 = sin(position.y * uWaveScale * 1.27 - uTime * uWaveSpeed * 1.3);
        float w3 = cos(position.z * uWaveScale * 1.61 + position.x * uWaveScale * 0.41
                 + uTime * uWaveSpeed * 0.9);
        float wave = (w1 * 0.5 + w2 * 0.3 + w3 * 0.2);
        transformed += normalize(position) * wave * uWaveHeight;

        // Analytic-ish normal perturbation: lower amplitude than the displacement
        // so specular highlights slide across the surface without looking like noise.
        vWaveNormal = vec3(w1, w2, w3) * 0.28;
        // Negative elevation below sea level => positive depth.
        vDepth = clamp(-aElevation / 0.055, 0.0, 1.0);
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uDeepColor;
        uniform vec3 uShallowColor;
        uniform float uSpecularStrength;
        varying float vDepth;
        varying vec3 vWaveNormal;
        `,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal = normalize(normal + vWaveNormal);
        `,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb = mix(uShallowColor, uDeepColor, smoothstep(0.0, 1.0, vDepth));
        `,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // A touch of self-illumination on the shelf keeps it from going black on
        // the night side, matching how real shelf water scatters light.
        totalEmissiveRadiance += uShallowColor * (1.0 - vDepth) * 0.12;
        `,
      );
  };

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'ocean';
  mesh.userData.uniforms = uniforms;
  mesh.userData.type = 'ocean';
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * Advance the wave animation.
 * @param {THREE.Mesh} oceanMesh
 * @param {number} elapsedSeconds
 */
export function updateOcean(oceanMesh, elapsedSeconds) {
  const u = oceanMesh.userData.uniforms;
  if (u) u.uTime.value = elapsedSeconds;
}
