import { normalizeEvent } from './core.js';

export function isConfigured() {
  return Boolean(chrome.runtime.getManifest().oauth2?.client_id);
}

export async function getToken(interactive = false) {
  if (!isConfigured()) throw new Error('Calendar needs one-time setup. See the README, or add a meeting below to try reminders.');
  const result = await chrome.identity.getAuthToken({ interactive });
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw new Error('Google sign-in did not return access. Try connecting again.');
  return token;
}

export async function fetchEvents(token, now = Date.now()) {
  const events = [];
  let pageToken;
  // One shared deadline bounds the entire paginated sync, not just each page.
  const signal = AbortSignal.timeout(15_000);
  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    const params = {
      timeMin: new Date(now - 2 * 60_000).toISOString(),
      timeMax: new Date(now + 7 * 86_400_000).toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', showDeleted: 'false'
    };
    if (pageToken) params.pageToken = pageToken;
    url.search = new URLSearchParams(params);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'Google sign-in expired. Reconnect Calendar.'
        : response.status === 403 ? 'Calendar access was denied. Check API setup or ask your work administrator.'
          : `Calendar sync failed (${response.status}). Saved reminders are still active.`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    for (const item of data.items || []) {
      const event = normalizeEvent(item);
      if (event) events.push(event);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return events;
}

export async function loadCalendar(initialToken) {
  let token = initialToken || await getToken();
  try { return await fetchEvents(token); }
  catch (error) {
    if (error.status !== 401) throw error;
    await chrome.identity.removeCachedAuthToken({ token });
    token = await getToken();
    return fetchEvents(token);
  }
}
