import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatWorldTime, formatAgo, WORLD_START, DAY, HOUR } from '../lib/clock.mjs';
import { newId } from '../lib/ids.mjs';
import { freshDb } from './helpers/db.mjs';

test('parseDuration', () => {
  assert.equal(parseDuration('2h'), 2 * HOUR);
  assert.equal(parseDuration('3d'), 3 * DAY);
  assert.equal(parseDuration('1w'), 7 * DAY);
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('+1d'), DAY);
  assert.equal(parseDuration('18:00', WORLD_START), 9 * HOUR, '09:00 → 18:00 the same day');
  assert.equal(parseDuration('09:00', WORLD_START), DAY, 'same time → a full day later');
  assert.equal(parseDuration('08:30', WORLD_START + 9 * HOUR), 14.5 * HOUR);
  assert.equal(parseDuration('25:00', WORLD_START), null);
  assert.equal(parseDuration(5000), 5000);
  assert.equal(parseDuration('soon'), null);
  // 09:00 → tomorrow 09:00; 15:00 → tomorrow 09:00 = 18h
  assert.equal(parseDuration('tomorrow', WORLD_START), DAY);
  assert.equal(parseDuration('tomorrow', WORLD_START + 6 * HOUR), 18 * HOUR);
});

test('world time format in Asia/Tokyo', () => {
  assert.equal(formatWorldTime(WORLD_START), '10月20日 周二 09:00');
  assert.equal(formatWorldTime(WORLD_START + 2 * DAY + 5 * HOUR + 7 * 60_000), '10月22日 周四 14:07');
  assert.equal(formatAgo(3 * HOUR), '3 小时前');
  assert.equal(formatAgo(10 * DAY), '上周');
});

test('clock only moves forward', () => {
  const { clock, saveId } = freshDb();
  assert.equal(clock.now(saveId), WORLD_START);
  clock.advance(saveId, HOUR);
  assert.equal(clock.now(saveId), WORLD_START + HOUR);
  assert.throws(() => clock.set(saveId, WORLD_START), /往回拨/);
});

test('ids', () => {
  assert.match(newId('f'), /^f_[0-9a-z]{8}$/);
  assert.notEqual(newId('f'), newId('f'));
});

test('parseDuration: 周四 / 周四 18:00 is the next such weekday (2.0 C6)', () => {
  const tue18 = Date.parse('2026-10-20T18:00:00+09:00'); // a Tuesday
  assert.equal(formatWorldTime(tue18 + parseDuration('周四 18:00', tue18)), '10月22日 周四 18:00');
  assert.equal(formatWorldTime(tue18 + parseDuration('周四', tue18)), '10月22日 周四 09:00');
  assert.equal(formatWorldTime(tue18 + parseDuration('星期二 20:00', tue18)), '10月27日 周二 20:00', 'today does not count');
  assert.equal(parseDuration('周八', tue18), null);
});
