import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from '../lib/llm-mock.mjs';
import { CHECKS } from '../lib/llm-checks.mjs';

const mock = createMock();
const facts = u => mock.answer('facts', { utterance: u, knownFacts: [{ id: 'f_old', predicate: 'name', object: '美林' }] }).facts;

test('every purpose returns a valid shape', () => {
  const inputs = {
    reply: { input: '你好', hintRefs: ['fact:f_1'] }, facts: { utterance: '我叫美林' },
    observe: { events: [{ seq: 1, type: 'user_said', actor: 'user', payload: { text: 'hi', to: 'rin' } }], names: { rin: '玲' } },
    reflect: { observations: [{ id: 'c_1', text: 'a' }] }, catchup: { allowed: [{ name: 'clean', target: 'red_cup' }] },
    forget_resolve: { request: '忘了吧', candidates: { seqs: [1] } }, judge: {}, test: {}
  };
  for (const [p, input] of Object.entries(inputs)) assert.deepEqual(CHECKS[p](mock.answer(p, input)), [], p);
  assert.deepEqual(mock.answer('reply', inputs.reply).used, ['fact:f_1']);
});

test('fact regexes', () => {
  assert.deepEqual(facts('我叫美林').map(f => [f.predicate, f.object]), [['name', '美林']]);
  assert.deepEqual(facts('以后叫我小美吧').map(f => [f.predicate, f.object]), [['call_me', '小美吧']]);
  assert.deepEqual(facts('我喜欢猫，可惜送人了').map(f => [f.predicate, f.object]), [['likes', '猫']]);
  assert.deepEqual(facts('我讨厌下雨').map(f => f.predicate), ['dislikes']);
  const c = facts('说错了，是美玲不是美林')[0];
  assert.deepEqual([c.predicate, c.object, c.corrects, c.evidence], ['name', '美玲', 'f_old', '是美玲不是美林']);
  assert.equal(facts('这个红杯子是我奶奶留下的，别弄坏了')[0].object, '这个红杯子是我奶奶留下的');
  assert.deepEqual(facts('你还记得我叫什么吗'), []);
  assert.equal(mock.answer('facts', { utterance: '那你明天陪我去看灯塔' }).commitments[0].due, '+1d');
});

test('queued answers win', () => {
  mock.enqueue('reply', { say: '排队的', action: null, used: [], self_claims: [] });
  assert.equal(mock.answer('reply', { input: 'x' }).say, '排队的');
  assert.match(mock.answer('reply', { input: 'x' }).say, /mock/);
});
