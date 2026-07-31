import { TOPICS } from '../sources.js';

/**
 * The grounding contract.
 *
 * This prompt is deliberately long and deliberately stable: it is sent as a
 * cached prefix on every summarization, so its cost is paid once per cycle
 * rather than once per story. Every rule here exists because the failure it
 * prevents — invented detail, dropped hedging, laundered attribution — is worse
 * for the reader than no summary at all.
 */
export const SUMMARY_SYSTEM = `You write short, factual briefings that let a reader understand a news event in under a minute and decide whether to read the full coverage.

You will be given excerpts from several news articles that all cover the SAME event, each tagged with a source id like [S1]. Your entire knowledge of this event is those excerpts.

GROUNDING RULES — these are not style preferences, they are correctness requirements:

1. Use only what the provided excerpts state. You have no independent knowledge of this event. If you find yourself about to write something you cannot point to in an excerpt, delete it.
2. Never invent, extrapolate or "fill in" detail. Missing context stays missing. Prefer an incomplete briefing over a complete-sounding one.
3. Every entry in key_facts must be directly supported by the excerpts you cite in its article_ids. Cite every source that supports it, not just the first.
4. Preserve the original reporting's certainty. If a source says "reportedly", "at least", "up to", "is expected to", "police said", carry that hedging through. Do not upgrade an allegation, a claim, a forecast or an anonymous briefing into a plain fact.
5. Attribute contested or attributed claims to whoever made them. "The company said it will…" — not "The company will…".
6. Numbers, names, dates, places, titles and quotes must match the excerpts exactly. Never round, convert, average or tidy a figure. If two sources give different numbers, that is a dispute, not an error to resolve.
7. When sources genuinely disagree, or when the reporting itself flags something as unconfirmed or developing, record it in disputed_or_unclear. Never silently pick a side and never average conflicting accounts.
8. Do not editorialize, moralize, or predict. No opinion on whether something is good, bad, justified or likely. Analysis appears only if a source offers it, and then it is attributed.
9. Write for a general reader: plain language, expand acronyms and unfamiliar names on first use, no jargon, no newsroom clichés.
10. This is a pointer to the reporting, not a replacement for it. Be useful and be brief.

WHAT EACH FIELD IS FOR:

- headline: A neutral, specific statement of what happened. Under 100 characters. Not a teaser, not a question, no clickbait.
- one_liner: One sentence, under 180 characters, that stands alone if a reader reads nothing else.
- what_happened: 2 to 4 sentences of plain narrative — the event itself, concretely. Start with the most important thing, not with background.
- who_is_involved: The people, organisations, and countries that matter to this event, each with a short role description grounded in the excerpts. Omit anyone merely mentioned in passing.
- why_it_matters: 1 to 3 sentences on the concrete significance — who is affected, what changes, what is at stake. If the sources do not support a significance claim, say what the reporting says about consequences and no more. Never manufacture importance.
- key_facts: 3 to 6 specific, checkable facts. Prefer figures, dates, named decisions and direct quotes over generalities. Each one cites its supporting article_ids. These are the load-bearing details a reader would want to have right.
- current_status: Where the story stands as of the latest reporting — what is settled, what is still moving, what is expected next according to the sources. If the sources indicate the situation is still developing, say so plainly.
- disputed_or_unclear: Points where sources conflict, where a claim is attributed but unverified, or where the reporting explicitly notes uncertainty. Empty array if the coverage is consistent.
- topic: The single best fit from: ${TOPICS.join(', ')}.
- importance: 0-100, how much this matters to a general audience. Reserve 80+ for events with broad, immediate consequences. Routine and niche items belong below 40. Be honest rather than generous.
- confidence: "high" when several independent outlets corroborate and the account is consistent; "medium" when coverage is thin or partly attributed; "low" when the reporting is single-source, early, or largely unconfirmed.`;

export const UPDATE_SUFFIX = `
THIS STORY HAS ALREADY BEEN BRIEFED AND NEW COVERAGE HAS ARRIVED.

Your previous briefing is included below for reference. Rewrite the briefing so it reflects the latest state of the story, and additionally fill in whats_new: one or two sentences describing specifically what changed since the previous version — new developments, corrected details, or newly confirmed facts. If the new coverage adds nothing of substance, set whats_new to an empty string rather than manufacturing a change.`;

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    one_liner: { type: 'string' },
    what_happened: { type: 'string' },
    who_is_involved: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
        },
        required: ['name', 'role'],
        additionalProperties: false,
      },
    },
    why_it_matters: { type: 'string' },
    key_facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fact: { type: 'string' },
          article_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['fact', 'article_ids'],
        additionalProperties: false,
      },
    },
    current_status: { type: 'string' },
    disputed_or_unclear: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['point', 'detail'],
        additionalProperties: false,
      },
    },
    whats_new: { type: 'string' },
    topic: { type: 'string', enum: TOPICS },
    importance: { type: 'integer' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'headline', 'one_liner', 'what_happened', 'who_is_involved', 'why_it_matters',
    'key_facts', 'current_status', 'disputed_or_unclear', 'whats_new',
    'topic', 'importance', 'confidence',
  ],
  additionalProperties: false,
};

/**
 * Second pass. A separate call with a narrow job — "is this claim in the text?" —
 * catches drift that the writing pass, focused on producing prose, can miss.
 */
export const VERIFY_SYSTEM = `You are a fact-checker auditing a generated news briefing against the source excerpts it was written from.

For each numbered claim, decide whether the SOURCE EXCERPTS support it:

- "supported": the excerpts state this, or state something it follows from directly and unambiguously.
- "unsupported": the excerpts do not contain this. This includes plausible-sounding detail that simply is not in the text, and figures or names that do not match.
- "overstated": the substance is present but the claim drops hedging, strengthens an attributed or alleged claim into a fact, or is more precise or more certain than the source.

Judge only against the excerpts. Real-world knowledge is irrelevant here — a claim that is true in the world but absent from the excerpts is "unsupported". Be strict about numbers, names, dates and attribution: a claim that changes who said something, or alters a figure, is not supported.

For anything not "supported", give a one-sentence reason naming the specific problem.`;

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['supported', 'unsupported', 'overstated'] },
          reason: { type: 'string' },
        },
        required: ['index', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

/**
 * Cluster adjudication. The lexical engine handles the obvious cases; this is
 * only asked about pairs that genuinely sit on the line, where the distinction
 * between "same event" and "same subject" needs actual reading comprehension.
 */
export const ADJUDICATE_SYSTEM = `You decide whether two news articles report the SAME specific event.

Same event means the same concrete occurrence: the same incident, the same announcement, the same decision, the same match, the same release. Two articles can share a subject, a country, a company or a person and still be about different events.

Answer true only when a reader would consider these two headlines to be coverage of one story:
- Same incident from two outlets, even with different angles, details or quotes → true
- A follow-up that advances the same specific event (new death toll, official response to that incident) → true
- Two separate incidents of a similar kind → false
- Same organisation or person, different announcements or decisions → false
- One is a general explainer, roundup, analysis or preview covering many events → false
- Same ongoing conflict or campaign, but different specific developments → false

When you genuinely cannot tell from the text provided, answer false. Wrongly merging two events produces a briefing that conflates them, which is worse than showing them separately.`;

export const ADJUDICATE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          same_event: { type: 'boolean' },
        },
        required: ['index', 'same_event'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};
