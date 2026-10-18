import { z } from 'zod';
import { db, id, nowIso, updateRow, audit } from '../db.js';
import { notFound } from '../http.js';

export const noteInput = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().max(200000).optional().default(''),
  category: z.string().trim().max(60).optional().default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional().default([]),
  pinned: z.boolean().optional().default(false),
  project_id: z.string().nullable().optional(),
});

function serialize(r, full = true) {
  return {
    id: r.id, title: r.title, content: full ? r.content : undefined, excerpt: r.content.slice(0, 220), category: r.category,
    tags: JSON.parse(r.tags || '[]'), pinned: !!r.pinned, project_id: r.project_id, is_demo: !!r.is_demo, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function listNotes(userId, { query, category, tag, project_id, full = false } = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (query) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    for (const t of terms) {
      where.push('(lower(title) LIKE ? OR lower(content) LIKE ? OR lower(tags) LIKE ?)');
      args.push(`%${t}%`, `%${t}%`, `%${t}%`);
    }
  }
  if (category) { where.push('category = ?'); args.push(category); }
  if (tag) { where.push('tags LIKE ?'); args.push(`%"${tag.replace(/["%_]/g, '')}"%`); }
  if (project_id) { where.push('project_id = ?'); args.push(project_id); }
  return db.prepare(`SELECT * FROM notes WHERE ${where.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT 500`).all(...args).map((r) => serialize(r, full));
}

export function getNote(userId, nid) {
  const r = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(nid, userId);
  if (!r) throw notFound('Note');
  return serialize(r);
}

export function createNote(userId, raw, { actor = 'user', isDemo = false } = {}) {
  const n = noteInput.parse(raw);
  if (n.project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ? AND user_id = ?').get(n.project_id, userId)) throw notFound('Project');
  const nid = id();
  const now = nowIso();
  db.prepare('INSERT INTO notes (id, user_id, title, content, category, tags, pinned, project_id, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(nid, userId, n.title, n.content, n.category, JSON.stringify([...new Set(n.tags)]), n.pinned ? 1 : 0, n.project_id ?? null, isDemo ? 1 : 0, now, now);
  audit(userId, actor, 'create', 'note', nid, n.title);
  return getNote(userId, nid);
}

export function updateNote(userId, nid, raw, { actor = 'user' } = {}) {
  getNote(userId, nid);
  const n = noteInput.partial().extend({ append: z.string().max(50000).optional() }).parse(raw);
  const patch = { ...n, updated_at: nowIso() };
  delete patch.append;
  if (n.tags) patch.tags = [...new Set(n.tags)];
  if (n.append) {
    const cur = db.prepare('SELECT content FROM notes WHERE id = ?').get(nid).content;
    patch.content = `${n.content ?? cur}${cur ? '\n\n' : ''}${n.append}`;
  }
  updateRow('notes', userId, nid, patch, ['title', 'content', 'category', 'tags', 'pinned', 'project_id', 'updated_at']);
  audit(userId, actor, 'update', 'note', nid, Object.keys(n).join(','));
  return getNote(userId, nid);
}

export function deleteNote(userId, nid, { actor = 'user' } = {}) {
  const n = getNote(userId, nid);
  db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(nid, userId);
  audit(userId, actor, 'delete', 'note', nid, n.title);
  return { deleted: true, title: n.title };
}

/** Pull checklist-style action items ("- [ ] ...", "TODO:", "Action:") out of note text. Deterministic, no AI needed. */
export function extractActionItems(content) {
  const items = [];
  for (const line of content.split('\n')) {
    const l = line.trim();
    let m = l.match(/^[-*]\s*\[\s\]\s+(.+)/) || l.match(/^(?:TODO|To-?do|Action(?: item)?|AI|Next step)s?\s*[:\-]\s*(.+)/i);
    if (m) items.push(m[1].trim());
  }
  return items;
}

export function noteMeta(userId) {
  const rows = db.prepare('SELECT category, tags FROM notes WHERE user_id = ?').all(userId);
  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
  const tags = [...new Set(rows.flatMap((r) => JSON.parse(r.tags || '[]')))].sort();
  return { categories, tags };
}
