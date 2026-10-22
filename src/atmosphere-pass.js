/**
 * Atmosphere composite pass (v2).
 *
 * ## Why this replaces the v1 shell
 *
 * v1 drew the atmosphere as an additive back-face shell and *guessed* how much of
 * the effect should land on the disc. That structure cannot express the two things
 * that make a real atmosphere:
 *
 *   - **Transmittance.** Air absorbs as well as scatters. A face-on ray passes
 *     through one scale height and must leave the surface almost untouched; a
 *     grazing ray crosses tens of them and must nearly extinguish the surface while
 *     lighting up. Additive blending has no way to darken what is behind it, so v1
 *     had to clamp the face-on contribution to 0.0025 to stop the blue from
 *     washing out the biomes — a number chosen by eye, not by the model.
 *   - **Analytic optical depth.** τ along a chord through a spherical shell is a
 *     closed-form function of the impact parameter. Solving it directly makes limb
 *     brightness follow from geometry, so marching more or fewer steps changes only
 *     noise, never brightness.
 *
 * This pass therefore renders in two stages:
 *
 *   1. The planet (surface, ocean, clouds, rings) is drawn into an offscreen
 *      render target.
 *   2. A full-screen quad composites that colour with the atmosphere:
 *        out = planetColour * T + scatteredLight
 *      where T and the scattered light come from the analytic model below.
 *
 * The visible result: the disc keeps its true palette, the limb glows, the
 * terminator has a coloured band, and the night side is lit only by what little
 * light is still scattered forward — all derived from the same three numbers
 * (planet radius, shell radius, scale height).
 */

import * as THREE from 'three';

export const ATMOSPHERE_DEFAULTS = {
  enabled: true,
  /** Shell radius as a multiple of the planet radius. */
  shellRadius: 1.16,
  /** Thickness of the atmosphere relative to the shell (controls scale height). */
  densityFalloff: 3.2,
  intensity: 1.0,
  /** Rayleigh scattering coefficient per unit length, as a colour. */
  rayleighColor: '#4a90ff',
  /** Mie scattered colour (haze, sunsets). */
  mieColor: '#ffd9b0',
  /** Mie contribution weight. */
  mieStrength: 0.18,
  /** Forward-scattering lobe sharpness (0 = isotropic, 1 = strongly forward). */
  mieG: 0.76,
  /** Multiple-scattering approximation weight (0 = single scattering only). */
  multipleScattering: 0.35,
  /** Night-side floor: light from stars and planet-shine, as a colour. */
  nightColor: '#2a3a52',
  nightIntensity: 0.55,
};

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uScene;
uniform vec2 uResolution;
uniform vec3 uSunDirection;
uniform vec3 uRayleigh;
uniform vec3 uMieColor;
uniform float uPlanetRadius;
uniform float uShellRadius;
uniform float uDensityFalloff;
uniform float uIntensity;
uniform float uMieStrength;
uniform float uMieG;
uniform float uMultipleScattering;
uniform vec3 uNightColor;
uniform float uNightIntensity;
uniform vec3 uCameraPos;
uniform mat4 uInverseProjection;
uniform mat4 uCameraMatrixWorld;

varying vec2 vUv;

const float PI = 3.14159265359;

/**
 * Distance to the far intersection of a ray with a sphere centred at the origin.
 * Returns (near, far); far < 0 means the ray misses.
 */
vec2 raySphere(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0, -1.0);
  float sq = sqrt(disc);
  return vec2(-b - sq, -b + sq);
}

/** Rayleigh phase: nearly uniform, slightly stronger forward and back. */
float phaseRayleigh(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

/** Cornette-Shanks phase: forward-biased, the standard Mie lobe in atmosphere work. */
float phaseMie(float cosTheta, float g) {
  float g2 = g * g;
  float num = (1.0 - g2) * (1.0 + cosTheta * cosTheta);
  float den = (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
  return (3.0 / (8.0 * PI)) * num / den;
}

/**
 * Optical depth along the segment of the view ray that lies inside the shell.
 *
 * For a ray at impact parameter p, the chord inside a shell of radius R spans
 * 2 * sqrt(R^2 - p^2) minus whatever is occluded by the planet. Using the chord
 * directly rather than integrating per sample is what makes the result
 * independent of step count: the density is approximated as exponential in
 * altitude, and the chord length is exact.
 */
float opticalDepth(vec3 origin, vec3 dir, float tEnter, float tExit) {
  // Midpoint of the in-shell segment, used to estimate the mean altitude.
  float tMid = (tEnter + tExit) * 0.5;
  vec3 mid = origin + dir * tMid;
  float r = length(mid);
  float altitude = max(0.0, r - uPlanetRadius);
  float shellThickness = max(0.0001, uShellRadius - uPlanetRadius);
  // Exponential density with a scale height derived from the falloff parameter.
  float scaleHeight = shellThickness / max(0.5, uDensityFalloff);
  float density = exp(-altitude / scaleHeight);
  return density * max(0.0, tExit - tEnter);
}

/**
 * Sun visibility for a point in the atmosphere: 0 if the planet blocks the sun,
 * 1 if not, with a soft edge from the penumbra of the shell itself.
 */
float sunVisibility(vec3 p) {
  // The planet occludes the sun if the point is behind the planet relative to
  // the sun AND its distance from the sun-planet axis is inside the planet.
  float alongSun = dot(p, uSunDirection);
  if (alongSun > 0.0) return 1.0;
  float perp = length(p - uSunDirection * alongSun);
  return smoothstep(uPlanetRadius * 0.98, uPlanetRadius * 1.06, perp);
}

void main() {
  vec3 sceneColor = texture2D(uScene, vUv).rgb;

  // Reconstruct the world-space view ray for this pixel using the scene camera's
  // own inverse projection. An earlier version assumed a fixed 60-degree frustum
  // (vec3(ndc*0.5, -1)), which silently offset every phase angle once the real fov
  // was 38 degrees: the terminator band landed in the wrong place relative to the
  // lit ground, so the glow and the lighting disagreed.
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 viewDir = uInverseProjection * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize((uCameraMatrixWorld * vec4(viewDir.xyz / viewDir.w, 0.0)).xyz);
  vec3 origin = uCameraPos;

  vec3 colour = sceneColor;

  // Does this ray intersect the planet body? That single test separates the two
  // kinds of pixel this pass must handle, and everything below branches on it.
  //
  // Getting this wrong is subtle: an earlier version multiplied the *scene colour*
  // by transmittance on sky pixels too, and since the offscreen clear colour was
  // the space background, the "sky" ended up as background*T + scattered over the
  // whole frame. The measured symptom was a uniform wash everywhere (radial
  // variation inside the disc collapsed to 0, corners jumped from [5,7,13] to
  // [49,86,104]) because every pixel shared nearly the same chord.
  vec2 planetHit = raySphere(origin, dir, uPlanetRadius);
  bool hitsPlanet = planetHit.y > 0.0 && planetHit.x > 0.0;

  vec2 shellHit = raySphere(origin, dir, uShellRadius);
  bool hitsShell = shellHit.y > 0.0;

  float chord = 0.0;
  vec3 mid = origin;

  if (hitsPlanet) {
    // Air column from the camera to the visible surface.
    float t0 = max(0.0, shellHit.x > 0.0 ? shellHit.x : 0.0);
    float t1 = planetHit.x;
    chord = max(0.0, t1 - t0);
    mid = origin + dir * (t0 + chord * 0.5);
  } else if (hitsShell) {
    // Air only: integrate the shell chord the ray crosses, which is what draws the
    // halo outside the disc. The length shrinks to zero at the silhouette.
    float t0 = max(0.0, shellHit.x);
    chord = max(0.0, shellHit.y - t0);
    mid = origin + dir * (t0 + chord * 0.5);
  }

  // Rays that touch neither the planet nor the shell are untouched space.
  if (chord <= 1e-6) {
    gl_FragColor = vec4(sceneColor, 1.0);
    #include <colorspace_fragment>
    return;
  }

  float cosTheta = dot(dir, uSunDirection);

  float altitude = max(0.0, length(mid) - uPlanetRadius);
  float shellThickness = max(0.0001, uShellRadius - uPlanetRadius);
  float scaleHeight = shellThickness / max(0.5, uDensityFalloff);
  float density = exp(-altitude / scaleHeight);

  // The density integral. Because the chord length is exact and the mean density
  // comes from the chord's midpoint altitude, the centre/limb ratio falls out of
  // the geometry instead of needing a hand-tuned power curve.
  float tau = density * chord * uDensityFalloff;

  vec3 rayleighCoeff = uRayleigh * vec3(0.28, 0.62, 1.0);
  vec3 mieCoeff = uMieColor * uMieStrength;
  vec3 tauTotal = (rayleighCoeff + mieCoeff) * tau;
  vec3 transmittance = exp(-tauTotal);

  float sunVis = sunVisibility(mid);
  float pr = phaseRayleigh(cosTheta);
  float pm = phaseMie(cosTheta, uMieG);

  vec3 single = (rayleighCoeff * pr + mieCoeff * pm) * (1.0 - transmittance) * sunVis;

  // Multiple scattering: a weakened, directionless echo of single scattering that
  // is deliberately NOT gated by sunVis. That is the physical reason a night limb
  // is visible at all: light from the lit side bounces across the terminator.
  vec3 multi = (rayleighCoeff + mieCoeff) * (1.0 - transmittance) * uMultipleScattering * 0.30;

  // Twilight band: just past the terminator the upper shell still sees the sun over
  // the horizon, so the air keeps glowing warm after the ground has gone dark.
  float twilight = smoothstep(0.35, -0.30, cosTheta) * 0.45;

  vec3 scattered = single + multi;
  scattered += (rayleighCoeff + mieCoeff) * twilight * (1.0 - transmittance) * 0.6;

  // Night floor: starlight and planet-shine, scaled by how much air is in the way.
  float airPresence = clamp(tau * 0.6, 0.0, 1.0);
  scattered += uNightColor * uNightIntensity * airPresence * (1.0 - sunVis) * 0.4;

  scattered *= uIntensity;

  // Composite. On the disc the surface is behind the air, so it is attenuated; over
  // pure sky there is no surface, so the background simply receives the glow.
  colour = hitsPlanet
    ? sceneColor * transmittance + scattered
    : sceneColor + scattered;

  gl_FragColor = vec4(colour, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * Screen-space atmosphere compositor.
 *
 * Owns an offscreen target sized to the canvas, a full-screen quad and the uniform
 * set. `render()` draws the scene into the target, then composites.
 */
export class AtmospherePass {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} [options]
   */
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.opts = { ...ATMOSPHERE_DEFAULTS, ...options };

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });

    this.uniforms = {
      uScene: { value: this.target.texture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uSunDirection: { value: new THREE.Vector3(1, 0.2, 0.3).normalize() },
      uRayleigh: { value: new THREE.Color(this.opts.rayleighColor) },
      uMieColor: { value: new THREE.Color(this.opts.mieColor) },
      uPlanetRadius: { value: 1 },
      uShellRadius: { value: this.opts.shellRadius },
      uDensityFalloff: { value: this.opts.densityFalloff },
      uIntensity: { value: this.opts.intensity },
      uMieStrength: { value: this.opts.mieStrength },
      uMieG: { value: this.opts.mieG },
      uMultipleScattering: { value: this.opts.multipleScattering },
      uNightColor: { value: new THREE.Color(this.opts.nightColor) },
      uNightIntensity: { value: this.opts.nightIntensity },
      uCameraPos: { value: new THREE.Vector3() },
      uInverseProjection: { value: new THREE.Matrix4() },
      uCameraMatrixWorld: { value: new THREE.Matrix4() },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /**
   * Resize the offscreen target.
   * @param {number} width
   * @param {number} height
   * @param {number} pixelRatio
   */
  setSize(width, height, pixelRatio = 1) {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.target.setSize(w, h);
    this.uniforms.uResolution.value.set(w, h);
  }

  /**
   * Render the scene with the atmosphere composited on top.
   *
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} state
   * @param {THREE.Vector3} state.sunDirection
   * @param {number} state.planetRadius
   */
  render(scene, camera, state) {
    const u = this.uniforms;
    u.uCameraPos.value.copy(camera.position);
    // The ray reconstruction needs the exact matrices the scene was rendered with.
    u.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    u.uCameraMatrixWorld.value.copy(camera.matrixWorld);
    u.uPlanetRadius.value = state.planetRadius;
    if (state.sunDirection) u.uSunDirection.value.copy(state.sunDirection).normalize();

    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(prevTarget);

    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /** Push tuned parameters into the uniforms (live, no rebuild). */
  applyParams(p) {
    const u = this.uniforms;
    u.uShellRadius.value = p.atmoRadius;
    u.uDensityFalloff.value = p.atmoDensity;
    u.uIntensity.value = p.atmoIntensity;
    u.uRayleigh.value.set(p.atmoRayleigh);
    u.uMieColor.value.set(p.atmoMie);
    u.uMieStrength.value = p.atmoMieStrength ?? ATMOSPHERE_DEFAULTS.mieStrength;
    u.uMieG.value = p.atmoMieG ?? ATMOSPHERE_DEFAULTS.mieG;
    u.uMultipleScattering.value = p.atmoMultipleScattering ?? ATMOSPHERE_DEFAULTS.multipleScattering;
    u.uNightColor.value.set(p.ambientColor ?? ATMOSPHERE_DEFAULTS.nightColor);
    u.uNightIntensity.value = (p.ambientIntensity ?? 0.14) * 3.0;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
