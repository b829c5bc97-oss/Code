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

/**
 * The final itself. This is what turns a list of years into a hundred years of
 * football: every one of these was ninety minutes somebody remembers.
 */
export type Final = {
  runnerUp: string;
  /** Score after normal or extra time, e.g. "4-2". */
  score: string;
  /** How it was settled, when it wasn't settled in ninety minutes. */
  decider?: 'aet' | 'pens';
  /** Penalty shoot-out score, when there was one. */
  pens?: string;
  /** Where it was played. */
  venue?: string;
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
  final?: Final;
};

export const worldCups: TimelineEntry[] = [
  {
    year: 1930, host: 'Uruguay', winner: 'Uruguay',
    final: {runnerUp: 'Argentina', score: '4-2', venue: 'Estadio Centenario, Montevideo'},
    hero: {label: 'The first whistle', action: 'first-whistle'},
  },
  {year: 1934, host: 'Italy', winner: 'Italy', final: {runnerUp: 'Czechoslovakia', score: '2-1', decider: 'aet', venue: 'Rome'}},
  {year: 1938, host: 'France', winner: 'Italy', final: {runnerUp: 'Hungary', score: '4-2', venue: 'Paris'}},
  {year: 1942, host: '—', winner: null, cancelled: true},
  {year: 1946, host: '—', winner: null, cancelled: true},
  {
    year: 1950, host: 'Brazil', winner: 'Uruguay',
    final: {runnerUp: 'Brazil', score: '2-1', venue: 'Maracanã, Rio de Janeiro'},
    hero: {label: 'A stadium falls silent', action: 'volley'},
  },
  {year: 1954, host: 'Switzerland', winner: 'West Germany', final: {runnerUp: 'Hungary', score: '3-2', venue: 'Bern'}},
  {year: 1958, host: 'Sweden', winner: 'Brazil', final: {runnerUp: 'Sweden', score: '5-2', venue: 'Stockholm'}},
  {year: 1962, host: 'Chile', winner: 'Brazil', final: {runnerUp: 'Czechoslovakia', score: '3-1', venue: 'Santiago'}},
  {year: 1966, host: 'England', winner: 'England', final: {runnerUp: 'West Germany', score: '4-2', decider: 'aet', venue: 'Wembley, London'}},
  {
    year: 1970, host: 'Mexico', winner: 'Brazil',
    final: {runnerUp: 'Italy', score: '4-1', venue: 'Estadio Azteca, Mexico City'},
    hero: {label: 'The header', action: 'header'},
  },
  {year: 1974, host: 'West Germany', winner: 'West Germany', final: {runnerUp: 'Netherlands', score: '2-1', venue: 'Munich'}},
  {year: 1978, host: 'Argentina', winner: 'Argentina', final: {runnerUp: 'Netherlands', score: '3-1', decider: 'aet', venue: 'Buenos Aires'}},
  {year: 1982, host: 'Spain', winner: 'Italy', final: {runnerUp: 'West Germany', score: '3-1', venue: 'Madrid'}},
  {
    year: 1986, host: 'Mexico', winner: 'Argentina',
    final: {runnerUp: 'West Germany', score: '3-2', venue: 'Estadio Azteca, Mexico City'},
    hero: {label: 'The run', action: 'solo-run'},
  },
  {year: 1990, host: 'Italy', winner: 'West Germany', final: {runnerUp: 'Argentina', score: '1-0', venue: 'Rome'}},
  {year: 1994, host: 'United States', winner: 'Brazil', final: {runnerUp: 'Italy', score: '0-0', decider: 'pens', pens: '3-2', venue: 'Pasadena'}},
  {year: 1998, host: 'France', winner: 'France', final: {runnerUp: 'Brazil', score: '3-0', venue: 'Saint-Denis, Paris'}},
  {year: 2002, host: 'Korea / Japan', winner: 'Brazil', final: {runnerUp: 'Germany', score: '2-0', venue: 'Yokohama'}},
  {
    year: 2006, host: 'Germany', winner: 'Italy',
    final: {runnerUp: 'France', score: '1-1', decider: 'pens', pens: '5-3', venue: 'Berlin'},
    hero: {label: 'The save', action: 'save'},
  },
  {year: 2010, host: 'South Africa', winner: 'Spain', final: {runnerUp: 'Netherlands', score: '1-0', decider: 'aet', venue: 'Johannesburg'}},
  {year: 2014, host: 'Brazil', winner: 'Germany', final: {runnerUp: 'Argentina', score: '1-0', decider: 'aet', venue: 'Maracanã, Rio de Janeiro'}},
  {year: 2018, host: 'Russia', winner: 'France', final: {runnerUp: 'Croatia', score: '4-2', venue: 'Moscow'}},
  {
    year: 2022, host: 'Qatar', winner: 'Argentina',
    final: {runnerUp: 'France', score: '3-3', decider: 'pens', pens: '4-2', venue: 'Lusail'},
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
