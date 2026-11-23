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
  return !!data && Array.isArray(data.days) && data.days.length === 8 &&
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
  if (op.action === 'order') return op.target === 'todo' || (op.target === 'event' && Number.isInteger(op.dayId) && op.dayId >= 1 && op.dayId <= 8);
  if (op.target === 'day') return Number.isInteger(op.dayId) && op.dayId >= 1 && op.dayId <= 8;
  if (op.target === 'event') return Number.isInteger(op.dayId) && op.dayId >= 1 && op.dayId <= 8 && typeof op.id === 'string' && op.id.length <= 80;
  if (op.target === 'booking' || op.target === 'todo') return typeof op.id === 'string' && op.id.length <= 80;
  return op.target === 'map';
}

// Legacy migration: adjust the shared family trip from Feb 3–11 to Feb 3–10.
// It is intentionally one-time, conditional on the blob etag, and backups the original.
const OLD_DEFAULT_BOOKINGS = {
  b5: {title:'2月11日 · 各自返程',dates:'2月11日'},
  b8: {title:'箱根温泉酒店 · 2晚',dates:'2/5 入住 · 2/7 离店'},
  b9: {title:'伊豆酒店 · 1晚',dates:'2/7 入住 · 2/8 离店'},
  b10: {title:'东京酒店 · 3晚',dates:'2/8 入住 · 2/11 离店'},
};
const OLD_DEFAULT_TODOS = {
  t3:'确认2月11日每个人的返程航班',
  t5:'预订东京酒店（2月4日1晚及2月8日起3晚）',
  t6:'预订箱根温泉酒店（2月5–7日，优先除夕晚餐）',
  t7:'确定伊豆游览区域并预订2月7日酒店',
};
const OLD_MAP_INTRO = '2月5日东京取车 → 箱根连住2晚 → 2月7日伊豆 → 2月8日回东京。御殿场为富士山可选绕行地点；地图路线为位置示意，非实时道路导航。';
const OLD_EVENT_BASELINES = {
  4:[
    ['上午','visit','箱根神社 · 芦之湖','适合拍全家福；景点顺序待调整','箱根神社'],
    ['下午','visit','大涌谷或芦之湖观景','视开放情况、天气及冬季路况选择','大涌谷'],
    ['晚上','stay','温泉休闲 · 家庭晚餐','第二晚继续在箱根休息','箱根'],
  ],
  5:[
    ['上午','transit','箱根出发 · 自驾前往伊豆','具体路线取决于伊豆入住区域','伊豆'],
    ['下午','visit','伊豆观光 · 待选路线','修善寺、河津早樱或伊豆海岸择一/择二','伊豆'],
    ['晚上','stay','入住伊豆 · 温泉或海景','期待体验伊豆当地美食','伊豆'],
  ],
  8:[
    ['上午','visit','东京自由观光','浅草、上野或其他区域，可由家人商量决定','东京'],
    ['下午','visit','购物 · 购买伴手礼','保留自由时间，避免行程过满','东京'],
    ['晚上','food','最后一晚 · 家庭晚餐','可挑选一家方便长辈的餐厅','东京'],
  ],
};
function legacyTrip(data) {
  return data && Array.isArray(data.days) && data.days.length === 9 &&
    Array.isArray(data.bookings) && Array.isArray(data.todos);
}
export function migrateTripToFeb10(current, nextSeed) {
  if (!legacyTrip(current) || !validTrip(nextSeed)) throw Error('Invalid trip migration');
  const migrated = clone(nextSeed);
  migrated.version = 2;
  migrated.name = current.name || migrated.name;
  migrated.mapNotes = clone(current.mapNotes || {});
  migrated.migrationWarnings = [];
  // Retain all user edits to dates that remain unchanged, including added activities.
  for (const dayId of [1,2,3,6,7]) {
    const old = current.days.find(x => x.id === dayId);
    if (old) migrated.days[dayId - 1] = clone(old);
  }
  // Hakone is one night now; honor manually written hotel text if different.
  if (migrated.days[2].hotel === '箱根温泉酒店 · 第 1 晚')
    migrated.days[2].hotel = '箱根温泉酒店 · 1 晚';
  // Move the original return-day activities and any personal edits to Feb 10 first.
  const oldReturn = current.days.find(d => d.id === 9);
  if (oldReturn?.events?.length) migrated.days[7].events = oldReturn.events.map((ev,i) =>
    ({...clone(ev),id:ev.id?.startsWith('e9_')?'e8_'+i:'return_'+ev.id}));
  // Keep non-template activities, manually edited notes/times and confirmed events
  // on changed days so family members can relocate them instead of losing them.
  for (const dayId of [4,5,8]) {
    const old = current.days.find(x => x.id === dayId);
    if (!old) continue;
    const nextDay = migrated.days[dayId - 1];
    for (const ev of old.events || []) {
      const origIdx = Number(String(ev.id).match(new RegExp('^e'+dayId+'_(\\d+)$'))?.[1]);
      const baseline = Number.isInteger(origIdx) ? OLD_EVENT_BASELINES[dayId]?.[origIdx] : null;
      const isOriginal = !!baseline &&
        ['time','type','title','note','location'].every((k,i) => ev[k] === baseline[i]);
      const userSignificant = ev.status === 'confirmed' || ev.lat != null || ev.lng != null;
      if (isOriginal && !userSignificant) continue;
      nextDay.events.push({...clone(ev),id:'legacy_'+dayId+'_'+ev.id,
        title:'原计划待调整 · '+ev.title,
        note:(ev.note || '')+'（已保留原日程，需确认是否仍适用）',status:'planned'});
    }
  }
  // Existing confirmed reservations are never rewritten as though changed by the airline/hotel.
  migrated.bookings = (current.bookings || []).map(old => {
    const next = migrated.bookings.find(x => x.id === old.id);
    if (!next || !OLD_DEFAULT_BOOKINGS[old.id]) return clone(old);
    if (old.status === 'confirmed') {
      migrated.migrationWarnings.push({id:old.id,title:old.title || old.id,originalDates:old.dates || ''});
      return clone(old);
    }
    const changed = clone(old), original = OLD_DEFAULT_BOOKINGS[old.id];
    // Preserve custom hotel names and notes while changing pending date ranges.
    if (old.title === original.title) changed.title = next.title;
    changed.dates = next.dates;
    if (next.type === 'stay') {
      const d = [...next.dates.matchAll(/2\/(\d+)/g)].map(m=>Number(m[1]));
      if (d.length >= 2) {
        changed.checkIn = '2027-02-'+String(d[0]).padStart(2,'0');
        changed.checkOut = '2027-02-'+String(d[1]).padStart(2,'0');
      }
    }
    return changed;
  });
  // New bookings from nextSeed, if any, are appended; keep independently created bookings.
  for (const b of nextSeed.bookings) if (!migrated.bookings.some(x => x.id === b.id)) migrated.bookings.push(clone(b));
  migrated.todos = (current.todos||[]).map(t => {
    const old = OLD_DEFAULT_TODOS[t.id], next = nextSeed.todos.find(x => x.id === t.id);
    return old && next && t.text === old ? {...clone(t),text:next.text} : clone(t);
  });
  for (const t of nextSeed.todos) if(!migrated.todos.some(x => x.id === t.id)) migrated.todos.push(clone(t));
  if (!migrated.mapNotes.intro || migrated.mapNotes.intro === OLD_MAP_INTRO)
    migrated.mapNotes.intro = '2月5日东京取车 → 箱根住1晚 → 2月6日伊豆连住2晚 → 2月8日回东京；富士山为路线备选。';
  return migrated;
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
      if (!['event','todo'].includes(op.target) || !Array.isArray(op.ids) || !Array.isArray(op.beforeIds) ||
          op.ids.length > 250 || op.beforeIds.length > 250 ||
          op.ids.some(id => typeof id !== 'string' || id.length > 80) ||
          op.beforeIds.some(id => typeof id !== 'string' || id.length > 80) ||
          new Set(op.ids).size !== op.ids.length || new Set(op.beforeIds).size !== op.beforeIds.length)
        return {error:'Invalid order'};
      const list = listFor(data, op);
      if (!list) return {error:'Invalid order target'};
      const actualBase = list.filter(x => op.beforeIds.includes(x.id)).map(x => x.id);
      const expectedBase = op.beforeIds.filter(id => list.some(x => x.id === id));
      const alreadyOrdered = op.ids.filter(id => list.some(x => x.id === id)).join('|') ===
        list.filter(x => op.ids.includes(x.id)).map(x => x.id).join('|');
      if (!equal(actualBase, expectedBase) && !alreadyOrdered) {
        conflicts.push(op.target === 'event' ? `event order:${op.dayId}` : 'todo order');
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
    if (method !== 'GET' && method !== 'PATCH' && method !== 'PUT' && method !== 'POST') {
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
    if (method === 'POST') {
      if (body?.action !== 'migrate-feb10-2027' || !validTrip(body.seed))
        return json({error:'Invalid migration request'},400);
      for (let attempt=0;attempt<MAX_TRIES;attempt++) {
        const entry=await store.getWithMetadata(RECORD_KEY,{type:'json',consistency:'strong'});
        if (validTrip(entry?.data?.data)) {
          return json({ok:true,alreadyMigrated:true,data:entry.data.data,
            updatedAt:entry.data.updatedAt,revision:entry.etag});
        }
        if (!legacyTrip(entry?.data?.data))
          return json({error:'No compatible legacy itinerary to migrate'},409);
        const original=entry.data.data;
        const migrated=migrateTripToFeb10(original,body.seed);
        const now=new Date().toISOString();migrated.updatedAt=now;
        // Create an immutable, server-side copy before modifying the shared live itinerary.
        const backupKey='backup-feb10-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
        await store.setJSON(backupKey,{data:original,updatedAt:entry.data.updatedAt,
          sourceRevision:entry.etag,createdAt:now},{onlyIfNew:true});
        migrated.planMigration={at:now,backupKey,from:'2027-02-11',to:'2027-02-10'};
        const saved=await store.setJSON(RECORD_KEY,{data:migrated,updatedAt:now},
          {onlyIfMatch:entry.etag});
        if(saved.modified)return json({ok:true,migrated:true,data:migrated,
          updatedAt:now,revision:saved.etag});
      }
      return json({error:'其他家人正在修改，请重试'},409);
    }
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
      if (!validTrip(seed)) return json({error:'请刷新网页，并完成2月10日返程行程更新'}, 409);
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
