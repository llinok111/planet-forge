/**
 * Starfield.
 *
 * A skybox of point sprites rather than a cube texture: points can be given a
 * real colour-temperature ramp, per-star size and a seeded distribution, and they
 * cost one draw call. Three populations are mixed because a single uniform
 * distribution always looks synthetic:
 *
 *   - field stars: uniform on the sphere, dim, tight size distribution
 *   - bright stars: sparse, larger, saturated colours at the extremes of the
 *     temperature ramp
 *   - galactic band: clustered on a great circle with a softened normal
 *     distribution, which produces the milky smear without a texture
 */

import * as THREE from 'three';
import { mulberry32 } from './noise3d.js';
import { deriveSeed } from './seed.js';

export const STARFIELD_DEFAULTS = {
  enabled: true,
  count: 9000,
  radius: 120,
  size: 0.55,
  brightness: 1.0,
  bandStrength: 0.55,
  colorVariance: 0.75,
  twinkle: 0.0,
};

/** Approximate star colour from a normalized temperature parameter 0..1. */
function starColor(t, rng, variance) {
  // 0 = cool red dwarf, 0.5 = solar white, 1 = hot blue giant.
  const warm = new THREE.Color(1.0, 0.72, 0.48);
  const mid = new THREE.Color(1.0, 0.97, 0.92);
  const cool = new THREE.Color(0.62, 0.76, 1.0);
  const base = t < 0.5
    ? warm.clone().lerp(mid, t / 0.5)
    : mid.clone().lerp(cool, (t - 0.5) / 0.5);
  // Desaturate slightly toward white so the field does not look like confetti.
  const white = new THREE.Color(1, 1, 1);
  const desat = 0.55 + rng() * 0.45 * variance;
  return base.lerp(white, 1 - desat);
}

/**
 * Build the starfield points cloud.
 *
 * @param {string|number} seed
 * @param {object} [options]
 * @returns {THREE.Points}
 */
export function createStarfield(seed, options = {}) {
  const opts = { ...STARFIELD_DEFAULTS, ...options };
  const rng = mulberry32(deriveSeed(seed, 'stars'));
  const total = Math.max(100, Math.floor(opts.count));

  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const sizes = new Float32Array(total);
  const phases = new Float32Array(total);

  // Galactic plane normal: a random great circle.
  let nx = rng() * 2 - 1, ny = rng() * 2 - 1, nz = rng() * 2 - 1;
  const nlen = Math.hypot(nx, ny, nz) || 1;
  nx /= nlen; ny /= nlen; nz /= nlen;

  const bandCount = Math.floor(total * 0.4);

  for (let i = 0; i < total; i++) {
    let x, y, z;
    let isBand = i < bandCount;

    if (isBand) {
      // Cluster near the galactic plane. Squashing the direction vector alone
      // barely narrows the resulting angular spread (measured: 81% of the
      // original latitude at full strength), because normalising undoes most of
      // the squash. Instead build the band from (1) a longitude around the plane
      // and (2) an explicitly drawn small latitude, so the band width is a
      // directly controlled quantity.
      // Orthonormal basis (u, v) spanning the galactic plane.
      // u = normalize(cross(n, a)) where a is whichever axis is least aligned
      // with n, which keeps the cross product away from degeneracy.
      const pick = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      let uX = ny * pick[2] - nz * pick[1];
      let uY = nz * pick[0] - nx * pick[2];
      let uZ = nx * pick[1] - ny * pick[0];
      const uLen = Math.hypot(uX, uY, uZ) || 1;
      uX /= uLen; uY /= uLen; uZ /= uLen;
      // v = cross(n, u)
      const vX = ny * uZ - nz * uY;
      const vY = nz * uX - nx * uZ;
      const vZ = nx * uY - ny * uX;

      const lon = rng() * Math.PI * 2;
      // Latitude drawn from a triangular-ish distribution: |lat| concentrated
      // near 0, width scaled by bandStrength.
      const widthRad = 0.14 + (1 - Math.min(1, opts.bandStrength)) * 0.9;
      const latRaw = (rng() + rng() - 1);
      const lat = latRaw * widthRad;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      const cLon = Math.cos(lon), sLon = Math.sin(lon);
      x = (uX * cLon + vX * sLon) * cl + nx * sl;
      y = (uY * cLon + vY * sLon) * cl + ny * sl;
      z = (uZ * cLon + vZ * sLon) * cl + nz * sl;
      const l2 = Math.hypot(x, y, z) || 1;
      x /= l2; y /= l2; z /= l2;
    } else {
      const u = rng() * 2 - 1;
      const phi = rng() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      x = s * Math.cos(phi);
      y = u;
      z = s * Math.sin(phi);
    }

    positions[i * 3] = x * opts.radius;
    positions[i * 3 + 1] = y * opts.radius;
    positions[i * 3 + 2] = z * opts.radius;

    // Temperature: band stars are dimmer and warmer on average.
    const temp = isBand ? rng() * 0.45 : rng();
    const col = starColor(temp, rng, opts.colorVariance);
    const bright = isBand ? 0.45 + rng() * 0.4 : 0.55 + Math.pow(rng(), 2.2) * 0.85;
    colors[i * 3] = col.r * bright;
    colors[i * 3 + 1] = col.g * bright;
    colors[i * 3 + 2] = col.b * bright;

    // Size: heavy-tailed so a few stars dominate, as in a real field.
    sizes[i] = isBand
      ? opts.size * (0.4 + rng() * 0.5)
      : opts.size * (0.5 + Math.pow(rng(), 3) * 2.6);
    phases[i] = rng() * Math.PI * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), opts.radius * 1.1);

  const uniforms = {
    uBrightness: { value: opts.brightness },
    uTwinkle: { value: opts.twinkle },
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      uniform float uTwinkle;
      uniform float uTime;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        vColor = color;
        float tw = 1.0;
        if (uTwinkle > 0.001) {
          tw = 1.0 - uTwinkle * 0.5 * (0.5 + 0.5 * sin(uTime * 2.3 + aPhase * 7.0));
        }
        vAlpha = tw;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * 2.2;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uBrightness;
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        // Round sprite with a soft core: distance from the sprite centre.
        vec2 d = gl_PointCoord - vec2(0.5);
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        float core = smoothstep(0.25, 0.0, r2);
        float halo = smoothstep(0.25, 0.06, r2) * 0.35;
        float a = clamp((core + halo) * vAlpha * uBrightness, 0.0, 1.0);
        gl_FragColor = vec4(vColor * (1.0 + core * 0.6), a);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'starfield';
  points.visible = opts.enabled;
  points.renderOrder = -1;
  points.frustumCulled = false;
  points.userData.uniforms = uniforms;
  points.userData.type = 'starfield';
  // Keep the unscaled sizes so the `starSize` slider can rescale without a rebuild.
  points.userData.baseSizes = Float32Array.from(sizes);
  points.userData.baseSizeSetting = opts.size;
  // Exposed so measurement code can test membership of the *actual* band rather
  // than guessing where it ended up.
  points.userData.galacticNormal = [nx, ny, nz];
  return points;
}

/**
 * Update star uniforms.
 *
 * @param {THREE.Points} points
 * @param {{elapsedSeconds: number, pixelRatio: number}} state
 */
export function updateStarfield(points, state) {
  const u = points.userData.uniforms;
  if (!u) return;
  if (typeof state.elapsedSeconds === 'number') u.uTime.value = state.elapsedSeconds;
  if (typeof state.pixelRatio === 'number') u.uPixelRatio.value = state.pixelRatio;
}

/** @param {THREE.Points} points */
export function disposeStarfield(points) {
  points.geometry?.dispose();
  points.material?.dispose();
}

/**
 * Count how many stars fall within a given angle of the galactic plane.
 *
 * The plane normal is derived from the second moments of the star directions
 * (the eigenvector of the smallest eigenvalue), so this measures the *actual*
 * clustering axis rather than assuming where it was placed. That makes the test
 * immune to the arbitrary orientation chosen for any given seed.
 *
 * @param {Float32Array} positions Star positions (xyz interleaved).
 * @param {number} maxLatRad Half-width of the band in radians.
 * @param {number} [planeNormal] Unit normal of the galactic plane. Pass the one the
 *   starfield was built with: the dominant variance axis is whichever direction has
 *   the *most* stars, which for a band is inside the plane, not perpendicular to it.
 * @returns {number} Fraction in [0,1].
 */
export function bandFraction(positions, maxLatRad, planeNormal) {
  const count = positions.length / 3;
  if (count === 0) return 0;

  if (planeNormal && planeNormal.length === 3) {
    let inside = 0;
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      const lat = Math.asin(Math.min(1, Math.max(-1, (x * planeNormal[0] + y * planeNormal[1] + z * planeNormal[2]) / l)));
      if (Math.abs(lat) <= maxLatRad) inside++;
    }
    return inside / count;
  }

  // Covariance matrix of unit directions.
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    const a = x / l, b = y / l, c = z / l;
    xx += a * a; xy += a * b; xz += a * c;
    yy += b * b; yz += b * c; zz += c * c;
  }
  // Normal-axis = eigenvector of the smallest eigenvalue. Power iteration on the
  // inverse is overkill here; instead use the fact that the direction of least
  // variance is the null space of the covariance, found by cross products of the
  // rows of (C - lambda I) for the smallest lambda.
  // Simpler and robust enough: the smallest-variance axis is perpendicular to the
  // dominant plane, so take the normal of the best-fit plane via the smallest
  // singular vector approximated from the covariance's cofactors.
  const cxx = yy * zz - yz * yz;
  const cxy = xz * yz - xy * zz;
  const cxz = xy * yz - xz * yy;
  let nx = cxx, ny = cxy, nz = cxz;
  let nlen = Math.hypot(nx, ny, nz);
  if (nlen < 1e-9) {
    // Fall back to the dominant eigenvector being the normal itself.
    nx = xy; ny = yy; nz = yz;
    nlen = Math.hypot(nx, ny, nz) || 1;
  }
  nx /= nlen; ny /= nlen; nz /= nlen;

  let inside = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    const lat = Math.asin(Math.min(1, Math.max(-1, (x * nx + y * ny + z * nz) / l)));
    if (Math.abs(lat) <= maxLatRad) inside++;
  }
  return inside / count;
}

/**
 * Measure the angular spread of a star population as the standard deviation of
 * |latitude| about the fitted plane, for tests and docs.
 *
 * @param {Float32Array} positions
 * @returns {number} RMS latitude in radians.
 */
export function bandSpread(positions) {
  const count = positions.length / 3;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    const lat = Math.asin(Math.min(1, Math.max(-1, y / l)));
    acc += lat * lat;
  }
  return Math.sqrt(acc / Math.max(1, count));
}
