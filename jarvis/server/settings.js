import { z } from 'zod';
import { db } from './db.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const perm = z.enum(['read', 'confirm', 'write']);

export const settingsSchema = z.object({
  profile: z.object({ displayName: z.string().max(80).default('') }).default({ displayName: '' }),
  timezone: z.string().refine(isValidTz, 'Unknown time zone').default('Asia/Kolkata'),
  locale: z.string().max(20).default('en-IN'),
  dateFormat: z.enum(['dd LLL yyyy', 'LLL dd, yyyy', 'yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy']).default('dd LLL yyyy'),
  timeFormat: z.enum(['12h', '24h']).default('12h'),
  weekStart: z.union([z.literal(0), z.literal(1)]).default(1),
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  workingHours: z.object({
    start: hhmm.default('09:00'),
    end: hhmm.default('18:00'),
    days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  }).default({ start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }),
  focusPeriods: z.array(z.object({ start: hhmm, end: hhmm })).max(6).default([{ start: '10:00', end: '12:00' }]),
  dailySchedule: z.object({
    wake: hhmm.default('07:00'),
    sleep: hhmm.default('23:00'),
    lunchStart: hhmm.default('13:00'),
    lunchEnd: hhmm.default('14:00'),
    bufferMinutes: z.number().int().min(0).max(60).default(10),
  }).default({ wake: '07:00', sleep: '23:00', lunchStart: '13:00', lunchEnd: '14:00', bufferMinutes: 10 }),
  notifications: z.object({
    inApp: z.boolean().default(true),
    browser: z.boolean().default(false),
    eventLeadMinutes: z.number().int().min(0).max(1440).default(15),
    billLeadDays: z.number().int().min(0).max(30).default(3),
    dailyBriefing: z.boolean().default(true),
    dailyBriefingTime: hhmm.default('08:00'),
    overdueDigest: z.boolean().default(true),
  }).default({ inApp: true, browser: false, eventLeadMinutes: 15, billLeadDays: 3, dailyBriefing: true, dailyBriefingTime: '08:00', overdueDigest: true }),
  assistant: z.object({
    voiceReplies: z.boolean().default(false),
    voiceName: z.string().max(200).default(''),
    speechRate: z.number().min(0.5).max(2).default(1),
    verbosity: z.enum(['concise', 'balanced', 'detailed']).default('concise'),
    useMemory: z.boolean().default(true),
    confirmAllChanges: z.boolean().default(false),
    permissions: z.object({
      calendar: perm.default('write'),
      tasks: perm.default('write'),
      finance: perm.default('write'),
      reminders: perm.default('write'),
      notes: perm.default('write'),
      email: z.enum(['read', 'confirm']).default('confirm'),
    }).prefault({}),
  }).prefault({}),
  demoMode: z.boolean().default(false),
  onboarded: z.boolean().default(false),
});

function isValidTz(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getSettings(userId) {
  const row = db.prepare('SELECT json FROM settings WHERE user_id = ?').get(userId);
  const raw = row ? JSON.parse(row.json) : {};
  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

function deepMerge(base, patch) {
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

/** Merge a partial patch into stored settings, validate the whole result, persist. */
export function updateSettings(userId, patch) {
  const merged = deepMerge(getSettings(userId), patch);
  const next = settingsSchema.parse(merged);
  db.prepare('INSERT INTO settings (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json')
    .run(userId, JSON.stringify(next));
  return next;
}
