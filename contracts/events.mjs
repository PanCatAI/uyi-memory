// Event types of the world ledger. lib/ledger.mjs calls validateEvent() before every insert.
// The host (server) is the only writer: model output becomes char_said / char_action only after the arbiter allows it.
// Changing this file changes the contract: ask under PROGRESS.md "## 待确认" first.

export const ACTORS_FIXED = ['user', 'host'];
export const OUTCOMES = ['ok', 'failed', 'interrupted'];
export const PRESENCE = ['present', 'maybe', 'absent'];

// payload: the deletable content. Every key listed is required; strings must be non-empty unless noted.
// actor: 'user' | 'host' | 'character' (any character id from the scene).
export const EVENT_TYPES = {
  session_start: { actor: 'host', payload: { gap_ms: 'number' } },
  session_end: { actor: 'host', payload: {} },
  time_skip: { actor: 'host', payload: { from: 'number', to: 'number' } },

  user_said: { actor: 'user', payload: { text: 'string', to: 'string' } },            // to = character id
  char_said: { actor: 'character', payload: { text: 'string', to: 'string', used: 'array', proactive: 'boolean' } },

  user_action: { actor: 'user', needs: ['action'], payload: { args: 'object' } },     // user does something in 3D: give, place_object, move_object, build; 3.0: cover_wood, help { incident }, scout { dir, finds }
  char_action: { actor: 'character', needs: ['action', 'outcome'], payload: { args: 'object', reason: 'string?', routine: 'boolean?', slot: 'string?' } }, // 2.0 D1: routine = done by the 作息, slot = "2026-10-21@05:30"
  char_moved: { actor: 'character', needs: ['target'], payload: { from: 'string', to: 'string' } }, // target = room id

  object_changed: { actor: 'host', needs: ['target'], payload: { field: 'string', from: 'any', to: 'any' } },
  object_created: { actor: 'host', needs: ['target'], payload: { object: 'object' } },
  object_removed: { actor: 'host', needs: ['target'], payload: {} },

  memory_op: { actor: 'host', payload: { op: 'string', job: 'string' } },             // op: suppress | forget | delete | correct

  // 2.0 C1: the save's scene was imported from 造物台. files: [{ path, sha256 }] under data/assets/<save>/.
  // 2.0 C2: a re-import found an object added / removed / moved (>0.3 m) in 造物台. The user built it, as the creator.
  // object: the full object for add, its id otherwise. from/to: { room, pos } (to may carry sit/facing).
  world_edit: { actor: 'user', needs: ['target'], payload: { op: 'string', object: 'any', by: 'string', from: 'object?', to: 'object?' } },
  // 2.0 C5: the host's weather for a world day (kind 晴|阴|小雨|起雾, day '2026-10-20'), and a fire burning out.
  // 3.0 F2: with features.world kind is one of 晴|阴|小雨|大雨|起雾|大风|雪 and the day's temperatures and wind come too.
  weather: { actor: 'host', payload: { kind: 'string', day: 'string', temp_hi: 'number?', temp_lo: 'number?', wind: 'string?' } },
  relationship_stage: { actor: 'host', needs: ['target'], payload: { from: 'string', to: 'string' } }, // 2.0 D5: target = character id
  fire_out: { actor: 'host', needs: ['target'], payload: { since: 'number' } },
  // 3.0 F (contracts/world.md): the camp's 量, the weather turning during a day, the evening sky, incidents, shared
  // activities and bets. All written by the host. cause is Chinese ("晚饭", "下雨", "岚拾柴").
  var_changed: { actor: 'host', payload: { var: 'string', from: 'any', to: 'any', cause: 'string' } },
  weather_change: { actor: 'host', payload: { kind: 'string', from: 'string', cause: 'string?' } },
  sky_sign: { actor: 'host', payload: { sign: 'string', day: 'string' } },
  // phase start|resolved|expired; target = an object id when the incident is about one. by: char|user|together|host.
  incident: { actor: 'host', payload: { incident: 'string', phase: 'string', sev: 'number', by: 'string?', how: 'string?', lasting: 'boolean?', deadline: 'number?', news: 'string?' } },
  practice: { actor: 'host', payload: { practice: 'string', phase: 'string', step: 'number?', outcome: 'string?', by: 'string?' } }, // 3.0 G3
  bet: { actor: 'host', payload: { phase: 'string', about: 'string', her_pick: 'string', user_pick: 'string', stake: 'string', winner: 'string?' } }, // 3.0 G4
  scene_imported: { actor: 'host', payload: { source: 'string', scene_asset_id: 'string', layout_updated_at: 'string?', files: 'array' } }
};

const typeOk = (kind, v) => {
  if (kind === 'any') return true;
  if (kind.endsWith('?')) return v === undefined || v === null || typeOk(kind.slice(0, -1), v);
  if (kind === 'array') return Array.isArray(v);
  if (kind === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (kind === 'string') return typeof v === 'string' && v.length > 0;
  return typeof v === kind;
};

/**
 * ev: { type, actor, action?, target?, outcome?, room?, perceivers?, user_presence?, offscreen?, payload }
 * characterIds: ids of the characters in this save's scene.
 * Returns [] when valid, else a list of Chinese error strings.
 */
export function validateEvent(ev, characterIds = []) {
  const errors = [];
  const spec = EVENT_TYPES[ev?.type];
  if (!spec) return [`未知事件类型：${ev?.type}`];
  const isChar = characterIds.includes(ev.actor);
  if (spec.actor === 'character' ? !isChar : ev.actor !== spec.actor) errors.push(`${ev.type} 的 actor 不对：${ev.actor}`);
  for (const k of spec.needs || []) if (!ev[k]) errors.push(`${ev.type} 缺少 ${k}`);
  if (ev.outcome != null && !OUTCOMES.includes(ev.outcome)) errors.push(`outcome 只能是 ${OUTCOMES.join('/')}`);
  if (ev.user_presence != null && !PRESENCE.includes(ev.user_presence)) errors.push(`user_presence 只能是 ${PRESENCE.join('/')}`);
  if (ev.perceivers != null && (!Array.isArray(ev.perceivers) || ev.perceivers.some(id => !characterIds.includes(id)))) errors.push('perceivers 必须是本场景的角色 id 数组');
  const payload = ev.payload ?? {};
  if (typeof payload !== 'object' || Array.isArray(payload)) return [...errors, 'payload 必须是对象'];
  for (const [k, kind] of Object.entries(spec.payload)) if (!typeOk(kind, payload[k])) errors.push(`${ev.type}.payload.${k} 应为 ${kind}`);
  if (ev.type === 'user_said' && payload.to && !characterIds.includes(payload.to)) errors.push('user_said.payload.to 必须是角色 id');
  return errors;
}

/** Event types whose payload holds words someone said. Forget/delete jobs search these. */
export const SPEECH_TYPES = ['user_said', 'char_said'];

/** Only these sources may produce user facts (rule 3 in AGENTS.md). */
export const FACT_SOURCE_TYPES = ['user_said', 'user_action', 'char_action', 'object_changed', 'object_created'];
