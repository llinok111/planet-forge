/**
 * Uniform declaration guard.
 *
 * Real defect this test exists for: `uAmbientSky` was added to a material's
 * uniform dictionary and read inside the fragment shader, but its `uniform vec3`
 * declaration was never inserted into the GLSL. The shader failed to compile, the
 * whole atmosphere silently disappeared, and every pixel-level assertion still
 * passed because the atmosphere is only part of the frame. A compile failure that
 * does not break the build is the most expensive kind, so it is checked statically
 * here — before any browser is involved.
 *
 * The rule: for every shader source in `src/`, every identifier that the GLSL body
 * reads as a uniform must be declared either in the GLSL itself or supplied as a
 * key in the accompanying uniforms object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Walk the source tree and return every .js file.
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Extract template literals that look like GLSL (contain `void main` or `#include`).
 * @param {string} source
 * @returns {string[]}
 */
function glslLiterals(source) {
  const bt = String.fromCharCode(96);
  const literals = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] !== bt) { i++; continue; }
    let j = i + 1;
    let buf = '';
    while (j < source.length) {
      if (source[j] === '\\') { buf += source[j + 1] ?? ''; j += 2; continue; }
      if (source[j] === bt) break;
      buf += source[j];
      j++;
    }
    if (/void\s+main|#include</.test(buf)) literals.push(buf);
    i = j + 1;
  }
  return literals;
}

/** Uniform names referenced in a GLSL body. */
function referencedUniforms(glsl) {
  const names = new Set();
  const re = /(?<![\w.])u[A-Z][A-Za-z0-9_]*/g;
  let m;
  while ((m = re.exec(glsl))) names.add(m[0]);
  return names;
}

/** Uniform names declared in a GLSL body. */
function declaredUniforms(glsl) {
  const names = new Set();
  const re = /uniform\s+\w+\s+(u[A-Z][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(glsl))) names.add(m[1]);
  return names;
}

const FILES = jsFiles(join(process.cwd(), 'src'));

test('着色器：每个被引用的 uniform 都在 GLSL 中声明', () => {
  const problems = [];

  for (const file of FILES) {
    const source = readFileSync(file, 'utf8');
    const literals = glslLiterals(source);
    if (literals.length === 0) continue;

    // Declarations may be spread across literals (e.g. vertex vs fragment shader),
    // and may be inserted by string replacement, so collect the union per file plus
    // the literal text of any `uniform ...` lines anywhere in the file.
    const declared = new Set();
    for (const l of literals) for (const n of declaredUniforms(l)) declared.add(n);
    // Also pick up declarations that appear in injected snippets passed to .replace().
    for (const m of source.matchAll(/uniform\s+\w+\s+(u[A-Z][A-Za-z0-9_]*)/g)) declared.add(m[1]);

    for (const l of literals) {
      for (const name of referencedUniforms(l)) {
        if (declared.has(name)) continue;
        // Ignore names that are clearly not this project's uniforms.
        problems.push(`${file.replace(process.cwd(), '.')}: "${name}" 被引用但未声明`);
      }
    }
  }

  assert.deepEqual(problems, [], `未声明的 uniform：\n${problems.join('\n')}`);
});

test('着色器：material 的 uniforms 对象与 GLSL 名称一致（无拼写漂移）', () => {
  // A uniform supplied with a typo'd name is invisible: three.js uploads it and the
  // shader never reads it. Checking the reverse direction catches that.
  const problems = [];
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8');
    const literals = glslLiterals(source);
    if (literals.length === 0) continue;

    const referenced = new Set();
    for (const l of literals) for (const n of referencedUniforms(l)) referenced.add(n);

    // Uniform dictionary keys look like `uSomething: { value: ... }`.
    const keys = new Set();
    for (const m of source.matchAll(/^\s*(u[A-Z][A-Za-z0-9_]*)\s*:\s*\{\s*value/gm)) keys.add(m[1]);

    for (const key of keys) {
      if (!referenced.has(key)) {
        problems.push(`${file.replace(process.cwd(), '.')}: uniform "${key}" 已定义但 GLSL 从未引用`);
      }
    }
  }
  assert.deepEqual(problems, [], `未被引用的 uniform：\n${problems.join('\n')}`);
});

test('着色器：GLSL 中不出现 JS 模板插值残留', () => {
  // `${` inside a GLSL literal that was meant to be literal GLSL is always a bug.
  const problems = [];
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8');
    for (const l of glslLiterals(source)) {
      if (l.includes('${')) problems.push(file.replace(process.cwd(), '.'));
    }
  }
  assert.deepEqual([...new Set(problems)], [], `GLSL 中出现模板插值残留：${problems.join(', ')}`);
});
