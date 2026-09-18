import test from 'node:test';
import assert from 'node:assert/strict';
import { GRACE, MINUTE, meetCode, normalizeEvent, manualEvent, manualOccurrences, matchingMeetings, reminderPlan } from '../extension/core.js';

const start = Date.parse('2026-09-18T10:00:00+01:00');
const event = { key: 'a', start, end: start + 30 * MINUTE, joinUrl: 'https://meet.google.com/abc-defg-hij' };

test('15, 5 and 0 minute alarms; delivered stages do not repeat', () => {
  for (const minutes of [15, 5, 0]) {
    const now = start - minutes * MINUTE;
    assert.equal(reminderPlan(event, {}, now).due, minutes);
    assert.equal(reminderPlan(event, { sent: [minutes] }, now).due, null);
  }
  assert.equal(reminderPlan(event, {}, start - 16 * MINUTE).next, start - 15 * MINUTE);
  assert.equal(reminderPlan(event, {}, start - 10 * MINUTE).next, start - 5 * MINUTE);
});

test('wake-up catch-up emits only the latest stage, within two minutes', () => {
  assert.equal(reminderPlan(event, {}, start + MINUTE).due, 0);
  assert.equal(reminderPlan(event, {}, start + GRACE + 1).due, null);
  assert.equal(reminderPlan(event, {}, start - 4 * MINUTE).due, 5);
  assert.equal(reminderPlan(event, {}, start - 8 * MINUTE).due, null);
  assert.equal(reminderPlan(event, { sent: [0] }, start + MINUTE).due, null);
});

test('joined, dismissed and ended meetings never schedule reminders', () => {
  for (const suppressed of ['joined', 'dismissed']) {
    assert.deepEqual(reminderPlan(event, { suppressed }, start - 16 * MINUTE), { due: null, next: null });
  }
  assert.deepEqual(reminderPlan(event, {}, event.end), { due: null, next: null });
});

test('Meet matching is strict and scoped to the occurrence reminder window', () => {
  assert.equal(meetCode('https://meet.google.com/abc-defg-hij?authuser=1'), 'abc-defg-hij');
  for (const url of ['https://meet.google.com.evil.test/abc-defg-hij', 'http://meet.google.com/abc-defg-hij', 'javascript:alert(1)', 'https://meet.google.com/lookup/team', 'https://meet.google.com:123/abc-defg-hij']) assert.equal(meetCode(url), null);
  const nextWeek = { ...event, start: start + 7 * 86_400_000, end: event.end + 7 * 86_400_000 };
  assert.deepEqual(matchingMeetings([event, nextWeek], event.joinUrl, start), [event]);
  assert.deepEqual(matchingMeetings([event], event.joinUrl, start - 16 * MINUTE), []);
  assert.deepEqual(matchingMeetings([event], event.joinUrl, event.end), []);
});

const raw = { id: 'abc', summary: 'Stand-up', start: { dateTime: '2026-09-18T10:00:00+01:00' }, end: { dateTime: '2026-09-18T10:30:00+01:00' }, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: event.joinUrl }] } };
test('calendar normalization handles offsets, conference links and rescheduled identities', () => {
  const normalized = normalizeEvent(raw);
  assert.equal(normalized.start, start);
  assert.equal(normalized.joinUrl, event.joinUrl);
  assert.notEqual(normalizeEvent({ ...raw, start: { dateTime: '2026-09-18T10:15:00+01:00' } }).key, normalized.key);
  assert.equal(normalizeEvent({ ...raw, htmlLink: 'https://evil.test' }).calendarUrl, null);
  assert.equal(normalizeEvent({ ...raw, start: { dateTime: '2026-10-25T01:30:00+00:00' }, end: { dateTime: '2026-10-25T02:00:00+00:00' } }).start, Date.parse('2026-10-25T01:30Z'));
});

test('skip cancelled, declined, all-day and non-meeting event types', () => {
  for (const patch of [{ status: 'cancelled' }, { attendees: [{ self: true, responseStatus: 'declined' }] }, { start: { date: '2026-09-18' } }, { eventType: 'workingLocation' }, { eventType: 'focusTime' }, { end: { dateTime: 'bad' } }]) assert.equal(normalizeEvent({ ...raw, ...patch }), null);
  assert.ok(normalizeEvent({ ...raw, attendees: [{ self: false, responseStatus: 'declined' }] }));
});

test('manual input validates time and link and never accepts arbitrary URLs', () => {
  const input = { title: ' Review ', start: '2026-09-18T10:00:00+01:00', duration: '30', joinUrl: event.joinUrl };
  assert.equal(manualEvent(input, 'id', start - MINUTE).title, 'Review');
  for (const patch of [{ title: '' }, { start: 'bad' }, { duration: 0 }, { duration: 2000 }, { joinUrl: 'https://evil.test' }]) assert.throws(() => manualEvent({ ...input, ...patch }, 'id', start - MINUTE));
  assert.throws(() => manualEvent(input, 'id', start));
});

test('weekday repeats skip weekends and old anchors continue indefinitely', () => {
  const anchor = new Date(2020, 0, 6, 9).getTime();
  const now = new Date(2026, 8, 18, 8).getTime();
  const series = { key: 'daily', start: anchor, end: anchor + 30 * MINUTE, repeat: 'weekdays' };
  const events = manualOccurrences([series], now);
  assert.equal(events.length, 15);
  assert.equal(new Date(events[0].start).getDate(), 18);
  assert.equal(new Date(events[1].start).getDate(), 21);
  assert.ok(events.every(event => ![0, 6].includes(new Date(event.start).getDay())));
  assert.equal(new Set(events.map(event => event.key)).size, events.length);
  assert.deepEqual(manualOccurrences([{ ...series, enabled: false }], now), []);
});

test('fortnightly repeats preserve their anchor and monthly/year boundaries', () => {
  const anchor = new Date(2025, 11, 26, 10).getTime();
  const events = manualOccurrences([{ key: 'retro', start: anchor, end: anchor + 60 * MINUTE, repeat: 'fortnightly' }], new Date(2026, 0, 1).getTime());
  assert.deepEqual(events.map(event => new Date(event.start).getDate()), [9]);
});

test('weekly local times survive both daylight-saving transitions', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/London';
  try {
    for (const [month, day] of [[2, 22], [9, 18]]) {
      const anchor = new Date(2026, month, day, 9).getTime();
      const events = manualOccurrences([{ key: 'weekly', start: anchor, end: anchor + 30 * MINUTE, repeat: 'weekly' }], anchor);
      assert.ok(events.length >= 3);
      assert.ok(events.every(event => new Date(event.start).getHours() === 9));
      assert.notEqual(events[1].start - events[0].start, 7 * 86_400_000);
      assert.ok(events.every(event => event.end - event.start === 30 * MINUTE));
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('invalid repeat rules and weekend weekday anchors are rejected', () => {
  const input = { title: 'Standup', start: new Date(2026, 8, 19, 9).toISOString(), duration: 30 };
  assert.throws(() => manualEvent({ ...input, repeat: 'monthly' }, 'id', 0));
  assert.throws(() => manualEvent({ ...input, repeat: 'weekdays' }, 'id', 0));
});
