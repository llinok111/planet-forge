/**
 * Scene export: GLB, scene JSON and configuration JSON.
 *
 * The GLB export is the part that proves the planet is real geometry: the file
 * contains the displaced vertex positions, the computed normals and the topology,
 * so it opens in Blender or three.js viewer with the actual terrain — not a
 * sphere with a picture on it.
 *
 * Shader-driven effects (biome colour ramp, atmosphere scattering, ring banding,
 * star sprite shape) cannot survive a glTF export, because glTF has no notion of
 * runtime-injected shader chunks. The exporter therefore bakes what it can into
 * vertex colours and materials, and the accompanying JSON records the parameters
 * so the exact look can be reproduced inside this app.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { PARAMS } from './params.js';

/**
 * Sample the same biome ramp the surface shader uses, in JS, for vertex-colour
 * baking. Kept deliberately close to shaders/biome.js so the exported GLB is not
 * a wildly different colour from the on-screen planet.
 *
 * @param {number} elevation Normalized elevation (radii).
 * @param {number} latitude |sin(angle from equator)|.
 * @param {number} slope 0..1.
 * @param {object} p Parameters.
 * @param {THREE.Color} out
 */
function bakeBiomeColor(elevation, latitude, slope, p, out) {
  const deep = new THREE.Color(p.colSeaBed);
  const shallow = new THREE.Color(p.colShallow);
  const beach = new THREE.Color(p.colBeach);
  const grass = new THREE.Color(p.colGrass);
  const forest = new THREE.Color(p.colForest);
  const rock = new THREE.Color(p.colRock);
  const snow = new THREE.Color(p.colSnow);
  const ice = new THREE.Color(p.colIce);

  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
    return t * t * (3 - 2 * t);
  };

  if (elevation < 0) {
    const depth = Math.min(1, -elevation / 0.06);
    out.copy(shallow).lerp(deep, smoothstep(0, 1, depth));
    return out;
  }

  const bw = p.beachWidth;
  out.copy(beach).lerp(grass, smoothstep(0, bw, elevation));
  out.lerp(forest, smoothstep(bw, bw * 3.5, elevation));
  out.lerp(rock, smoothstep(p.snowLine * 0.45, p.snowLine * 0.85, elevation));
  const snowAlt = smoothstep(p.snowLine, p.snowLine * 1.25, elevation);
  const snowFlat = 1 - smoothstep(0.35, 0.75, slope);
  out.lerp(snow, snowAlt * (0.55 + 0.45 * snowFlat));
  out.lerp(rock, smoothstep(0.35, 0.7, slope) * 0.75);
  out.lerp(ice, smoothstep(p.iceCapLatitude, p.iceCapLatitude + 0.08, latitude));
  return out;
}

/**
 * Bake the biome ramp into a vertex-colour attribute on a clone of the surface
 * geometry. GLB has no shader injection, so this is the only way the terrain
 * carries its colour with it.
 *
 * @param {THREE.BufferGeometry} source
 * @param {object} params
 * @returns {THREE.BufferGeometry}
 */
export function bakeVertexColors(source, params) {
  const geo = source.clone();
  const pos = geo.attributes.position;
  const elev = geo.attributes.aElevation;
  const normal = geo.attributes.normal;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const latitude = Math.abs(y / len);
    // Slope from the angle between the vertex normal and the outward radial.
    const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
    const dot = Math.abs(nx * (x / len) + ny * (y / len) + nz * (z / len));
    const slope = Math.min(1, Math.max(0, 1 - dot));
    bakeBiomeColor(elev ? elev.getX(i) : 0, latitude, slope * 1.6, params, c);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/**
 * Export the planet as a binary glTF (GLB).
 *
 * Included meshes: the displaced surface (with baked vertex colours) and the
 * rings. Clouds, atmosphere and stars are excluded because their appearance is
 * entirely shader-driven and would export as blank geometry, which is more
 * misleading than omitting them.
 *
 * @param {import('./planet.js').PlanetScene} scene
 * @param {object} [options]
 * @returns {Promise<ArrayBuffer>}
 */
export async function exportGLB(scene, options = {}) {
  const params = scene.params;
  const exporter = new GLTFExporter();
  const group = new THREE.Group();
  group.name = `planet-${params.seed}`;

  const surfaceGeo = bakeVertexColors(scene.surface.geometry, params);
  const surfaceMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
  });
  const surfaceMesh = new THREE.Mesh(surfaceGeo, surfaceMat);
  surfaceMesh.name = 'surface';
  group.add(surfaceMesh);

  if (params.ringsEnabled && scene.rings) {
    const ringGeo = scene.rings.geometry.clone();
    const ringMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(params.ringColorA),
      transparent: true,
      opacity: params.ringOpacity,
      side: THREE.DoubleSide,
      roughness: 0.8,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.name = 'rings';
    ringMesh.rotation.x = THREE.MathUtils.degToRad(params.ringTilt);
    group.add(ringMesh);
  }

  // Apply the planet's current spin so the export matches what is on screen.
  group.rotation.y = scene.planetGroup.rotation.y;

  const result = await exporter.parseAsync(group, {
    binary: true,
    onlyVisible: true,
    trs: false,
    includeCustomExtensions: false,
  });

  surfaceGeo.dispose();
  surfaceMat.dispose();

  if (!(result instanceof ArrayBuffer)) {
    throw new Error('GLTFExporter did not return a binary buffer');
  }
  return result;
}

/**
 * Build the portable scene description (all parameters, metadata, environment).
 *
 * @param {import('./planet.js').PlanetScene} scene
 * @param {object} meta
 * @returns {object}
 */
export function buildSceneJSON(scene, meta = {}) {
  const params = {};
  for (const def of PARAMS) params[def.key] = scene.params[def.key];

  return {
    format: 'planet-forge/scene',
    version: 1,
    generator: 'planet-forge',
    createdAt: new Date().toISOString(),
    seed: scene.params.seed,
    parameters: params,
    environment: {
      sun: {
        azimuthDeg: scene.params.sunAzimuth,
        elevationDeg: scene.params.sunElevation,
        intensity: scene.params.sunIntensity,
        color: scene.params.sunColor,
      },
      ambient: {
        intensity: scene.params.ambientIntensity,
        color: scene.params.ambientColor,
      },
      background: scene.params.background,
    },
    camera: {
      position: scene.camera.position.toArray(),
      target: [0, 0, 0],
      fov: scene.camera.fov,
    },
    geometry: {
      ...scene.geometryInfo,
      relief: scene.heightField?.stats,
    },
    measurements: scene.measure(),
    note: 'Shader-driven subsystems (atmosphere, clouds, stars) are described by parameters only; they are not part of the GLB.',
    ...meta,
  };
}

/**
 * Trigger a browser download for a Blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
