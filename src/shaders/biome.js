/**
 * GLSL shared between the planet surface and the ocean.
 *
 * Colours are defined once in linear-ish sRGB and converted at the boundary, so
 * the surface, the ocean and the polar caps all agree on what "this green" means.
 */

/**
 * Biome ramp applied per fragment from elevation and slope.
 *
 * Doing this on the GPU (rather than baking a texture) is deliberate: the ramp
 * stays crisp at any zoom level, responds instantly to parameter changes, and
 * costs no memory proportional to the planet's resolution. The vertex attribute
 * `aElev` carries the normalized elevation; slope comes from `dFdx`/`dFdy` on the
 * world position, so it is correct even between vertices.
 */
export const BIOME_FRAGMENT = /* glsl */ `
uniform vec3 uColDeepWater;
uniform vec3 uColShallow;
uniform vec3 uColBeach;
uniform vec3 uColGrass;
uniform vec3 uColForest;
uniform vec3 uColRock;
uniform vec3 uColSnow;
uniform vec3 uColSeaBed;
uniform vec3 uColIce;
uniform float uSnowLine;
uniform float uBeachWidth;
uniform float uIceCapLatitude;
uniform float uBiomeSharpen;

varying float vElevation;
varying float vLatitude;
varying vec3 vLocalPos;

vec3 elevationRamp(float e, float slope) {
  // Below sea level: sea bed, only visible through translucent water.
  if (e < 0.0) {
    float depth = clamp(-e / 0.06, 0.0, 1.0);
    return mix(uColShallow, uColSeaBed, smoothstep(0.0, 1.0, depth));
  }
  // Beach sits right at the waterline and is deliberately narrow, otherwise
  // every coast reads as a sand belt from orbit.
  float beach = smoothstep(0.0, uBeachWidth, e);
  vec3 land = mix(uColBeach, uColGrass, beach);

  // Vegetation band, then forest, then bare rock as altitude climbs.
  float veg = smoothstep(uBeachWidth, uBeachWidth * 3.5, e);
  land = mix(land, uColForest, veg);

  float rock = smoothstep(uSnowLine * 0.45, uSnowLine * 0.85, e);
  land = mix(land, uColRock, rock);

  // Snow on high ground, but only where the ground is not a sheer cliff.
  float snowAlt = smoothstep(uSnowLine, uSnowLine * 1.25, e);
  float snowFlat = 1.0 - smoothstep(0.35, 0.75, slope);
  land = mix(land, uColSnow, snowAlt * mix(0.55, 1.0, snowFlat));

  // Steep faces turn to rock regardless of altitude; this is what makes ridges read.
  float cliff = smoothstep(0.35, 0.7, slope);
  land = mix(land, uColRock, cliff * 0.75);

  return land;
}

vec3 biomeColor(float e, float slope, float lat) {
  vec3 c = elevationRamp(e, slope);

  // Polar caps: latitude is |sin| of the angle from the equator, so the term is
  // symmetric north/south and the cap boundary is a clean circle.
  float polar = smoothstep(uIceCapLatitude, uIceCapLatitude + 0.08, lat);
  // Ice only forms on land above sea level; oceanic poles stay water.
  polar *= step(0.0, e);
  c = mix(c, uColIce, polar);

  // Slight contrast boost so the bands do not look muddy under strong sunlight.
  c = mix(c, c * c * (3.0 - 2.0 * c), uBiomeSharpen);
  return c;
}
`;

/** Vertex-side varyings shared by surface and ocean. */
export const BIOME_VERTEX = /* glsl */ `
attribute float aElevation;
varying float vElevation;
varying float vLatitude;
varying vec3 vLocalPos;
`;

export const BIOME_VERTEX_BODY = /* glsl */ `
vElevation = aElevation;
vLatitude = abs(normalize(position).y);
vLocalPos = position;
`;
