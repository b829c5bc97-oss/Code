/**
 * Brief — front end.
 *
 * Deliberately small: the list is the product, so it renders fast, and a story's
 * full briefing is fetched only when someone actually opens it.
 */

const state = {
  topic: 'all',
  query: '',
  offset: 0,
  limit: 25,
  total: 0,
  loading: false,
  stories: [],
  detailCache: new Map(),
  openId: null,
};

const el = {
  stories: document.getElementById('stories'),
  skeletons: document.getElementById('skeletons'),
  topics: document.getElementById('topics'),
  statusBar: document.getElementById('status-bar'),
  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  searchClear: document.getElementById('search-clear'),
  refresh: document.getElementById('refresh-btn'),
  loadMore: document.getElementById('load-more'),
  endNote: document.getElementById('end-note'),
  colophon: document.getElementById('colophon'),
  template: document.getElementById('story-template'),
};

// ---------------------------------------------------------------- utilities

async function api(path, options) {
  const response = await fetch(`/api${path}`, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${response.status})`);
  }
  return response.json();
}

function relativeTime(ms) {
  if (!ms) return '';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function absoluteTime(ms) {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Everything user- or model-supplied goes through here before touching the DOM. */
function text(value) {
  return document.createTextNode(value ?? '');
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.append(text(content));
  return node;
}

const debounce = (fn, wait) => {
  let handle;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), wait);
  };
};

// ---------------------------------------------------------------- rendering

function renderStoryCard(story) {
  const fragment = el.template.content.cloneNode(true);
  const article = fragment.querySelector('.story');
  const head = fragment.querySelector('.story-head');

  article.dataset.id = String(story.id);

  fragment.querySelector('.chip-topic').textContent = story.topic || 'news';

  const developing = fragment.querySelector('.badge-developing');
  developing.hidden = !story.isDeveloping;

  const updated = fragment.querySelector('.badge-updated');
  if (story.whatsNew && !story.isDeveloping) updated.hidden = false;

  const time = fragment.querySelector('.story-time');
  time.textContent = relativeTime(story.lastPublishedAt);
  time.dateTime = new Date(story.lastPublishedAt).toISOString();
  time.title = `Latest coverage ${absoluteTime(story.lastPublishedAt)}`;

  fragment.querySelector('.story-headline').textContent = story.headline;
  fragment.querySelector('.story-oneliner').textContent = story.oneLiner || '';

  const sourcesLine = fragment.querySelector('.sources-line');
  const names = (story.sources || []).slice(0, 3);
  names.forEach((source, index) => {
    sourcesLine.append(element('span', 'source-name', source.name));
    if (index < names.length - 1) sourcesLine.append(text(' · '));
  });
  const extra = story.sourceCount - names.length;
  if (extra > 0) sourcesLine.append(element('span', 'source-more', ` +${extra} more`));
  if (names.length === 0) sourcesLine.append(element('span', 'source-more', `${story.sourceCount} source(s)`));

  const confidence = fragment.querySelector('.confidence');
  confidence.dataset.level = story.confidence || 'medium';
  confidence.textContent =
    story.sourceCount > 1
      ? `${story.sourceCount} outlets · ${story.confidence} confidence`
      : `single source · ${story.confidence} confidence`;

  head.addEventListener('click', () => toggleStory(story.id, article, head));
  return article;
}

function renderList({ append = false } = {}) {
  el.skeletons?.remove();
  el.stories.setAttribute('aria-busy', 'false');

  if (!append) el.stories.replaceChildren();

  if (state.stories.length === 0) {
    el.stories.replaceChildren(emptyState());
    el.loadMore.hidden = true;
    el.endNote.hidden = true;
    return;
  }

  const slice = append ? state.stories.slice(el.stories.children.length) : state.stories;
  const batch = document.createDocumentFragment();
  for (const story of slice) batch.append(renderStoryCard(story));
  el.stories.append(batch);

  const shown = el.stories.querySelectorAll('.story').length;
  const more = state.query ? state.stories.length >= state.offset : shown < state.total;
  el.loadMore.hidden = !more;
  el.endNote.hidden = more || shown === 0;
  if (!more && shown > 0) {
    el.endNote.textContent = `${shown} ${shown === 1 ? 'story' : 'stories'} — that's everything for this view.`;
  }
}

function emptyState() {
  const wrap = element('div', 'empty');
  if (state.query) {
    wrap.append(element('h2', null, 'No stories match that search'));
    wrap.append(element('p', null, 'Try fewer or more general words — search covers headlines and briefing text.'));
    return wrap;
  }
  wrap.append(element('h2', null, 'No briefings yet'));
  wrap.append(
    element(
      'p',
      null,
      'The pipeline gathers coverage, groups articles that describe the same event, and writes ' +
      'a briefing for each one. Press Refresh to run a cycle now — the first one takes a couple of minutes.',
    ),
  );
  return wrap;
}

// ---------------------------------------------------------------- detail view

async function toggleStory(id, article, head) {
  const isOpen = article.dataset.open === 'true';

  if (isOpen) {
    article.dataset.open = 'false';
    head.setAttribute('aria-expanded', 'false');
    article.querySelector('.story-body').hidden = true;
    state.openId = null;
    return;
  }

  // One story open at a time keeps the page scannable.
  if (state.openId !== null && state.openId !== id) {
    const previous = el.stories.querySelector(`.story[data-id="${state.openId}"]`);
    if (previous) {
      previous.dataset.open = 'false';
      previous.querySelector('.story-head').setAttribute('aria-expanded', 'false');
      previous.querySelector('.story-body').hidden = true;
    }
  }

  state.openId = id;
  article.dataset.open = 'true';
  head.setAttribute('aria-expanded', 'true');

  const body = article.querySelector('.story-body');
  body.hidden = false;

  if (body.dataset.loaded === 'true') return;
  body.replaceChildren(element('p', 'briefing-loading', 'Loading the full briefing…'));

  try {
    let detail = state.detailCache.get(id);
    if (!detail) {
      detail = await api(`/stories/${id}`);
      state.detailCache.set(id, detail);
    }
    body.replaceChildren(renderBriefing(detail));
    body.dataset.loaded = 'true';
  } catch (error) {
    body.replaceChildren(element('p', 'briefing-loading', `Couldn't load this briefing: ${error.message}`));
  }
}

function section(title, node) {
  const wrap = element('div', 'section');
  wrap.append(element('h3', null, title));
  wrap.append(node);
  return wrap;
}

function renderBriefing(story) {
  const frag = document.createDocumentFragment();

  if (story.whatsNew) {
    const box = element('div', 'whats-new');
    box.append(element('h3', null, "What's new"));
    box.append(element('p', null, story.whatsNew));
    frag.append(box);
  }

  frag.append(section('What happened', element('p', null, story.whatHappened)));

  if (story.whyItMatters) {
    frag.append(section('Why it matters', element('p', null, story.whyItMatters)));
  }

  if (story.keyFacts?.length) {
    const list = element('ul', 'facts');
    for (const item of story.keyFacts) {
      const li = element('li', 'fact');
      const holder = element('div', 'fact-text');
      holder.append(text(item.fact));
      if (item.sources?.length) {
        const cites = element('span', 'fact-cites');
        for (const source of item.sources) {
          const link = document.createElement('a');
          link.href = source.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = source.name;
          cites.append(link);
        }
        holder.append(cites);
      }
      li.append(holder);
      list.append(li);
    }
    frag.append(section('Key facts', list));
  }

  if (story.people?.length) {
    const list = element('ul', 'people');
    for (const person of story.people) {
      const li = element('li', 'person');
      li.append(Object.assign(document.createElement('b'), { textContent: person.name }));
      if (person.role) li.append(element('span', null, ` — ${person.role}`));
      list.append(li);
    }
    frag.append(section('Who is involved', list));
  }

  if (story.currentStatus) {
    frag.append(section('Where it stands', element('p', null, story.currentStatus)));
  }

  if (story.disputes?.length) {
    const list = element('ul', 'disputes');
    for (const dispute of story.disputes) {
      const li = element('li', 'dispute');
      li.append(Object.assign(document.createElement('b'), { textContent: dispute.point }));
      if (dispute.detail) li.append(element('span', null, dispute.detail));
      list.append(li);
    }
    frag.append(section('Disputed or unconfirmed', list));
  }

  if (story.updates?.length > 1) {
    const list = element('ul', 'timeline');
    for (const update of story.updates) {
      const li = document.createElement('li');
      const when = document.createElement('time');
      when.dateTime = new Date(update.at).toISOString();
      when.textContent = absoluteTime(update.at);
      li.append(when, element('span', null, update.whatsNew));
      list.append(li);
    }
    frag.append(section('How this story developed', list));
  }

  if (story.articles?.length) {
    const list = element('ul', 'source-list');
    for (const article of story.articles) {
      const li = element('li', 'source-item');
      const link = document.createElement('a');
      link.href = article.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(element('span', 'outlet', article.sourceName));
      link.append(element('span', 'headline-text', article.title));
      link.append(element('span', 'stamp', relativeTime(article.publishedAt)));
      li.append(link);
      list.append(li);
    }
    frag.append(section(`Read the original reporting (${story.articles.length})`, list));
  }

  frag.append(renderProvenance(story));
  return frag;
}

/** Honesty panel: how this briefing was made, and what we did or didn't verify. */
function renderProvenance(story) {
  const wrap = element('div', 'provenance');
  const extractive = story.generator === 'extractive-fallback';

  const lines = [];
  lines.push(
    extractive
      ? 'Automated extract — sentences are quoted verbatim from the articles below, not written. ' +
        'Set an ANTHROPIC_API_KEY to enable written briefings.'
      : `Briefing written by ${story.generator} from ${story.sourceCount} outlet(s), ` +
        `${absoluteTime(story.generatedAt)}.`,
  );

  const paragraph = element('p', null, lines.join(' '));
  wrap.append(paragraph);

  const check = element('p');
  if (story.verificationNote) {
    check.append(element('span', 'flag', '⚠ '));
    check.append(text(story.verificationNote));
  } else if (story.verified) {
    check.append(element('span', 'checked', '✓ '));
    check.append(text('Every claim above was checked back against the linked source text.'));
  } else if (!extractive) {
    check.append(text('This briefing was not machine-verified against its sources — read the originals for anything that matters.'));
  }
  if (check.childNodes.length) wrap.append(check);

  return wrap;
}

// ---------------------------------------------------------------- data loading

async function loadStories({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;

  if (!append) {
    state.offset = 0;
    el.stories.setAttribute('aria-busy', 'true');
  }

  const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
  if (state.topic !== 'all') params.set('topic', state.topic);
  if (state.query) params.set('q', state.query);

  try {
    const data = await api(`/stories?${params}`);
    state.total = data.total;
    state.stories = append ? [...state.stories, ...data.stories] : data.stories;
    state.offset += data.stories.length;
    renderList({ append });
  } catch (error) {
    el.stories.replaceChildren(
      Object.assign(element('div', 'empty'), {}),
    );
    const wrap = el.stories.firstChild;
    wrap.append(element('h2', null, 'Could not load stories'));
    wrap.append(element('p', null, error.message));
  } finally {
    state.loading = false;
  }
}

async function loadTopics() {
  try {
    const data = await api('/topics');
    const buttons = [{ topic: 'all', count: data.total }, ...data.topics];
    el.topics.replaceChildren();
    for (const item of buttons) {
      const button = element('button', 'topic-btn');
      button.type = 'button';
      button.dataset.topic = item.topic;
      button.setAttribute('aria-pressed', String(item.topic === state.topic));
      button.append(text(item.topic === 'all' ? 'Top stories' : item.topic));
      if (item.count) button.append(element('span', 'count', item.count));
      button.addEventListener('click', () => {
        if (state.topic === item.topic) return;
        state.topic = item.topic;
        state.openId = null;
        for (const other of el.topics.children) {
          other.setAttribute('aria-pressed', String(other.dataset.topic === item.topic));
        }
        loadStories();
      });
      el.topics.append(button);
    }
  } catch {
    // Topic chips are navigation sugar; the list works fine without them.
  }
}

async function loadStatus() {
  try {
    const status = await api('/status');
    const notices = [];

    if (!status.ai.enabled) {
      notices.push(
        '<strong>Running without AI.</strong> ANTHROPIC_API_KEY is not set, so stories are still ' +
        'gathered, grouped by event and ranked, but each briefing is a verbatim extract rather ' +
        'than a written summary.',
      );
    }
    if (status.content.briefings === 0 && status.pipelineRunning !== true) {
      notices.push('No briefings yet — press <strong>Refresh</strong> to run the first cycle.');
    }
    // Only count feeds we actually tried — feeds never attempted aren't broken.
    const attempted = status.sources.feedsAttempted ?? 0;
    const unhealthy = attempted - status.sources.feedsHealthy;
    if (attempted > 0 && unhealthy > 3) {
      notices.push(`${unhealthy} of ${attempted} feeds were unreachable on the last run.`);
    }

    if (notices.length) {
      el.statusBar.innerHTML = notices.join(' ');
      el.statusBar.hidden = false;
    } else {
      el.statusBar.hidden = true;
    }

    const last = status.pipeline.lastRunRecord;
    const parts = [
      `${status.content.briefings} briefings from ${status.content.articles} articles`,
      `${status.sources.outlets} outlets`,
    ];
    if (last?.startedAt) parts.push(`last updated ${relativeTime(last.startedAt)}`);
    if (status.ai.enabled) parts.push(`summaries by ${status.ai.model}`);
    el.colophon.textContent = parts.join(' · ');
  } catch {
    // Status is diagnostic only.
  }
}

// ---------------------------------------------------------------- events

el.searchInput.addEventListener(
  'input',
  debounce((event) => {
    state.query = event.target.value.trim();
    el.searchClear.hidden = state.query.length === 0;
    state.openId = null;
    loadStories();
  }, 280),
);

el.searchForm.addEventListener('submit', (event) => event.preventDefault());

el.searchClear.addEventListener('click', () => {
  el.searchInput.value = '';
  state.query = '';
  el.searchClear.hidden = true;
  loadStories();
});

el.loadMore.addEventListener('click', () => loadStories({ append: true }));

el.refresh.addEventListener('click', async () => {
  el.refresh.dataset.busy = 'true';
  try {
    await api('/refresh', { method: 'POST' });
    el.statusBar.innerHTML =
      '<strong>Fetching the latest coverage…</strong> This takes a minute or two — ' +
      'feeds are read, articles are grouped by event, then briefings are written.';
    el.statusBar.hidden = false;
    // Poll until the cycle finishes rather than guessing at a delay.
    await waitForCycle();
    state.detailCache.clear();
    await Promise.all([loadStories(), loadTopics(), loadStatus()]);
  } catch (error) {
    el.statusBar.textContent = `Refresh failed: ${error.message}`;
    el.statusBar.hidden = false;
  } finally {
    el.refresh.dataset.busy = 'false';
  }
});

async function waitForCycle(maxWaitMs = 5 * 60_000) {
  const deadline = Date.now() + maxWaitMs;
  // Give the server a moment to flip `running` to true before watching for false.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  while (Date.now() < deadline) {
    const status = await api('/status').catch(() => null);
    if (status && status.pipeline.running === false) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== el.searchInput) {
    event.preventDefault();
    el.searchInput.focus();
  }
  if (event.key === 'Escape' && document.activeElement === el.searchInput) {
    el.searchInput.blur();
  }
});

// ---------------------------------------------------------------- boot

loadStories();
loadTopics();
loadStatus();
setInterval(loadStatus, 60_000);
