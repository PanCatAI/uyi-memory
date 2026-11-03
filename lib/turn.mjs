// One turn of conversation (PLAN §4.8), and the user's god-panel actions (PLAN §3.2).
import { newId } from './ids.mjs';
import { j, pj, tx } from './db.mjs';
import { TURN_MS } from './clock.mjs';
import { checkAction, actionEvents, failureLine, unbackedClaims, planActions } from './arbiter.mjs';
import { bannedIn, stripBanned } from './memory/style.mjs';
import { turnIndexInSession } from './memory/common.mjs';
import { VERB_TEXT } from './memory/forget.mjs';
import { estimate } from './tokens.mjs';
import { roomCenter } from './scene.mjs';
import { INTENTS, stripPhrase } from './memory/voice.mjs';

const THOUGHT_MAX = 40;
const FALLBACK = name => `……（${name}好像在发呆）`;

export function createTurns(lab) {
  const { db, ledger, clock } = lab;

  function saveTurn({ saveId, charId, mode, committed, userSeq, replySeq, ctx, output, rejected, thought = null, intent = null }) {
    // 3.0 G1: the topic she actually said (its ref in used) is what cools it down.
    const topic = committed ? (output?.used || []).find(r => String(r).startsWith('topic:'))?.slice(6) ?? null : null;
    const id = newId('t');
    db.prepare('INSERT INTO turns (id, save_id, character_id, mode, committed, user_seq, reply_seq, sections_json, prompt_json, output_json, rejected_json, generation, t, thought, card_version, intent, topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, saveId, charId, mode, committed ? 1 : 0, userSeq ?? null, replySeq ?? null, j(ctx.sections), j([{ role: 'system', content: ctx.system }, { role: 'user', content: ctx.user }]), j(output), j(rejected), lab.saves.getSave(saveId).generation, clock.now(saveId), thought, lab.cards.version(saveId, charId), intent, topic);
    return id;
  }

  /** Calls the reply model and cleans its output. Never throws: failures become the fallback line. */
  async function reply(saveId, charId, ctx, mockInput) {
    const scene = lab.scene(saveId);
    const name = scene.characters.find(c => c.id === charId).name;
    const refs = new Set(ctx.sections.flatMap(s => s.refs));
    const rejected = { used: [], banned: [], action: null, error: null };
    let out;
    try {
      out = await lab.llm.callChecked({ purpose: 'reply', system: ctx.system, user: ctx.user, saveId, mockInput, maxTokens: 400 });
      if (bannedIn(out.say).length) {
        rejected.banned.push(out.say);
        out = await lab.llm.callChecked({ purpose: 'reply', system: ctx.system, user: `${ctx.user}\n\n（不要用这些说法：${bannedIn(out.say).join('、')}）`, saveId, mockInput, maxTokens: 400 });
        if (bannedIn(out.say).length) { rejected.banned.push(out.say); out.say = stripBanned(out.say) || FALLBACK(name); }
      }
    } catch (e) {
      rejected.error = e.message;
      out = { say: FALLBACK(name), action: null, used: [], self_claims: [] };
    }
    const used = (out.used || []).filter(r => (refs.has(r) ? true : (rejected.used.push(r), false)));
    // mood must name one of the card's moods; anything else is the default mood, not a format error.
    const moods = scene.characters.find(c => c.id === charId).card?.moods || [];
    const mood = moods.some(m => m.name === out.mood) ? out.mood : (moods[0]?.name ?? null);
    // thought is the model's private note before it speaks: kept on the turn row only (THOUGHT_MAX chars).
    const thought = typeof out.thought === 'string' && out.thought.trim() ? out.thought.trim().slice(0, THOUGHT_MAX) : null;
    // 3.0 E2: what this line is for; anything else is 回应, not a format error.
    const intent = INTENTS.includes(out.intent) ? out.intent : '回应';
    // 3.0 G3/G4: optional; anything that is not an object is dropped (the host checks the rest after the reply).
    const obj = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);
    return { say: out.say, thought, mood, intent, practice: obj(out.practice), bet: obj(out.bet), action: out.action || null, used, self_claims: out.self_claims || [], done_commitments: out.done_commitments || [], rejected, meta: out.__meta || null };
  }

  async function runTurn({ saveId, charId, text, compare = false }) {
    const input = String(text || '').trim();
    if (!input) throw new Error('说点什么吧');
    if (!lab.scene(saveId).characters.some(c => c.id === charId)) throw new Error(`没有这个角色：${charId}`);
    return lab.queues.queue(saveId, charId, 'act', async () => {
      const opened = [];
      if (!lab.saves.getSave(saveId).session_id) opened.push(...await lab.session.start(saveId));
      clock.advance(saveId, TURN_MS);
      opened.push(...lab.environment.tick(saveId));
      lab.diary.check(saveId);
      const userEv = ledger.append(saveId, { type: 'user_said', actor: 'user', payload: { text: input, to: charId } });
      lab.relationship.sync(saveId, charId); // 2.0 D5: this line may be the one that moves the stage
      opened.push(...lab.practice.beforeReply(saveId, charId, input)); // 3.0 G3: his words may finish a step

      const extraHints = [];
      let forgetJob = null;
      const verb = lab.forget.detect(input);
      if (verb) {
        try {
          forgetJob = await lab.forget.propose(saveId, charId, { ...verb, requestSeq: userEv.seq, requestText: input });
          extraHints.push(`用户请你${VERB_TEXT[verb.verb]}一件事。简短答应，不要复述那件事的内容。`);
        } catch (e) { lab.jobs.reportError(saveId, `忘记任务失败：${e.message}`); }
      }

      // 2.0 D7: a save may answer in full or none mode for real (three-arm runs); hints belong to memory mode only.
      const replyMode = lab.saves.getSave(saveId).reply_mode || 'memory';
      const hints = replyMode === 'memory' ? lab.proactive.hints({ saveId, charId, turnIndex: turnIndexInSession(lab, saveId), inputSeq: userEv.seq }) : [];
      const ctx = lab.context.build({ mode: replyMode, saveId, charId, input, inputSeq: userEv.seq, hints, extraHints });
      // Comparison contexts are built from the same ledger state; their calls start after the real reply took
      // its (possibly queued mock) answer.
      const compareCtx = compare ? ['memory', 'full', 'none'].filter(m => m !== replyMode).map(mode => ({ mode, ctx: lab.context.build({ mode, saveId, charId, input, inputSeq: userEv.seq }) })) : [];
      const snapshot = structuredClone(ledger.world(saveId)); // the world every mode of this turn saw
      const pending = reply(saveId, charId, ctx, { input, hintRefs: hints.map(h => h.ref) });
      const comparing = compareCtx.map(({ mode, ctx: c }) => reply(saveId, charId, c, { input, hintRefs: [] }).then(r => ({ mode, ctx: c, r })));
      let r = await pending;
      // 3.0 E2: a catchphrase used again inside its window, or a question she already asked, gets one more try with
      // a host note naming them (one extra call, only in this case, only with the voice feature).
      const voiceNote = v => `（这句${v.tics.length ? `别用${v.tics.map(x => `「${x}」`).join('')}` : ''}${v.tics.length && v.repeats.length ? '；' : ''}${v.repeats.length ? `别再问${v.repeats.map(x => `「${x}」`).join('')}` : ''}。）`;
      const firstVoice = r.rejected.error ? { tics: [], repeats: [] } : lab.voice.problems(saveId, charId, r.say);
      if (firstVoice.tics.length || firstVoice.repeats.length) {
        const again = await reply(saveId, charId, { ...ctx, user: `${ctx.user}\n\n${voiceNote(firstVoice)}` }, { input, hintRefs: hints.map(h => h.ref) });
        if (!again.rejected.error) { again.rejected.voice = { first: r.say, ...firstVoice }; r = again; }
      }
      // A line that says an action is done without doing it gets one more try with a host note (one extra call, only
      // in this case). If the retry still claims it, it is delivered but flagged for review.
      const claims = unbackedClaims(snapshot, charId, r.say, r.action);
      if (claims.length && !r.rejected.error) {
        const note = `（宿主提示：你说已经${claims.map(n => lab.scene(saveId).actions[n]?.desc || n).join('、')}，但没有在 action 里做这个动作，世界里也没有发生。要做就在 action 里做；没做就不要说成做完了。）`;
        const again = await reply(saveId, charId, { ...ctx, user: `${ctx.user}\n\n${note}` }, { input, hintRefs: hints.map(h => h.ref) });
        const still = unbackedClaims(snapshot, charId, again.say, again.action);
        again.rejected.unbacked = { first: r.say, claims, retried: true, still };
        r = again;
      }

      // 2.0 D9: an action the world refuses gets one more try with the reason (one extra call, only in this case), so
      // she can pick something she can really do instead of the host saying it did not work. Still refused → host line.
      if (!r.rejected.error && r.action) {
        const dry = planActions(snapshot, lab.scene(saveId), charId, r.action, { userName: lab.saves.getSave(saveId).user_name });
        if (dry.failed) {
          const what = `${dry.failed.action.name}${dry.failed.action.target ? ` ${dry.failed.action.target}` : ''}`;
          const note = `（宿主提示：动作 ${what} 做不到：${dry.failed.check.reason}。只用「你能感知到的」表里列出的、现在能做的动作，换一个，或者不做动作；说的话要和真正做的一致，不要提宿主。）`;
          const again = await reply(saveId, charId, { ...ctx, user: `${ctx.user}\n\n${note}` }, { input, hintRefs: hints.map(h => h.ref) });
          if (!again.rejected.error) { again.rejected.retried_action = { first: r.action, say: r.say, reason: dry.failed.check.reason }; r = again; }
        }
      }

      // A line that says the opposite of what she said about herself before ("掀被子我可不动手" → "起不来我掀被子") gets
      // one more try with both sayings in a host note. Still the opposite → delivered, but flagged and not learned.
      let selfCheck = { conflicts: [], superseded: [] };
      if (!r.rejected.error && r.self_claims?.length) {
        selfCheck = await lab.selfCanon.check(saveId, charId, { line: r.say, claims: r.self_claims });
        if (selfCheck.conflicts.length) {
          const note = `（宿主提示：你以前说过${selfCheck.conflicts.map(c => `「${c.text}」`).join('')}，这句和它说反了${selfCheck.conflicts[0].why ? `（${selfCheck.conflicts[0].why}）` : ''}。要么和以前说的一致，要么明说你改主意了。）`;
          const again = await reply(saveId, charId, { ...ctx, user: `${ctx.user}\n\n${note}` }, { input, hintRefs: hints.map(h => h.ref) });
          if (!again.rejected.error) {
            const first = selfCheck.conflicts;
            selfCheck = again.self_claims?.length ? await lab.selfCanon.check(saveId, charId, { line: again.say, claims: again.self_claims }) : { conflicts: [], superseded: [] };
            again.rejected.self_retry = { first: r.say, conflicts: first };
            if (selfCheck.conflicts.length) again.rejected.self_conflict = selfCheck.conflicts;
            r = again;
          }
        }
      }

      // Still a catchphrase over its limit after all the tries: drop it where it opens a sentence (questions stay).
      if (!r.rejected.error) {
        const v = lab.voice.problems(saveId, charId, r.say);
        if (v.tics.length) {
          const cut = v.tics.reduce((t, p) => stripPhrase(t, p), r.say);
          if (cut && cut !== r.say) { r.rejected.voice = { ...(r.rejected.voice || {}), stripped: { from: r.say, phrases: v.tics } }; r.say = cut; }
        }
      }

      const scene = lab.scene(saveId);
      const hintRefs = new Set(hints.map(h => h.ref));
      const out = tx(db, () => {
        // The actions (up to 3, in order) are checked before anything is said: if one does not happen, the model's
        // line (which may say it did) is withheld and the host delivers a short line saying what did and didn't work.
        const userName = lab.saves.getSave(saveId).user_name;
        const plan = planActions(ledger.world(saveId), scene, charId, r.action, { userName });
        const mapped = plan.steps.filter(x => x.mapped).map(x => x.mapped);
        if (mapped.length) r.rejected.mapped = mapped.length === 1 ? mapped[0] : mapped;
        const withhold = Boolean(plan.failed);
        const done = plan.steps.filter(x => x.check.ok).map(x => x.action);
        const delivered = withhold ? failureLine(ledger.world(saveId), scene, plan.failed.action, plan.failed.check.reason, done) : r.say;
        const used = withhold ? [] : r.used;
        if (withhold) r.rejected.withheld = { say: r.say, used: r.used, self_claims: r.self_claims, reason: plan.failed.check.reason };
        const said = ledger.append(saveId, { type: 'char_said', actor: charId, payload: { text: delivered, to: 'user', used, proactive: used.some(u => hintRefs.has(u)), ...(withhold ? { host_line: true } : {}) } });
        // The host executes against the live world, re-checking each step (the plan was only a dry run).
        const actionEvs = [], results = [];
        for (const step of plan.steps) {
          if (step.check.noop) { results.push({ ok: true, noop: step.check.noop }); continue; }
          const check = checkAction(ledger.world(saveId), scene, charId, step.action);
          actionEvs.push(...ledger.appendMany(saveId, actionEvents(ledger.world(saveId), scene, charId, step.action, check)));
          results.push(check.ok ? { ok: true } : { ok: false, reason: check.reason });
          if (!check.ok) r.rejected.action = { ...step.action, reason: check.reason };
          if (step === plan.failed) break;
        }
        const executed = plan.steps.length > 1 ? plan.steps.map(x => x.action) : plan.steps[0]?.action ?? null;
        const failedAt = results.findIndex(x => !x.ok);
        const actionResult = !results.length ? null : failedAt < 0 ? { ok: true, ...(results.length > 1 ? { steps: results } : {}) } : { ...results[failedAt], ...(results.length > 1 ? { steps: results } : {}) };
        const action = executed;
        // 3.0 G3/G4: her practice step and her bet, checked against the world (dropped ones are noted, never an error).
        const worldEvs = [];
        if (!withhold) {
          const pr = lab.practice.afterReply(saveId, charId, r.practice, plan.steps.filter(x => x.check.ok).map(x => x.action));
          const bt = lab.bets.afterReply(saveId, charId, r.bet);
          worldEvs.push(...pr.events, ...bt.events);
          if (pr.rejected) r.rejected.practice = pr.rejected;
          if (bt.rejected) r.rejected.bet = bt.rejected;
        }
        actionEvs.push(...worldEvs);
        const turnId = saveTurn({ saveId, charId, mode: replyMode, committed: true, userSeq: userEv.seq, replySeq: said.seq, ctx, output: { say: r.say, mood: r.mood, intent: r.intent, practice: r.practice, bet: r.bet, delivered, action: r.action, executed: action, used, self_claims: withhold ? [] : r.self_claims, done_commitments: withhold ? [] : r.done_commitments, meta: r.meta }, rejected: r.rejected, thought: r.thought, intent: r.intent });
        for (const ref of new Set(ctx.sections.flatMap(s => s.refs))) db.prepare('INSERT INTO retrievals (save_id, character_id, memory_ref, turn_id, t) VALUES (?, ?, ?, ?, ?)').run(saveId, charId, ref, turnId, clock.now(saveId));
        if (!withhold) {
          lab.selfCanon.add(saveId, charId, r.self_claims, said.seq, { selfConflict: Boolean(r.rejected.self_conflict) });
          lab.selfCanon.supersede(saveId, selfCheck.superseded);
          lab.commitments.markDone(saveId, charId, r.done_commitments.filter(x => ctx.sections.some(s => s.refs.includes(x))), said.seq);
        }
        return { turnId, said, actionEvs, actionResult, delivered, used, action, withheld: withhold ? r.say : null };
      });

      lab.jobs.enqueue(saveId, charId, 'facts');
      if (lab.observe.backlog(saveId, charId) >= 8) lab.jobs.enqueue(saveId, charId, 'observe');

      const compared = {};
      for (const { mode, ctx: c, r: cr } of await Promise.all(comparing)) {
        // Checked against the same snapshot so the comparison is fair, but never executed.
        let check = null;
        if (cr.action) {
          const p = planActions(snapshot, scene, charId, cr.action, { userName: lab.saves.getSave(saveId).user_name });
          check = p.failed ? { ok: false, reason: p.failed.check.reason } : { ok: true };
        }
        const id = saveTurn({ saveId, charId, mode, committed: false, userSeq: userEv.seq, ctx: c, output: { say: cr.say, mood: cr.mood, intent: cr.intent, action: cr.action, check, executed: false, used: cr.used, meta: cr.meta }, rejected: cr.rejected, thought: cr.thought, intent: cr.intent });
        compared[mode] = { turnId: id, say: cr.say, action: cr.action, check, actionResult: check ? { ...check, executed: false } : null, executed: false, tokens: estimate(c.system) + estimate(c.user), inputTokens: cr.meta?.usage && cr.meta.model !== 'mock' ? cr.meta.usage.input : null, cost: cr.meta?.cost ?? null, truncated: c.sections.find(s => s.name === 'transcript')?.dropped || 0 };
      }
      return {
        turnId: out.turnId, opened, userEvent: userEv, events: [out.said, ...out.actionEvs], forgetJob,
        reply: { inputTokens: r.meta?.usage && r.meta.model !== 'mock' ? r.meta.usage.input : null, say: r.say, delivered: out.delivered, withheld: out.withheld, action: out.action, proposedAction: r.action, actionResult: out.actionResult, used: out.used, hints, error: r.rejected.error, tokens: estimate(ctx.system) + estimate(ctx.user), cost: r.meta?.cost ?? null },
        compare: compare ? compared : null
      };
    });
  }

  /** God-panel actions by the user (PLAN §3.2). */
  function act(saveId, { action, target, args = {} }) {
    const scene = lab.scene(saveId);
    const st = ledger.world(saveId);
    const pal = scene.palette.find(p => p.id === target);
    const evs = [];
    if (action === 'give') {
      const to = st.characters[args.to];
      if (!to) throw new Error('要送给谁？');
      if (!pal && !st.objects[target]) throw new Error(`没有这个东西：${target}`);
      evs.push({ type: 'user_action', actor: 'user', action, target, payload: { args }, room: to.room });
      if (to.holding) evs.push({ type: 'object_changed', actor: 'host', target: to.holding, payload: { field: 'holder', from: to.id, to: null } });
      if (pal && !st.objects[target]) evs.push({ type: 'object_created', actor: 'host', target, payload: { object: { ...pal, room: to.room, pos: [...to.pos] } } });
      evs.push({ type: 'object_changed', actor: 'host', target, payload: { field: 'holder', from: st.objects[target]?.holder ?? null, to: to.id } });
    } else if (action === 'build' || action === 'place') {
      if (!pal) throw new Error(`搭建栏里没有：${target}`);
      if (st.objects[target]) throw new Error(`${pal.name}已经在场景里了`);
      const room = args.room || pal.rooms?.[0];
      if (!scene.rooms.some(r => r.id === room)) throw new Error('要放在哪个房间？');
      if (pal.rooms && !pal.rooms.includes(room)) throw new Error(`${pal.name}只能放在：${pal.rooms.join('、')}`);
      const [cx, , cz] = roomCenter(scene, room);
      const pos = action === 'build' && pal.pos ? pal.pos : [cx, 0.2, cz];
      evs.push({ type: 'user_action', actor: 'user', action, target, payload: { args: { ...args, room } } });
      evs.push({ type: 'object_created', actor: 'host', target, payload: { object: { ...pal, room, pos } } });
    } else if (action === 'move_object') {
      const o = st.objects[target];
      if (!o) throw new Error(`没有这个东西：${target}`);
      const room = scene.rooms.find(r => r.id === args.room);
      if (!room) throw new Error('要挪到哪个房间？');
      const [cx, , cz] = roomCenter(scene, room.id);
      const off = room.box ? 0.8 : 0.3; // polygon areas are small (the camp): stay near the middle
      evs.push({ type: 'user_action', actor: 'user', action, target, payload: { args } });
      if (o.holder) evs.push({ type: 'object_changed', actor: 'host', target, payload: { field: 'holder', from: o.holder, to: null } });
      evs.push({ type: 'object_changed', actor: 'host', target, payload: { field: 'room', from: o.room, to: room.id } });
      evs.push({ type: 'object_changed', actor: 'host', target, payload: { field: 'pos', from: o.pos, to: [cx + off, o.pos[1], cz + off] } });
    } else if (action === 'move_character') {
      const c = st.characters[target];
      if (!c) throw new Error(`没有这个角色：${target}`);
      if (!scene.rooms.some(r => r.id === args.room)) throw new Error('要叫到哪个房间？');
      evs.push({ type: 'user_action', actor: 'user', action, target, payload: { args } });
      if (args.room !== c.room) evs.push({ type: 'char_moved', actor: target, target: args.room, payload: { from: c.room, to: args.room } });
    } else if (scene.rules?.user_actions?.[action]) {
      // 3.0 F3: 盖柴 and the like; the worldsim writes what it changes.
      const ua = scene.rules.user_actions[action];
      evs.push({ type: 'user_action', actor: 'user', action, target: ua.target ?? null, payload: { args }, ...(ua.target ? {} : { room: st.userRoom }) });
    } else if (action === 'help' && scene.rules) {
      // 3.0 F4: 搭把手 on an incident going on now.
      const open = st.incidents?.[args.incident];
      if (!open) throw new Error('现在没有要帮忙的事');
      evs.push({ type: 'user_action', actor: 'user', action, target: open.target ?? null, payload: { args: { incident: open.id } }, ...(open.target ? {} : { room: st.userRoom }) });
    } else throw new Error(`不认识的操作：${action}`);
    clock.advance(saveId, 5_000);
    return ledger.appendMany(saveId, evs);
  }

  /**
   * Turn groups for review (P1-03): every mode answered the same input against the same world (user_seq is both the
   * input and the event cutoff). For each mode: reply, what was delivered, proposed action and its check, errors,
   * the context size and the actual API attempts (llm_calls rows of the reply's logical call).
   */
  function view(t) {
    const out = pj(t.output_json, {}) || {};
    const rej = pj(t.rejected_json, {}) || {};
    const prompt = pj(t.prompt_json, []);
    const sections = pj(t.sections_json, []);
    const logical = out.meta?.logicalId;
    const calls = logical ? db.prepare('SELECT stage, attempt, model, input_tokens, cached_tokens, output_tokens, usage_known, cost_usd, latency_ms, finish_reason, error FROM llm_calls WHERE logical_id = ? ORDER BY attempt').all(logical) : [];
    const actionResult = t.committed
      ? (rej.action ? { ok: false, reason: rej.action.reason } : out.executed ? { ok: true } : null)
      : out.check ? { ...out.check, executed: false } : null;
    return {
      turnId: t.id, mode: t.mode, committed: Boolean(t.committed), thought: t.thought ?? null, intent: t.intent ?? null, cardVersion: t.card_version ?? 0, mood: out.mood ?? null, say: out.say ?? null, delivered: out.delivered ?? out.say ?? null,
      withheld: rej.withheld?.say ?? null, action: out.executed || out.action || null, actionResult, used: out.used || [],
      error: rej.error || null, tokens: prompt.reduce((n, m) => n + estimate(m.content || ''), 0),
      inputTokens: calls.filter(c => c.usage_known).at(-1)?.input_tokens ?? null,
      truncated: sections.find(s => s.name === 'transcript')?.dropped || 0,
      sections: sections.map(s => ({ name: s.name, title: s.title, tokens: s.tokens, refs: s.refs.length })),
      calls, cost: calls.reduce((n, c) => (c.cost_usd == null ? n : n + c.cost_usd), 0) || null
    };
  }
  function groups(saveId, charId, { limit = 200 } = {}) {
    const rows = db.prepare(`SELECT * FROM turns WHERE save_id = ? AND character_id = ? AND user_seq IS NOT NULL AND mode IN ('memory', 'full', 'none') ORDER BY user_seq DESC, rowid LIMIT ?`).all(saveId, charId, limit * 3);
    const by = new Map();
    for (const t of rows) {
      if (!by.has(t.user_seq)) by.set(t.user_seq, { userSeq: t.user_seq, replySeq: null, t: t.t, modes: {} });
      const g = by.get(t.user_seq);
      g.modes[t.mode] = view(t);
      if (t.committed) { g.replySeq = t.reply_seq; g.replyMode = t.mode; }
    }
    return [...by.values()].reverse();
  }

  return { runTurn, act, groups, view };
}
