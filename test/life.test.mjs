// 2.0 D1: 岚 lives by her 作息 — one thing per slot, no model calls, the same every time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { slotAt, slotsBetween, matchesWish, TICK_MS } from '../lib/memory/life.mjs';
import { parseCardV2 } from '../lib/card.mjs';
import { readFileSync } from 'node:fs';

const at = s => Date.parse(`${s}+09:00`);
const routine = parseCardV2(readFileSync(new URL('../characters/lan.md', import.meta.url), 'utf8')).card.routine;
const routineEvents = (lab, saveId) => lab.ledger.list(saveId, { types: ['char_action'], all: true }).filter(e => e.payload?.routine);
const bySlot = evs => evs.reduce((m, e) => ({ ...m, [e.payload.slot]: [...(m[e.payload.slot] || []), e.action] }), {});
const llmCalls = lab => lab.db.prepare('SELECT count(*) n FROM llm_calls').get().n;

/** A camp save at 06:00 on day 2 with a fresh session (no earlier session, so nothing to make up). */
async function morning() {
  const t = await freshLab({ sceneId: 'camp', open: false });
  t.lab.session.advance(t.saveId, '06:00');
  await t.lab.session.start(t.saveId);
  return t;
}
async function tickUntil(lab, saveId, until) {
  while (lab.clock.now(saveId) < until) await lab.session.tick(saveId);
}

test('slots: the one containing a time (night wraps past midnight) and the ones crossed', () => {
  assert.equal(slotAt(routine, at('2026-10-21T06:00:00')).key, '2026-10-21@05:30');
  assert.equal(slotAt(routine, at('2026-10-22T03:00:00')).key, '2026-10-21@22:00', 'the night slot belongs to the day it started');
  assert.equal(slotAt(routine, at('2026-10-21T22:00:00')).key, '2026-10-21@22:00');
  assert.deepEqual(slotsBetween(routine, at('2026-10-21T11:00:00'), at('2026-10-21T18:00:00')).map(s => s.slot.from), ['08:00', '12:00', '14:00', '17:30']);
  // 2.0 D3: an intention picks the slot it is about.
  assert.deepEqual(routine.filter(r => matchesWish(r, '把你说的那条溪画上')).map(r => r.from), ['08:00']);
});

test('ticks from 06:00 to 22:00: fire → bench and map → supplies → path → fire → tent, one slot each, no model', async () => {
  const { lab, saveId } = await morning();
  const before = llmCalls(lab);
  const t0 = lab.clock.now(saveId);
  await lab.session.tick(saveId);
  assert.equal(lab.clock.now(saveId) - t0, TICK_MS);
  await tickUntil(lab, saveId, at('2026-10-21T22:10:00'));
  const slots = bySlot(routineEvents(lab, saveId));
  assert.deepEqual(Object.keys(slots), ['2026-10-21@05:30', '2026-10-21@08:00', '2026-10-21@12:00', '2026-10-21@14:00', '2026-10-21@17:30', '2026-10-21@22:00']);
  // 3.0 F3 card: the morning slot ends with a look at the north slope; without features.world gather_wood is left out.
  assert.deepEqual(Object.values(slots), [
    ['walk_to', 'tend_fire', 'look_at'], ['walk_to', 'sit', 'draw_map'], ['walk_to', 'look_at'], ['walk_to', 'look_at'], ['walk_to', 'tend_fire', 'sit'], ['walk_to', 'enter']
  ]);
  const map = routineEvents(lab, saveId).find(e => e.action === 'draw_map');
  assert.equal(map.payload.args.with, 'cup', 'the cup is on the bench, so it is the ink bowl');
  assert.ok(routineEvents(lab, saveId).every(e => e.outcome === 'ok'));
  assert.equal(lab.ledger.world(saveId).characters.lan.room, 'tent');
  assert.equal(llmCalls(lab), before, 'life never calls a model');
  // Asleep in the tent: her now section says so, and the page can show it.
  const now = lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '睡了吗', inputSeq: lab.ledger.lastSeq(saveId) }).sections.find(s => s.name === 'now').text;
  assert.match(now, /在帐篷里睡觉/);
  assert.equal(lab.life.now(saveId, 'lan').asleep, true);
});

test('no routine action while the user is talking (time still moves)', async () => {
  const { lab, saveId } = await morning();
  const { say } = { say: text => lab.turns.runTurn({ saveId, charId: 'lan', text }) };
  await say('早');
  const t = lab.clock.now(saveId);
  const r = await lab.session.tick(saveId);
  assert.equal(r.skipped, 'chatting');
  assert.ok(!r.events.some(e => e.payload?.routine));
  assert.equal(lab.clock.now(saveId), t + TICK_MS);
  assert.equal(routineEvents(lab, saveId).length, 0);
  // The next tick is 5 quiet world minutes later: she gets on with it.
  assert.ok((await lab.session.tick(saveId)).events.some(e => e.payload?.routine));
});

test('the cup is only the ink bowl when it is in the same area', async () => {
  const { lab, saveId } = await morning();
  lab.ledger.append(saveId, { type: 'object_changed', actor: 'host', target: 'cup', payload: { field: 'room', from: 'fireside', to: 'supply' } });
  await tickUntil(lab, saveId, at('2026-10-21T08:10:00'));
  const map = routineEvents(lab, saveId).find(e => e.action === 'draw_map');
  assert.ok(map, 'still draws');
  assert.equal(map.payload.args.with, undefined);
});

test('coming back after two days: at most 6 made-up slots, off-screen, in order, inside the gap; deterministic', async () => {
  const run = async () => {
    const { lab, saveId } = await freshLab({ sceneId: 'camp' });
    lab.session.end(saveId);
    const left = lab.clock.now(saveId);
    lab.session.advance(saveId, '2d');
    lab.session.advance(saveId, '18:00');
    await lab.session.start(saveId);
    const evs = routineEvents(lab, saveId);
    assert.equal(lab.db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose = 'catchup'").get().n, 0, 'no catchup model call for a character with a 作息');
    assert.ok(Object.keys(bySlot(evs)).length <= 6 && evs.length > 0);
    assert.ok(evs.every(e => e.offscreen && e.t > left && e.t <= lab.clock.now(saveId)));
    assert.deepEqual(evs.map(e => e.t), [...evs.map(e => e.t)].sort((a, b) => a - b));
    assert.equal(Object.keys(bySlot(evs)).at(-1), '2026-10-22@17:30', 'ends with what she is doing now');
    return evs.map(e => [e.type, e.action, e.target, e.t, e.payload.slot, JSON.stringify(e.payload.args)]);
  };
  assert.deepEqual(await run(), await run());
});

test('the 1.0 island (cards without 作息) keeps the old catch-up', async () => {
  const { lab, saveId } = await freshLab();
  lab.session.advance(saveId, '10h');
  await lab.session.start(saveId);
  assert.equal(routineEvents(lab, saveId).length, 0);
  assert.ok(lab.db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose = 'catchup'").get().n >= 1);
});
