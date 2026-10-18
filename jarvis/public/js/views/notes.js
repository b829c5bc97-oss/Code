import { h, icon, clear, tabs, emptyState, toast, toastError, debounce, demoBadge, markdown, confirmDialog, fmtRelDay, select, formModal, field, input } from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { state, onState, emit } from '../state.js';

let tab = 'notes';
let selectedId = null;
const f = { q: '', category: '', tag: '' };

export async function render(el, { query }) {
  if (query.get('note')) selectedId = query.get('note');
  const tabBar = h('div');
  const body = h('div');
  clear(el, h('div', { class: 'page-head' }, h('div', h('h1', 'Notes & Knowledge'), h('p', 'Meeting summaries, ideas, reference material — searchable, and usable by JARVIS.')),
    h('button', { class: 'btn primary', onclick: newNote }, icon('plus'), 'New note')), tabBar, body);
  const draw = async () => {
    clear(tabBar, tabs([['notes', 'Notes'], ['research', 'Web research']], tab, (t) => { tab = t; draw(); }));
    try {
      if (tab === 'notes') await notesView(body, draw);
      else researchView(body);
    } catch (e) { clear(body, emptyState(e.message)); }
  };
  async function newNote() {
    try {
      const n = await post('/notes', { title: 'Untitled note', category: f.category || '' });
      selectedId = n.id;
      tab = 'notes';
      draw();
    } catch (e) { toastError(e); }
  }
  await draw();
  const off = onState((w) => w === 'data' && tab === 'notes' && draw());
  return () => off();
}

async function notesView(body, redraw) {
  const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const [list, meta] = await Promise.all([get(`/notes?${p}`), get('/notes/meta')]);
  if (!selectedId && list.length) selectedId = list[0].id;
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search notes…', value: f.q, 'aria-label': 'Search notes' });
  search.addEventListener('input', debounce(() => { f.q = search.value; redraw(); }, 300));
  const catSel = select('category', [['', 'All categories'], ...meta.categories.map((c) => [c, c])], f.category);
  catSel.setAttribute('aria-label', 'Filter by category');
  catSel.addEventListener('change', () => { f.category = catSel.value; redraw(); });
  const tagSel = select('tag', [['', 'All tags'], ...meta.tags.map((t) => [t, `#${t}`])], f.tag);
  tagSel.setAttribute('aria-label', 'Filter by tag');
  tagSel.addEventListener('change', () => { f.tag = tagSel.value; redraw(); });
  const editor = h('section', { class: 'card note-editor' });
  clear(body, h('div', { class: 'notes-layout' },
    h('aside', { class: 'card stack' }, search, h('div', { class: 'row tight' }, catSel, tagSel),
      list.length ? h('div', { class: 'stack tight', role: 'list' }, list.map((n) => h('div', { class: 'note-item', role: 'listitem', tabindex: 0, 'aria-current': String(n.id === selectedId), onclick: () => { selectedId = n.id; redraw(); }, onkeydown: (e) => { if (e.key === 'Enter') { selectedId = n.id; redraw(); } } },
        h('div', { class: 'row tight' }, n.pinned ? h('span', { title: 'Pinned' }, '📌') : null, h('strong', { class: 'grow truncate' }, n.title), demoBadge(n)),
        h('div', { class: 'excerpt' }, n.excerpt || 'Empty note'),
        h('div', { class: 'tiny faint row tight' }, n.category ? h('span', n.category) : null, n.tags.map((t) => h('span', `#${t}`)), h('span', fmtRelDay(n.updated_at)))))) : emptyState(f.q || f.category || f.tag ? 'No notes match.' : 'No notes yet.')),
    editor));
  if (selectedId && list.some((n) => n.id === selectedId)) await drawEditor(editor, selectedId, redraw);
  else clear(editor, emptyState('Select a note or create a new one.'));
}

async function drawEditor(card, id, redraw) {
  const n = await get(`/notes/${id}`);
  let preview = false;
  const title = h('input', { class: 'input', value: n.title, 'aria-label': 'Note title', maxlength: 300, style: { 'font-size': '18px', 'font-weight': '650', height: '44px' } });
  const category = h('input', { class: 'input', value: n.category, placeholder: 'Category', 'aria-label': 'Category', maxlength: 60 });
  const tags = h('input', { class: 'input', value: n.tags.join(', '), placeholder: 'tags, comma, separated', 'aria-label': 'Tags' });
  const content = h('textarea', { class: 'input', 'aria-label': 'Note content', placeholder: 'Write in plain text or simple Markdown. Use "- [ ] item" or "TODO: …" for action items.' });
  content.value = n.content;
  const previewBox = h('div', { class: 'card', hidden: true, style: { 'min-height': '360px' } });
  const savedLbl = h('span', { class: 'small faint', 'aria-live': 'polite' }, `Saved ${fmtRelDay(n.updated_at)}`);
  const save = async () => {
    try {
      await patch(`/notes/${id}`, { title: title.value.trim() || 'Untitled note', category: category.value.trim(), tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean), content: content.value });
      savedLbl.textContent = 'Saved';
    } catch (e) { savedLbl.textContent = `Not saved: ${e.message}`; }
  };
  const autosave = debounce(() => { savedLbl.textContent = 'Saving…'; save(); }, 800);
  for (const elx of [title, category, tags, content]) elx.addEventListener('input', autosave);
  const actionsBox = h('div');
  const showActions = async () => {
    await save();
    const fresh = await get(`/notes/${id}`);
    const items = fresh.action_items;
    if (!items.length) return clear(actionsBox, h('p', { class: 'small faint' }, 'No action items found. Mark them as "- [ ] task" or "TODO: task" — or ask JARVIS to extract them.'));
    const checks = items.map((t) => ({ t, on: true }));
    clear(actionsBox, h('div', { class: 'card stack tight', style: { 'margin-top': '10px' } }, h('strong', 'Action items found'),
      checks.map((c) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { c.on = e.target.checked; } }), c.t)),
      h('button', { class: 'btn primary sm', onclick: async () => { const sel = checks.filter((c) => c.on).map((c) => c.t); if (!sel.length) return; const r = await post(`/notes/${id}/to-tasks`, { items: sel }); toast(`Created ${r.created.length} task${r.created.length === 1 ? '' : 's'}.`, { type: 'success' }); emit('data'); clear(actionsBox); } }, 'Create selected tasks')));
  };
  const ask = (prompt) => { location.hash = `#/assistant?q=${encodeURIComponent(`${prompt} (note id: ${id}, title: "${n.title}")`)}`; };
  clear(card,
    h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, title), demoBadge(n)),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, category), h('div', { class: 'grow' }, tags),
        h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: n.pinned, onchange: async (e) => { await patch(`/notes/${id}`, { pinned: e.target.checked }); redraw(); } }), 'Pin')),
      h('div', { class: 'row tight' },
        h('button', { class: 'btn sm', 'aria-pressed': 'false', onclick: (e) => { preview = !preview; e.currentTarget.setAttribute('aria-pressed', String(preview)); content.hidden = preview; previewBox.hidden = !preview; clear(previewBox, markdown(content.value)); } }, 'Preview'),
        h('button', { class: 'btn sm', onclick: showActions }, icon('tasks'), 'Find action items'),
        state.ai?.configured ? [
          h('button', { class: 'btn sm', onclick: () => ask('Summarise this note in a few bullet points') }, icon('sparkle'), 'Summarise'),
          h('button', { class: 'btn sm', onclick: () => ask('Turn this note into a project plan with tasks') }, icon('sparkle'), 'Make a project plan'),
        ] : h('span', { class: 'small faint' }, 'Connect an AI model for summaries and project plans from notes.'),
        h('div', { class: 'grow' }), savedLbl,
        h('button', { class: 'btn ghost sm icon', 'aria-label': 'Delete note', onclick: async () => { if (await confirmDialog(`Delete "${n.title}"?`, { danger: true, confirmLabel: 'Delete' })) { await del(`/notes/${id}`); selectedId = null; redraw(); } } }, icon('trash'))),
      content, previewBox, actionsBox));
}

function researchView(body) {
  const configured = state.ai?.web_search?.configured;
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search the web…', 'aria-label': 'Web search query' });
  const out = h('div', { class: 'stack', style: { 'margin-top': '14px' } });
  const run = async () => {
    if (!q.value.trim()) return;
    clear(out, h('span', { class: 'spinner' }));
    try {
      const r = await post('/integrations/search', { query: q.value.trim() });
      clear(out, h('div', { class: 'row small' }, h('span', { class: 'badge accent source-tag' }, 'External source'), h('span', { class: 'faint' }, `${r.source} · retrieved ${new Date(r.retrieved_at).toLocaleString()}`)),
        r.results.length ? r.results.map((x) => h('div', { class: 'ext-result' }, h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, h('strong', x.title)), h('div', { class: 'tiny faint' }, x.url), h('p', { class: 'small muted' }, x.snippet || ''),
          h('button', { class: 'btn sm', onclick: async () => { await post('/notes', { title: x.title.slice(0, 300), category: 'Research', tags: ['web'], content: `Source (external): ${x.url}\nRetrieved: ${r.retrieved_at}\n\n${x.snippet || ''}` }); toast('Saved to notes (marked as external source).', { type: 'success' }); } }, 'Save to notes'))) : emptyState('No results.'));
    } catch (e) { clear(out, h('p', { class: 'error-text' }, e.message)); }
  };
  q.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  clear(body, h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', icon('globe', 'icon'), 'Web research')),
    configured ? h('div', h('div', { class: 'row' }, h('div', { class: 'grow' }, q), h('button', { class: 'btn primary', onclick: run }, 'Search')), h('p', { class: 'small faint' }, 'Results come from an external search provider and are labelled as such — they are kept separate from your own notes unless you save them.'), out)
      : h('div', { class: 'banner warn' }, icon('alert'), h('span', { class: 'grow' }, 'Web search is not configured on this server, so JARVIS cannot research the web. Set TAVILY_API_KEY or BRAVE_API_KEY in the server environment. Your own notes remain fully searchable.'))));
}

export { formModal, field, input };
