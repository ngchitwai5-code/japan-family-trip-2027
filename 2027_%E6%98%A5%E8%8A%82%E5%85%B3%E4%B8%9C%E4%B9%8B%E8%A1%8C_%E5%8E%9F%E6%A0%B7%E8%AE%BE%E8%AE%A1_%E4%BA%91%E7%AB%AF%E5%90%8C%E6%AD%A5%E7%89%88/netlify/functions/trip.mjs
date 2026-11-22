import { getStore } from '@netlify/blobs';

// Shared trip: anyone with the public URL can write. Do not add private booking details.
// The current site's original blob name/key are retained to preserve existing cloud data.
const STORE_NAME = 'japan-family-2027';
const RECORD_KEY = 'itinerary';
const MAX_TRIES = 8;
const DAY_FIELDS = new Set(['title', 'summary', 'hotel', 'icon', 'place', 'holiday']);
const EVENT_FIELDS = new Set(['time', 'type', 'title', 'note', 'location', 'status', 'dotColor', 'lat', 'lng']);
const BOOKING_FIELDS = new Set(['type', 'title', 'dates', 'people', 'details', 'status', 'location', 'reference', 'checkIn', 'checkOut']);
const TODO_FIELDS = new Set(['text', 'done']);
const MAP_FIELDS = new Set(['intro', 'warning']);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => JSON.parse(JSON.stringify(value));

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
  });
}

function validTrip(data) {
  return !!data && Array.isArray(data.days) && data.days.length === 9 &&
    Array.isArray(data.bookings) && Array.isArray(data.todos) &&
    data.days.every(d => d && Number.isInteger(d.id) && d.id >= 1 && d.id <= 9 && Array.isArray(d.events));
}

function findTarget(data, op) {
  if (op.target === 'day') return data.days.find(d => d.id === op.dayId);
  if (op.target === 'event') return data.days.find(d => d.id === op.dayId)?.events?.find(x => x.id === op.id);
  if (op.target === 'booking') return data.bookings.find(x => x.id === op.id);
  if (op.target === 'todo') return data.todos.find(x => x.id === op.id);
  if (op.target === 'map') {
    data.mapNotes ??= {};
    return data.mapNotes;
  }
  return null;
}
function listFor(data, op) {
  if (op.target === 'event') return data.days.find(d => d.id === op.dayId)?.events;
  if (op.target === 'booking') return data.bookings;
  if (op.target === 'todo') return data.todos;
  return null;
}
function fieldAllowed(target, key) {
  return target === 'day' ? DAY_FIELDS.has(key) :
    target === 'event' ? EVENT_FIELDS.has(key) :
    target === 'booking' ? BOOKING_FIELDS.has(key) :
    target === 'todo' ? TODO_FIELDS.has(key) :
    target === 'map' ? (MAP_FIELDS.has(key) || /^stop[0-4]$/.test(key)) : false;
}
function readField(target, obj, key) {
  if (target === 'map' && key.startsWith('stop')) {
    const idx = Number(key.slice(4));
    return {has: own(obj?.stops, idx), value: obj?.stops?.[idx]};
  }
  return {has: own(obj, key), value: obj?.[key]};
}
function writeField(target, obj, key, value) {
  if (target === 'map' && key.startsWith('stop')) {
    obj.stops ??= [];
    obj.stops[Number(key.slice(4))] = value;
  } else {
    obj[key] = value;
  }
}
function validateId(op) {
  if (op.action === 'order') return op.target === 'event' && Number.isInteger(op.dayId) && op.dayId >= 1 && op.dayId <= 9;
  if (op.target === 'day') return Number.isInteger(op.dayId) && op.dayId >= 1 && op.dayId <= 9;
  if (op.target === 'event') return Number.isInteger(op.dayId) && op.dayId >= 1 && op.dayId <= 9 && typeof op.id === 'string' && op.id.length <= 80;
  if (op.target === 'booking' || op.target === 'todo') return typeof op.id === 'string' && op.id.length <= 80;
  return op.target === 'map';
}

// All edits are applied to the freshest cloud document. Unrelated edits merge;
// editing an identical field from two devices returns 409 instead of silent overwrite.
export function applyTripOps(source, ops) {
  if (!validTrip(source) || !Array.isArray(ops) || ops.length > 250) {
    return { error: 'Invalid trip data or operations' };
  }
  const data = clone(source);
  const conflicts = [];
  for (const op of ops) {
    if (!op || !['set', 'add', 'remove', 'order'].includes(op.action) || !validateId(op)) {
      return {error: 'Invalid operation'};
    }
    const target = findTarget(data, op);
    if (op.action === 'set') {
      if (!target || !op.fields || typeof op.fields !== 'object' || Array.isArray(op.fields)) {
        conflicts.push(`${op.target}:${op.id ?? op.dayId ?? 'map'} missing`); continue;
      }
      for (const [field, change] of Object.entries(op.fields)) {
        if (!fieldAllowed(op.target, field) || !change || !own(change, 'value')) return {error:'Invalid field'};
        const current = readField(op.target, target, field);
        const baseMatches = current.has === !!change.hadBefore && (!current.has || equal(current.value, change.before));
        if (!baseMatches && !equal(current.value, change.value)) {
          conflicts.push(`${op.target}:${op.id ?? op.dayId ?? 'map'}.${field}`); continue;
        }
        writeField(op.target, target, field, change.value);
      }
    } else if (op.action === 'add') {
      const list = listFor(data, op);
      if (!list || !op.value || op.value.id !== op.id || typeof op.id !== 'string') return {error:'Invalid add'};
      const existing = list.find(x => x.id === op.id);
      if (existing && !equal(existing, op.value)) conflicts.push(`${op.target}:${op.id} already exists`);
      else if (!existing) list.push(clone(op.value));
    } else if (op.action === 'remove') {
      const list = listFor(data, op);
      if (!list) return {error:'Invalid remove'};
      const idx = list.findIndex(x => x.id === op.id);
      if (idx >= 0 && !equal(list[idx], op.before)) conflicts.push(`${op.target}:${op.id} changed`);
      else if (idx >= 0) list.splice(idx, 1);
    } else if (op.action === 'order') {
      if (op.target !== 'event' || !Array.isArray(op.ids) || !Array.isArray(op.beforeIds)) return {error:'Invalid order'};
      const list = listFor(data, op);
      if (!list) return {error:'Invalid order target'};
      const actualBase = list.filter(x => op.beforeIds.includes(x.id)).map(x => x.id);
      const expectedBase = op.beforeIds.filter(id => list.some(x => x.id === id));
      const alreadyOrdered = op.ids.filter(id => list.some(x => x.id === id)).join('|') ===
        list.filter(x => op.ids.includes(x.id)).map(x => x.id).join('|');
      if (!equal(actualBase, expectedBase) && !alreadyOrdered) {
        conflicts.push(`event order:${op.dayId}`);
      } else {
        const orderMap = new Map(list.map(x => [x.id, x]));
        list.splice(0, list.length, ...op.ids.filter(id => orderMap.has(id)).map(id => orderMap.get(id)),
          ...list.filter(x => !op.ids.includes(x.id)));
      }
    }
  }
  return conflicts.length ? {conflicts} : {data};
}

export default async function handler(request) {
  try {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'PATCH' && method !== 'PUT') {
      return json({error:'Method not allowed'}, 405);
    }
    const store = getStore({name: STORE_NAME, consistency:'strong'});
    if (method === 'GET') {
      const entry = await store.getWithMetadata(RECORD_KEY, {type:'json', consistency:'strong'});
      const record = entry?.data;
      return json({data:record?.data || null, updatedAt:record?.updatedAt || null,
        revision:entry?.etag || null});
    }
    if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
      return json({error:'JSON content type required'}, 415);
    }
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== new URL(request.url).host) {
      return json({error:'Cross-origin write not allowed'}, 403);
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > 200000) return json({error:'Payload too large'}, 413);
    let body;
    try {body = JSON.parse(raw);} catch {return json({error:'Invalid JSON'}, 400);}
    if (method === 'PUT') {
      // Old clients must not overwrite the whole trip after this upgrade.
      // A one-time legacy initialization is allowed only when no trip exists.
      if (!validTrip(body?.data)) return json({error:'Invalid trip data'}, 400);
      const updatedAt = new Date().toISOString();
      const initial = clone(body.data);
      initial.updatedAt = updatedAt;
      const written = await store.setJSON(RECORD_KEY, {data:initial, updatedAt}, {onlyIfNew:true});
      if (!written.modified) return json({error:'请刷新网页到最新版本，以免覆盖家人的修改'}, 409);
      return json({ok:true,data:initial, updatedAt, revision:written.etag});
    }
    if (!Array.isArray(body?.ops) || body.ops.length > 250 ||
        (body.ops.length === 0 && !validTrip(body.seed))) {
      return json({error:'Invalid patch'}, 400);
    }
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const entry = await store.getWithMetadata(RECORD_KEY, {type:'json',consistency:'strong'});
      const seed = entry?.data?.data || body.seed;
      if (!validTrip(seed)) return json({error:'Missing initial trip document'}, 400);
      const result = applyTripOps(seed, body.ops);
      if (result.error) return json({error:result.error}, 400);
      if (result.conflicts) return json({error:'Family edit conflict', conflicts:result.conflicts}, 409);
      const updatedAt = new Date().toISOString();
      result.data.updatedAt = updatedAt;
      const stored = await store.setJSON(RECORD_KEY, {data:result.data,updatedAt},
        entry ? {onlyIfMatch:entry.etag} : {onlyIfNew:true});
      if (stored.modified) {
        return json({ok:true,data:result.data,updatedAt,revision:stored.etag});
      }
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 14));
    }
    return json({error:'同时编辑较多，请重试', retryable:true}, 409);
  } catch (err) {
    console.error('Trip API error:', err?.stack || err);
    return json({error:'Server or storage unavailable'}, 503);
  }
}
