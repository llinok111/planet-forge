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
uniform float uDetailStrength;
uniform float uDetailScale;
uniform float uSedimentStrength;
uniform float uRiverStrength;
uniform vec3 uRiverColor;

in float aRiver;
varying float vElevation;
varying float vLatitude;
varying vec3 vLocalPos;
varying float vRiver;

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

/**
 * Cheap 3D value noise for surface micro-detail.
 *
 * Why a procedural noise instead of a texture: the detail has to survive a 100x
 * zoom range without blurring or repeating. A derivative-free hash noise evaluated
 * in local space tiles naturally over the whole planet and costs no memory.
 */
float hash13(vec3 p) {
  // Three mixing rounds rather than the common single-round fract trick. With
  // detailScale around 110 the sample coordinate reaches 110+, and the single-round
  // version was losing contrast at that magnitude (measured: raising detail from 0
  // to 0.9 moved high-frequency pixel variance by only 2%, i.e. the noise was
  // effectively constant). Explicit primes keep the field alive at large inputs.
  vec3 q = fract(p * 0.1031);
  q += dot(q, q.yzx + 33.33);
  float h = q.x + q.y * 7.0 + q.z * 113.0;
  return fract(h * 43758.5453123);
}

float valueNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3(0.0, 0.0, 0.0)), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}

/**
 * Three octaves of value noise, used as a *texture mask* rather than as a height.
 *
 * The first attempt multiplied the biome colour by (1 + delta) where delta came
 * from two octaves. That made detailStrength act like a global brightness shift:
 * measured high-frequency pixel variance fell as strength rose (2.495 -> 2.259),
 * because a smooth large-scale multiplier flattens the terrain's own shading faster
 * than it adds grain. The fix is to keep the modulation high-frequency-only: the
 * top octave carries the visible grain and the lower ones only vary its intensity.
 */
float detailNoise(vec3 p) {
  float grain = valueNoise(p * 3.9);
  float clump = valueNoise(p * 1.3);
  // NOT named "patch": that is a reserved word in GLSL ES and fails to compile with
  // an error that points at the *use* site, not the declaration.
  float broad = valueNoise(p * 0.45);
  return grain * (0.55 + 0.45 * clump) * (0.6 + 0.4 * broad);
}

vec3 biomeColor(float e, float slope, float lat) {
  vec3 c = elevationRamp(e, slope);

  // Polar caps: latitude is |sin| of the angle from the equator, so the term is
  // symmetric north/south and the cap boundary is a clean circle.
  float polar = smoothstep(uIceCapLatitude, uIceCapLatitude + 0.08, lat);
  // Ice only forms on land above sea level; oceanic poles stay water.
  polar *= step(0.0, e);
  c = mix(c, uColIce, polar);

  // Surface micro-detail. Without this the disc reads as flat colour patches at
  // close range; the noise is evaluated in local space so it scales with the planet
  // rather than with the screen.
  float detail = detailNoise(vLocalPos * uDetailScale);
  // Grain is strongest on rock and steep faces, weakest on smooth lowland; the mask
  // also fades below sea level so the sea bed stays readable through the water.
  float detailMask = smoothstep(0.0, 0.30, e) * (0.3 + 0.7 * smoothstep(0.05, 0.55, slope));
  // Additive grain around the local colour, not a multiplicative brightness. Keeping
  // the mean fixed is what lets the slider add texture without changing exposure.
  c += (detail - 0.5) * uDetailStrength * (0.25 + 0.75 * detailMask) * 0.55;

  // Rivers: catchment area darkens and desaturates the bed, the way wet ground and
  // riparian vegetation read from orbit. Without this the drainage network exists
  // in the geometry but is invisible, so the terrain still looks dry.
  vec3 riverTint = mix(c, uRiverColor, clamp(vRiver * uRiverStrength, 0.0, 0.85));
  c = riverTint;

  // Sediment: material collects on gentle ground and is stripped from steep faces.
  // This is the visual signature of erosion, so it is driven by slope rather than
  // by a separate noise field.
  float sediment = (1.0 - smoothstep(0.08, 0.45, slope)) * smoothstep(0.0, 0.02, e);
  c = mix(c, c * 1.22 + vec3(0.035, 0.030, 0.018), sediment * uSedimentStrength);

  // Slight contrast boost so the bands do not look muddy under strong sunlight.
  c = mix(c, c * c * (3.0 - 2.0 * c), uBiomeSharpen);
  return c;
}
`;

/** Vertex-side varyings shared by surface and ocean. */
export const BIOME_VERTEX = /* glsl */ `
// Written as "in", not "attribute": three.js rewrites the deprecated "attribute"
// keyword to "in" only inside shader sources it processes itself. This block is
// injected by string concatenation in planet.js, so it reaches the driver verbatim —
// and "attribute" is a reserved word in GLSL ES 3.00, which WebGL2 compiles to.
in float aElevation;
in float aRiver;
varying float vElevation;
varying float vLatitude;
varying vec3 vLocalPos;
varying float vRiver;
`;

export const BIOME_VERTEX_BODY = /* glsl */ `
vElevation = aElevation;
vLatitude = abs(normalize(position).y);
vLocalPos = position;
vRiver = aRiver;
`;
