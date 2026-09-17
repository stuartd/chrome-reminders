import test from 'node:test';
import assert from 'node:assert/strict';

const MINUTE = 60_000;
const baseline = Date.parse('2026-09-18T09:00:00Z');
const meeting = (patch = {}) => ({ key: 'manual:one', source: 'manual', title: 'Stand-up', start: baseline + 15 * MINUTE, end: baseline + 45 * MINUTE, joinUrl: 'https://meet.google.com/abc-defg-hij', calendarUrl: null, ...patch });
let instance = 0;

async function harness(t, seed = {}) {
  let now = baseline;
  t.mock.method(Date, 'now', () => now);
  const event = () => { const listeners = []; return { listeners, addListener(fn) { listeners.push(fn); } }; };
  const alarms = new Map();
  const notifications = new Map();
  const shown = [];
  const opened = [];
  let stored = structuredClone({ state: { manual: [], events: [], records: {}, connected: false, ...seed } });
  const tabs = [];
  const replies = new Map();
  const chrome = globalThis.chrome = {
    runtime: { id: 'test-extension', getManifest: () => ({}), getURL: path => `chrome-extension://test-extension/${path}`, onMessage: event(), onStartup: event(), onInstalled: event() },
    storage: { local: {
      setAccessLevel: async () => {}, get: async () => structuredClone(stored),
      set: async value => { stored = structuredClone({ ...stored, ...value }); }
    } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { get: async key => alarms.get(key), create: async (key, alarm) => alarms.set(key, { ...alarm, scheduledTime: alarm.when }), clear: async key => alarms.delete(key), onAlarm: event() },
    notifications: {
      getPermissionLevel: async () => 'granted',
      create: async (id, options) => { shown.push({ id, options }); notifications.set(id, options); return id; },
      clear: async id => notifications.delete(id), onClicked: event(), onButtonClicked: event()
    },
    tabs: { query: async () => tabs, sendMessage: async id => replies.get(id), create: async options => opened.push(options) },
    identity: { clearAllCachedAuthTokens: async () => {} }
  };
  await import(`../extension/background.js?test=${++instance}`);
  async function request(message, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('app.html') }) {
    return new Promise(resolve => {
      const accepted = chrome.runtime.onMessage.listeners[0](message, sender, resolve);
      if (!accepted) resolve(undefined);
    });
  }
  const flush = () => request({ type: 'get-state' });
  await flush();
  return { chrome, alarms, shown, notifications, opened, tabs, replies, request, flush,
    state: () => stored.state, time: value => { now = value; },
    alarm: async name => { chrome.alarms.onAlarm.listeners[0]({ name }); await flush(); },
    click: async (id, index) => { chrome.notifications.onButtonClicked.listeners[0](id, index); await flush(); }
  };
}

test('worker sends 15/5/0 once each and reconstructs its next alarm', async t => {
  const h = await harness(t, { manual: [meeting()] });
  assert.equal(h.shown.length, 1);
  assert.equal(h.alarms.get('next-reminder').when, baseline + 10 * MINUTE);
  await h.alarm('next-reminder');
  assert.equal(h.shown.length, 1);
  h.time(baseline + 10 * MINUTE);
  await h.alarm('next-reminder');
  h.time(baseline + 15 * MINUTE);
  await h.alarm('next-reminder');
  assert.equal(h.shown.length, 3);
  assert.deepEqual(h.state().records['manual:one'].sent, [15, 5, 0]);
  assert.equal(h.alarms.has('next-reminder'), false);
  assert.equal(h.shown[0].options.requireInteraction, true);
});

test('a recreated worker restores future alarms without repeating persisted alerts', async t => {
  const h = await harness(t, { manual: [meeting()], records: { 'manual:one': { sent: [15] } } });
  assert.equal(h.shown.length, 0);
  assert.equal(h.alarms.get('next-reminder').when, baseline + 10 * MINUTE);
});

test('active Meet call suppresses only matching occurrences, not next week', async t => {
  const h = await harness(t, { manual: [meeting({ start: baseline + 16 * MINUTE }), meeting({ key: 'manual:next-week', start: baseline + 7 * 86_400_000, end: baseline + 7 * 86_400_000 + 30 * MINUTE })] });
  h.tabs.push({ id: 1, url: meeting().joinUrl });
  h.replies.set(1, { joined: true, url: meeting().joinUrl });
  h.time(baseline + MINUTE);
  await h.alarm('next-reminder');
  assert.equal(h.shown.length, 0);
  assert.equal(h.state().records['manual:one'].suppressed, 'joined');
  assert.equal(h.state().records['manual:next-week'], undefined);
  assert.equal(h.alarms.get('next-reminder').when, baseline + 7 * 86_400_000 - 15 * MINUTE);
});

test('waiting room and unavailable Meet scripts keep reminders enabled', async t => {
  const h = await harness(t, { manual: [meeting({ start: baseline + 16 * MINUTE })] });
  h.tabs.push({ id: 1, url: meeting().joinUrl });
  h.replies.set(1, { joined: false, url: meeting().joinUrl });
  h.time(baseline + MINUTE);
  await h.alarm('next-reminder');
  assert.equal(h.shown.length, 1);
  h.replies.delete(1);
  h.time(baseline + 11 * MINUTE);
  await h.alarm('next-reminder');
  assert.equal(h.shown.length, 2);
});

test('Open Meet does not mark joined; Dismiss meeting cancels future alerts', async t => {
  const h = await harness(t, { manual: [meeting()] });
  await h.click(h.shown[0].id, 0);
  assert.equal(h.opened[0].url, meeting().joinUrl);
  assert.equal(h.state().records['manual:one'].suppressed, undefined);
  h.time(baseline + 10 * MINUTE);
  await h.alarm('next-reminder');
  await h.click(h.shown.at(-1).id, 1);
  h.time(baseline + 15 * MINUTE);
  await h.alarm('next-reminder');
  assert.equal(h.shown.length, 2);
  assert.equal(h.state().records['manual:one'].suppressed, 'dismissed');
});

test('disconnect deletes Google meetings and alarms but preserves manual meetings', async t => {
  const google = meeting({ key: 'google:one', source: 'google', start: baseline + 60 * MINUTE });
  const manual = meeting({ start: baseline + 120 * MINUTE });
  const h = await harness(t, { connected: true, lastSync: baseline, events: [google], manual: [manual] });
  assert.equal((await h.request({ type: 'disconnect' })).ok, true);
  assert.deepEqual(h.state().events, []);
  assert.equal(h.state().manual.length, 1);
  assert.equal(h.alarms.get('next-reminder').when, manual.start - 15 * MINUTE);
});

test('content scripts cannot invoke privileged UI operations', async t => {
  const h = await harness(t);
  const result = await h.request({ type: 'test' }, { id: h.chrome.runtime.id, tab: { id: 1 }, url: meeting().joinUrl, frameId: 0 });
  assert.equal(result, undefined);
  assert.equal(h.shown.length, 0);
});

test('denied notifications surface an error without marking the reminder delivered', async t => {
  const h = await harness(t, { manual: [meeting({ start: baseline + 16 * MINUTE })] });
  h.chrome.notifications.getPermissionLevel = async () => 'denied';
  h.time(baseline + MINUTE);
  await h.alarm('next-reminder');
  assert.equal(h.shown.length, 0);
  assert.match(h.state().notificationError, /disabled/);
  assert.deepEqual(h.state().records['manual:one'].sent, []);
});

test('background test uses a Chrome alarm independently of the popup', async t => {
  const h = await harness(t);
  assert.equal((await h.request({ type: 'test-later' })).ok, true);
  assert.equal(h.alarms.get('test-reminder').when, baseline + MINUTE);
  h.time(baseline + MINUTE);
  await h.alarm('test-reminder');
  assert.equal(h.shown[0].id, 'test');
});

test('a successful refresh removes cancelled events, visible alerts and pending alarms', async t => {
  const h = await harness(t, { connected: true, lastSync: baseline, events: [meeting({ key: 'google:one', source: 'google' })] });
  h.chrome.runtime.getManifest = () => ({ oauth2: { client_id: 'configured' } });
  h.chrome.identity.getAuthToken = async () => ({ token: 'test' });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ items: [] }) }));
  assert.equal(h.notifications.size, 1);
  await h.alarm('calendar-sync');
  assert.deepEqual(h.state().events, []);
  assert.equal(h.notifications.size, 0);
  assert.equal(h.alarms.has('next-reminder'), false);
});

test('failed Calendar sync preserves cached events and still delivers the due reminder', async t => {
  const h = await harness(t, { connected: true, lastSync: baseline, events: [meeting({ key: 'google:one', source: 'google', start: baseline + 16 * MINUTE })] });
  h.chrome.runtime.getManifest = () => ({ oauth2: { client_id: 'configured' } });
  h.chrome.identity.getAuthToken = async () => ({ token: 'test' });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline'); });
  h.time(baseline + MINUTE);
  await h.alarm('calendar-sync');
  assert.equal(h.state().events.length, 1);
  assert.equal(h.state().syncError, 'Offline');
  assert.equal(h.shown.length, 1);
});

test('the full options page can send requests even when Chrome includes its tab', async t => {
  const h = await harness(t);
  assert.equal((await h.request({ type: 'get-state' }, { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('app.html'), tab: { id: 42 } })).ok, true);
});

test('a meeting becoming due during notification delivery gets an immediate follow-up alarm', async t => {
  const h = await harness(t, { manual: [meeting({ start: baseline + 16 * MINUTE }), meeting({ key: 'manual:second', start: baseline + 16 * MINUTE + 500 })] });
  h.time(baseline + MINUTE);
  h.chrome.notifications.getPermissionLevel = async () => { h.time(baseline + MINUTE + 1000); return 'granted'; };
  await h.alarm('next-reminder');
  assert.equal(h.shown.length, 1);
  assert.equal(h.alarms.get('next-reminder').when, baseline + MINUTE + 1100);
  h.time(baseline + MINUTE + 1100);
  await h.alarm('next-reminder');
  assert.equal(h.shown.length, 2);
});
