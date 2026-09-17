const $ = selector => document.querySelector(selector);
let busy = false;

async function request(type, extra = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...extra });
  if (!reply?.ok) throw new Error(reply?.error || 'The extension did not respond. Reload it in chrome://extensions.');
  return reply.data;
}

function feedback(message, error = false) {
  $('#feedback').hidden = !message;
  $('#feedback').textContent = message;
  $('#feedback').classList.toggle('error', error);
}

async function action(task, success) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await task(); feedback(success || ''); }
  catch (error) { feedback(error.message, true); }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    await refresh().catch(error => feedback(error.message, true));
  }
}

function button(text, callback) {
  const element = document.createElement('button');
  element.textContent = text;
  element.addEventListener('click', callback);
  return element;
}

function renderMeeting(event, record) {
  const card = document.createElement('article');
  card.className = 'meeting';
  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = new Date(event.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const title = document.createElement('h3');
  title.textContent = event.title;
  const status = document.createElement('p');
  status.textContent = record?.suppressed === 'joined' ? 'Joined · remaining reminders skipped'
    : record?.suppressed ? 'Dismissed · remaining reminders skipped'
      : `${event.source === 'manual' ? 'Added manually' : 'Google Calendar'} · ${event.start <= Date.now() ? 'In progress' : 'Reminders scheduled'}`;
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (event.joinUrl || event.calendarUrl) {
    const link = document.createElement('a');
    link.href = event.joinUrl || event.calendarUrl;
    link.textContent = event.joinUrl ? 'Open Meet ↗' : 'Open event ↗';
    link.target = '_blank';
    link.rel = 'noreferrer';
    actions.append(link);
  }
  if (!record?.suppressed) actions.append(button('Dismiss meeting', () => action(() => request('dismiss', { key: event.key }), 'Remaining reminders for this meeting dismissed.')));
  if (event.source === 'manual') actions.append(button('Remove', () => action(() => request('remove-meeting', { key: event.key }), 'Meeting removed.')));
  card.append(when, title, status, actions);
  return card;
}

async function refresh() {
  const state = await request('get-state');
  $('#connection').textContent = state.connected ? state.syncError ? 'Needs attention' : 'Connected' : 'Not connected';
  $('#connection').classList.toggle('connected', state.connected && !state.syncError);
  $('#calendar-status').textContent = state.syncError || (state.connected
    ? `Primary calendar · next 7 days. Last synced ${state.lastSync ? new Date(state.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'never'}. Refreshes every 5 minutes.`
    : 'Connect your work Google account to find upcoming meetings automatically.');
  $('#connect').hidden = state.connected && !state.syncError;
  $('#connect').textContent = state.connected ? 'Reconnect Calendar' : 'Connect Google Calendar';
  $('#connect').disabled = !state.configured;
  $('#setup').hidden = state.configured;
  $('#sync').hidden = !state.connected;
  $('#disconnect').hidden = !state.connected;
  $('#notification-status').textContent = state.notificationError || (state.notificationPermission !== 'granted'
    ? 'Notifications are disabled. Allow Chrome notifications in Windows Settings.'
    : 'Windows must allow Chrome notifications. Focus / Do Not Disturb can silence or hide them.');
  $('#test-status').textContent = state.testAt ? `Test scheduled for ${new Date(state.testAt).toLocaleTimeString()}. Switch to your editor now.` : '';
  $('#event-count').textContent = String(state.events.length);
  const list = $('#events');
  list.replaceChildren(...state.events.map(event => renderMeeting(event, state.records[event.key])));
  if (!state.events.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.connected ? 'No upcoming timed events found in your primary calendar. All-day events and declined invitations are skipped.' : 'Your next meeting will appear here. Connect Calendar or add one manually.';
    list.append(empty);
  }
}

for (const [id, message] of Object.entries({
  connect: 'Calendar connected.', sync: 'Calendar refreshed.', disconnect: 'Calendar disconnected. Manually added meetings remain.',
  test: 'Test sent. Check for a Windows desktop notification.', 'test-later': 'Test scheduled. Switch to your editor; the notification should arrive in about a minute.'
})) $(`#${id}`).addEventListener('click', () => action(() => request(id), message));

$('#meeting-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const meeting = Object.fromEntries(new FormData(form));
  void action(async () => { await request('add-meeting', { meeting }); form.reset(); }, 'Meeting added. Reminders are scheduled for 15 minutes before, 5 minutes before, and the start.');
});

let refreshTimer;
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local' || busy) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(error => feedback(error.message, true)), 150);
});
refresh().catch(error => feedback(error.message, true));
