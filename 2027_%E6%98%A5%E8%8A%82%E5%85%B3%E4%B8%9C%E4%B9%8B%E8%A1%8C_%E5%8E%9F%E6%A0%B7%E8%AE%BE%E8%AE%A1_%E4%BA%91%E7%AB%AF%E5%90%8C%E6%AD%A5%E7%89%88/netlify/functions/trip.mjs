import { getStore } from '@netlify/blobs';

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

// Publicly editable family travel journal. The public URL is the write permission.
// Do not store sensitive personal or booking information here.
export default async function handler(request) {
  try {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'PUT') {
      return json({ error: 'Method not allowed' }, 405);
    }
    const store = getStore({ name: 'japan-family-2027', consistency: 'strong' });
    if (method === 'GET') {
      const record = await store.get('itinerary', { type: 'json', consistency: 'strong' });
      return json({ data: record?.data || null, updatedAt: record?.updatedAt || null });
    }
    // Require the normal same-origin JSON request shape to reduce accidental cross-site writes.
    // This is not authentication: anyone can intentionally call the public endpoint.
    if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
      return json({ error: 'JSON content type required' }, 415);
    }
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== new URL(request.url).host) {
      return json({ error: 'Cross-origin write not allowed' }, 403);
    }
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
