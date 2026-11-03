import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { LAB_DIR } from './scene.mjs';

const dir = path.join(LAB_DIR, 'prompts');
const cache = new Map();
export const PROMPT_NAMES = readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));

export function template(name) {
  if (!cache.has(name)) cache.set(name, readFileSync(path.join(dir, `${name}.md`), 'utf8'));
  return cache.get(name);
}

/** Fills {{key}} placeholders. A placeholder without a value is an error that names it. */
export function render(name, vars = {}) {
  return template(name).replace(/{{(\w+)}}/g, (_, key) => {
    if (!(key in vars) || vars[key] == null) throw new Error(`提示词 ${name} 缺少变量：${key}`);
    return String(vars[key]);
  });
}
