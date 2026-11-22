import { getStore } from '@netlify/blobs';
import { timingSafeEqual } from 'node:crypto';

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

function isAdmin(request) {
  const expected = process.env.TRIP_ADMIN_PASSWORD || '';
  const supplied = request.headers.get('x-admin-key') || '';
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Netlify Blobs: site-wide store (persists through new deployments).
// The admin password must be set in the Netlify UI, not in this source file.
export default async function handler(request) {
  try {
    const method = request.method.toUpperCase();
    if (method === 'POST') {
      return isAdmin(request) ? json({ ok: true }) : json({ error: 'Unauthorized' }, 401);
    }
    if (method !== 'GET' && method !== 'PUT') {
      return json({ error: 'Method not allowed' }, 405);
    }
    const store = getStore({ name: 'japan-family-2027', consistency: 'strong' });
    if (method === 'GET') {
      const record = await store.get('itinerary', { type: 'json', consistency: 'strong' });
      return json({ data: record?.data || null, updatedAt: record?.updatedAt || null });
    }
    if (!isAdmin(request)) return json({ error: 'Unauthorized' }, 401);
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > 200000) return json({ error: 'Payload too large' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const data = body?.data;
    if (!data || !Array.isArray(data.days) || data.days.length !== 9 ||
        !Array.isArray(data.bookings) || !Array.isArray(data.todos)) {
      return json({ error: 'Invalid trip data' }, 400);
    }
    const updatedAt = new Date().toISOString();
    data.updatedAt = updatedAt;
    await store.setJSON('itinerary', { data, updatedAt });
    return json({ ok: true, updatedAt });
  } catch (err) {
    console.error('Trip API error:', err?.message || err);
    return json({ error: 'Server or storage unavailable' }, 503);
  }
}
