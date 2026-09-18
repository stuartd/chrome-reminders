import { matchingMeetings, manualEvent, manualOccurrences, meetCode, reminderPlan, reminderText } from './core.js';
import { getToken, isConfigured, loadCalendar } from './calendar.js';

const SYNC = 'calendar-sync';
const NEXT = 'next-reminder';
const TEST = 'test-reminder';
const SYNC_INTERVAL = 5 * 60_000;
let state;

const allEvents = () => [...state.events, ...manualOccurrences(state.manual, Date.now())].sort((a, b) => a.start - b.start);
const save = () => chrome.storage.local.set({ state });
const recordFor = event => state.records[event.key] ||= { sent: [] };

async function notificationId(event) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(event.key));
  return 'meeting:' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function badge() {
  await chrome.action.setBadgeBackgroundColor({ color: '#A33920' });
  await chrome.action.setBadgeText({ text: state.syncError || state.notificationError ? '!' : '' });
}

async function suppress(events, reason) {
  for (const event of events) {
    const record = recordFor(event);
    record.suppressed = reason;
    if (record.notificationId) await chrome.notifications.clear(record.notificationId);
  }
}

async function probeCalls(events) {
  if (!events.some(event => event.joinUrl && !state.records[event.key]?.suppressed)) return;
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  await Promise.all(tabs.map(async tab => {
    if (!matchingMeetings(events, tab.url, Date.now()).length) return;
    try {
      let timeout;
      const reply = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: 'probe-meet' }),
        new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1500); })
      ]).finally(() => clearTimeout(timeout));
      if (reply?.joined === true && meetCode(reply.url) === meetCode(tab.url)) {
        await suppress(matchingMeetings(events, tab.url, Date.now()), 'joined');
      }
    } catch { /* Closed/reloaded tabs and missing content scripts must not suppress reminders. */ }
  }));
}

async function showReminder(event, now) {
  if (await chrome.notifications.getPermissionLevel() !== 'granted') {
    state.notificationError = 'Notifications are disabled. Allow Chrome notifications in Windows Settings.';
    return false;
  }
  const id = await notificationId(event);
  const url = event.joinUrl || event.calendarUrl;
  await chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icons/icon128.png',
    title: event.title, message: `${reminderText(event, now)} · ${new Date(event.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    contextMessage: 'Meeting Reminders', priority: 2, requireInteraction: true, silent: false,
    buttons: url ? [{ title: event.joinUrl ? 'Open Meet' : 'Open Calendar' }, { title: 'Dismiss meeting' }]
      : [{ title: 'Dismiss meeting' }]
  });
  recordFor(event).notificationId = id;
  state.notificationError = null;
  return true;
}

async function reconcile() {
  const now = Date.now();
  state.manual = state.manual.filter(event => (event.repeat && event.repeat !== 'none') || event.end > now - 86_400_000);
  state.events = state.events.filter(event => event.end > now - 86_400_000);
  const events = allEvents();
  const activeKeys = new Set(events.filter(event => event.end > now).map(event => event.key));
  for (const [key, record] of Object.entries(state.records)) {
    if (!activeKeys.has(key)) {
      if (record.notificationId) await chrome.notifications.clear(record.notificationId);
      delete state.records[key];
    }
  }
  const due = events.filter(event => reminderPlan(event, state.records[event.key], now).due !== null);
  await probeCalls(due);
  for (const event of due) {
    const record = recordFor(event);
    const minutes = reminderPlan(event, record, Date.now()).due;
    if (minutes === null) continue;
    try {
      if (await showReminder(event, Date.now())) record.sent.push(minutes);
    } catch (error) { state.notificationError = `Could not show a notification: ${error.message}`; }
  }
  await save();
  await chrome.alarms.clear(NEXT);
  // Use this pass's starting time: another meeting can become due while we probe Meet.
  // Schedule a prompt follow-up for that boundary instead of skipping its stage.
  const future = events.map(event => reminderPlan(event, state.records[event.key], now).next).filter(time => time !== null);
  if (future.length) await chrome.alarms.create(NEXT, { when: Math.max(Date.now() + 100, Math.min(...future)) });
  await badge();
}

async function sync(token) {
  if (!state.connected) return;
  try {
    // Only replace the cache after every API page succeeds.
    state.events = await loadCalendar(token);
    state.lastSync = Date.now();
    state.syncError = null;
  } catch (error) { state.syncError = error.message || 'Calendar sync failed. Saved reminders are still active.'; }
  await save();
}

async function initialize() {
  // Calendar titles remain private to extension pages and the worker.
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const stored = await chrome.storage.local.get('state');
  state = { events: [], manual: [], records: {}, connected: false, lastSync: null, syncError: null, notificationError: null, ...stored.state };
  if (!await chrome.alarms.get(SYNC)) await chrome.alarms.create(SYNC, { periodInMinutes: 5 });
  // Rebuild alarms whenever Chrome starts this worker, including after a browser restart.
  if (state.connected && (!state.lastSync || Date.now() - state.lastSync >= SYNC_INTERVAL)) await sync();
  await reconcile();
}

// A single writer prevents a sync, alarm and Meet message from overwriting each other.
let queue = initialize();
function run(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.error('Meeting Reminders:', error.message));
  return result;
}
function listen(task) { void run(task).catch(() => {}); }

async function testNotification() {
  if (await chrome.notifications.getPermissionLevel() !== 'granted') throw new Error('Chrome notifications are disabled. Allow them in Windows Settings.');
  await chrome.notifications.create('test', {
    type: 'basic', iconUrl: 'icons/icon128.png', title: 'Your reminders are ready',
    message: 'This is a test. Meetings will remind you 15 minutes before, 5 minutes before, and at the start.',
    priority: 2, requireInteraction: true, silent: false
  });
}

async function handle(message) {
  switch (message.type) {
    case 'get-state':
      return { ...state, events: allEvents().filter(event => event.end > Date.now()),
        configured: isConfigured(), notificationPermission: await chrome.notifications.getPermissionLevel(),
        testAt: (await chrome.alarms.get(TEST))?.scheduledTime ?? null };
    case 'connect': {
      const token = await getToken(true);
      state.connected = true;
      await sync(token);
      await reconcile();
      if (state.syncError) throw new Error(state.syncError);
      return;
    }
    case 'sync':
      if (!state.connected) throw new Error('Connect Google Calendar first.');
      await sync();
      await reconcile();
      if (state.syncError) throw new Error(state.syncError);
      return;
    case 'disconnect':
      state.connected = false;
      state.events = [];
      state.lastSync = null;
      state.syncError = null;
      await save();
      await reconcile();
      await chrome.identity.clearAllCachedAuthTokens();
      return;
    case 'add-meeting':
      state.manual.push(manualEvent(message.meeting || {}, crypto.randomUUID(), Date.now()));
      await save();
      await reconcile();
      return;
    case 'remove-meeting':
      state.manual = state.manual.filter(event => event.key !== message.key);
      await save();
      await reconcile();
      return;
    case 'update-meeting': {
      const index = state.manual.findIndex(event => event.key === message.key);
      if (index < 0) throw new Error('Meeting no longer exists.');
      const previous = state.manual[index];
      const updated = manualEvent(message.meeting || {}, crypto.randomUUID(), Date.now(), true);
      // Keep occurrence records for title/link edits; schedule edits get fresh identities.
      if (updated.start === previous.start && updated.repeat === (previous.repeat || 'none')) updated.key = previous.key;
      state.manual[index] = { ...updated, enabled: previous.enabled !== false };
      await save();
      await reconcile();
      return;
    }
    case 'set-enabled': {
      const meeting = state.manual.find(event => event.key === message.key);
      if (!meeting) throw new Error('Meeting no longer exists.');
      if (typeof message.enabled !== 'boolean') throw new Error('Choose whether the meeting is enabled.');
      meeting.enabled = message.enabled;
      await save();
      await reconcile();
      return;
    }
    case 'dismiss':
      await suppress(allEvents().filter(event => event.key === message.key), 'dismissed');
      await reconcile();
      return;
    case 'test':
      await testNotification();
      return;
    case 'test-later':
      await chrome.alarms.create(TEST, { when: Date.now() + 60_000 });
      return;
    default: throw new Error('Unknown request.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'meet-joined') {
    // Never accept privileged operations from a website/content script.
    if (!sender.tab || sender.frameId !== 0 || !meetCode(sender.url)) return;
    run(async () => {
      const events = matchingMeetings(allEvents(), sender.url, Date.now());
      // Verify the current DOM rather than trusting a stale queued message.
      await probeCalls(events);
      await reconcile();
    }).then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
  } else {
    if (sender.url !== chrome.runtime.getURL('app.html')) return;
    run(() => handle(message)).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  }
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => listen(async () => {
  if (alarm.name === TEST) await testNotification();
  else {
    if (alarm.name === SYNC) await sync();
    await reconcile();
  }
}));
chrome.runtime.onStartup.addListener(() => listen(async () => { await sync(); await reconcile(); }));
chrome.runtime.onInstalled.addListener(() => listen(reconcile));

async function notificationAction(id, button) {
  const event = allEvents().find(item => state.records[item.key]?.notificationId === id);
  if (!event) return;
  const url = event.joinUrl || event.calendarUrl;
  // Clicking Open Meet never counts as joining: the user could remain in the waiting room.
  if (url && (button === undefined || button === 0)) await chrome.tabs.create({ url });
  else if (button !== undefined) await suppress([event], 'dismissed');
  await chrome.notifications.clear(id);
  await reconcile();
}
chrome.notifications.onClicked.addListener(id => listen(() => notificationAction(id)));
chrome.notifications.onButtonClicked.addListener((id, button) => listen(() => notificationAction(id, button)));
// Closing a Windows toast only closes that alert; use Dismiss meeting to cancel later stages.
