/**
 * 3D noise primitives for spherical sampling.
 *
 * Why this file exists: the upstream library (IceCreamYou/THREE.Terrain, MIT)
 * ships a 2D-only Simplex/Perlin implementation in `src/noise.js`. A planet is a
 * sphere, so every height sample has to be taken in 3D — 2D noise wrapped onto a
 * sphere produces a visible seam and polar pinching. This module adds a
 * permutation-seeded 3D Simplex noise plus the fractal combinators the tectonic
 * height field needs (fBm, ridged multifractal, domain warp).
 *
 * The 3D Simplex algorithm follows Stefan Gustavson's reference implementation
 * (public domain) as popularised by Ashima Arts / josephg/noisejs, the same
 * lineage the upstream 2D code credits.
 */

const F3 = 1 / 3;
const G3 = 1 / 6;

// 12 gradient directions of the rhombic dodecahedron, flattened for speed.
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/**
 * Small, fast, deterministic PRNG. Same seed => same stream, in Node and in the
 * browser, with no reliance on Math.random.
 *
 * @param {number} seed Unsigned 32-bit integer.
 * @returns {() => number} Generator producing values in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Build a seeded 3D Simplex noise sampler.
 *
 * @param {number} seed Unsigned 32-bit integer.
 * @returns {(x: number, y: number, z: number) => number} Sampler in roughly [-1, 1].
 */
export function createNoise3D(seed) {
  const rng = mulberry32(seed >>> 0);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  // Fisher-Yates shuffle driven by the seeded stream.
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = base[i];
    base[i] = base[j];
    base[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = base[i & 255];
    permMod12[i] = perm[i] % 12;
  }

  // 3D Simplex returns exactly 0 at lattice points (the four tetrahedral corner
  // contributions cancel). Sphere sampling can land on those points for certain
  // frequencies, producing visible pinpricks of zero height. Shifting the whole
  // sampling space by a seed-derived irrational offset makes a lattice hit
  // effectively impossible while keeping the field fully deterministic.
  const ox = 0.5 + (perm[0] / 256) * 0.7318;
  const oy = 0.5 + (perm[1] / 256) * 0.6180;
  const oz = 0.5 + (perm[2] / 256) * 0.4142;

  return function noise3(xin, yin, zin) {
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
    xin += ox;
    yin += oy;
    zin += oz;

    // Skew the input space to determine which simplex cell we are in.
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    // Determine which simplex (tetrahedron) we are in, and the offsets.
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else {
      if (y0 < z0) {
        i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
      } else if (x0 < z0) {
        i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
      } else {
        i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      }
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const gi = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[gi] * x0 + GRAD3[gi + 1] * y0 + GRAD3[gi + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const gi = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[gi] * x1 + GRAD3[gi + 1] * y1 + GRAD3[gi + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const gi = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[gi] * x2 + GRAD3[gi + 1] * y2 + GRAD3[gi + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const gi = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n3 = t3 * t3 * (GRAD3[gi] * x3 + GRAD3[gi + 1] * y3 + GRAD3[gi + 2] * z3);
    }

    // Scale to approximately [-1, 1].
    return 32 * (n0 + n1 + n2 + n3);
  };
}

/**
 * Fractal Brownian motion over a 3D sampler.
 *
 * @param {(x:number,y:number,z:number)=>number} noise
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} [octaves=5]
 * @param {number} [lacunarity=2]
 * @param {number} [gain=0.5]
 * @returns {number} Sum in roughly [-1, 1].
 */
export function fbm3(noise, x, y, z, octaves = 5, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x, fy = y, fz = z;
  for (let o = 0; o < octaves; o++) {
    sum += noise(fx, fy, fz) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
    fz *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal. Sharp creases come from folding the noise around zero and
 * squaring it, which is what makes mountain belts read as ridges instead of
 * rolling hills. Weighting by the previous octave keeps detail concentrated on
 * the crests.
 *
 * @param {(x:number,y:number,z:number)=>number} noise
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} [octaves=4]
 * @param {number} [lacunarity=2.1]
 * @param {number} [gain=0.5]
 * @returns {number} Sum in roughly [0, 1].
 */
export function ridged3(noise, x, y, z, octaves = 4, lacunarity = 2.1, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let weight = 1;
  let fx = x, fy = y, fz = z;
  for (let o = 0; o < octaves; o++) {
    let signal = 1 - Math.abs(noise(fx, fy, fz));
    signal *= signal;
    signal *= weight;
    weight = Math.min(1, Math.max(0, signal * 2));
    sum += signal * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
    fz *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Domain warp: offset the sample position by a second noise field. This is what
 * breaks up the "obviously Perlin" grid alignment and lets coastlines meander.
 *
 * @param {(x:number,y:number,z:number)=>number} noise
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} strength
 * @param {number} [frequency=1]
 * @returns {{x:number,y:number,z:number}}
 */
export function warp3(noise, x, y, z, strength, frequency = 1) {
  const wx = noise(x * frequency + 11.3, y * frequency + 3.7, z * frequency + 27.1);
  const wy = noise(x * frequency - 7.9, y * frequency + 19.4, z * frequency - 5.2);
  const wz = noise(x * frequency + 2.6, y * frequency - 13.8, z * frequency + 8.9);
  return {
    x: x + wx * strength,
    y: y + wy * strength,
    z: z + wz * strength,
  };
}
