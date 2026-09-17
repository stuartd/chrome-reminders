import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEvents, loadCalendar } from '../extension/calendar.js';

const item = { id: 'a', start: { dateTime: '2026-09-18T10:00:00Z' }, end: { dateTime: '2026-09-18T11:00:00Z' } };
test('calendar sync expands recurring events and follows all pages', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => requests.length === 1 ? { items: [item], nextPageToken: 'second' } : { items: [{ ...item, id: 'b' }] } };
  });
  const events = await fetchEvents('test-token', Date.parse('2026-09-18T08:00:00Z'));
  assert.equal(events.length, 2);
  assert.equal(requests[0].url.searchParams.get('singleEvents'), 'true');
  assert.equal(requests[1].url.searchParams.get('pageToken'), 'second');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
});

test('a later-page error rejects the whole sync instead of returning a partial calendar', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? { ok: true, json: async () => ({ items: [item], nextPageToken: 'second' }) } : { ok: false, status: 503 });
  await assert.rejects(fetchEvents('test-token'), /503/);
});

test('expired tokens are removed and retried once without an interactive prompt', async t => {
  let calls = 0;
  const removed = [];
  globalThis.chrome = { runtime: { getManifest: () => ({ oauth2: { client_id: 'configured' } }) }, identity: {
    removeCachedAuthToken: async details => removed.push(details.token),
    getAuthToken: async options => { assert.equal(options.interactive, false); return { token: 'fresh' }; }
  } };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (++calls === 1) return { ok: false, status: 401 };
    assert.equal(options.headers.Authorization, 'Bearer fresh');
    return { ok: true, json: async () => ({ items: [item] }) };
  });
  assert.equal((await loadCalendar('expired')).length, 1);
  assert.deepEqual(removed, ['expired']);
});
