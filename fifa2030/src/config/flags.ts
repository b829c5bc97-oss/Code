/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FLAGS — the world, in one graphic language
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Football Unites the World" has to be shown, not just typed. These flags are
 * how the film says it: on the timeline's winner cards, in the crowd, at the
 * globe pins, and ringing the ball in the final lockup.
 *
 * Every flag is CONSTRUCTED FROM PRIMITIVES, not imported as artwork:
 *   · they render at any size with no raster assets and no network fetch
 *   · they share one stroke weight, one corner treatment, one level of
 *     abstraction, so 57 flags read as one designed system rather than as a
 *     sprite sheet scraped from somewhere
 *   · they animate — a flag built from shapes can ripple; a PNG cannot
 *
 * DELIBERATE SIMPLIFICATION. Coats of arms, Arabic script, the Brazilian
 * celestial globe, the Mexican eagle and similar fine detail are reduced to a
 * single mark. At the sizes these appear — often 40px wide, often moving — the
 * detail is invisible anyway, and a half-rendered coat of arms looks worse than
 * an honest abstraction. Nations are identified by their colour structure,
 * which is what actually reads at broadcast distance.
 *
 * SWAP POINT: to use official vector flags, drop SVGs into `public/flags/` and
 * give the entry an `assetSrc`. `<Flag>` renders that instead. Nothing else
 * changes.
 *
 * The list below is the 48-team format populated with the confederations'
 * strongest sides plus every past champion and all six hosts. FINAL QUALIFIERS
 * ARE NOT YET KNOWN — replace entries here once qualification completes.
 */

export type FlagLayer =
  /** Horizontal or vertical bands. `weights` defaults to equal. */
  | {t: 'bands'; dir: 'h' | 'v'; colors: string[]; weights?: number[]}
  /** Arbitrary rectangle, in a 60×40 space. */
  | {t: 'rect'; x: number; y: number; w: number; h: number; color: string}
  | {t: 'disc'; cx: number; cy: number; r: number; color: string}
  | {t: 'ring'; cx: number; cy: number; r: number; color: string; width: number}
  | {t: 'star'; cx: number; cy: number; r: number; color: string; points?: number; rot?: number}
  /** Crescent, drawn as a disc with a bite taken out of it. */
  | {t: 'crescent'; cx: number; cy: number; r: number; color: string}
  /** Nordic or centred cross. `offsetX` shifts it toward the hoist. */
  | {t: 'cross'; color: string; thickness: number; offsetX?: number}
  | {t: 'saltire'; color: string; thickness: number}
  /** Triangle from the hoist. */
  | {t: 'triangle'; color: string; width: number}
  | {t: 'diamond'; cx: number; cy: number; rx: number; ry: number; color: string}
  /** Repeating stars, e.g. the US canton. */
  | {t: 'starfield'; x: number; y: number; w: number; h: number; cols: number; rows: number; r: number; color: string};

export type FlagSpec = {
  /** ISO-ish short code, used as the React key and the label. */
  code: string;
  name: string;
  confederation: 'UEFA' | 'CONMEBOL' | 'CAF' | 'AFC' | 'CONCACAF' | 'OFC';
  layers: FlagLayer[];
  /** SWAP POINT: path under `public/flags/` to an official vector flag. */
  assetSrc?: string;
};

export const FLAG_W = 60;
export const FLAG_H = 40;

const B = (dir: 'h' | 'v', colors: string[], weights?: number[]): FlagLayer =>
  weights ? {t: 'bands', dir, colors, weights} : {t: 'bands', dir, colors};

export const flags: FlagSpec[] = [
  // ── Hosts ────────────────────────────────────────────────────────────────
  {
    code: 'MAR', name: 'Morocco', confederation: 'CAF',
    layers: [B('h', ['#C1272D']), {t: 'star', cx: 30, cy: 20, r: 8, color: '#006233'}],
  },
  {
    code: 'ESP', name: 'Spain', confederation: 'UEFA',
    layers: [B('h', ['#AA151B', '#F1BF00', '#AA151B'], [1, 2, 1])],
  },
  {
    code: 'POR', name: 'Portugal', confederation: 'UEFA',
    layers: [
      B('v', ['#046A38', '#DA291C'], [2, 3]),
      {t: 'disc', cx: 24, cy: 20, r: 7, color: '#F1BF00'},
      {t: 'disc', cx: 24, cy: 20, r: 4.2, color: '#DA291C'},
    ],
  },
  {
    code: 'URU', name: 'Uruguay', confederation: 'CONMEBOL',
    layers: [
      B('h', ['#FFFFFF', '#0038A8', '#FFFFFF', '#0038A8', '#FFFFFF', '#0038A8', '#FFFFFF', '#0038A8', '#FFFFFF']),
      {t: 'rect', x: 0, y: 0, w: 26, h: 17.8, color: '#FFFFFF'},
      {t: 'star', cx: 13, cy: 8.9, r: 6, color: '#F1BF00', points: 8},
      {t: 'disc', cx: 13, cy: 8.9, r: 3, color: '#F1BF00'},
    ],
  },
  {
    code: 'ARG', name: 'Argentina', confederation: 'CONMEBOL',
    layers: [
      B('h', ['#75AADB', '#FFFFFF', '#75AADB']),
      {t: 'star', cx: 30, cy: 20, r: 5.4, color: '#F1BF00', points: 8},
      {t: 'disc', cx: 30, cy: 20, r: 2.6, color: '#F1BF00'},
    ],
  },
  {
    code: 'PAR', name: 'Paraguay', confederation: 'CONMEBOL',
    layers: [
      B('h', ['#D52B1E', '#FFFFFF', '#0038A8']),
      {t: 'disc', cx: 30, cy: 20, r: 5, color: '#FFFFFF'},
      {t: 'ring', cx: 30, cy: 20, r: 5, color: '#009B3A', width: 1.1},
      {t: 'star', cx: 30, cy: 20, r: 2.6, color: '#F1BF00'},
    ],
  },

  // ── Past champions not already listed ────────────────────────────────────
  {
    code: 'BRA', name: 'Brazil', confederation: 'CONMEBOL',
    layers: [
      B('h', ['#009B3A']),
      {t: 'diamond', cx: 30, cy: 20, rx: 22, ry: 14.5, color: '#FEDF00'},
      {t: 'disc', cx: 30, cy: 20, r: 8, color: '#002776'},
      {t: 'rect', x: 22, y: 18.6, w: 16, h: 1.5, color: '#FFFFFF'},
    ],
  },
  {code: 'GER', name: 'Germany', confederation: 'UEFA', layers: [B('h', ['#000000', '#DD0000', '#FFCE00'])]},
  {code: 'ITA', name: 'Italy', confederation: 'UEFA', layers: [B('v', ['#008C45', '#F4F5F0', '#CD212A'])]},
  {code: 'FRA', name: 'France', confederation: 'UEFA', layers: [B('v', ['#002395', '#FFFFFF', '#ED2939'])]},
  {
    code: 'ENG', name: 'England', confederation: 'UEFA',
    layers: [B('h', ['#FFFFFF']), {t: 'cross', color: '#CE1124', thickness: 7}],
  },

  // ── UEFA ─────────────────────────────────────────────────────────────────
  {code: 'NED', name: 'Netherlands', confederation: 'UEFA', layers: [B('h', ['#AE1C28', '#FFFFFF', '#21468B'])]},
  {code: 'BEL', name: 'Belgium', confederation: 'UEFA', layers: [B('v', ['#000000', '#FDDA24', '#EF3340'])]},
  {
    code: 'CRO', name: 'Croatia', confederation: 'UEFA',
    layers: [
      B('h', ['#FF0000', '#FFFFFF', '#171796']),
      {t: 'rect', x: 24, y: 12, w: 12, h: 10, color: '#FFFFFF'},
      {t: 'rect', x: 24, y: 12, w: 4, h: 5, color: '#FF0000'},
      {t: 'rect', x: 32, y: 12, w: 4, h: 5, color: '#FF0000'},
      {t: 'rect', x: 28, y: 17, w: 4, h: 5, color: '#FF0000'},
    ],
  },
  {
    code: 'DEN', name: 'Denmark', confederation: 'UEFA',
    layers: [B('h', ['#C60C30']), {t: 'cross', color: '#FFFFFF', thickness: 6, offsetX: -6}],
  },
  {
    code: 'SUI', name: 'Switzerland', confederation: 'UEFA',
    layers: [B('h', ['#DA291C']), {t: 'rect', x: 26.5, y: 10, w: 7, h: 20, color: '#FFFFFF'}, {t: 'rect', x: 20, y: 16.5, w: 20, h: 7, color: '#FFFFFF'}],
  },
  {
    code: 'SWE', name: 'Sweden', confederation: 'UEFA',
    layers: [B('h', ['#006AA7']), {t: 'cross', color: '#FECC00', thickness: 6, offsetX: -6}],
  },
  {code: 'POL', name: 'Poland', confederation: 'UEFA', layers: [B('h', ['#FFFFFF', '#DC143C'])]},
  {code: 'SRB', name: 'Serbia', confederation: 'UEFA', layers: [B('h', ['#C6363C', '#0C4076', '#FFFFFF'])]},
  {code: 'AUT', name: 'Austria', confederation: 'UEFA', layers: [B('h', ['#ED2939', '#FFFFFF', '#ED2939'])]},
  {
    code: 'NOR', name: 'Norway', confederation: 'UEFA',
    layers: [
      B('h', ['#BA0C2F']),
      {t: 'cross', color: '#FFFFFF', thickness: 9, offsetX: -6},
      {t: 'cross', color: '#00205B', thickness: 4.5, offsetX: -6},
    ],
  },
  {code: 'UKR', name: 'Ukraine', confederation: 'UEFA', layers: [B('h', ['#0057B7', '#FFD700'])]},
  {
    code: 'SCO', name: 'Scotland', confederation: 'UEFA',
    layers: [B('h', ['#005EB8']), {t: 'saltire', color: '#FFFFFF', thickness: 6}],
  },
  {
    code: 'WAL', name: 'Wales', confederation: 'UEFA',
    layers: [
      B('h', ['#FFFFFF', '#00AD3B']),
      // The dragon reduced to a single red mark — see the note at the top.
      {t: 'rect', x: 20, y: 15, w: 20, h: 6, color: '#C8102E'},
      {t: 'triangle', color: '#C8102E', width: 0},
    ],
  },
  {code: 'CZE', name: 'Czechia', confederation: 'UEFA', layers: [B('h', ['#FFFFFF', '#D7141A']), {t: 'triangle', color: '#11457E', width: 24}]},
  {code: 'TUR', name: 'Türkiye', confederation: 'UEFA', layers: [B('h', ['#E30A17']), {t: 'crescent', cx: 24, cy: 20, r: 8, color: '#FFFFFF'}, {t: 'star', cx: 36, cy: 20, r: 4, color: '#FFFFFF'}]},

  // ── CONMEBOL ─────────────────────────────────────────────────────────────
  {
    code: 'CHI', name: 'Chile', confederation: 'CONMEBOL',
    layers: [
      B('h', ['#FFFFFF', '#D52B1E']),
      {t: 'rect', x: 0, y: 0, w: 20, h: 20, color: '#0039A6'},
      {t: 'star', cx: 10, cy: 10, r: 6, color: '#FFFFFF'},
    ],
  },
  {code: 'COL', name: 'Colombia', confederation: 'CONMEBOL', layers: [B('h', ['#FCD116', '#003893', '#CE1126'], [2, 1, 1])]},
  {
    code: 'ECU', name: 'Ecuador', confederation: 'CONMEBOL',
    layers: [B('h', ['#FFDD00', '#0072CE', '#EF3340'], [2, 1, 1]), {t: 'disc', cx: 30, cy: 20, r: 5, color: '#0072CE'}],
  },
  {code: 'PER', name: 'Peru', confederation: 'CONMEBOL', layers: [B('v', ['#D91023', '#FFFFFF', '#D91023'])]},
  {code: 'BOL', name: 'Bolivia', confederation: 'CONMEBOL', layers: [B('h', ['#D52B1E', '#F9E300', '#007934'])]},
  {
    code: 'VEN', name: 'Venezuela', confederation: 'CONMEBOL',
    layers: [
      B('h', ['#FFCC00', '#00247D', '#CF142B']),
      {t: 'starfield', x: 18, y: 16, w: 24, h: 8, cols: 4, rows: 1, r: 1.7, color: '#FFFFFF'},
    ],
  },

  // ── CAF ──────────────────────────────────────────────────────────────────
  {
    code: 'SEN', name: 'Senegal', confederation: 'CAF',
    layers: [B('v', ['#00853F', '#FDEF42', '#E31B23']), {t: 'star', cx: 30, cy: 20, r: 5, color: '#00853F'}],
  },
  {code: 'NGA', name: 'Nigeria', confederation: 'CAF', layers: [B('v', ['#008751', '#FFFFFF', '#008751'])]},
  {
    code: 'EGY', name: 'Egypt', confederation: 'CAF',
    layers: [B('h', ['#CE1126', '#FFFFFF', '#000000']), {t: 'star', cx: 30, cy: 20, r: 4, color: '#C09300'}],
  },
  {
    code: 'GHA', name: 'Ghana', confederation: 'CAF',
    layers: [B('h', ['#CE1126', '#FCD116', '#006B3F']), {t: 'star', cx: 30, cy: 20, r: 5, color: '#000000'}],
  },
  {
    code: 'CMR', name: 'Cameroon', confederation: 'CAF',
    layers: [B('v', ['#007A5E', '#CE1126', '#FCD116']), {t: 'star', cx: 30, cy: 20, r: 5, color: '#FCD116'}],
  },
  {
    code: 'TUN', name: 'Tunisia', confederation: 'CAF',
    layers: [
      B('h', ['#E70013']),
      {t: 'disc', cx: 30, cy: 20, r: 10, color: '#FFFFFF'},
      {t: 'crescent', cx: 31, cy: 20, r: 6.4, color: '#E70013'},
      {t: 'star', cx: 32.5, cy: 20, r: 3, color: '#E70013'},
    ],
  },
  {
    code: 'ALG', name: 'Algeria', confederation: 'CAF',
    layers: [
      B('v', ['#006233', '#FFFFFF']),
      {t: 'crescent', cx: 30, cy: 20, r: 7.5, color: '#D21034'},
      {t: 'star', cx: 33, cy: 20, r: 3.4, color: '#D21034'},
    ],
  },
  {code: 'CIV', name: "Côte d'Ivoire", confederation: 'CAF', layers: [B('v', ['#FF8200', '#FFFFFF', '#009E60'])]},
  {
    code: 'RSA', name: 'South Africa', confederation: 'CAF',
    layers: [
      B('h', ['#E03C31', '#FFFFFF', '#007A4D', '#FFFFFF', '#001489'], [3, 1, 2, 1, 3]),
      {t: 'triangle', color: '#000000', width: 20},
      {t: 'rect', x: 0, y: 16, w: 60, h: 8, color: '#007A4D'},
      {t: 'rect', x: 0, y: 17.6, w: 60, h: 4.8, color: '#FFB612'},
    ],
  },
  {code: 'MLI', name: 'Mali', confederation: 'CAF', layers: [B('v', ['#14B53A', '#FCD116', '#CE1126'])]},

  // ── AFC ──────────────────────────────────────────────────────────────────
  {code: 'JPN', name: 'Japan', confederation: 'AFC', layers: [B('h', ['#FFFFFF']), {t: 'disc', cx: 30, cy: 20, r: 9, color: '#BC002D'}]},
  {
    code: 'KOR', name: 'Korea Republic', confederation: 'AFC',
    layers: [
      B('h', ['#FFFFFF']),
      {t: 'disc', cx: 30, cy: 20, r: 8, color: '#CD2E3A'},
      {t: 'disc', cx: 30, cy: 24, r: 4, color: '#0047A0'},
      {t: 'rect', x: 8, y: 11, w: 8, h: 1.4, color: '#000000'},
      {t: 'rect', x: 44, y: 27.6, w: 8, h: 1.4, color: '#000000'},
    ],
  },
  {
    code: 'AUS', name: 'Australia', confederation: 'AFC',
    layers: [
      B('h', ['#00008B']),
      {t: 'rect', x: 0, y: 0, w: 30, h: 20, color: '#00247D'},
      {t: 'cross', color: '#FFFFFF', thickness: 4, offsetX: -15},
      {t: 'star', cx: 15, cy: 30, r: 4, color: '#FFFFFF'},
      {t: 'starfield', x: 34, y: 8, w: 22, h: 24, cols: 2, rows: 2, r: 2, color: '#FFFFFF'},
    ],
  },
  {
    code: 'KSA', name: 'Saudi Arabia', confederation: 'AFC',
    layers: [
      B('h', ['#006C35']),
      {t: 'rect', x: 12, y: 16, w: 36, h: 2.4, color: '#FFFFFF'},
      {t: 'rect', x: 12, y: 24, w: 36, h: 1.6, color: '#FFFFFF'},
    ],
  },
  {
    code: 'IRN', name: 'IR Iran', confederation: 'AFC',
    layers: [B('h', ['#239F40', '#FFFFFF', '#DA0000']), {t: 'star', cx: 30, cy: 20, r: 4, color: '#DA0000', points: 4}],
  },
  {
    code: 'QAT', name: 'Qatar', confederation: 'AFC',
    layers: [B('h', ['#8A1538']), {t: 'rect', x: 0, y: 0, w: 18, h: 40, color: '#FFFFFF'}],
  },
  {
    code: 'IRQ', name: 'Iraq', confederation: 'AFC',
    layers: [B('h', ['#CE1126', '#FFFFFF', '#000000']), {t: 'rect', x: 20, y: 18.4, w: 20, h: 3.2, color: '#007A3D'}],
  },
  {
    code: 'UZB', name: 'Uzbekistan', confederation: 'AFC',
    layers: [
      B('h', ['#0099B5', '#FFFFFF', '#1EB53A']),
      {t: 'crescent', cx: 12, cy: 7, r: 4, color: '#FFFFFF'},
      {t: 'starfield', x: 18, y: 3, w: 18, h: 8, cols: 3, rows: 1, r: 1.4, color: '#FFFFFF'},
    ],
  },
  {
    code: 'JOR', name: 'Jordan', confederation: 'AFC',
    layers: [
      B('h', ['#000000', '#FFFFFF', '#007A3D']),
      {t: 'triangle', color: '#CE1126', width: 24},
      {t: 'star', cx: 8, cy: 20, r: 2.6, color: '#FFFFFF', points: 7},
    ],
  },

  // ── CONCACAF ─────────────────────────────────────────────────────────────
  {
    code: 'USA', name: 'United States', confederation: 'CONCACAF',
    layers: [
      B('h', ['#B31942', '#FFFFFF', '#B31942', '#FFFFFF', '#B31942', '#FFFFFF', '#B31942', '#FFFFFF', '#B31942', '#FFFFFF', '#B31942', '#FFFFFF', '#B31942']),
      {t: 'rect', x: 0, y: 0, w: 24, h: 21.5, color: '#0A3161'},
      {t: 'starfield', x: 1.5, y: 1.5, w: 21, h: 18.5, cols: 5, rows: 4, r: 1.4, color: '#FFFFFF'},
    ],
  },
  {
    code: 'MEX', name: 'Mexico', confederation: 'CONCACAF',
    layers: [B('v', ['#006847', '#FFFFFF', '#CE1126']), {t: 'disc', cx: 30, cy: 20, r: 4.6, color: '#8B5A2B'}],
  },
  {
    code: 'CAN', name: 'Canada', confederation: 'CONCACAF',
    layers: [
      B('v', ['#D80621', '#FFFFFF', '#D80621'], [1, 2, 1]),
      {t: 'star', cx: 30, cy: 20, r: 7, color: '#D80621', points: 5},
      {t: 'rect', x: 29, y: 22, w: 2, h: 6, color: '#D80621'},
    ],
  },
  {code: 'CRC', name: 'Costa Rica', confederation: 'CONCACAF', layers: [B('h', ['#002B7F', '#FFFFFF', '#CE1126', '#FFFFFF', '#002B7F'], [1, 1, 2, 1, 1])]},
  {
    code: 'JAM', name: 'Jamaica', confederation: 'CONCACAF',
    layers: [
      B('h', ['#009B3A']),
      {t: 'triangle', color: '#000000', width: 22},
      {t: 'saltire', color: '#FED100', thickness: 6},
    ],
  },
  {
    code: 'PAN', name: 'Panama', confederation: 'CONCACAF',
    layers: [
      B('h', ['#FFFFFF']),
      {t: 'rect', x: 30, y: 0, w: 30, h: 20, color: '#DA121A'},
      {t: 'rect', x: 0, y: 20, w: 30, h: 20, color: '#005293'},
      {t: 'star', cx: 15, cy: 10, r: 4, color: '#005293'},
      {t: 'star', cx: 45, cy: 30, r: 4, color: '#DA121A'},
    ],
  },
  {
    code: 'HON', name: 'Honduras', confederation: 'CONCACAF',
    layers: [
      B('h', ['#0073CF', '#FFFFFF', '#0073CF']),
      {t: 'starfield', x: 22, y: 15, w: 16, h: 10, cols: 3, rows: 2, r: 1.5, color: '#0073CF'},
    ],
  },

  // ── OFC ──────────────────────────────────────────────────────────────────
  {
    code: 'NZL', name: 'New Zealand', confederation: 'OFC',
    layers: [
      B('h', ['#00247D']),
      {t: 'rect', x: 0, y: 0, w: 30, h: 20, color: '#00247D'},
      {t: 'cross', color: '#FFFFFF', thickness: 4, offsetX: -15},
      {t: 'starfield', x: 36, y: 8, w: 20, h: 24, cols: 2, rows: 2, r: 2, color: '#CC142B'},
    ],
  },
];

export const flagByCode = (code: string): FlagSpec | undefined =>
  flags.find((f) => f.code === code);

/**
 * Winner-name → flag code, for the timeline cards. West Germany maps to the
 * German flag: the same football association, and the film is telling a
 * hundred-year story in which that continuity matters more than the statehood
 * footnote.
 */
export const WINNER_FLAG: Record<string, string> = {
  Uruguay: 'URU',
  Italy: 'ITA',
  'West Germany': 'GER',
  Germany: 'GER',
  Brazil: 'BRA',
  England: 'ENG',
  Argentina: 'ARG',
  France: 'FRA',
  Spain: 'ESP',
};

/** Host-name → flag code, for the timeline cards' host line. */
export const HOST_FLAG: Record<string, string> = {
  Uruguay: 'URU',
  Italy: 'ITA',
  France: 'FRA',
  Brazil: 'BRA',
  Switzerland: 'SUI',
  Sweden: 'SWE',
  Chile: 'CHI',
  England: 'ENG',
  Mexico: 'MEX',
  'West Germany': 'GER',
  Germany: 'GER',
  Argentina: 'ARG',
  Spain: 'ESP',
  'United States': 'USA',
  'Korea / Japan': 'KOR',
  'South Africa': 'RSA',
  Russia: 'SRB',
  Qatar: 'QAT',
  'Canada / Mexico / USA': 'CAN',
};

/**
 * The colour a flag leads with — used to tint the timeline cards so a century
 * of winners reads as a run of colour, not a column of grey type. Skips whites
 * and near-blacks, which identify nothing on a dark card.
 */
export const flagAccent = (spec: FlagSpec | undefined): string | undefined => {
  if (!spec) return undefined;
  const usable = (c: string) => {
    const n = parseInt(c.replace('#', ''), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max > 60 && max - min > 40;
  };
  for (const layer of spec.layers) {
    if (layer.t === 'bands') {
      const hit = layer.colors.find(usable);
      if (hit) return hit;
    } else if ('color' in layer && usable(layer.color)) {
      return layer.color;
    }
  }
  return undefined;
};
