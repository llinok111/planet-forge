/**
 * Parameter panel, driven entirely by the schema in params.js.
 *
 * Behaviour that matters for the demo:
 *   - Shape sliders are debounced and regenerate geometry; live sliders apply
 *     immediately on `input` so dragging feels direct.
 *   - Regeneration is synchronous but wrapped so the loading overlay can paint
 *     first. Without that, L6 regeneration freezes the page with no feedback.
 */

import { GROUPS, PARAMS } from './params.js';

const REBUILD_DEBOUNCE_MS = 90;

/**
 * @param {HTMLElement} root
 * @param {object} params Live parameter object (mutated in place).
 * @param {{onRebuild: Function, onLive: Function, onSeedChange: Function}} handlers
 * @returns {{syncFromParams: Function, setBusy: Function}}
 */
export function createPanel(root, params, handlers) {
  const openState = new Map();
  for (const g of GROUPS) openState.set(g.id, g.id === 'shape' || g.id === 'light');

  const rebuildTimers = new Map();

  function scheduleRebuild(def) {
    const existing = rebuildTimers.get(def.key);
    if (existing) clearTimeout(existing);
    rebuildTimers.set(
      def.key,
      setTimeout(() => {
        rebuildTimers.delete(def.key);
        handlers.onRebuild(def.key);
      }, REBUILD_DEBOUNCE_MS),
    );
  }

  function render() {
    root.innerHTML = '';
    for (const group of GROUPS) {
      const section = document.createElement('section');
      section.className = 'group';
      section.dataset.group = group.id;
      section.dataset.open = String(openState.get(group.id));

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'group-head';
      head.innerHTML = `<span class="group-caret">▶</span><span>${group.label}</span>`;
      head.addEventListener('click', () => {
        const next = !(section.dataset.open === 'true');
        section.dataset.open = String(next);
        openState.set(group.id, next);
      });
      section.appendChild(head);

      const body = document.createElement('div');
      body.className = 'group-body';

      if (group.hint) {
        const hint = document.createElement('p');
        hint.className = 'group-hint';
        hint.textContent = group.hint;
        body.appendChild(hint);
      }

      for (const def of PARAMS.filter((p) => p.group === group.id)) {
        body.appendChild(buildField(def));
      }

      section.appendChild(body);
      root.appendChild(section);
    }
  }

  function buildField(def) {
    const field = document.createElement('div');
    field.className = 'field';
    field.dataset.key = def.key;

    if (def.type === 'toggle') {
      const label = document.createElement('label');
      label.className = 'toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(params[def.key]);
      input.addEventListener('change', () => {
        params[def.key] = input.checked;
        handlers.onLive(def.key);
      });
      const track = document.createElement('span');
      track.className = 'toggle-track';
      const text = document.createElement('span');
      text.textContent = def.label;
      label.append(text, input, track);
      field.appendChild(label);
      return field;
    }

    const labelRow = document.createElement('div');
    labelRow.className = 'field-label';
    const name = document.createElement('span');
    name.textContent = def.label;
    const value = document.createElement('span');
    value.className = 'field-value';
    labelRow.append(name, value);
    field.appendChild(labelRow);

    if (def.type === 'color') {
      value.textContent = String(params[def.key]).toUpperCase();
      const input = document.createElement('input');
      input.type = 'color';
      input.value = params[def.key];
      input.addEventListener('input', () => {
        params[def.key] = input.value;
        value.textContent = input.value.toUpperCase();
        handlers.onLive(def.key);
      });
      field.appendChild(input);
    } else if (def.type === 'range') {
      value.textContent = formatValue(def, params[def.key]);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(def.min);
      input.max = String(def.max);
      input.step = String(def.step);
      input.value = String(params[def.key]);
      input.addEventListener('input', () => {
        params[def.key] = Number(input.value);
        value.textContent = formatValue(def, params[def.key]);
        if (def.rebuild) scheduleRebuild(def);
        else handlers.onLive(def.key);
      });
      // Commit immediately on release, in case the debounce has not fired yet.
      input.addEventListener('change', () => {
        if (def.rebuild) {
          const t = rebuildTimers.get(def.key);
          if (t) clearTimeout(t);
          rebuildTimers.delete(def.key);
          handlers.onRebuild(def.key);
        }
      });
      field.appendChild(input);
    } else if (def.type === 'seed') {
      value.textContent = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.spellcheck = false;
      input.value = String(params[def.key]);
      input.style.cssText =
        'width:100%;padding:6px 8px;font-family:var(--mono);font-size:11px;color:var(--gold-bright);background:rgba(0,0,0,.5);border:1px solid var(--line);border-radius:5px;outline:none';
      input.addEventListener('change', () => {
        params[def.key] = input.value || 'planet-forge';
        handlers.onSeedChange(params[def.key]);
      });
      field.appendChild(input);
    }

    if (def.hint) {
      const hint = document.createElement('div');
      hint.className = 'field-hint';
      hint.textContent = def.hint;
      field.appendChild(hint);
    }

    return field;
  }

  function formatValue(def, v) {
    const step = def.step ?? 1;
    if (step >= 1) return String(Math.round(v));
    const decimals = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step))));
    return Number(v).toFixed(decimals);
  }

  /** Push current `params` values back into the DOM (after reset, seed load, etc). */
  function syncFromParams() {
    for (const def of PARAMS) {
      const field = root.querySelector(`.field[data-key="${def.key}"]`);
      if (!field) continue;
      const colorInput = field.querySelector('input[type="color"]');
      const rangeInput = field.querySelector('input[type="range"]');
      const textInput = field.querySelector('input[type="text"]');
      const checkInput = field.querySelector('input[type="checkbox"]');
      const valueEl = field.querySelector('.field-value');
      if (colorInput) {
        colorInput.value = params[def.key];
        if (valueEl) valueEl.textContent = String(params[def.key]).toUpperCase();
      } else if (rangeInput) {
        rangeInput.value = String(params[def.key]);
        if (valueEl) valueEl.textContent = formatValue(def, params[def.key]);
      } else if (textInput) {
        textInput.value = String(params[def.key]);
      } else if (checkInput) {
        checkInput.checked = Boolean(params[def.key]);
      }
    }
  }

  render();
  return { syncFromParams, render };
}
