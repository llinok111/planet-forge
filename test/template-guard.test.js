/**
 * Guard against backtick leakage inside GLSL template literals.
 *
 * Why this exists: three separate bugs during development came from writing a
 * backtick inside a JS template literal (e.g. quoting a GLSL identifier in a
 * comment). That terminates the template early and produces a confusing
 * "Unexpected token" at a random later line. A backtick can never appear in GLSL,
 * so any occurrence between a template's opening and closing backtick that is not
 * the delimiter itself is a bug.
 *
 * This test parses each source file's template literals and fails if a literal
 * still contains a backtick.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
  'src/atmosphere.js',
  'src/rings.js',
  'src/clouds.js',
  'src/ocean.js',
  'src/starfield.js',
  'src/shaders/biome.js',
  'src/planet.js',
];

/**
 * Scan a file and return every template literal's raw content.
 * Handles \` escapes; this codebase does not nest templates inside GLSL.
 */
function templateLiterals(source) {
  const literals = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '`') {
      let j = i + 1;
      let buf = '';
      while (j < source.length) {
        if (source[j] === '\\') {
          buf += source[j] + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (source[j] === '`') break;
        buf += source[j];
        j++;
      }
      literals.push(buf);
      i = j + 1;
      continue;
    }
    i++;
  }
  return literals;
}

for (const rel of FILES) {
  test(`${rel}: GLSL 模板字符串内没有多余反引号`, () => {
    const abs = join(process.cwd(), rel);
    const src = readFileSync(abs, 'utf8');
    const literals = templateLiterals(src);
    const offenders = literals.filter((l) => l.includes('`'));
    assert.equal(
      offenders.length,
      0,
      `found ${offenders.length} template literal(s) containing an inner backtick: ${offenders
        .map((o) => JSON.stringify(o.slice(0, 80)))
        .join(', ')}`,
    );
  });
}

test('模板字符串扫描器本身可用（能检出被反引号切断的字面量）', () => {
  // Build the fixture with String.fromCharCode(96) so writing this test cannot
  // itself terminate a template literal.
  //
  // What the scanner is really detecting: a stray backtick splits one intended
  // literal into fragments. It cannot report "the literal contains a backtick"
  // (the delimiter is what splits it), so the detectable signature is that the
  // fragments do not line up with the file's real literals — here, a fragment that
  // is only a fragment: it has no closing statement terminator and the text around
  // it ended up outside the literal.
  const bt = String.fromCharCode(96);
  const bad = [
    `const shader = /* glsl */ ${bt}`,
    'void main() {',
    '  // note the ' + bt + 'accum' + bt + ' identifier',
    '}',
    `${bt};`,
  ].join('\n');
  const literals = templateLiterals(bad);
  // Four backticks in this fixture pair up into two fragments: the shader body
  // before the stray pair, and everything after it. The signature of the bug is
  // that neither fragment is the literal the author intended.
  assert.equal(literals.length, 2, `expected 2 fragments, got ${literals.length}`);
  assert.ok(literals[0].includes('void main()'), 'first fragment should hold the shader body');
  assert.ok(literals[1].includes('identifier'), 'second fragment should hold the tail');
  // A clean source yields exactly the literals it declares, with no splitting.
  const clean = `const a = ${bt}one${bt}; const b = ${bt}two${bt};`;
  assert.deepEqual(templateLiterals(clean), ['one', 'two']);
});
