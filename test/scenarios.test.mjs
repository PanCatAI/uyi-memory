import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../lib/lab.mjs';
import { createScenarios, listScenarios } from '../lib/scenarios.mjs';

process.env.LAB_QUIET = '1';
for (const s of listScenarios()) {
  test(`scenario ${s.id} passes with the mock model`, async () => {
    const runner = createScenarios(createLab());
    const v = await runner.runAll(runner.create(s.id).id);
    const bad = v.results.filter(r => r.ok === false).map(r => `第 ${r.step + 1} 步 ${r.kind}：${r.detail}`);
    assert.deepEqual(bad, []);
    assert.equal(v.state, 'passed');
  });
}
