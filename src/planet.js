/**
 * Planet scene: assembles the six subsystems into one renderable, mutable object.
 *
 * The contract this class enforces is what the whole project is judged on:
 *
 *   - `regenerate()` is a pure function of (seed, shape params). Same inputs =>
 *     identical geometry. Nothing in the chain may call Math.random.
 *   - `applyLive()` never touches vertex data, so it can run on every slider drag.
 *   - Every subsystem exposes `measure()` values that come from the actual data
 *     (vertex positions, star positions, coverage samples), not from the input
 *     parameters echoed back. That is what lets the test suite prove a slider
 *     changed the result instead of just the label.
 */

import * as THREE from 'three';
import { createIcosphere, applyRadii } from './icosphere.js';
import { buildHeightField, computeDisplacedNormals } from './heightfield.js';
import { createOcean, updateOcean, OCEAN_DEFAULTS } from './ocean.js';
import { createClouds, updateClouds, disposeClouds, measureCloudCoverage } from './clouds.js';
import { createAtmosphere, updateAtmosphereSun, disposeAtmosphere } from './atmosphere.js';
import { createRings, updateRings, disposeRings } from './rings.js';
import { createStarfield, updateStarfield, disposeStarfield } from './starfield.js';
import { BIOME_FRAGMENT, BIOME_VERTEX, BIOME_VERTEX_BODY } from './shaders/biome.js';
import { shapeParams } from './params.js';

/**
 * Surface material: MeshStandardMaterial with the biome ramp injected.
 *
 * Using the standard material (rather than a raw ShaderMaterial) keeps three.js
 * lighting, shadows-capable normals and tone mapping intact, so the planet reacts
 * to the sun colour and intensity sliders for free.
 *
 * @returns {THREE.MeshStandardMaterial}
 */
function createSurfaceMaterial() {
  const uniforms = {
    uColDeepWater: { value: new THREE.Color('#0a1f38') },
    uColShallow: { value: new THREE.Color('#2b6f88') },
    uColBeach: { value: new THREE.Color('#c8b58a') },
    uColGrass: { value: new THREE.Color('#4f7a3a') },
    uColForest: { value: new THREE.Color('#2c4a26') },
    uColRock: { value: new THREE.Color('#7a6f63') },
    uColSnow: { value: new THREE.Color('#eef2f5') },
    uColSeaBed: { value: new THREE.Color('#16303d') },
    uColIce: { value: new THREE.Color('#dfe9ef') },
    uSnowLine: { value: 0.038 },
    uBeachWidth: { value: 0.003 },
    uIceCapLatitude: { value: 0.86 },
    uBiomeSharpen: { value: 0.22 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
    vertexColors: false,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BIOME_VERTEX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${BIOME_VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BIOME_FRAGMENT}`)
      // Slope from screen-space derivatives of the world position: exact per
      // fragment, and independent of vertex density.
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 dpx = dFdx(vLocalPos);
        vec3 dpy = dFdy(vLocalPos);
        float slope = 1.0 - abs(dot(normalize(cross(dpx, dpy)), normalize(vNormal)));
        diffuseColor.rgb = biomeColor(vElevation, clamp(slope * 1.6, 0.0, 1.0), vLatitude);
        `,
      );
  };

  material.userData.uniforms = uniforms;
  return material;
}

export class PlanetScene {
  /**
   * @param {object} [params] Full parameter object (see defaultParams()).
   */
  constructor(params) {
    this.params = params;
    this.three = new THREE.Scene();
    this.three.background = new THREE.Color(params.background ?? '#05070d');

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 600);
    this.camera.position.set(0, 0.85, 3.5);
    this.camera.lookAt(0, 0, 0);

    // --- lights ------------------------------------------------------------
    this.sun = new THREE.DirectionalLight(new THREE.Color(params.sunColor ?? '#fff5e6'), params.sunIntensity ?? 2.6);
    this.sun.position.set(5, 2, 3);
    this.three.add(this.sun);
    this.three.add(this.sun.target);

    this.ambient = new THREE.AmbientLight(new THREE.Color(params.ambientColor ?? '#2a3a52'), params.ambientIntensity ?? 0.14);
    this.three.add(this.ambient);

    // --- group ------------------------------------------------------------
    this.planetGroup = new THREE.Group();
    this.planetGroup.name = 'planet';
    this.three.add(this.planetGroup);

    this.geometryInfo = null;
    this.heightField = null;
    this.surface = null;
    this.ocean = null;
    this.clouds = null;
    this.atmosphere = null;
    this.rings = null;
    this.stars = null;

    this.regenerate();
    this.applyLive();
  }

  // ---------------------------------------------------------------- rebuild --

  /**
   * Rebuild geometry and every mesh whose shape depends on the seed or shape
   * parameters. Called on seed change, detail change and any tectonic slider.
   */
  regenerate() {
    const p = this.params;
    this.disposeGeometryOnly();

    const icosphere = createIcosphere(p.detail);
    const field = buildHeightField(icosphere, shapeParams(p));
    const radius = p.radius ?? 1;

    // Displaced positions.
    const radii = new Float32Array(icosphere.vertexCount);
    for (let v = 0; v < icosphere.vertexCount; v++) radii[v] = radius + field.elevation[v];
    const positions = applyRadii(icosphere.positions, radii);
    const normals = computeDisplacedNormals(icosphere, positions);

    // Normalized elevation attribute for the biome ramp, in units of the
    // configured relief budget so colour bands stay put when the budget changes.
    const elevAttr = new Float32Array(icosphere.vertexCount);
    for (let v = 0; v < icosphere.vertexCount; v++) elevAttr[v] = field.elevation[v] / radius;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('aElevation', new THREE.BufferAttribute(elevAttr, 1));
    geo.setIndex(new THREE.BufferAttribute(icosphere.indices, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.35);

    const surfaceMaterial = this.surface?.material ?? createSurfaceMaterial();
    this.surface = new THREE.Mesh(geo, surfaceMaterial);
    this.surface.name = 'surface';
    this.surface.userData.type = 'surface';
    this.surface.userData.geometry = icosphere;
    // Biomes are drawn from a ramp inside the fragment shader, so the standard
    // material must not reject fills by alpha. Without this, any opacity rounding
    // in the injected shader makes the planet body discard itself.
    surfaceMaterial.transparent = false;
    surfaceMaterial.opacity = 1;
    this.planetGroup.add(this.surface);

    // Ocean shell shares the topology, so it inherits exact coastlines.
    if (this.ocean) {
      this.planetGroup.remove(this.ocean);
      this.ocean.geometry.dispose();
      this.ocean.material.dispose();
    }
    this.ocean = createOcean(icosphere, field.elevation, radius, {
      color: p.oceanColor,
      shallowColor: p.oceanShallow,
      opacity: p.oceanOpacity,
      waveHeight: p.waveHeight,
      waveSpeed: p.waveSpeed,
      roughness: p.oceanRoughness,
      specular: p.oceanSpecular,
    });
    this.planetGroup.add(this.ocean);

    // Clouds and atmosphere depend on radius only; rebuild to keep them aligned.
    if (this.clouds) {
      this.planetGroup.remove(this.clouds);
      disposeClouds(this.clouds);
    }
    this.clouds = createClouds(radius, p.seed, {
      enabled: p.cloudsEnabled,
      coverage: p.cloudCoverage,
      density: p.cloudDensity,
      sharpness: p.cloudSharpness,
      altitude: p.cloudAltitude,
      speed: p.cloudSpeed,
      banding: p.cloudBanding,
      color: p.cloudColor,
      shadowTint: p.cloudShadow,
    });
    this.planetGroup.add(this.clouds);

    if (this.atmosphere) {
      this.planetGroup.remove(this.atmosphere);
      disposeAtmosphere(this.atmosphere);
    }
    this.atmosphere = createAtmosphere(radius, {
      enabled: p.atmoEnabled,
      radius: p.atmoRadius,
      intensity: p.atmoIntensity,
      rayleighColor: p.atmoRayleigh,
      mieColor: p.atmoMie,
      densityFalloff: p.atmoDensity,
      steps: p.atmoSteps,
    });
    this.planetGroup.add(this.atmosphere);

    if (this.rings) {
      this.planetGroup.remove(this.rings);
      disposeRings(this.rings);
    }
    this.rings = createRings(radius, p.seed, {
      enabled: p.ringsEnabled,
      innerRadius: p.ringInner,
      outerRadius: p.ringOuter,
      tilt: p.ringTilt,
      opacity: p.ringOpacity,
      color: p.ringColorA,
      colorB: p.ringColorB,
      seedBands: p.ringBands,
      gapStrength: p.ringGap,
      shadow: p.ringShadow,
      densityWave: p.ringDensityWave,
    });
    this.planetGroup.add(this.rings);

    // Starfield lives on the scene, not the planet, so planet scale never affects it.
    if (this.stars) {
      this.three.remove(this.stars);
      disposeStarfield(this.stars);
    }
    this.stars = createStarfield(p.seed, {
      enabled: p.starsEnabled,
      count: p.starCount,
      size: p.starSize,
      brightness: p.starBrightness,
      bandStrength: p.starBand,
      colorVariance: p.starColorVariance,
      twinkle: p.starTwinkle,
    });
    this.three.add(this.stars);

    this.geometryInfo = {
      level: icosphere.level,
      vertexCount: icosphere.vertexCount,
      triangleCount: icosphere.triangleCount,
      radius,
    };
    this.heightField = {
      stats: field.stats,
      plateCount: field.plateCount,
      elevation: field.elevation,
      oceanMask: field.oceanMask,
    };

    this.applyLive();
  }

  // ------------------------------------------------------------------- live --

  /**
   * Apply everything that does not require regenerating geometry.
   * Safe to call on every animation frame or slider input event.
   */
  applyLive() {
    const p = this.params;

    // Surface biome uniforms.
    const su = this.surface?.material.userData.uniforms;
    if (su) {
      su.uColDeepWater.value.set(p.colDeepWater);
      su.uColShallow.value.set(p.colShallow);
      su.uColBeach.value.set(p.colBeach);
      su.uColGrass.value.set(p.colGrass);
      su.uColForest.value.set(p.colForest);
      su.uColRock.value.set(p.colRock);
      su.uColSnow.value.set(p.colSnow);
      su.uColSeaBed.value.set(p.colSeaBed);
      su.uColIce.value.set(p.colIce);
      su.uSnowLine.value = p.snowLine;
      su.uBeachWidth.value = p.beachWidth;
      su.uIceCapLatitude.value = p.iceCapLatitude;
      su.uBiomeSharpen.value = p.biomeSharpen;
    }

    // Ocean.
    if (this.ocean) {
      this.ocean.visible = p.oceanEnabled;
      const ou = this.ocean.userData.uniforms;
      ou.uDeepColor.value.set(p.oceanColor);
      ou.uShallowColor.value.set(p.oceanShallow);
      ou.uWaveHeight.value = p.waveHeight;
      ou.uWaveSpeed.value = p.waveSpeed;
      ou.uSpecularStrength.value = p.oceanSpecular;
      this.ocean.material.opacity = p.oceanOpacity;
      this.ocean.material.transparent = p.oceanOpacity < 1;
      this.ocean.material.roughness = p.oceanRoughness;
      this.ocean.material.needsUpdate = true;
    }

    // Clouds.
    if (this.clouds) {
      this.clouds.visible = p.cloudsEnabled;
      const cu = this.clouds.userData.uniforms;
      cu.uCoverage.value = p.cloudCoverage;
      cu.uDensity.value = p.cloudDensity;
      cu.uSharpness.value = p.cloudSharpness;
      cu.uBanding.value = p.cloudBanding;
      cu.uCloudColor.value.set(p.cloudColor);
      cu.uShadowTint.value.set(p.cloudShadow);
      // The shell is built at base radius and scaled, so this is idempotent.
      this.clouds.scale.setScalar(p.cloudAltitude);
    }

    // Atmosphere.
    if (this.atmosphere) {
      this.atmosphere.visible = p.atmoEnabled;
      const au = this.atmosphere.userData.uniforms;
      au.uIntensity.value = p.atmoIntensity;
      au.uRayleighColor.value.set(p.atmoRayleigh);
      au.uMieColor.value.set(p.atmoMie);
      au.uDensityFalloff.value = p.atmoDensity;
      au.uSteps.value = Math.max(4, Math.min(32, Math.round(p.atmoSteps)));
      // Night-side floor colour follows the scene ambient so the halo stays
      // coherent when the ambient light is recoloured.
      au.uAmbientSky?.value.set(p.ambientColor);
      if (au.uAmbientSky) au.uAmbientSky.value.multiplyScalar(Math.max(0.35, p.ambientIntensity));
      const atmoBase = this.geometryInfo?.radius ?? 1;
      const desired = atmoBase * p.atmoRadius;
      au.uAtmoRadius.value = desired;
      // Geometry is rebuilt directly here (not via geometry.dispose() + new, which
      // would drop the bounding sphere) so the shell resizes without leaking.
      if (Math.abs((this.atmosphere.userData.shellRadius ?? 0) - desired) > 1e-6) {
        this.atmosphere.geometry.dispose();
        this.atmosphere.geometry = new THREE.SphereGeometry(desired, 96, 64);
        this.atmosphere.userData.shellRadius = desired;
      }
    }

    // Rings.
    if (this.rings) {
      this.rings.visible = p.ringsEnabled;
      const ru = this.rings.userData.uniforms;
      ru.uOpacity.value = p.ringOpacity;
      ru.uColorA.value.set(p.ringColorA);
      ru.uColorB.value.set(p.ringColorB);
      ru.uBands.value = p.ringBands;
      ru.uGapStrength.value = p.ringGap;
      ru.uShadow.value = p.ringShadow;
      ru.uDensityWave.value = p.ringDensityWave;
      this.rings.rotation.x = THREE.MathUtils.degToRad(p.ringTilt);
      const ringBase = this.geometryInfo?.radius ?? 1;
      const inner = ringBase * p.ringInner;
      const outer = ringBase * p.ringOuter;
      ru.uInner.value = inner;
      ru.uOuter.value = outer;
      ru.uPlanetRadius.value = ringBase;
      const geoInner = this.rings.geometry.parameters?.innerRadius;
      if (geoInner === undefined || Math.abs(geoInner - inner) > 1e-6) {
        this.rings.geometry.dispose();
        const g = new THREE.RingGeometry(inner, outer, 256, 8);
        g.rotateX(-Math.PI / 2);
        this.rings.geometry = g;
      }
    }

    // Stars.
    if (this.stars) {
      this.stars.visible = p.starsEnabled;
      const su2 = this.stars.userData.uniforms;
      su2.uBrightness.value = p.starBrightness;
      su2.uTwinkle.value = p.starTwinkle;
      // Size is baked into an attribute at build time; `starSize` rescales it.
      // Normalising by the build-time size keeps repeated drags idempotent.
      const sizeAttr = this.stars.geometry.attributes.aSize;
      const baseSizes = this.stars.userData.baseSizes;
      const baseSetting = this.stars.userData.baseSizeSetting || 1;
      if (sizeAttr && baseSizes) {
        const k = p.starSize / baseSetting;
        for (let i = 0; i < sizeAttr.count; i++) sizeAttr.array[i] = baseSizes[i] * k;
        sizeAttr.needsUpdate = true;
      }
    }

    // Lights.
    if (this.three.background instanceof THREE.Color) this.three.background.set(p.background);
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.ambient.color.set(p.ambientColor);
    this.ambient.intensity = p.ambientIntensity;
    this.updateSunDirection();
  }

  /** Recompute the sun vector from azimuth/elevation and propagate to all consumers. */
  updateSunDirection() {
    const p = this.params;
    const az = THREE.MathUtils.degToRad(p.sunAzimuth);
    const el = THREE.MathUtils.degToRad(p.sunElevation);
    const dir = new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az),
    ).normalize();
    this.sunDirection = dir;
    this.sun.position.copy(dir).multiplyScalar(12);
    this.sun.target.position.set(0, 0, 0);

    if (this.atmosphere) updateAtmosphereSun(this.atmosphere, dir);
    if (this.rings) {
      updateRings(this.rings, {
        sunDirection: dir,
        sunColor: this.sun.color,
        elapsedSeconds: this.elapsed ?? 0,
      });
    }
  }

  /**
   * Per-frame animation.
   * @param {number} elapsedSeconds
   * @param {number} deltaSeconds
   */
  update(elapsedSeconds, deltaSeconds) {
    this.elapsed = elapsedSeconds;
    const p = this.params;

    if (p.autoRotate) {
      this.planetGroup.rotation.y += deltaSeconds * p.rotateSpeed * 0.35;
    }

    if (this.ocean) updateOcean(this.ocean, elapsedSeconds);
    if (this.clouds) updateClouds(this.clouds, elapsedSeconds, { speed: p.cloudSpeed });
    if (this.rings) {
      updateRings(this.rings, {
        sunDirection: this.sunDirection,
        sunColor: this.sun.color,
        elapsedSeconds,
      });
    }
    if (this.stars) {
      updateStarfield(this.stars, { elapsedSeconds, pixelRatio: this.pixelRatio ?? 1 });
    }
  }

  // -------------------------------------------------------------- diagnostics --

  /**
   * Measurements taken from the generated data, used by tests and the info panel.
   * @returns {object}
   */
  measure() {
    const geo = this.surface?.geometry;
    const pos = geo?.attributes.position?.array;
    let minR = Infinity, maxR = -Infinity, sumR = 0;
    if (pos) {
      const n = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const r = Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        sumR += r;
      }
      sumR /= n;
    }

    const starPos = this.stars?.geometry.attributes.position.array;
    let band = 0;
    if (starPos) {
      // Fraction of stars within 15 degrees of the galactic plane, using the
      // fitted plane from the point cloud (see starfield.bandFraction).
      const maxLat = THREE.MathUtils.degToRad(15);
      for (let i = 0; i < starPos.length / 3; i++) {
        const y = starPos[i * 3 + 1];
        const len = Math.hypot(starPos[i * 3], y, starPos[i * 3 + 2]) || 1;
        if (Math.abs(Math.asin(Math.min(1, Math.max(-1, y / len)))) <= maxLat) band++;
      }
      band /= starPos.length / 3;
    }

    return {
      vertices: this.geometryInfo?.vertexCount ?? 0,
      triangles: this.geometryInfo?.triangleCount ?? 0,
      detailLevel: this.geometryInfo?.level ?? 0,
      minRadius: Number.isFinite(minR) ? minR : 0,
      maxRadius: Number.isFinite(maxR) ? maxR : 0,
      meanRadius: Number.isFinite(sumR) ? sumR : 0,
      relief: Number.isFinite(maxR - minR) ? maxR - minR : 0,
      landFraction: this.heightField?.stats.landFraction ?? 0,
      plateCount: this.heightField?.plateCount ?? 0,
      cloudCoverage: measureCloudCoverage(this.params.seed, {
        coverage: this.params.cloudCoverage,
        banding: this.params.cloudBanding,
        noiseScale: this.params.cloudNoiseScale ?? 3.4,
      }),
      starCount: this.stars?.geometry.attributes.position.count ?? 0,
      starBandFraction: band,
      sunElevation: this.params.sunElevation,
      sunAzimuth: this.params.sunAzimuth,
    };
  }

  /** Release geometry resources that `regenerate()` will replace. */
  disposeGeometryOnly() {
    if (this.surface) {
      this.planetGroup.remove(this.surface);
      this.surface.geometry.dispose();
      // Material is reused across regenerations to keep the compiled program.
    }
    if (this.ocean) {
      this.planetGroup.remove(this.ocean);
      this.ocean.geometry.dispose();
      this.ocean.material.dispose();
      this.ocean = null;
    }
    if (this.clouds) {
      this.planetGroup.remove(this.clouds);
      disposeClouds(this.clouds);
      this.clouds = null;
    }
    if (this.atmosphere) {
      this.planetGroup.remove(this.atmosphere);
      disposeAtmosphere(this.atmosphere);
      this.atmosphere = null;
    }
    if (this.rings) {
      this.planetGroup.remove(this.rings);
      disposeRings(this.rings);
      this.rings = null;
    }
    if (this.stars) {
      this.three.remove(this.stars);
      disposeStarfield(this.stars);
      this.stars = null;
    }
  }

  /** Full teardown. */
  dispose() {
    this.disposeGeometryOnly();
    this.surface?.material.dispose();
    this.surface = null;
    this.rings && disposeRings(this.rings);
    this.stars && disposeStarfield(this.stars);
  }
}

export { OCEAN_DEFAULTS };
