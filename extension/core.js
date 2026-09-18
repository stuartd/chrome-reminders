export const MINUTE = 60_000;
export const OFFSETS = [15, 5, 0];
export const GRACE = 2 * MINUTE;

export function meetCode(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || url.port) return null;
    return /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

export function meetUrl(value) {
  const code = meetCode(value);
  return code ? `https://meet.google.com/${code}` : null;
}

function calendarUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'calendar.google.com' && !url.port
      ? url.href : null;
  } catch { return null; }
}

export function normalizeEvent(event) {
  if (!event.id || event.status === 'cancelled' || !event.start?.dateTime || !event.end?.dateTime) return null;
  if (event.eventType && event.eventType !== 'default') return null;
  if (event.attendees?.some(a => a.self && a.responseStatus === 'declined')) return null;
  const start = Date.parse(event.start.dateTime);
  const end = Date.parse(event.end.dateTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const joinUrl = meetUrl(event.hangoutLink) ?? event.conferenceData?.entryPoints
    ?.filter(p => p.entryPointType === 'video').map(p => meetUrl(p.uri)).find(Boolean) ?? null;
  return {
    key: `google:${event.id}:${start}`, source: 'google',
    title: String(event.summary || 'Untitled meeting').slice(0, 200), start, end,
    joinUrl, calendarUrl: calendarUrl(event.htmlLink)
  };
}

export function manualEvent(input, id, now, editing = false) {
  const title = String(input.title || '').trim();
  const start = Date.parse(input.start);
  const duration = Number(input.duration);
  const rawUrl = String(input.joinUrl || '').trim();
  const repeat = input.repeat || 'none';
  if (!['none', 'weekdays', 'weekly', 'fortnightly'].includes(repeat)) throw new Error('Choose a valid repeat pattern.');
  if (!title || title.length > 200) throw new Error('Enter a meeting title (up to 200 characters).');
  if (!Number.isFinite(start) || (!editing && start <= now)) throw new Error('Choose a meeting time in the future.');
  if (repeat === 'weekdays' && [0, 6].includes(new Date(start).getDay())) throw new Error('Choose a weekday for the first meeting.');
  if (!Number.isFinite(duration) || duration < 1 || duration > 1440) throw new Error('Duration must be between 1 and 1,440 minutes.');
  if (rawUrl && !meetUrl(rawUrl)) throw new Error('Use a Google Meet link like https://meet.google.com/abc-defg-hij.');
  return {
    key: `manual:${id}:${start}`, source: 'manual', title, start, repeat, enabled: input.enabled !== false,
    end: start + duration * MINUTE, joinUrl: meetUrl(rawUrl), calendarUrl: null
  };
}

// Advance calendar dates with Date's local-time rules, preserving the wall clock across DST.
export function manualOccurrences(meetings, now) {
  const events = [];
  const horizon = now + 21 * 86_400_000;
  for (const meeting of meetings) {
    if (meeting.enabled === false) continue;
    if (!meeting.repeat || meeting.repeat === 'none') {
      events.push(meeting);
      continue;
    }
    const anchor = new Date(meeting.start);
    const from = new Date(Math.max(meeting.start, now - 86_400_000));
    const dayNumber = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
    const firstDay = dayNumber(anchor);
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate(), anchor.getHours(), anchor.getMinutes());
    while (candidate.getTime() <= horizon) {
      const days = dayNumber(candidate) - firstDay;
      const matches = meeting.repeat === 'weekdays' ? ![0, 6].includes(candidate.getDay())
        : days % (meeting.repeat === 'fortnightly' ? 14 : 7) === 0;
      const start = candidate.getTime();
      const end = start + meeting.end - meeting.start;
      if (days >= 0 && matches && start >= meeting.start && end > now) {
        events.push({ ...meeting, seriesKey: meeting.key, key: `${meeting.key}:occurrence:${start}`, start, end });
      }
      // Reconstruct each date so a spring-forward adjustment cannot move later meetings.
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(anchor.getHours(), anchor.getMinutes(), 0, 0);
    }
  }
  return events;
}

// Collapse late alarms after wake/restart to the most recent stage only.
export function reminderPlan(event, record = {}, now) {
  if (record.suppressed || event.end <= now) return { due: null, next: null };
  const stages = OFFSETS.map(minutes => ({ minutes, at: event.start - minutes * MINUTE }));
  const latest = stages.filter(stage => stage.at <= now).at(-1);
  const due = latest && now - latest.at <= GRACE && !record.sent?.includes(latest.minutes)
    ? latest.minutes : null;
  const next = stages.find(stage => stage.at > now && !record.sent?.includes(stage.minutes))?.at ?? null;
  return { due, next };
}

export function matchingMeetings(events, url, now) {
  const code = meetCode(url);
  if (!code) return [];
  return events.filter(event => meetCode(event.joinUrl) === code
    && now >= event.start - 15 * MINUTE && now < event.end);
}

export function reminderText(event, now) {
  const minutes = Math.max(0, Math.ceil((event.start - now) / MINUTE));
  return minutes ? `Starts in ${minutes} minute${minutes === 1 ? '' : 's'}` : 'Starting now';
}
