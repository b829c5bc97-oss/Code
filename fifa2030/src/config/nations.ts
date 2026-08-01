import {boundaries, ringToPath, type LonLat} from './geo';
import {players, type PlayerSlot} from './players';

/**
 * The six hosts of the centenary tournament.
 *
 * 2030 marks 100 years of the FIFA World Cup — not 100 years of FIFA. Morocco,
 * Spain and Portugal host the tournament proper; Uruguay, Argentina and
 * Paraguay each host one celebratory centenary match, and the tournament OPENS
 * at the Estadio Centenario in Montevideo, on the ground that staged the 1930
 * final. That return is the emotional spine of the film.
 */

export type HostRole = 'primary' | 'centenary';

/** Which of the three parallax depths a motif occupies. Every nation fills all
 *  three in the same order, which is what keeps six modules reading as one film. */
export type MotifKind =
  // far — landscape / horizon
  | 'atlas-ridge'
  | 'plaza-arcade'
  | 'lisbon-hills'
  | 'rambla-coast'
  | 'andes-ridge'
  | 'jesuit-ruins'
  // mid — architecture / human
  | 'medina-arches'
  | 'flamenco-spiral'
  | 'tram-28'
  | 'centenario-arch'
  | 'tango-couple'
  | 'harp'
  // near — pattern / ornament
  | 'zellige'
  | 'trencadis'
  | 'azulejo'
  | 'sun-of-may'
  | 'fileteado'
  | 'nanduti';

export type Nation = {
  id: string;
  order: number;
  role: HostRole;
  nameEn: string;
  /** Local-language / local-script rendering of the name. */
  nameLocal: string;
  localLanguage: string;
  /** Set for names that need RTL shaping (Arabic). */
  rtl?: boolean;
  /** Short line under the name — what this nation hosts. */
  hostLine: string;
  colors: {
    /** The national colour field the module sits on. */
    field: string;
    /** Secondary, used for the second pattern pass. */
    secondary: string;
    /** Linework and type over the field. */
    line: string;
    /**
     * The colour this nation takes as a panel of the ball in Shot 12. Drawn
     * from the same national palette as `field`, but chosen so six panels
     * sitting side by side read as six distinct nations — four near-identical
     * blues would collapse into "a blue half and a red half".
     */
    panel: string;
  };
  /** Far → mid → near. */
  motifs: [MotifKind, MotifKind, MotifKind];
  /** Named motifs listed for the client, and echoed as the module's caption chips. */
  motifNotes: string[];
  /** What the temp score does under this module (see README §Audio). */
  musicCue: string;
  /** Host city used for the globe pin and the arcs. */
  city: {name: string; lonLat: LonLat};
  /** Simplified national outline, projected to a 100×100 box. */
  outline: string;
  player: PlayerSlot;
};

const outline = (key: keyof typeof boundaries) => ringToPath(boundaries[key]!);

export const nations: Nation[] = [
  {
    id: 'morocco',
    order: 0,
    role: 'primary',
    nameEn: 'Morocco',
    nameLocal: 'المغرب',
    localLanguage: 'العربية',
    rtl: true,
    hostLine: 'Host nation · Africa',
    colors: {field: '#8E1B20', secondary: '#046233', line: '#F4EFE6', panel: '#8E1B20'},
    motifs: ['atlas-ridge', 'medina-arches', 'zellige'],
    motifNotes: ['Zellige tessellation', 'Medina archways', 'Atlas ridgeline', 'Mint tea, Gnawa drums'],
    musicCue: 'Gnawa krakeb rhythm over a guembri bassline',
    city: {name: 'Casablanca', lonLat: [-7.59, 33.57]},
    outline: outline('morocco'),
    player: players.morocco!,
  },
  {
    id: 'spain',
    order: 1,
    role: 'primary',
    nameEn: 'Spain',
    nameLocal: 'España',
    localLanguage: 'Español',
    hostLine: 'Host nation · Europe',
    colors: {field: '#AA151B', secondary: '#F1BF00', line: '#F4EFE6', panel: '#C1502E'},
    motifs: ['plaza-arcade', 'flamenco-spiral', 'trencadis'],
    motifNotes: ['Trencadís mosaic', 'Flamenco spiral', 'Plaza at golden hour', 'Guitar rasgueado'],
    musicCue: 'Flamenco palmas and guitar',
    city: {name: 'Madrid', lonLat: [-3.7, 40.42]},
    outline: outline('spain'),
    player: players.spain!,
  },
  {
    id: 'portugal',
    order: 2,
    role: 'primary',
    nameEn: 'Portugal',
    nameLocal: 'Portugal',
    localLanguage: 'Português',
    hostLine: 'Host nation · Europe',
    colors: {field: '#0B3B5C', secondary: '#046A38', line: '#F4EFE6', panel: '#0B5D3B'},
    motifs: ['lisbon-hills', 'tram-28', 'azulejo'],
    motifNotes: ['Azulejo tilework', 'Tram 28 climbing', 'Belém & the caravels', 'Calçada wave paving'],
    musicCue: 'Fado guitarra melody',
    city: {name: 'Lisbon', lonLat: [-9.14, 38.72]},
    outline: outline('portugal'),
    player: players.portugal!,
  },
  {
    id: 'uruguay',
    order: 3,
    role: 'centenary',
    nameEn: 'Uruguay',
    nameLocal: 'Uruguay',
    localLanguage: 'Español',
    hostLine: 'Opening match · Estadio Centenario',
    colors: {field: '#2C6FA8', secondary: '#F1BF00', line: '#F4EFE6', panel: '#3E86C4'},
    motifs: ['rambla-coast', 'centenario-arch', 'sun-of-may'],
    motifNotes: ['Estadio Centenario', 'Candombe tamboriles', 'Mate on the Rambla', 'Sun motif, sky blue'],
    musicCue: 'Candombe tamboril drums',
    city: {name: 'Montevideo', lonLat: [-56.16, -34.9]},
    outline: outline('uruguay'),
    player: players.uruguay!,
  },
  {
    id: 'argentina',
    order: 4,
    role: 'centenary',
    nameEn: 'Argentina',
    nameLocal: 'Argentina',
    localLanguage: 'Español',
    hostLine: 'Centenary match · South America',
    colors: {field: '#2E6FA3', secondary: '#75AADB', line: '#F4EFE6', panel: '#0B3B5C'},
    motifs: ['andes-ridge', 'tango-couple', 'fileteado'],
    motifNotes: ['La Boca colour', 'Tango in silhouette', 'Andes ridgeline', 'Fileteado porteño'],
    musicCue: 'Bandoneón phrase',
    city: {name: 'Buenos Aires', lonLat: [-58.38, -34.6]},
    outline: outline('argentina'),
    player: players.argentina!,
  },
  {
    id: 'paraguay',
    order: 5,
    role: 'centenary',
    nameEn: 'Paraguay',
    nameLocal: 'Paraguái',
    localLanguage: "Avañe'ẽ · Guaraní",
    hostLine: 'Centenary match · South America',
    colors: {field: '#123C7A', secondary: '#D52B1E', line: '#F4EFE6', panel: '#1E2F63'},
    motifs: ['jesuit-ruins', 'harp', 'nanduti'],
    motifNotes: ['Ñandutí lace', 'Paraguayan harp', 'Jesuit mission ruins', 'Guaraní geometry'],
    musicCue: 'Paraguayan harp arpeggio',
    city: {name: 'Asunción', lonLat: [-57.64, -25.28]},
    outline: outline('paraguay'),
    player: players.paraguay!,
  },
];

export const nationById = (id: string): Nation => {
  const found = nations.find((n) => n.id === id);
  if (!found) throw new Error(`Unknown nation: ${id}`);
  return found;
};

/** Each nation module is exactly 180 frames — 6 seconds, 12 beats. */
export const NATION_MODULE_FRAMES = 180;

/**
 * Pin order on the globe: the three primary hosts first (Africa → Iberia),
 * then across the Atlantic to the three centenary hosts. The last hop is the
 * one that matters — it is the tournament reaching back to 1930.
 */
export const arcSequence: [string, string][] = [
  ['morocco', 'spain'],
  ['spain', 'portugal'],
  ['portugal', 'uruguay'],
  ['uruguay', 'argentina'],
  ['argentina', 'paraguay'],
];
