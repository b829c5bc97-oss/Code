/**
 * Every FIFA World Cup from 1930 to 2026, plus the two editions lost to the
 * Second World War. The 1942/1946 gap is not an omission — it is shown in the
 * rail as a deliberate beat, because a century of the tournament includes the
 * years it could not be played.
 */

export type HeroMoment = {
  /** Short caption shown during the 1.5s hero hold. */
  label: string;
  /**
   * Which stylised action the freeze-frame depicts. No real player is named,
   * depicted or implied — see §6 of the brief and `players.ts`.
   */
  action: 'header' | 'solo-run' | 'save' | 'lift' | 'volley' | 'first-whistle';
};

export type TimelineEntry = {
  year: number;
  /** Host nation(s), display string. */
  host: string;
  /** Champion. `null` for the cancelled editions and for a not-yet-filled result. */
  winner: string | null;
  /** True for 1942 and 1946. */
  cancelled?: boolean;
  /** Editions that get the rail-slowing hero treatment in Shot 03. */
  hero?: HeroMoment;
};

export const worldCups: TimelineEntry[] = [
  {
    year: 1930,
    host: 'Uruguay',
    winner: 'Uruguay',
    hero: {label: 'The first whistle', action: 'first-whistle'},
  },
  {year: 1934, host: 'Italy', winner: 'Italy'},
  {year: 1938, host: 'France', winner: 'Italy'},
  {year: 1942, host: '—', winner: null, cancelled: true},
  {year: 1946, host: '—', winner: null, cancelled: true},
  {
    year: 1950,
    host: 'Brazil',
    winner: 'Uruguay',
    hero: {label: 'A stadium falls silent', action: 'volley'},
  },
  {year: 1954, host: 'Switzerland', winner: 'West Germany'},
  {year: 1958, host: 'Sweden', winner: 'Brazil'},
  {year: 1962, host: 'Chile', winner: 'Brazil'},
  {year: 1966, host: 'England', winner: 'England'},
  {
    year: 1970,
    host: 'Mexico',
    winner: 'Brazil',
    hero: {label: 'The header', action: 'header'},
  },
  {year: 1974, host: 'West Germany', winner: 'West Germany'},
  {year: 1978, host: 'Argentina', winner: 'Argentina'},
  {year: 1982, host: 'Spain', winner: 'Italy'},
  {
    year: 1986,
    host: 'Mexico',
    winner: 'Argentina',
    hero: {label: 'The run', action: 'solo-run'},
  },
  {year: 1990, host: 'Italy', winner: 'West Germany'},
  {year: 1994, host: 'United States', winner: 'Brazil'},
  {year: 1998, host: 'France', winner: 'France'},
  {year: 2002, host: 'Korea / Japan', winner: 'Brazil'},
  {
    year: 2006,
    host: 'Germany',
    winner: 'Italy',
    hero: {label: 'The save', action: 'save'},
  },
  {year: 2010, host: 'South Africa', winner: 'Spain'},
  {year: 2014, host: 'Brazil', winner: 'Germany'},
  {year: 2018, host: 'Russia', winner: 'France'},
  {
    year: 2022,
    host: 'Qatar',
    winner: 'Argentina',
    hero: {label: 'Lifted again', action: 'lift'},
  },
  // ─── SWAP POINT ────────────────────────────────────────────────────────────
  // Set `winner` once the 2026 champion is known. Nothing else needs editing;
  // the card renders an em-dash placeholder until then.
  {year: 2026, host: 'Canada / Mexico / USA', winner: null},
];

/** The destination the whole rail is travelling toward. */
export const CENTENARY = {
  year: 2030,
  host: 'Morocco · Spain · Portugal · Uruguay · Argentina · Paraguay',
} as const;

export const heroEditions = worldCups.filter((c) => c.hero);
