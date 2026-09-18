const $ = selector => document.querySelector(selector);
let busy = false;
let editingKey = null;
const repeats = { none: 'One-off', weekdays: 'Every weekday', weekly: 'Every week', fortnightly: 'Every 2 weeks' };

function resetEditor() {
  editingKey = null;
  $('#meeting-form').reset();
  $('#editor-title').textContent = 'Add a meeting';
  $('#save-meeting').textContent = 'Add meeting';
  $('#cancel-edit').hidden = true;
}

function editMeeting(meeting) {
  editingKey = meeting.key;
  const form = $('#meeting-form');
  const date = new Date(meeting.start);
  const pad = value => String(value).padStart(2, '0');
  form.elements.title.value = meeting.title;
  form.elements.start.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  form.elements.duration.value = (meeting.end - meeting.start) / 60_000;
  form.elements.repeat.value = meeting.repeat || 'none';
  form.elements.joinUrl.value = meeting.joinUrl || '';
  $('#editor-title').textContent = 'Edit meeting';
  $('#save-meeting').textContent = 'Save changes';
  $('#cancel-edit').hidden = false;
  $('#meeting-editor').open = true;
  form.elements.title.focus();
}

function renderSaved(meeting) {
  const row = document.createElement('article');
  row.className = 'meeting';
  const title = document.createElement('h3');
  title.textContent = meeting.title;
  const schedule = document.createElement('p');
  schedule.textContent = `${repeats[meeting.repeat || 'none']} · ${new Date(meeting.start).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${(meeting.end - meeting.start) / 60_000} min`;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const label = document.createElement('label');
  label.className = 'enabled';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = meeting.enabled !== false;
  enabled.setAttribute('aria-label', `Reminders for ${meeting.title}`);
  enabled.addEventListener('change', () => {
    if (busy) { enabled.checked = meeting.enabled !== false; return; }
    void action(() => request('set-enabled', { key: meeting.key, enabled: enabled.checked }), enabled.checked ? 'Reminders enabled.' : 'Reminders disabled.');
  });
  label.append(enabled, 'Enabled');
  actions.append(label, button('Edit', () => editMeeting(meeting)), button('Remove', () => action(async () => {
    await request('remove-meeting', { key: meeting.key });
    if (editingKey === meeting.key) resetEditor();
  }, 'Meeting removed.')));
  row.append(title, schedule, actions);
  return row;
}

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
      : `${event.source === 'manual' ? repeats[event.repeat || 'none'] : 'Google Calendar'} · ${event.start <= Date.now() ? 'In progress' : 'Reminders scheduled'}`;
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
  card.append(when, title, status, actions);
  return card;
}

async function refresh() {
  const state = await request('get-state');
  $('#calendar-section').hidden = !state.configured && !state.connected;
  $('#saved-meetings').replaceChildren(...state.manual.map(renderSaved));
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
    empty.textContent = state.connected ? 'No upcoming timed events found in your primary calendar. All-day events and declined invitations are skipped.' : 'No upcoming meetings.';
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
  const key = editingKey;
  void action(async () => {
    await request(key ? 'update-meeting' : 'add-meeting', { key, meeting });
    resetEditor();
  }, key ? 'Meeting updated.' : 'Meeting added.');
});

$('#cancel-edit').addEventListener('click', resetEditor);

let refreshTimer;
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local' || busy) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(error => feedback(error.message, true)), 150);
});
refresh().catch(error => feedback(error.message, true));
