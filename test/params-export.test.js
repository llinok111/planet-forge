/**
 * Parameter schema, URL encoding and export-serialisation tests.
 *
 * The parameter table drives the UI, the URL and the exports, so a defect here
 * shows up as "a slider that does nothing" or "a share link that restores a
 * different planet".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAMS,
  GROUPS,
  defaultParams,
  paramDef,
  encodeParams,
  decodeParams,
  shapeParams,
} from '../src/params.js';
import { measureCloudCoverage, sampleCloudField, coverageToThreshold, CLOUD_DEFAULTS } from '../src/clouds.js';
import { createStarfield, bandFraction } from '../src/starfield.js';

// -------------------------------------------------------------------- schema --

test('params: every key is unique', () => {
  const keys = PARAMS.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate parameter key');
});

test('params: every parameter belongs to a declared group', () => {
  const groupIds = new Set(GROUPS.map((g) => g.id));
  for (const p of PARAMS) assert.ok(groupIds.has(p.group), `${p.key} has unknown group ${p.group}`);
});

test('params: every group has at least one parameter', () => {
  for (const g of GROUPS) {
    const count = PARAMS.filter((p) => p.group === g.id).length;
    assert.ok(count > 0, `group ${g.id} is empty and would render as a dead section`);
  }
});

test('params: range definitions are self-consistent', () => {
  for (const p of PARAMS.filter((d) => d.type === 'range')) {
    assert.ok(typeof p.min === 'number' && typeof p.max === 'number', `${p.key} missing bounds`);
    assert.ok(p.min < p.max, `${p.key} has min >= max`);
    assert.ok(typeof p.step === 'number' && p.step > 0, `${p.key} has invalid step`);
    assert.ok(p.default >= p.min && p.default <= p.max, `${p.key} default outside range`);
    // Defaults must land on the step grid, otherwise the slider snaps on first paint
    // and the value silently changes.
    const steps = (p.default - p.min) / p.step;
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${p.key} default not on step grid`);
  }
});

test('params: colour defaults are valid hex', () => {
  for (const p of PARAMS.filter((d) => d.type === 'color')) {
    assert.match(p.default, /^#[0-9a-fA-F]{6}$/, `${p.key} default "${p.default}"`);
  }
});

test('params: seed parameter is marked as requiring a rebuild', () => {
  assert.equal(paramDef('seed').rebuild, true);
  assert.equal(paramDef('detail').rebuild, true);
  // A colour must never force a geometry rebuild.
  assert.ok(!paramDef('colGrass').rebuild);
});

test('params: defaultParams returns every key with its default', () => {
  const d = defaultParams();
  for (const p of PARAMS) assert.deepEqual(d[p.key], p.default, p.key);
  assert.equal(Object.keys(d).length, PARAMS.length);
});

test('params: shapeParams forwards exactly the rebuild keys', () => {
  const d = defaultParams();
  const shape = shapeParams(d);
  const rebuildKeys = PARAMS.filter((p) => p.rebuild).map((p) => p.key);
  for (const key of rebuildKeys) assert.ok(key in shape, `shapeParams missing ${key}`);
  // And nothing that is not a rebuild key.
  assert.ok(!('colGrass' in shape));
  assert.ok(!('sunAzimuth' in shape));
});

// ------------------------------------------------------------------- encoding --

test('encode/decode: round-trips a mutated parameter set', () => {
  const p = defaultParams();
  p.seed = 'round-trip';
  p.detail = 4;
  p.plateCount = 23;
  p.continentBias = 0.66;
  p.colGrass = '#123456';
  p.cloudsEnabled = false;
  p.sunAzimuth = 271;

  const query = encodeParams(p);
  const back = decodeParams(query);

  assert.equal(back.seed, 'round-trip');
  assert.equal(back.detail, 4);
  assert.equal(back.plateCount, 23);
  assert.ok(Math.abs(back.continentBias - 0.66) < 1e-9);
  assert.equal(back.colGrass, '#123456');
  assert.equal(back.cloudsEnabled, false);
  assert.equal(back.sunAzimuth, 271);
});

test('encode: defaults are omitted to keep URLs short', () => {
  const query = encodeParams(defaultParams());
  assert.equal(query, '', 'default params should produce an empty query string');
});

test('encode: colours drop the hash prefix', () => {
  const p = defaultParams();
  p.colSnow = '#abcdef';
  const query = encodeParams(p);
  assert.ok(query.includes('colSnow=abcdef'));
  assert.ok(!query.includes('%23'), 'hash should not be percent-encoded into the URL');
});

test('decode: unknown keys are ignored and missing keys fall back to defaults', () => {
  const back = decodeParams('totallyUnknown=1&seed=custom');
  assert.equal(back.seed, 'custom');
  assert.equal(back.detail, paramDef('detail').default);
  assert.equal(back.totallyUnknown, undefined);
});

test('decode: out-of-range numbers are clamped, not trusted', () => {
  const back = decodeParams('detail=99&continentBias=-5');
  assert.equal(back.detail, paramDef('detail').max);
  assert.equal(back.continentBias, paramDef('continentBias').min);
});

test('decode: malformed numbers fall back to the default', () => {
  const back = decodeParams('detail=abc');
  assert.equal(back.detail, paramDef('detail').default);
});

test('decode: toggles accept true/1 and false/0', () => {
  assert.equal(decodeParams('cloudsEnabled=true').cloudsEnabled, true);
  assert.equal(decodeParams('cloudsEnabled=1').cloudsEnabled, true);
  assert.equal(decodeParams('cloudsEnabled=false').cloudsEnabled, false);
  assert.equal(decodeParams('cloudsEnabled=0').cloudsEnabled, false);
});

test('decode: colour without a hash gets one', () => {
  assert.equal(decodeParams('colSnow=ff0000').colSnow, '#ff0000');
  assert.equal(decodeParams('colSnow=%23ff0000').colSnow, '#ff0000');
});

test('decode: a URL with no query yields full defaults', () => {
  assert.deepEqual(decodeParams(''), defaultParams());
  assert.deepEqual(decodeParams('?'), defaultParams());
});

// -------------------------------------------------------------------- clouds --

test('clouds: coverage maps to the requested sky fraction almost exactly', () => {
  for (const coverage of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const measured = measureCloudCoverage('cloud-test', { coverage });
    assert.ok(
      Math.abs(measured - coverage) < 0.02,
      `coverage ${coverage} measured ${measured.toFixed(3)}`,
    );
  }
});

test('clouds: coverage is monotonic and spans zero to all sky', () => {
  const values = [0.05, 0.25, 0.5, 0.75, 0.98].map((c) =>
    measureCloudCoverage('mono-cloud', { coverage: c }),
  );
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1], `coverage not increasing: ${values}`);
  }
  assert.ok(values[0] < 0.1);
  assert.ok(values[values.length - 1] > 0.9);
});

test('clouds: the field distribution is deterministic per seed', () => {
  const a = sampleCloudField('cloud-seed', {}, 512);
  const b = sampleCloudField('cloud-seed', {}, 512);
  assert.deepEqual(Array.from(a), Array.from(b));
  const c = sampleCloudField('other-seed', {}, 512);
  assert.notDeepEqual(Array.from(a), Array.from(c));
});

test('clouds: threshold is inside the sampled distribution', () => {
  const field = sampleCloudField('threshold', {}, 1024);
  const t = coverageToThreshold(field, 0.5);
  assert.ok(t >= field[0] && t <= field[field.length - 1], `threshold ${t} outside [${field[0]}, ${field[field.length - 1]}]`);
});

test('clouds: banding reduces total coverage at equal threshold', () => {
  // Banding multiplies the field down near the poles, so more of the sky falls
  // below a fixed threshold.
  const noBand = measureCloudCoverage('banding', { coverage: 0.5, banding: 0 });
  const heavyBand = measureCloudCoverage('banding', { coverage: 0.5, banding: 1 });
  assert.ok(heavyBand <= noBand + 1e-9, `${noBand} -> ${heavyBand}`);
  assert.ok(CLOUD_DEFAULTS.banding >= 0 && CLOUD_DEFAULTS.banding <= 1);
});

// ------------------------------------------------------------------- stars --

test('starfield: star count is respected and positions are seeded', () => {
  const s = createStarfield('star-test', { count: 2000 });
  assert.equal(s.geometry.attributes.position.count, 2000);
  const a = Array.from(s.geometry.attributes.position.array.slice(0, 30));
  const s2 = createStarfield('star-test', { count: 2000 });
  assert.deepEqual(Array.from(s2.geometry.attributes.position.array.slice(0, 30)), a);
});

test('starfield: bandStrength clusters stars toward the plane', () => {
  const width = 0.35; // 20 degrees
  const loose = createStarfield('band', { count: 4000, bandStrength: 0.1 });
  const tight = createStarfield('band', { count: 4000, bandStrength: 0.95 });
  const looseFrac = bandFraction(loose.geometry.attributes.position.array, width, loose.userData.galacticNormal);
  const tightFrac = bandFraction(tight.geometry.attributes.position.array, width, tight.userData.galacticNormal);
  assert.ok(tightFrac > looseFrac, `band strength did not cluster stars: ${looseFrac} -> ${tightFrac}`);
});

test('starfield: all stars lie on the configured sphere radius', () => {
  const s = createStarfield('radius', { count: 500, radius: 120 });
  const p = s.geometry.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) {
    const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
    assert.ok(Math.abs(r - 120) < 1e-3, `star at radius ${r}`);
  }
});
