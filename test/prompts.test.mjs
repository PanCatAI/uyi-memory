import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, template, PROMPT_NAMES } from '../lib/prompts.mjs';

test('all seven templates exist', () => {
  assert.deepEqual([...PROMPT_NAMES].sort(), ['card-draft', 'catchup', 'diary', 'digest', 'facts', 'forget-resolve', 'fun-judge', 'idle', 'judge', 'observe', 'ooc-judge', 'reflect', 'reply.system', 'self-check', 'sim-user']);
  for (const n of PROMPT_NAMES) assert.ok(template(n).length > 50, n);
});

test('render fills and names missing variables', () => {
  const out = render('reply.system', { character_card: '# 玲', actions: '- wave', moods: '平常' });
  assert.match(out, /# 玲/);
  assert.doesNotMatch(out, /{{/);
  assert.throws(() => render('facts', { known_facts: '', context: '' }), /缺少变量：utterance/);
});
