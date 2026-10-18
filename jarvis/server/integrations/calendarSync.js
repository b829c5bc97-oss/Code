import { db, id, nowIso, audit } from '../db.js';
import { apiFetch, getIntegration } from './oauth.js';
import { DateTime, toUtcIso } from '../services/time.js';
import { HttpError } from '../http.js';

/**
 * One-way import of the next N days of events from Google Calendar or Outlook
 * into JARVIS (source = provider). Imported events are refreshed on each sync;
 * events deleted upstream are removed locally. JARVIS does not write back.
 */
export async function syncCalendar(userId, provider, days = 30) {
  const row = getIntegration(userId, provider);
  if (!row || row.status !== 'connected') throw new HttpError(400, 'Not connected.');
  const from = DateTime.utc().minus({ days: 1 });
  const to = DateTime.utc().plus({ days });
  let items = [];
  if (provider === 'google') {
    let pageToken;
    do {
      const params = new URLSearchParams({ timeMin: from.toISO(), timeMax: to.toISO(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
      if (pageToken) params.set('pageToken', pageToken);
      const r = await apiFetch(userId, 'google', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
      for (const e of r.items || []) {
        if (e.status === 'cancelled') continue;
        const allDay = !!e.start?.date;
        items.push({
          external_id: e.id, title: e.summary || '(no title)', description: e.description || '', location: e.location || '',
          participants: (e.attendees || []).map((a) => a.email).filter(Boolean),
          start: allDay ? toUtcIso(DateTime.fromISO(e.start.date, { zone: e.start.timeZone || 'utc' })) : toUtcIso(DateTime.fromISO(e.start.dateTime)),
          end: allDay ? toUtcIso(DateTime.fromISO(e.end.date, { zone: e.end.timeZone || 'utc' })) : toUtcIso(DateTime.fromISO(e.end.dateTime)),
          all_day: allDay,
        });
      }
      pageToken = r.nextPageToken;
    } while (pageToken && items.length < 2000);
  } else {
    let url = `https://graph.microsoft.com/v1.0/me/calendarView?${new URLSearchParams({ startDateTime: from.toISO(), endDateTime: to.toISO(), $top: '200', $select: 'id,subject,bodyPreview,location,attendees,start,end,isAllDay,isCancelled' })}`;
    while (url && items.length < 2000) {
      const r = await apiFetch(userId, 'microsoft', url, { headers: { Prefer: 'outlook.timezone="UTC"' } });
      for (const e of r.value || []) {
        if (e.isCancelled) continue;
        items.push({
          external_id: e.id, title: e.subject || '(no title)', description: e.bodyPreview || '', location: e.location?.displayName || '',
          participants: (e.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean),
          start: toUtcIso(DateTime.fromISO(e.start.dateTime, { zone: 'utc' })), end: toUtcIso(DateTime.fromISO(e.end.dateTime, { zone: 'utc' })), all_day: !!e.isAllDay,
        });
      }
      url = r['@odata.nextLink'];
    }
  }
  const seen = new Set();
  let created = 0;
  let updated = 0;
  db.exec('BEGIN');
  try {
    for (const it of items) {
      seen.add(it.external_id);
      const existing = db.prepare('SELECT id FROM events WHERE user_id = ? AND source = ? AND external_id = ?').get(userId, provider, it.external_id);
      if (existing) {
        db.prepare('UPDATE events SET title = ?, description = ?, location = ?, participants = ?, start_at = ?, end_at = ?, all_day = ?, updated_at = ? WHERE id = ?')
          .run(it.title, it.description, it.location, JSON.stringify(it.participants), it.start, it.end, it.all_day ? 1 : 0, nowIso(), existing.id);
        updated++;
      } else {
        db.prepare(`INSERT INTO events (id, user_id, title, description, location, participants, start_at, end_at, all_day, kind, source, external_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id(), userId, it.title, it.description, it.location, JSON.stringify(it.participants), it.start, it.end, it.all_day ? 1 : 0, 'meeting', provider, it.external_id, nowIso(), nowIso());
        created++;
      }
    }
    const stale = db.prepare('SELECT id, external_id FROM events WHERE user_id = ? AND source = ? AND start_at >= ? AND start_at <= ?').all(userId, provider, toUtcIso(from), toUtcIso(to)).filter((e) => !seen.has(e.external_id));
    for (const s of stale) db.prepare('DELETE FROM events WHERE id = ?').run(s.id);
    db.prepare('UPDATE integrations SET last_sync_at = ?, last_error = NULL WHERE user_id = ? AND provider = ?').run(nowIso(), userId, provider);
    db.exec('COMMIT');
    audit(userId, 'user', 'sync', 'integration', provider, `${created} new, ${updated} updated, ${stale.length} removed`);
    return { created, updated, removed: stale.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
