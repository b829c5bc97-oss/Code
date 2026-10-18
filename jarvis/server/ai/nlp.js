import { DateTime } from '../services/time.js';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, an: 1, a: 1 };

const monthIdx = (word) => MONTHS.findIndex((m) => m.startsWith(word.toLowerCase().slice(0, 3)));

/**
 * Small, deterministic date/time extractor for the demo assistant.
 * Returns { date: DateTime|null, time: {hour, minute}|null, part: 'morning'|'afternoon'|'evening'|null, matched: string[] }.
 */
export function parseWhen(text, zone, now = DateTime.now().setZone(zone)) {
  const t = text.toLowerCase();
  const matched = [];
  let date = null;
  let m;

  if ((m = t.match(/\bday after tomorrow\b/))) { date = now.plus({ days: 2 }); matched.push(m[0]); }
  else if ((m = t.match(/\btomorrow\b/))) { date = now.plus({ days: 1 }); matched.push(m[0]); }
  else if ((m = t.match(/\b(today|tonight)\b/))) { date = now; matched.push(m[0]); }
  else if ((m = t.match(/\bin (\d+|one|two|three|four|five|six|seven|ten) (day|days|week|weeks)\b/))) {
    const n = Number(m[1]) || NUMBERS[m[1]];
    date = now.plus(m[2].startsWith('week') ? { weeks: n } : { days: n });
    matched.push(m[0]);
  } else if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
    date = DateTime.fromISO(m[0], { zone });
    matched.push(m[0]);
  } else if ((m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/)) || (m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/))) {
    const day = Number(/\d/.test(m[1]) ? m[1] : m[2]);
    const mon = monthIdx(/\d/.test(m[1]) ? m[2] : m[1]) + 1;
    date = DateTime.fromObject({ year: now.year, month: mon, day }, { zone });
    if (date < now.startOf('day')) date = date.plus({ years: 1 });
    matched.push(m[0]);
  } else if ((m = t.match(/\b(next|this|on|by|before|until)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/))) {
    const target = WEEKDAYS.indexOf(m[2]) + 1;
    let diff = (target - now.weekday + 7) % 7;
    if (diff === 0 && m[1] !== 'this') diff = 7;
    date = now.plus({ days: diff });
    matched.push(m[0]);
  } else if ((m = t.match(/\bnext week\b/))) {
    date = now.plus({ weeks: 1 }).startOf('week');
    matched.push(m[0]);
  }

  let time = null;
  if ((m = t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/))) {
    let h = Number(m[1]) % 12;
    if (m[3].startsWith('p')) h += 12;
    time = { hour: h, minute: Number(m[2] || 0) };
    matched.push(m[0]);
  } else if ((m = t.match(/\bat\s+(\d{1,2}):(\d{2})\b/)) || (m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/))) {
    time = { hour: Number(m[1]), minute: Number(m[2]) };
    matched.push(m[0]);
  } else if ((m = t.match(/\b(noon|midday)\b/))) { time = { hour: 12, minute: 0 }; matched.push(m[0]); }
  else if ((m = t.match(/\bat (\d{1,2})\b/))) {
    let h = Number(m[1]);
    if (h >= 1 && h <= 7) h += 12; // "at 3" almost always means 3 PM
    time = { hour: h, minute: 0 };
    matched.push(m[0]);
  }

  let part = null;
  if ((m = t.match(/\b(morning|afternoon|evening|tonight)\b/))) { part = m[1] === 'tonight' ? 'evening' : m[1]; matched.push(m[0]); }
  if (part === 'evening' && !date && /tonight/.test(t)) date = now;

  return { date: date ? date.startOf('day') : null, time, part, matched };
}

export function parseDuration(text) {
  const t = text.toLowerCase();
  let m;
  if ((m = t.match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|half an?|an?)\s*(?:-|\s)?(hours?|hrs?|h)\b/))) {
    const n = Number(m[1]) || NUMBERS[m[1].split(' ')[0]] || 1;
    return Math.round(n * 60);
  }
  if ((m = t.match(/\b(\d+)\s*(?:-|\s)?(minutes?|mins?|m)\b/))) return Number(m[1]);
  if (/half an hour/.test(t)) return 30;
  return null;
}

export function parseAmount(text) {
  const m = text.replace(/,/g, '').match(/(?:₹|rs\.?|inr|\$|usd|€|eur)?\s*(\d+(?:\.\d{1,2})?)\s*(?:k\b)?/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (/\d\s*k\b/i.test(m[0])) n *= 1000;
  return n;
}

/** Month referenced in finance questions: "this month", "last month", "in September". */
export function parseMonth(text, zone, now = DateTime.now().setZone(zone)) {
  const t = text.toLowerCase();
  if (/\blast month\b|\bprevious month\b/.test(t)) return now.minus({ months: 1 }).startOf('month');
  if (/\bthis month\b|\bso far\b/.test(t)) return now.startOf('month');
  const m = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b(?:\s+(\d{4}))?/);
  if (m) {
    const mon = monthIdx(m[1]) + 1;
    let d = DateTime.fromObject({ year: m[2] ? Number(m[2]) : now.year, month: mon, day: 1 }, { zone });
    if (!m[2] && d > now) d = d.minus({ years: 1 }); // "in September" = most recent September
    return d;
  }
  return null;
}

export function stripPhrases(text, phrases) {
  let s = text;
  for (const p of phrases) s = s.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  return s.replace(/\s+/g, ' ').trim();
}
