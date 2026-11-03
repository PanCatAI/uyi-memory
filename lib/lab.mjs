// Wires every module together. server.mjs, the scenario runner and the tests all build a lab the same way.
import { openDb } from './db.mjs';
import { createClock } from './clock.mjs';
import { createSaves } from './saves.mjs';
import { createLedger } from './ledger.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadScene, loadSceneFile, parseCard } from './scene.mjs';
import { createCards } from './cards.mjs';
import { createQueues } from './arbiter.mjs';
import { createLlm } from './llm.mjs';
import { createAdmission } from './memory/admission.mjs';
import { createRelationship } from './memory/relationship.mjs';
import { createCommitments } from './memory/commitments.mjs';
import { createFacts } from './memory/facts.mjs';
import { createObserve } from './memory/observe.mjs';
import { createSelfCanon } from './memory/selfcanon.mjs';
import { createProactive } from './memory/proactive.mjs';
import { createCatchup } from './memory/catchup.mjs';
import { createForget } from './memory/forget.mjs';
import { createJobs } from './memory/jobs.mjs';
import { createContext } from './memory/context.mjs';
import { createEnvironment } from './environment.mjs';
import { createLife } from './memory/life.mjs';
import { createIdle } from './memory/idle.mjs';
import { createDiary } from './memory/diary.mjs';
import { createSession } from './session.mjs';
import { createTurns } from './turn.mjs';
import { createFeatures } from './features.mjs';
import { createVoice } from './memory/voice.mjs';
import { worldScene, createRules } from './rules.mjs';
import { createWorldSim } from './worldsim.mjs';
import { createDirector } from './director.mjs';
import { createTopics } from './memory/topics.mjs';
import { createScout } from './scout.mjs';
import { createPractice } from './memory/practice.mjs';
import { createBets } from './bets.mjs';

/** file: database path or ':memory:'. getEnv: () => env object (LLM_* keys). savesDir: where per-save scene files live (2.0 C1). */
export function createLab({ file = ':memory:', db = openDb(file), getEnv = () => ({ LLM_PROVIDER: 'mock' }), fetchImpl, savesDir = null } = {}) {
  const lab = { db, savesDir, assetsDir: savesDir ? path.join(path.dirname(savesDir), 'assets') : null };
  // An imported save keeps its own scene in <savesDir>/<save>/scene.json; the others use scenes/<id>.json.
  // (Read when called: the scenario runner gives an in-memory lab a temporary savesDir the first time it imports.)
  lab.sceneFile = saveId => (lab.savesDir ? path.join(lab.savesDir, saveId, 'scene.json') : null);
  lab.clock = createClock(db);
  lab.saves = createSaves(db);
  const feats = createFeatures(db);
  lab.features = saveId => feats.get(saveId); // 3.0 E4
  lab.setFeatures = (saveId, patch) => {
    const next = feats.set(saveId, patch);
    lab.ledger?.forget(saveId); // features.world changes the scene the world is folded over (vars, actions)
    return next;
  };
  const baseScene = saveId => {
    const s = lab.saves.getSave(saveId);
    if (!s) throw new Error(`没有这个存档：${saveId}`);
    const own = lab.sceneFile(saveId);
    return own && existsSync(own) ? loadSceneFile(own) : loadScene(s.scene_id);
  };
  // A save with card versions from the settings tab sees its own copy of the scene with those cards in it.
  // Keyed by the base scene object, so a re-imported scene file never serves a stale copy.
  const withCards = new WeakMap();
  lab.cards = createCards(lab, baseScene);
  // 3.0 F: with features.world the scene carries its rules and incidents, and the rules' extra actions.
  const worldScenes = new WeakMap();
  const withWorld = (saveId, scene) => {
    if (!scene.worldFiles?.rules || !lab.features(saveId).world) return scene;
    if (!worldScenes.has(scene)) worldScenes.set(scene, worldScene(scene));
    return worldScenes.get(scene);
  };
  lab.scene = saveId => withWorld(saveId, cardScene(saveId));
  const cardScene = saveId => {
    const base = baseScene(saveId);
    const over = lab.cards.overrides(saveId);
    const sig = Object.entries(over).map(([id, o]) => `${id}@${o.version}`).sort().join(',');
    if (!sig) return base;
    if (!withCards.has(base)) withCards.set(base, new Map());
    const byBase = withCards.get(base);
    const key = `${saveId}|${sig}`;
    if (!byBase.has(key)) {
      const scene = { ...base, characters: base.characters.map(c => {
        if (!over[c.id]) return c;
        const p = parseCard(over[c.id].text);
        return { ...c, cardText: p.text, canon: p.canon, card: p.card, meta: p.meta, cardVersion: over[c.id].version };
      }) };
      byBase.set(key, scene);
    }
    return byBase.get(key);
  };
  lab.ledger = createLedger({ db, clock: lab.clock, sceneOf: lab.scene });
  lab.queues = createQueues();
  lab.mockSaves = new Set(); // saves that always use the mock model (scenario runs with provider 'mock')
  lab.llm = createLlm({ db, getEnv, forceMock: saveId => lab.mockSaves.has(saveId), ...(fetchImpl ? { fetchImpl } : {}) });
  lab.admission = createAdmission(lab);
  lab.relationship = createRelationship(lab);
  lab.commitments = createCommitments(lab);
  lab.facts = createFacts(lab);
  lab.observe = createObserve(lab);
  lab.selfCanon = createSelfCanon(lab);
  lab.proactive = createProactive(lab);
  lab.catchup = createCatchup(lab);
  lab.forget = createForget(lab);
  lab.jobs = createJobs(lab);
  lab.voice = createVoice(lab);
  lab.context = createContext(lab);
  lab.environment = createEnvironment(lab);
  lab.rules = createRules(lab);       // 3.0 F
  lab.director = createDirector(lab);
  lab.worldsim = createWorldSim(lab);
  lab.topics = createTopics(lab);     // 3.0 G1
  lab.scout = createScout(lab);       // 3.0 G2
  lab.practice = createPractice(lab); // 3.0 G3
  lab.bets = createBets(lab);         // 3.0 G4
  lab.life = createLife(lab);
  lab.idle = createIdle(lab);
  lab.diary = createDiary(lab);
  lab.session = createSession(lab);
  lab.turns = createTurns(lab);
  return lab;
}
