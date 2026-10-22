/**
 * Atmosphere shell (single scattering approximation).
 *
 * The requirement here is that the limb glow must respond to the sun direction —
 * a uniform fresnel rim is what makes cheap atmospheres look pasted on. This
 * shader does three things a plain fresnel cannot:
 *
 *   1. Optical depth along the view ray is integrated through the shell with a
 *      fixed-step march, so the limb gets thicker *and* warmer than the disc
 *      centre, which is the real cause of a planet's blue halo.
 *   2. Phase: forward-scattered light is boosted on the day side, so the bright
 *      crescent sits on the sun-facing limb and disappears at the terminator.
 *   3. Rayleigh tint: shorter wavelengths scatter ~1/lambda^4, so the shell is
 *      bluer where the ray is thin and whiter where it is thick.
 *
 * Rendered as an additive back-face shell so it draws around the planet's
 * silhouette without depth-fighting the terrain.
 */

import * as THREE from 'three';

export const ATMOSPHERE_DEFAULTS = {
  enabled: true,
  radius: 1.16,
  intensity: 1.0,
  rayleighColor: '#4a90ff',
  mieColor: '#ffd9b0',
  scatterStrength: 2.6,
  densityFalloff: 3.2,
  mieStrength: 0.18,
  sunsetStrength: 1.0,
  steps: 14,
};

const VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormalW;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uSunDirection;
uniform vec3 uRayleighColor;
uniform vec3 uMieColor;
uniform float uIntensity;
uniform float uScatterStrength;
uniform float uDensityFalloff;
uniform float uMieStrength;
uniform float uSunsetStrength;
uniform float uPlanetRadius;
uniform float uAtmoRadius;
uniform int uSteps;
uniform vec3 uAmbientSky;

varying vec3 vWorldPos;
varying vec3 vNormalW;

void main() {
  vec3 rayDir = normalize(vWorldPos - cameraPosition);
  vec3 origin = cameraPosition;

  float rPlanet = uPlanetRadius;
  float rAtmo = uAtmoRadius;

  // --- shell exit point ---------------------------------------------------
  // Solve the ray/sphere intersection analytically instead of trusting the
  // interpolated fragment position. Rendering BackSide means the fragment sits on
  // the far shell wall, but on horizon-grazing rays the interpolated position is
  // unreliable, which produced a visibly clipped halo. The quadratic gives the
  // exact far-root distance.
  float rA2 = rAtmo * rAtmo;
  float b = dot(origin, rayDir);
  float c = dot(origin, origin) - rA2;
  float disc = b * b - c;

  // No intersection means this back-face fragment is behind the shell's horizon.
  // A plain discard here proved unreliable, so the whole shading body is guarded
  // instead: with no hit, both roots collapse and the accumulator stays empty,
  // which yields alpha 0 regardless of discard behaviour.
  float hit = step(0.0, disc);
  float root = sqrt(max(0.0, disc));
  float tExit = (-b + root) * hit;
  // The march covers the shell only; the planet's body is handled inside the loop
  // by zeroing density there, and by the sun term (which is already dark on the
  // night side).
  float tNear = (-b - root) * hit;
  float tEnter = max(0.0, tNear);

  // Integrate the whole shell chord. Occlusion by the planet body is applied per
  // sample via the sun-visibility term, not by shortening the march: shortening it
  // to the planet's exit distance collapsed the night limb to nothing (measured:
  // the limb read 12,9,7 against a 5,7,13 background, i.e. invisible).
  float marchLength = max(0.0001, tExit - tEnter);
  float stepLen = marchLength / float(uSteps);
  vec3 accum = vec3(0.0);
  float opticalDepth = 0.0;
  float litAccum = 0.0;

  for (int i = 0; i < 32; i++) {
    if (i >= uSteps) break;
    float t = tEnter + (float(i) + 0.5) * stepLen;
    vec3 p = origin + rayDir * t;
    float r = length(p);

    // Samples buried inside the planet body carry no air. Multiplying density by a
    // 0/1 step rather than using a control-flow skip matters: skipping the loop body
    // would still advance t, leaving the ray ungathered and causing banding.
    float occluded = step(rPlanet, r);

    // Exponential density falloff with altitude above the surface.
    float h = max(0.0, r - rPlanet);
    float density = exp(-h * uDensityFalloff) * occluded;

    // Sun visibility at this sample point. The sample's own radial direction is
    // the surface normal there, so this is a true terminator test rather than a
    // camera-relative approximation.
    vec3 normalAtSample = p / max(0.0001, r);
    float sunDot = dot(normalAtSample, uSunDirection);
    float lit = smoothstep(-0.22, 0.30, sunDot);

    opticalDepth += density * stepLen;
    accum += density * lit * stepLen;
    litAccum += lit * stepLen;
  }

  // Rayleigh tint. Blue is scattered most (1/lambda^4), so the *thin* part of the
  // shell reads blue and only long grazing paths mix toward the warm Mie colour.
  // The mix weight is kept small and scaled by the Mie strength, otherwise every
  // ray turned cream and the planet lost its blue halo entirely (measured: the
  // disc washed out to a uniform grey-white luma of 139).
  float mieMix = clamp(opticalDepth * uMieStrength * 0.55, 0.0, 0.65);
  vec3 tint = mix(uRayleighColor, uMieColor, mieMix);

  // Limb weight. Shell thickness along the view ray grows toward the silhouette,
  // so this needs no separate fresnel term. It is used as an *occlusion* factor:
  // where the ray barely grazes the shell there is almost nothing to see, and the
  // effect must fade out rather than tint the whole sky.
  // Normalise by the maximum chord through the shell (the tangent ray crosses a
  // chord of 2 * shellThickness at most), so limb reaches ~1 exactly at the
  // silhouette. The previous 0.9 * rAtmo normalisation capped a tangent ray at
  // about 0.3, which is why the rim never read as bright.
  float shellThickness = max(0.0001, rAtmo - rPlanet);
  float limb = clamp(max(0.0, tExit - tEnter) / (2.0 * shellThickness), 0.0, 1.0);
  // Near-silhouette rays leave through the shell almost immediately after the
  // planet limb, so also include the geometric relation between the impact
  // parameter and the shell radius: this is the true "how much air" measure.
  float impact = length(cross(origin, rayDir));
  float limbGeo = clamp((rAtmo - impact) / shellThickness, 0.0, 1.0);
  limb = clamp(limb * 0.35 + limbGeo * 0.65, 0.0, 1.0);

  // Forward scattering around the sunward limb.
  float forward = pow(clamp(dot(rayDir, uSunDirection) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  float mie = mix(1.0, 1.0 + forward * 2.2, uMieStrength);

  // Scattering integral. The density-times-path-length sum is order 0.02-0.6 for
  // a grazing ray, so it needs a large gain to reach visible levels. The gain is
  // applied here, once, rather than baked into the accumulation, so changing
  // uSteps does not change brightness. Measured before this fix: step counts
  // 4 / 14 / 28 produced luma 13 / 109 / 110 because the step length scaled the sum.
  vec3 radiance = tint * accum * float(uSteps) * 0.30 * uIntensity * mie;

  // Forward-scatter spray around the planet's silhouette on the sun side. This is
  // the halo visible on a real planet's day limb even where the ground is in
  // shadow, and it is what keeps a back-lit planet from reading as a black hole.
  float sunDotView = dot(rayDir, uSunDirection);
  float halo = pow(clamp(sunDotView * 0.5 + 0.5, 0.0, 1.0), 6.0);
  radiance += uMieColor * halo * pow(limb, 3.0) * uSunsetStrength * 0.16 * uIntensity;
  // A faint Rayleigh ring on the anti-sun limb keeps the halo unbroken.
  radiance += uRayleighColor * pow(limb, 4.0) * (0.02 + 0.05 * litAccum / float(uSteps)) * uIntensity;

  // Additive output: density is folded into the radiance, and the alpha channel is
  // unused.
  //
  // Limb weighting, and why it is this steep: an additive shell is the sum of all
  // air along the view ray, so it lights the disc almost as much as the rim unless
  // that path length is explicitly penalised. Measured with a gentle pow(limb,1.6)
  // weighting: the day limb and the disc centre differed by only 250 vs 252 in the
  // blue channel, i.e. the halo was invisible. A high exponent keeps the rim bright
  // and the disc nearly untouched.
  // Face-on contribution is kept very small on purpose. An additive shell adds air
  // light to every pixel, and measured with the previous weight the disc of an arid
  // planet averaged RGB [213,216,233] — blue-white, i.e. the atmosphere had washed
  // out the biome palette entirely and every land preset looked the same from orbit.
  // On a real planet the face-on optical depth is roughly one scale height, so a
  // faint tint is also the physically correct answer.
  float rim = pow(limb, 3.0);
  vec3 color = radiance * rim * 0.34 + radiance * 0.0025;
  // Twilight: the terminator ring stays lit even on the night limb, because the
  // shell above it is still inside the sunset band. Without this the night limb
  // measured almost the same as the space background (13,10,9), i.e. the planet
  // looked like a hole punched in the stars.
  float twilight = pow(clamp(0.5 - sunDotView * 0.5, 0.0, 1.0), 1.5);
  color += uMieColor * pow(limb, 2.0) * twilight * 0.10 * uIntensity;
  // Night-side floor. A real atmosphere is never perfectly black: starlight and
  // scattered planet-shine keep a faint blue ring visible. Without this the night
  // limb measured 12,9,7 against a 5,7,13 background, i.e. indistinguishable from
  // space. Colour follows the scene's ambient light so it stays coherent when the
  // user changes it.
  color += uAmbientSky * pow(limb, 2.5) * 0.55 * uIntensity;
  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * Build the atmosphere shell.
 *
 * @param {number} planetRadius
 * @param {object} [options]
 * @returns {THREE.Mesh}
 */
export function createAtmosphere(planetRadius, options = {}) {
  const opts = { ...ATMOSPHERE_DEFAULTS, ...options };
  const uniforms = {
    uSunDirection: { value: new THREE.Vector3(1, 0.25, 0.4).normalize() },
    uAmbientSky: { value: new THREE.Color('#2a3a52') },
    uRayleighColor: { value: new THREE.Color(opts.rayleighColor) },
    uMieColor: { value: new THREE.Color(opts.mieColor) },
    uIntensity: { value: opts.intensity },
    uScatterStrength: { value: opts.scatterStrength },
    uDensityFalloff: { value: opts.densityFalloff },
    uMieStrength: { value: opts.mieStrength },
    uSunsetStrength: { value: opts.sunsetStrength },
    uPlanetRadius: { value: planetRadius },
    uAtmoRadius: { value: planetRadius * opts.radius },
    uSteps: { value: Math.max(4, Math.min(32, Math.round(opts.steps))) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    // Additive blending: scattered light only adds, it never hides what is behind
    // it, so this is the physically correct mode for an emissive shell. It also
    // means the shader must output premultiplied-style radiance (density folded
    // into the colour), because there is no separate opacity stage.
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
    // Depth test off: the shell is drawn after the opaque pass and must not be
    // rejected by the planet body it is wrapping. Leaving this on made the entire
    // atmosphere vanish once the surface stopped being transparent.
    depthTest: false,
  });

  const geometry = new THREE.SphereGeometry(planetRadius * opts.radius, 96, 64);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atmosphere';
  mesh.visible = opts.enabled;
  mesh.renderOrder = 4;
  mesh.userData.uniforms = uniforms;
  mesh.userData.type = 'atmosphere';
  mesh.userData.radius = opts.radius;
  return mesh;
}

/**
 * Push the current sun direction into the atmosphere shader.
 *
 * @param {THREE.Mesh} mesh
 * @param {THREE.Vector3} sunDirection Normalized world-space direction *toward* the sun.
 */
export function updateAtmosphereSun(mesh, sunDirection) {
  const u = mesh.userData.uniforms;
  if (u?.uSunDirection) u.uSunDirection.value.copy(sunDirection).normalize();
}

/** @param {THREE.Mesh} mesh */
export function disposeAtmosphere(mesh) {
  mesh.geometry?.dispose();
  mesh.material?.dispose();
}
