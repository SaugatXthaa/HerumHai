/**
 * AIOStreams Formatter Engine — JavaScript port.
 *
 * Ported from /tmp/AIOStreams/packages/core/src/formatters/ (TypeScript).
 * All modifier, parser, compiler, sentinel and stream-converter logic is
 * preserved 1:1; only TypeScript types have been stripped.
 *
 * Public API:
 *   - formatStream(stream, context) -> { name, description }
 *   - evaluateTemplate(template, data) -> string
 *   - convertStreamToParseValue(stream, context) -> ParseValue
 *   - compileTemplate(template, hooks, depth?) -> (parseValue) => string
 *
 * Layout directives travel through a render as control characters so that only
 * the template can emit them. Rendered values are stripped of them on the way
 * in, which stops a filename from deleting a line of output.
 */

// ============================================================================
// Sentinels
// ============================================================================

export const NEW_LINE_SENTINEL = '\u0011';
export const REMOVE_LINE_SENTINEL = '\u0012';

const SENTINEL_PATTERN = /[\u0011\u0012]/g;

export function hasSentinel(text) {
  return (
    text.includes(NEW_LINE_SENTINEL) || text.includes(REMOVE_LINE_SENTINEL)
  );
}

/** Applied where data enters a render, never to finished output. */
export function sanitise(text) {
  return hasSentinel(text) ? text.replace(SENTINEL_PATTERN, '') : text;
}

/** Directives written inside a modifier argument, e.g. `join('{tools.newLine}- ')`. */
export function substituteTools(text) {
  return text
    .replaceAll('{tools.newLine}', NEW_LINE_SENTINEL)
    .replaceAll('{tools.removeLine}', REMOVE_LINE_SENTINEL);
}

// ============================================================================
// Comparators
// ============================================================================

export const comparatorFunctions = {
  and: (a, b) => a && b,
  or: (a, b) => a || b,
  xor: (a, b) => (a || b) && !(a && b),
  neq: (a, b) => a !== b,
  equal: (a, b) => a === b,
  left: (a) => a,
  right: (_, b) => b,
};

export const comparatorNames = Object.keys(comparatorFunctions);

// ============================================================================
// Field registry
// ============================================================================

export const FIELD_REGISTRY = {
  config: ['addonName'],
  stream: [
    'filename',
    'folderName',
    'size',
    'bitrate',
    'folderSize',
    'library',
    'quality',
    'resolution',
    'subbed',
    'dubbed',
    'languages',
    'uLanguages',
    'subtitles',
    'uSubtitles',
    'languageEmojis',
    'uLanguageEmojis',
    'subtitleEmojis',
    'uSubtitleEmojis',
    'languageCodes',
    'uLanguageCodes',
    'subtitleCodes',
    'uSubtitleCodes',
    'smallLanguageCodes',
    'uSmallLanguageCodes',
    'smallSubtitleCodes',
    'uSmallSubtitleCodes',
    'wedontknowwhatakilometeris',
    'uWedontknowwhatakilometeris',
    'visualTags',
    'audioTags',
    'releaseGroup',
    'regexMatched',
    'rankedRegexMatched',
    'regexScore',
    'nRegexScore',
    'encode',
    'audioChannels',
    'edition',
    'editions',
    'remastered',
    'regraded',
    'repack',
    'proper',
    'uncensored',
    'unrated',
    'upscaled',
    'hasChapters',
    'network',
    'container',
    'extension',
    'indexer',
    'year',
    'title',
    'date',
    'folderSeasons',
    'formattedFolderSeasons',
    'seasons',
    'season',
    'formattedSeasons',
    'episodes',
    'episode',
    'formattedEpisodes',
    'folderEpisodes',
    'formattedFolderEpisodes',
    'seasonEpisode',
    'seasonPack',
    'seeders',
    'private',
    'freeleech',
    'age',
    'ageHours',
    'duration',
    'infoHash',
    'type',
    'message',
    'proxied',
    'seadex',
    'seadexBest',
    'seScore',
    'nSeScore',
    'seMatched',
    'rseMatched',
    'preloading',
  ],
  metadata: [
    'queryType',
    'title',
    'runtime',
    'genres',
    'year',
    'episodeRuntime',
  ],
  service: ['id', 'shortName', 'name', 'cached'],
  addon: ['name', 'presetId', 'manifestUrl'],
  debug: ['json', 'jsonf'],
};

/** Lower-cased name to its canonical spelling, so field names are case-insensitive. */
const CANONICAL_FIELDS = new Map(
  Object.entries(FIELD_REGISTRY).flatMap(([section, properties]) =>
    properties.map(
      (property) => [
        `${section}.${property}`.toLowerCase(),
        [section, property],
      ]
    )
  )
);

/** Returns the canonical `[section, property]`, or undefined if unknown. */
export function canonicaliseField(section, property) {
  return CANONICAL_FIELDS.get(`${section}.${property}`.toLowerCase());
}

/** Lower-cased property to every `section.property` declaring it. */
const PROPERTY_INDEX = (() => {
  const index = new Map();
  for (const [section, properties] of Object.entries(FIELD_REGISTRY)) {
    for (const property of properties) {
      const key = property.toLowerCase();
      const existing = index.get(key);
      if (existing) existing.push(`${section}.${property}`);
      else index.set(key, [`${section}.${property}`]);
    }
  }
  return index;
})();

/**
 * Levenshtein distance, but it stops as soon as it exceeds `max`. Bounded so a
 * suggestion can never be a wild guess.
 */
function distanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return undefined;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      best = Math.min(best, current[j]);
    }
    if (best > max) return undefined;
    previous = current;
  }
  const distance = previous[b.length];
  return distance <= max ? distance : undefined;
}

/** Tight enough that a suggestion is a near-miss rather than a guess. */
function budget(word) {
  return Math.min(2, Math.floor(word.length / 3));
}

/** Closest single entry in `candidates`, or undefined when none is near enough. */
export function nearestName(word, candidates) {
  return nearest(word, candidates)[0];
}

/** Closest entries in `candidates`, or [] when nothing is near enough. */
function nearest(word, candidates) {
  const max = budget(word);
  if (max < 1) return [];
  const lower = word.toLowerCase();
  let best = max + 1;
  let matches = [];
  for (const candidate of candidates) {
    const distance = distanceAtMost(lower, candidate.toLowerCase(), max);
    if (distance === undefined || distance > best) continue;
    if (distance < best) {
      best = distance;
      matches = [];
    }
    matches.push(candidate);
  }
  return matches;
}

/**
 * Best-guess corrections for an unknown field, as canonical `section.property`
 * strings. Diagnostics only — the parser never consults this.
 */
export function suggestField(section, property) {
  const elsewhere = PROPERTY_INDEX.get(property.toLowerCase());
  if (elsewhere) return [...elsewhere];

  const sections = Object.keys(FIELD_REGISTRY);
  const canonicalSection = sections.find(
    (name) => name.toLowerCase() === section.toLowerCase()
  );

  if (canonicalSection) {
    const properties = FIELD_REGISTRY[canonicalSection];
    return nearest(property, properties).map(
      (name) => `${canonicalSection}.${name}`
    );
  }

  return nearest(section, sections)
    .map((name) => canonicaliseField(name, property))
    .filter((field) => field !== undefined)
    .map(([s, p]) => `${s}.${p}`);
}

// ============================================================================
// Utilities — bytes / bitrate / duration / dates / small-caps
// ============================================================================

export function formatBytes(bytes, k, round = false) {
  if (bytes === 0) return '0 B';
  const sizes =
    k === 1024
      ? ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      : ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  let value = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
  if (round) {
    value = Math.round(value);
  }
  return value + ' ' + sizes[i];
}

export function formatSmartBytes(bytes, k) {
  if (bytes === 0) return '0 B';
  const sizes =
    k === 1024
      ? ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      : ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const rawValue = bytes / Math.pow(k, i);
  const integerPart = Math.floor(rawValue);

  let value;
  let formattedValue;

  if (integerPart >= 100) {
    value = Math.round(rawValue);
    formattedValue = value.toString();
  } else if (integerPart >= 10) {
    value = parseFloat(rawValue.toFixed(1));
    formattedValue = value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
  } else {
    value = parseFloat(rawValue.toFixed(2));
    formattedValue = value.toString();
  }

  return formattedValue + ' ' + sizes[i];
}

export function formatBitrate(bitrate, round = false) {
  if (!Number.isFinite(bitrate) || bitrate <= 0) return '0 bps';
  const k = 1000;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.min(
    sizes.length - 1,
    Math.max(0, Math.floor(Math.log(bitrate) / Math.log(k)))
  );
  let value = bitrate / Math.pow(k, i);
  value = round ? Math.round(value) : parseFloat(value.toFixed(2));
  return `${value} ${sizes[i]}`;
}

export function formatSmartBitrate(bitrate) {
  if (!Number.isFinite(bitrate) || bitrate <= 0) return '0 bps';
  const k = 1000;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.min(
    sizes.length - 1,
    Math.max(0, Math.floor(Math.log(bitrate) / Math.log(k)))
  );
  const rawValue = bitrate / Math.pow(k, i);
  const integerPart = Math.floor(rawValue);

  let value;
  let formattedValue;
  if (integerPart >= 100) {
    value = Math.round(rawValue);
    formattedValue = value.toString();
  } else if (integerPart >= 10) {
    value = parseFloat(rawValue.toFixed(1));
    formattedValue = value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
  } else {
    value = parseFloat(rawValue.toFixed(2));
    formattedValue = value.toString();
  }
  return `${formattedValue} ${sizes[i]}`;
}

export function formatDuration(durationInMs) {
  const seconds = Math.floor(durationInMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const formattedSeconds = seconds % 60;
  const formattedMinutes = minutes % 60;

  if (hours > 0) {
    return `${hours}h:${formattedMinutes}m:${formattedSeconds}s`;
  } else if (formattedSeconds > 0) {
    return `${formattedMinutes}m:${formattedSeconds}s`;
  } else {
    return `${formattedMinutes}m`;
  }
}

/**
 * Renders a `%`-token pattern.
 *
 * `[...]` marks an optional group: it is dropped when every token inside it
 * resolved to zero, which is what lets a single pattern hide an empty unit
 * (e.g. `[%-Hh ]%-Mm` drops the hours for a sub-hour duration).
 *
 * `%%`, `%[` and `%]` emit literals. Unrecognised tokens are emitted verbatim
 * so typos are visible in the output rather than silently swallowed.
 */
function renderPattern(pattern, resolve) {
  const stack = [{ text: '', zero: true, sawToken: false }];
  const closeGroup = () => {
    const group = stack.pop();
    const parent = stack[stack.length - 1];
    // an all-zero group is only dropped if it actually contained a token,
    // otherwise `[ - ]` style literal-only groups would vanish
    if (!group.sawToken || !group.zero) {
      parent.text += group.text;
      parent.sawToken = parent.sawToken || group.sawToken;
      if (!group.zero) parent.zero = false;
    }
  };

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const top = stack[stack.length - 1];

    if (char === '%') {
      const next = pattern[i + 1];
      if (next === undefined) {
        top.text += '%';
        break;
      }
      if (next === '%' || next === '[' || next === ']') {
        top.text += next;
        i += 1;
        continue;
      }
      const token = next === '-' ? pattern.slice(i + 1, i + 3) : next;
      const resolved = resolve(token);
      if (resolved === undefined) {
        top.text += `%${token}`;
      } else {
        top.text += resolved.text;
        top.sawToken = true;
        if (!resolved.zero) top.zero = false;
      }
      i += token.length;
      continue;
    }

    if (char === '[') {
      stack.push({ text: '', zero: true, sawToken: false });
      continue;
    }
    if (char === ']' && stack.length > 1) {
      closeGroup();
      continue;
    }
    top.text += char;
  }

  while (stack.length > 1) closeGroup(); // tolerate unclosed groups
  return stack[0].text;
}

const DURATION_UNITS = ['H', 'M', 'S'];

/**
 * This function exists to handle differing units between stream.duration and metadata.runtime
 * One is stored in milliseconds, the other in minutes. This function will normalise both to milliseconds.
 */
export function normaliseDuration(duration) {
  if (duration < 0) {
    return 0;
  }
  if (duration < 1000) {
    return duration * 60 * 1000; // convert minutes to milliseconds
  }
  return duration; // already in milliseconds
}

/**
 * @param durationInMs - duration in milliseconds
 * @param pattern - `%H` `%M` `%S` (zero padded) or `%-H` `%-M` `%-S` (bare)
 * @returns e.g. `'%H:%M:%S'` -> "01:23:45", `'[%-Hh ]%-Mm'` -> "1h 23m" / "45m"
 */
export function formatDurationPattern(durationInMs, pattern) {
  // the largest unit present in the pattern carries the overflow, so `%-Mm`
  // alone reads as total minutes ("83m") rather than truncating to "23m"
  const units = new Set();
  renderPattern(pattern, (token) => {
    const unit = token.startsWith('-') ? token.slice(1) : token;
    if (!DURATION_UNITS.includes(unit)) {
      return undefined;
    }
    units.add(unit);
    return { text: '' };
  });

  const totalSeconds = Math.max(0, Math.floor(durationInMs / 1000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const values = {
    H: Math.floor(totalSeconds / 3600),
    M: units.has('H') ? totalMinutes % 60 : totalMinutes,
    S: units.has('H') || units.has('M') ? totalSeconds % 60 : totalSeconds,
  };

  return renderPattern(pattern, (token) => {
    const padded = !token.startsWith('-');
    const value = values[padded ? token : token.slice(1)];
    if (value === undefined) return undefined;
    return {
      text: padded ? String(value).padStart(2, '0') : String(value),
      zero: value === 0,
    };
  });
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function ordinalise(day) {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * @param value - an ISO-ish date, e.g. "2023-07-04" (any time part is ignored)
 * @param pattern - `%Y` `%y` `%m` `%-m` `%d` `%-d` `%o` `%B` `%b` `%A` `%a`
 * @returns e.g. `'%B %o, %Y'` -> "July 4th, 2023". Unparseable input is
 *          returned unchanged so a bad date never becomes a bogus one.
 */
export function formatDatePattern(value, pattern) {
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
  if (!parts) return value;

  // built and read in UTC throughout: these are date-only values, and local
  // getters would shift them a day either side of midnight
  const [year, month, day] = [
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
  ];
  const date = new Date(Date.UTC(year, month, day));
  // Date.UTC rolls overflow forward (month 13 -> next January), which would
  // turn a nonsense date into a confident wrong one, so require a round-trip
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return value;
  }

  const tokens = {
    Y: String(year),
    y: String(year % 100).padStart(2, '0'),
    m: String(month + 1).padStart(2, '0'),
    '-m': String(month + 1),
    d: String(day).padStart(2, '0'),
    '-d': String(day),
    o: ordinalise(day),
    B: MONTH_NAMES[month],
    b: MONTH_NAMES[month].slice(0, 3),
    A: DAY_NAMES[date.getUTCDay()],
    a: DAY_NAMES[date.getUTCDay()].slice(0, 3),
  };

  return renderPattern(pattern, (token) =>
    tokens[token] !== undefined ? { text: tokens[token] } : undefined
  );
}

/**
 * @param hours - number of hours
 * @returns formatted string in days or hours e.g. "23h", "1d", "1023d"
 */
export function formatHours(hours) {
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function makeSmall(code) {
  return code
    .split('')
    .map((char) => SMALL_CAPS_MAP[char.toUpperCase()] || char)
    .join('');
}

const SMALL_CAPS_MAP = {
  A: 'ᴀ', // U+1D00
  B: 'ʙ', // U+0299
  C: 'ᴄ', // U+1D04
  D: 'ᴅ', // U+1D05
  E: 'ᴇ', // U+1D07
  F: 'ғ', // U+0493
  G: 'ɢ', // U+0262
  H: 'ʜ', // U+029C
  I: 'ɪ', // U+026A
  J: 'ᴊ', // U+1D0A
  K: 'ᴋ', // U+1D0B
  L: 'ʟ', // U+029F
  M: 'ᴍ', // U+1D0D
  N: 'ɴ', // U+0274
  O: 'ᴏ', // U+1D0F
  P: 'ᴘ', // U+1D18
  Q: 'ǫ', // U+01EB
  R: 'ʀ', // U+0280
  S: 'ꜱ', // U+A731
  T: 'ᴛ', // U+1D1B
  U: 'ᴜ', // U+1D1C
  V: 'ᴠ', // U+1D20
  W: 'ᴡ', // U+1D21
  // There is no widely supported small-cap X; fall back to "x".
  X: 'x',
  Y: 'ʏ', // U+028F
  Z: 'ᴢ', // U+1D22
};

// ============================================================================
// Language helpers (pragmatic port — full AIOStreams table is huge; this covers
// the languageEmojiMap and a basic ISO 639-1 mapping used by the stream converter)
// ============================================================================

const LANGUAGE_EMOJI_MAP = {
  multi: '🌎',
  english: '🇬🇧',
  japanese: '🇯🇵',
  chinese: '🇨🇳',
  russian: '🇷🇺',
  arabic: '🇸🇦',
  portuguese: '🇵🇹',
  'portuguese (brazil)': '🇧🇷',
  spanish: '🇪🇸',
  french: '🇫🇷',
  german: '🇩🇪',
  italian: '🇮🇹',
  korean: '🇰🇷',
  hindi: '🇮🇳',
  bengali: '🇧🇩',
  punjabi: '🇵🇰',
  marathi: '🇮🇳',
  gujarati: '🇮🇳',
  tamil: '🇮🇳',
  telugu: '🇮🇳',
  kannada: '🇮🇳',
  malayalam: '🇮🇳',
  thai: '🇹🇭',
  vietnamese: '🇻🇳',
  indonesian: '🇮🇩',
  turkish: '🇹🇷',
  hebrew: '🇮🇱',
  persian: '🇮🇷',
  ukrainian: '🇺🇦',
  greek: '🇬🇷',
  lithuanian: '🇱🇹',
  latvian: '🇱🇻',
  estonian: '🇪🇪',
  polish: '🇵🇱',
  czech: '🇨🇿',
  slovak: '🇸🇰',
  hungarian: '🇭🇺',
  romanian: '🇷🇴',
  bulgarian: '🇧🇬',
  serbian: '🇷🇸',
  croatian: '🇭🇷',
  slovenian: '🇸🇮',
  dutch: '🇳🇱',
  danish: '🇩🇰',
  finnish: '🇫🇮',
  swedish: '🇸🇪',
  norwegian: '🇳🇴',
  malay: '🇲🇾',
  latino: '💃🏻',
};

const LANGUAGE_CODE_MAP = {
  multi: 'MULTI',
  english: 'EN',
  japanese: 'JA',
  chinese: 'ZH',
  russian: 'RU',
  arabic: 'AR',
  portuguese: 'PT',
  'portuguese (brazil)': 'PT-BR',
  spanish: 'ES',
  french: 'FR',
  german: 'DE',
  italian: 'IT',
  korean: 'KO',
  hindi: 'HI',
  bengali: 'BN',
  punjabi: 'PA',
  marathi: 'MR',
  gujarati: 'GU',
  tamil: 'TA',
  telugu: 'TE',
  kannada: 'KN',
  malayalam: 'ML',
  thai: 'TH',
  vietnamese: 'VI',
  indonesian: 'ID',
  turkish: 'TR',
  hebrew: 'HE',
  persian: 'FA',
  ukrainian: 'UK',
  greek: 'EL',
  lithuanian: 'LT',
  latvian: 'LV',
  estonian: 'ET',
  polish: 'PL',
  czech: 'CS',
  slovak: 'SK',
  hungarian: 'HU',
  romanian: 'RO',
  bulgarian: 'BG',
  serbian: 'SR',
  croatian: 'HR',
  slovenian: 'SL',
  dutch: 'NL',
  danish: 'DA',
  finnish: 'FI',
  swedish: 'SV',
  norwegian: 'NO',
  malay: 'MS',
  latino: 'ES-LATINO',
};

export function languageToEmoji(language) {
  if (!language) return undefined;
  return LANGUAGE_EMOJI_MAP[language.toLowerCase()];
}

export function languageToCode(language) {
  if (!language) return undefined;
  const code = LANGUAGE_CODE_MAP[language.toLowerCase()];
  return code || language.toUpperCase();
}

// ============================================================================
// Modifiers
// ============================================================================

const DIGITS = '0123456789+-=()';
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎';
const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾';

/**
 * Maps characters by position. Anything in `from` without a counterpart in `to`
 * is left alone rather than dropped, so a short `to` cannot silently lose text.
 */
function mapChars(value, from, to) {
  const table = new Map();
  const source = [...from];
  const target = [...to];
  for (let i = 0; i < source.length && i < target.length; i++) {
    table.set(source[i], target[i]);
  }
  return [...value].map((char) => table.get(char) || char).join('');
}

const arrayGetOrDefault = (value, index) =>
  value.length > 0 ? String(value[index]) : '';

const sortBy = (ascending) => (value) =>
  [...value].sort((a, b) => {
    const result =
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true });
    return ascending ? result : -result;
  });

const stars = (padWithEmpty) => (value) => {
  const FULL = '★';
  const HALF = '⯪';
  const EMPTY = '☆';
  const full = Math.floor(value / 20);
  const half = value % 20 >= 10 ? 1 : 0;
  return (
    FULL.repeat(full) +
    HALF.repeat(half) +
    (padWithEmpty ? EMPTY.repeat(5 - full - half) : '')
  );
};

const stringModifiers = {
  upper: (value) => value.toUpperCase(),
  lower: (value) => value.toLowerCase(),
  title: (value) =>
    value
      .split(' ')
      .map((word) => word.toLowerCase())
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' '),
  length: (value) => value.length.toString(),
  reverse: (value) => value.split('').reverse().join(''),
  // not btoa: it throws above U+00FF, which real release names hit constantly
  base64: (value) => toBase64(value),
  string: (value) => value,
  smallcaps: (value) => makeSmall(value),
  subscript: (value) => mapChars(value, DIGITS, SUBSCRIPT_DIGITS),
  superscript: (value) => mapChars(value, DIGITS, SUPERSCRIPT_DIGITS),
};

function toBase64(value) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64');
  }
  // Browser / Vercel Edge fallback
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const arrayModifiers = {
  join: (value) => value.join(', '),
  length: (value) => value.length.toString(),
  first: (value) => arrayGetOrDefault(value, 0),
  last: (value) => arrayGetOrDefault(value, value.length - 1),
  random: (value) =>
    arrayGetOrDefault(value, Math.floor(Math.random() * value.length)),
  sort: sortBy(true),
  rsort: sortBy(false),
  lsort: (value) => [...value].sort(),
  reverse: (value) => [...value].reverse(),
  string: (value) => value.toString(),
};

const numberModifiers = {
  comma: (value) => value.toLocaleString(),
  hex: (value) => value.toString(16),
  octal: (value) => value.toString(8),
  binary: (value) => value.toString(2),
  bytes: (value) => formatBytes(value, 1000),
  sbytes: (value) => formatSmartBytes(value, 1000),
  sbytes10: (value) => formatSmartBytes(value, 1000),
  sbytes2: (value) => formatSmartBytes(value, 1024),
  rbytes: (value) => formatBytes(value, 1000, true),
  bytes10: (value) => formatBytes(value, 1000),
  rbytes10: (value) => formatBytes(value, 1000, true),
  bytes2: (value) => formatBytes(value, 1024),
  rbytes2: (value) => formatBytes(value, 1024, true),
  bitrate: (value) => formatBitrate(value),
  rbitrate: (value) => formatBitrate(value, true),
  sbitrate: (value) => formatSmartBitrate(value),
  string: (value) => value.toString(),
  time: (value) => formatDuration(normaliseDuration(value)),
  star: stars(false),
  pstar: stars(true),
};

const booleanModifiers = {
  string: (value) => String(value),
};

const conditionalModifiers = {
  exact: {
    istrue: (value) => value === true,
    isfalse: (value) => value === false,
    exists: (value) => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'string') return /\S/.test(value);
      if (Array.isArray(value)) return value.length > 0;
      return true;
    },
  },

  prefix: {
    $: (value, check) =>
      typeof value === 'string'
        ? value.startsWith(check)
        : value?.[0] === check,
    '^': (value, check) =>
      typeof value === 'string'
        ? value.endsWith(check)
        : value?.[value.length - 1] === check,
    '~': (value, check) => value.includes(check),
    '=': (value, check) => value === check,
    '>=': (value, check) => value >= check,
    '>': (value, check) => value > check,
    '<=': (value, check) => value <= check,
    '<': (value, check) => value < check,
  },
};

/** Plain modifier names grouped by the value type they apply to. */
export const stringModifierNames = Object.keys(stringModifiers);
export const numberModifierNames = Object.keys(numberModifiers);
export const arrayModifierNames = Object.keys(arrayModifiers);
export const booleanModifierNames = Object.keys(booleanModifiers);
/** Argument-free conditionals (`istrue`, `isfalse`, `exists`); apply to any type. */
export const conditionalModifierNames = Object.keys(
  conditionalModifiers.exact
);

export const allModifierNames = [
  ...stringModifierNames,
  ...booleanModifierNames,
  ...numberModifierNames,
  ...arrayModifierNames,
  ...conditionalModifierNames,
];

export const prefixOperators = Object.keys(conditionalModifiers.prefix).sort(
  (a, b) => b.length - a.length
);

// ------------------------------------------------------------ argument parsing

/** Pulls quoted arguments out of a call's argument list, in order. */
function quotedArguments(inner) {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'/g;
  let match;
  while ((match = pattern.exec(inner)) !== null) {
    args.push(match[1] ?? match[2] ?? '');
  }
  return args;
}

/** `"'%H:%M'"` -> `"%H:%M"`; undefined when not quoted. */
function unquote(arg) {
  const quote = arg[0];
  return arg.length >= 2 &&
    (quote === "'" || quote === '"') &&
    arg.endsWith(quote)
    ? arg.slice(1, -1)
    : undefined;
}

// ------------------------------------------------------------------- compiling

/**
 * Returns `undefined` when the modifier does not apply to the value's runtime
 * type; the caller turns that into the right error message.
 */
function compileConditional(lower) {
  const exact = conditionalModifiers.exact;
  const isExact = Object.prototype.hasOwnProperty.call(exact, lower);
  const operator = prefixOperators.find((op) => lower.startsWith(op));
  if (!isExact && !operator) return undefined;

  const rawCheck = operator ? lower.slice(operator.length) : '';
  const isArrayCapable = operator ? ['$', '^', '~'].includes(operator) : false;
  const isNumericCapable = operator
    ? ['<', '<=', '>', '>=', '='].includes(operator)
    : false;

  return (value) => {
    try {
      // absent values are false without consulting the operator
      if (!exact.exists(value)) return false;
      if (isExact) return exact[lower](value);

      const arrayValue =
        Array.isArray(value) && value.every((item) => typeof item === 'string')
          ? value.map((item) => item.toLowerCase())
          : undefined;
      const stringValue = String(value).toLowerCase();

      // whitespace is only stripped from the check when the value has none
      const check = /\s/.test(stringValue)
        ? rawCheck
        : rawCheck.replace(/\s/g, '');

      const numericValue = Number(stringValue.replace(/,\s/g, ''));
      const numericCheck = Number(check.replace(/,\s/g, ''));
      const numeric =
        isNumericCapable && !isNaN(numericValue) && !isNaN(numericCheck);

      const compare = conditionalModifiers.prefix[operator];

      return compare(
        numeric
          ? numericValue
          : ((isArrayCapable ? arrayValue : undefined) ?? stringValue),
        numeric ? numericCheck : check
      );
    } catch {
      return false;
    }
  };
}

function compileParameterised(source, lower) {
  const open = source.indexOf('(');
  if (open === -1 || !source.endsWith(')')) return undefined;
  const name = lower.slice(0, open);
  const inner = source.slice(open + 1, -1);

  switch (name) {
    case 'replace': {
      // Split on the separator between the two arguments rather than pairing
      // quotes, so a quote inside an argument stays literal.
      const variableForm = /^\s*\{([^}]+)\}\s*,\s*(['"])([\s\S]*)\2\s*$/.exec(
        inner
      );
      if (variableForm) {
        const variablePath = variableForm[1];
        const rawReplacement = variableForm[3];
        const replacementText = substituteTools(rawReplacement);
        return (value, parseValue, ctx) => {
          if (typeof value !== 'string') return undefined;
          const resolved = ctx.resolveVariable(variablePath, parseValue);
          return resolved ? value.replaceAll(resolved, replacementText) : value;
        };
      }

      const openQuote = source.charAt('replace('.length);
      const closeQuote = source.charAt(source.length - 2);
      const body = source.slice('replace('.length + 1, -2);
      const [rawSearch, replacement, extra] = body.split(
        new RegExp(`${escapeRegex(openQuote)}\\s*,\\s*${escapeRegex(closeQuote)}`)
      );

      // an empty search would match between every character
      if (extra !== undefined || !rawSearch || replacement === undefined) {
        return (value) => (typeof value === 'string' ? value : undefined);
      }

      const variableKey =
        rawSearch.startsWith('{') && rawSearch.endsWith('}')
          ? rawSearch.slice(1, -1)
          : undefined;

      const replacementText = substituteTools(replacement);

      return (value, parseValue, ctx) => {
        if (typeof value !== 'string') return undefined;
        if (!variableKey) return value.replaceAll(rawSearch, replacementText);

        const resolved = ctx.resolveVariable(variableKey, parseValue);
        if (!resolved) return value;
        return value.replaceAll(resolved, replacementText);
      };
    }

    case 'remove': {
      const args = quotedArguments(inner);
      if (args.length === 0) return () => undefined;
      const targets = args.filter(Boolean);
      return (value) => {
        if (typeof value === 'string') {
          let result = value;
          for (const target of targets) result = result.replaceAll(target, '');
          return result;
        }
        if (Array.isArray(value)) return value.filter((v) => !args.includes(v));
        return undefined;
      };
    }

    case 'join': {
      const raw = unquote(inner);
      if (raw === undefined) return undefined;
      const separator = substituteTools(raw);
      return (value) =>
        Array.isArray(value) ? value.join(separator) : undefined;
    }

    case 'truncate': {
      const limit = parseInt(inner, 10);
      if (isNaN(limit) || limit < 0) return undefined;
      const segmenter = new Intl.Segmenter();
      return (value) => {
        if (typeof value !== 'string') return undefined;
        const graphemes = [...segmenter.segment(value)];
        if (graphemes.length <= limit) return value;
        return (
          graphemes
            .slice(0, limit)
            .map((s) => s.segment)
            .join('')
            .replace(/\s+$/, '') + '…'
        );
      };
    }

    case 'slice': {
      const parts = inner.split(',').map((part) => parseInt(part.trim(), 10));
      if (isNaN(parts[0])) return undefined;
      const [start, end] = [
        parts[0],
        parts.length > 1 && !isNaN(parts[1]) ? parts[1] : undefined,
      ];
      return (value) =>
        Array.isArray(value) ? value.slice(start, end) : undefined;
    }

    case 'default': {
      const fallback = unquote(inner);
      if (fallback === undefined) return undefined;
      return (value) =>
        conditionalModifiers.exact.exists(value) ? value : fallback;
    }

    case 'translate': {
      const [from, to] = quotedArguments(inner);
      if (from === undefined || to === undefined) return undefined;
      return (value) =>
        typeof value === 'string' ? mapChars(value, from, to) : undefined;
    }

    case 'in': {
      const options = quotedArguments(inner).map((option) =>
        option.toLowerCase()
      );
      if (options.length === 0) return undefined;
      const set = new Set(options);
      return (value) => {
        if (value === null || value === undefined) return false;
        if (Array.isArray(value)) {
          return value.some(
            (item) => typeof item === 'string' && set.has(item.toLowerCase())
          );
        }
        return set.has(String(value).toLowerCase());
      };
    }

    case 'time': {
      const pattern = unquote(inner);
      if (pattern === undefined) return undefined;
      return (value) =>
        typeof value === 'number'
          ? formatDurationPattern(normaliseDuration(value), pattern)
          : undefined;
    }

    case 'date': {
      const pattern = unquote(inner);
      if (pattern === undefined) return undefined;
      return (value) =>
        typeof value === 'string'
          ? formatDatePattern(value, pattern)
          : undefined;
    }

    default:
      return undefined;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePlain(lower) {
  return (value) => {
    if (typeof value === 'string') {
      const fn = stringModifiers[lower];
      return fn ? fn(value) : undefined;
    }
    if (Array.isArray(value)) {
      const fn = arrayModifiers[lower];
      return fn ? fn(value) : undefined;
    }
    if (typeof value === 'number') {
      const fn = numberModifiers[lower];
      return fn ? fn(value) : undefined;
    }
    if (typeof value === 'boolean') {
      const fn = booleanModifiers[lower];
      return fn ? fn(value) : undefined;
    }
    return undefined;
  };
}

/**
 * Order matters: conditionals are tested first because `::exists` and `::>5`
 * apply to every type.
 */
export function compileModifier(source) {
  const lower = source.toLowerCase();
  return (
    compileConditional(lower) ??
    compileParameterised(source, lower) ??
    compilePlain(lower)
  );
}

// ============================================================================
// Parser
// ============================================================================

/** Longest first, so `sbytes10` wins over `sbytes`. */
const PLAIN_MODIFIERS = [...allModifierNames]
  .map((name) => name.toLowerCase())
  .sort((a, b) => b.length - a.length);

const plainModifiers = () => PLAIN_MODIFIERS;

/**
 * Argument shape per modifier. These decide whether an expression parses at all,
 * so they are not interchangeable: `remove()` is valid, `join()` is not.
 */
export const CALL_MODIFIERS = [
  ['replace', 'replaceArgs'],
  ['remove', 'loose'],
  ['join', 'quoted'],
  ['truncate', 'digits'],
  ['slice', 'digitsOrPair'],
  ['time', 'quoted'],
  ['date', 'quoted'],
  ['default', 'quoted'],
  ['in', 'loose'],
  ['translate', 'quotedPair'],
];

const LOOKS_LIKE_EXPRESSION =
  /^\s*[A-Za-z_][A-Za-z0-9_]*\s*\.\s*[A-Za-z_][A-Za-z0-9_]*/;

/** Caps so a pathological template cannot produce unbounded diagnostic work. */
const MAX_DIAGNOSTICS = 25;
const MAX_SPAN_SCAN = 4000;
const MAX_BRANCH_DEPTH = 5;

/**
 * Recovery resumes one character past a failed `{`, so text nested inside it is
 * re-scanned as though it were top level.
 */
const NESTED_SAFE_CATEGORIES = new Set([
  'unknown-field',
  'unknown-modifier',
  'modifier-arguments',
]);

class Scanner {
  constructor(input, pos = 0) {
    this.input = input;
    this.pos = pos;
  }

  get atEnd() {
    return this.pos >= this.input.length;
  }

  peek(offset = 0) {
    return this.input[this.pos + offset];
  }

  /** Case-insensitive literal match, consuming on success. */
  eat(literal) {
    const slice = this.input.substr(this.pos, literal.length);
    if (slice.toLowerCase() !== literal.toLowerCase()) return false;
    this.pos += literal.length;
    return true;
  }

  startsWith(literal) {
    return (
      this.input.substr(this.pos, literal.length).toLowerCase() ===
      literal.toLowerCase()
    );
  }

  slice(from, to = this.pos) {
    return this.input.slice(from, to);
  }
}

/** Terminates a section/property name, so no lookahead is needed. */
function isIdentifierChar(char) {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/** Unquoted prefix argument: anything but `}`, `[`, `]`, stopping at `::`. */
function scanPrefixArgument(scanner) {
  while (!scanner.atEnd) {
    const char = scanner.peek();
    if (char === '}' || char === '[' || char === ']') break;
    if (char === ':' && scanner.peek(1) === ':') break;
    scanner.pos += 1;
  }
}

/**
 * A quote only closes the argument when followed by `,`, `)` or whitespace, so
 * an apostrophe mid-word stays literal: `replace("Director's Cut", 'x')`.
 */
function scanQuotedArgument(scanner) {
  const quote = scanner.peek();
  if (quote !== "'" && quote !== '"') return false;
  scanner.pos += 1;

  while (!scanner.atEnd) {
    if (scanner.peek() === quote) {
      const after = scanner.peek(1);
      if (
        after === undefined ||
        after === ',' ||
        after === ')' ||
        /\s/.test(after)
      ) {
        scanner.pos += 1;
        return true;
      }
    }
    scanner.pos += 1;
  }
  return false;
}

function scanDigits(scanner) {
  const start = scanner.pos;
  while (scanner.peek() !== undefined && /\d/.test(scanner.peek())) {
    scanner.pos += 1;
  }
  return scanner.pos > start;
}

function skipSpaces(scanner) {
  while (scanner.peek() !== undefined && /\s/.test(scanner.peek())) {
    scanner.pos += 1;
  }
}

/**
 * The argument may itself contain parentheses, as in `remove('DV (Disk)')`, so
 * it ends at the last `)` in range rather than the first.
 */
function scanLooseArgument(scanner) {
  let lastParen = -1;
  while (!scanner.atEnd) {
    const char = scanner.peek();
    if (char === '}' || char === '[' || char === ']') break;
    if (char === ':' && scanner.peek(1) === ':') break;
    if (char === ')') lastParen = scanner.pos;
    scanner.pos += 1;
  }
  if (lastParen === -1) return false;
  scanner.pos = lastParen;
  return true;
}

function scanCallArguments(scanner, shape) {
  if (!scanner.eat('(')) return false;

  switch (shape) {
    case 'quoted':
      if (!scanQuotedArgument(scanner)) return false;
      break;
    case 'quotedPair':
      if (!scanQuotedArgument(scanner)) return false;
      skipSpaces(scanner);
      if (!scanner.eat(',')) return false;
      skipSpaces(scanner);
      if (!scanQuotedArgument(scanner)) return false;
      break;
    case 'replaceArgs':
      // the search key may be a {variable} rather than a quoted string
      if (scanner.peek() === '{') {
        while (!scanner.atEnd && scanner.peek() !== '}') scanner.pos += 1;
        if (!scanner.eat('}')) return false;
      } else if (!scanQuotedArgument(scanner)) {
        return false;
      }
      skipSpaces(scanner);
      if (!scanner.eat(',')) return false;
      skipSpaces(scanner);
      if (!scanQuotedArgument(scanner)) return false;
      break;
    case 'digits':
      if (!scanDigits(scanner)) return false;
      break;
    case 'digitsOrPair':
      skipSpaces(scanner);
      if (!scanDigits(scanner)) return false;
      skipSpaces(scanner);
      if (scanner.eat(',')) {
        skipSpaces(scanner);
        if (!scanDigits(scanner)) return false;
        skipSpaces(scanner);
      }
      break;
    case 'loose':
      // consumes up to its own closing paren, so return directly
      return scanLooseArgument(scanner) && scanner.eat(')');
  }

  return scanner.eat(')');
}

/** One `::modifier`. Returns the modifier's source text, or undefined. */
function parseModifier(scanner) {
  const start = scanner.pos;

  for (const [name, shape] of CALL_MODIFIERS) {
    if (!scanner.startsWith(`${name}(`)) continue;
    scanner.pos += name.length;
    if (scanCallArguments(scanner, shape)) return scanner.slice(start);
    // wrong shape is not a match; a prefix or plain modifier may still fit
    scanner.pos = start;
    break;
  }

  for (const operator of prefixOperators) {
    if (scanner.startsWith(operator)) {
      scanner.pos += operator.length;
      scanPrefixArgument(scanner);
      return scanner.slice(start);
    }
  }

  for (const name of plainModifiers()) {
    if (!scanner.startsWith(name)) continue;
    const after = scanner.peek(name.length);
    // must end at a boundary, so `upper` does not match `uppercase`
    if (isIdentifierChar(after)) continue;
    scanner.pos += name.length;
    return scanner.slice(start);
  }

  scanner.pos = start;
  return undefined;
}

/** `section.property`, case preserved. */
function parseOperandHead(scanner) {
  const start = scanner.pos;
  while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
  let section = scanner.slice(start);
  if (!section || scanner.peek() !== '.') {
    scanner.pos = start;
    return undefined;
  }
  scanner.pos += 1;

  const propertyStart = scanner.pos;
  while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
  let property = scanner.slice(propertyStart);
  if (!property) {
    scanner.pos = start;
    return undefined;
  }

  // an unknown property is not an expression at all, so it stays literal
  const canonical = canonicaliseField(section, property);
  if (!canonical) {
    scanner.pos = start;
    return undefined;
  }
  // stored canonically so lookup does not depend on how it was typed
  [section, property] = canonical;

  return { section, property };
}

function parseOperand(scanner) {
  // a quoted literal stands in for a field
  let head;
  if (scanner.peek() === "'" || scanner.peek() === '"') {
    const quote = scanner.peek();
    const start = scanner.pos;
    scanner.pos += 1;
    const from = scanner.pos;
    while (!scanner.atEnd && scanner.peek() !== quote) scanner.pos += 1;
    if (scanner.atEnd) {
      scanner.pos = start;
      return undefined;
    }
    const literal = scanner.slice(from);
    scanner.pos += 1;
    head = { section: '', property: '', literal };
  } else {
    head = parseOperandHead(scanner);
  }
  if (!head) return undefined;

  const modifiers = [];
  while (scanner.startsWith('::')) {
    // a comparator ends this operand rather than extending it
    const save = scanner.pos;
    scanner.pos += 2;
    if (comparatorNames.some((c) => scanner.startsWith(`${c}::`))) {
      scanner.pos = save;
      break;
    }
    const modifier = parseModifier(scanner);
    if (modifier === undefined) {
      scanner.pos = save;
      break;
    }
    modifiers.push(modifier);
  }

  return { ...head, modifiers };
}

/** `["true"||"false"]`, with an optional third branch for absent. */
function parseCheck(scanner, onFail) {
  const start = scanner.pos;
  const fail = (reason) => {
    if (onFail) onFail(reason, scanner.pos);
    scanner.pos = start;
    return undefined;
  };

  if (!scanner.eat('[')) return fail('no-open');

  /**
   * Brace depth is tracked so a quote inside a nested expression does not close
   * the branch, which is what allows conditionals to nest.
   */
  const branch = () => {
    if (!scanner.eat('"')) return undefined;
    let text = '';
    let depth = 0;
    while (!scanner.atEnd) {
      const char = scanner.peek();
      if (char === '\\' && scanner.peek(1) === '"') {
        text += '"';
        scanner.pos += 2;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') depth = Math.max(0, depth - 1);
      else if (char === '"' && depth === 0) {
        scanner.pos += 1;
        return text;
      }
      text += char;
      scanner.pos += 1;
    }
    return undefined;
  };

  // `branch()` eats the opening `"`, so the content begins one past here
  const trueStart = scanner.pos + 1;
  const trueTemplate = branch();
  if (trueTemplate === undefined) return fail('true-branch');
  if (!scanner.eat('||')) return fail('missing-or');
  const falseStart = scanner.pos + 1;
  const falseTemplate = branch();
  if (falseTemplate === undefined) return fail('false-branch');

  // third branch distinguishes absent from false
  let absentTemplate;
  let absentStart;
  if (scanner.startsWith('||')) {
    scanner.pos += 2;
    absentStart = scanner.pos + 1;
    absentTemplate = branch();
    if (absentTemplate === undefined) return fail('absent-branch');
  }

  if (!scanner.eat(']')) return fail('missing-close');
  const result = {
    trueTemplate,
    falseTemplate,
    trueStart,
    falseStart,
  };
  if (absentTemplate !== undefined) {
    result.absentTemplate = absentTemplate;
    result.absentStart = absentStart;
  }
  return result;
}

/** Finds the matching `?}`, allowing groups to nest. */
function parseGroupBody(scanner) {
  const start = scanner.pos;
  if (!scanner.eat('{?')) return undefined;

  const from = scanner.pos;
  let depth = 1;
  while (!scanner.atEnd) {
    if (scanner.startsWith('{?')) {
      depth += 1;
      scanner.pos += 2;
      continue;
    }
    if (scanner.startsWith('?}')) {
      depth -= 1;
      if (depth === 0) {
        const body = scanner.slice(from);
        scanner.pos += 2;
        return body;
      }
      scanner.pos += 2;
      continue;
    }
    scanner.pos += 1;
  }

  scanner.pos = start;
  return undefined;
}

/** `{tools.newLine}` / `{tools.removeLine}`: layout directives, not values. */
function parseTool(scanner) {
  const start = scanner.pos;
  for (const tool of ['newLine', 'removeLine']) {
    if (scanner.eat(`{tools.${tool}}`)) return { kind: 'tool', tool };
    scanner.pos = start;
  }
  return undefined;
}

/** Attempts one `{...}` at the scanner's position. */
function parseExpression(scanner) {
  const start = scanner.pos;
  const fail = () => {
    scanner.pos = start;
    return undefined;
  };

  if (!scanner.eat('{')) return fail();
  skipSpaces(scanner);

  const operands = [];
  const found = [];

  const first = parseOperand(scanner);
  if (!first) return fail();
  operands.push(first);

  while (scanner.startsWith('::')) {
    const save = scanner.pos;
    scanner.pos += 2;
    const comparator = comparatorNames.find((name) =>
      scanner.startsWith(`${name}::`)
    );
    if (!comparator) {
      scanner.pos = save;
      break;
    }
    scanner.pos += comparator.length + 2;
    const operand = parseOperand(scanner);
    if (!operand) return fail();
    found.push(comparator.toLowerCase());
    operands.push(operand);
  }

  const check = scanner.peek() === '[' ? parseCheck(scanner) : undefined;
  skipSpaces(scanner);
  if (!scanner.eat('}')) return fail();

  const node = {
    kind: 'expression',
    source: scanner.slice(start),
    operands,
    comparators: found,
    start,
    end: scanner.pos,
  };
  if (check) node.check = check;
  return node;
}

/**
 * Shifts every node position (and each check branch start) by `delta`, so a
 * group body parsed as its own substring reports document-absolute offsets.
 */
function offsetNodes(nodes, delta) {
  for (const node of nodes) {
    if (node.start !== undefined) node.start += delta;
    if (node.end !== undefined) node.end += delta;
    if (node.kind === 'group') offsetNodes(node.nodes, delta);
    if (node.kind === 'expression' && node.check) {
      const c = node.check;
      if (c.trueStart !== undefined) c.trueStart += delta;
      if (c.falseStart !== undefined) c.falseStart += delta;
      if (c.absentStart !== undefined) c.absentStart += delta;
    }
  }
}

function rawText(text) {
  return { kind: 'raw', text };
}

/** Never throws; unparseable spans render verbatim and are reported in `diagnostics`. */
export function parseTemplate(template) {
  const scanner = new Scanner(template);
  const nodes = [];
  const diagnostics = [];

  let literalStart = 0;
  /** End of the furthest span that has already failed; see NESTED_SAFE_CATEGORIES. */
  let recoveringUntil = 0;
  const flushLiteral = (end) => {
    if (end > literalStart) {
      const node = rawText(template.slice(literalStart, end));
      node.start = literalStart;
      node.end = end;
      nodes.push(node);
    }
  };

  while (!scanner.atEnd) {
    if (scanner.peek() !== '{') {
      scanner.pos += 1;
      continue;
    }

    const braceIndex = scanner.pos;

    if (scanner.startsWith('{?')) {
      const body = parseGroupBody(scanner);
      if (body !== undefined) {
        flushLiteral(braceIndex);
        const inner = parseTemplate(body);
        // `parseGroupBody` eats `{?` before capturing the body, so body offset 0
        // sits two characters in; nested groups compose by each adding its own
        const offset = braceIndex + 2;
        for (const d of inner.diagnostics) {
          diagnostics.push({ ...d, index: d.index + offset });
        }
        // re-base child offsets so every node position is in document coordinates
        offsetNodes(inner.nodes, offset);
        nodes.push({
          kind: 'group',
          nodes: inner.nodes,
          start: braceIndex,
          end: scanner.pos,
        });
        literalStart = scanner.pos;
        continue;
      }
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push({
          index: braceIndex,
          message: 'unterminated group: no matching `?}`',
          source: template.slice(braceIndex, braceIndex + 2),
          category: 'unterminated-group',
        });
      }
    }

    const node = parseTool(scanner) ?? parseExpression(scanner);

    if (!node) {
      const closing = template.indexOf('}', braceIndex);
      const inner =
        closing === -1 ? '' : template.slice(braceIndex + 1, closing);

      // Diagnosed over a brace-matched span, independently of the substitution
      // decision below. That decision governs rendered output and must not
      // change, so the two are deliberately kept apart.
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        const diagnostic = diagnoseSpan(template, braceIndex);
        const nested = braceIndex < recoveringUntil;
        if (
          diagnostic &&
          (!nested || NESTED_SAFE_CATEGORIES.has(diagnostic.category))
        ) {
          diagnostics.push(diagnostic);
        }
      }
      recoveringUntil = Math.max(
        recoveringUntil,
        matchBrace(template, braceIndex).end
      );

      // only substitute when the text was clearly meant as an expression, so
      // prose containing a stray brace stays prose. a nested `{` may still open
      // a valid expression, so leave it alone
      if (!inner.includes('{') && LOOKS_LIKE_EXPRESSION.test(inner)) {
        flushLiteral(braceIndex);
        nodes.push({
          kind: 'raw',
          text: `{invalid_expression(${inner.trim()})}`,
          start: braceIndex,
          end: closing + 1,
        });
        scanner.pos = closing + 1;
        literalStart = scanner.pos;
        continue;
      }
      scanner.pos = braceIndex + 1;
      continue;
    }

    flushLiteral(braceIndex);
    // tool nodes carry no position of their own; expressions already do
    if (node.start === undefined) node.start = braceIndex;
    if (node.end === undefined) node.end = scanner.pos;
    nodes.push(node);
    literalStart = scanner.pos;
  }

  flushLiteral(template.length);
  return { nodes, diagnostics };
}

// --------------------------------------------------------------- diagnostics

/** Example argument list per shape, so the message can show the fix. */
export const ARGUMENT_EXAMPLES = {
  quoted: "('text')",
  quotedPair: "('from', 'to')",
  replaceArgs: "('find', 'replaceWith')",
  digits: '(3)',
  digitsOrPair: '(0, 3)',
  loose: "('a', 'b')",
};

/** Extent of the `{...}` opening at `braceIndex`, matching nested braces. */
function matchBrace(template, braceIndex) {
  let depth = 0;
  const limit = Math.min(template.length, braceIndex + MAX_SPAN_SCAN);
  for (let i = braceIndex; i < limit; i++) {
    const char = template[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { end: i, terminated: true };
    }
  }
  return { end: limit, terminated: false };
}

/** Every modifier name the grammar accepts, for near-miss suggestions. */
function knownModifierNames() {
  return [
    ...new Set([...plainModifiers(), ...CALL_MODIFIERS.map(([name]) => name)]),
  ];
}

function isKnownModifier(token) {
  return knownModifierNames().includes(token.toLowerCase());
}

/**
 * Classifies an already-failed `{...}` span. Returns undefined when the span was
 * never expression-like, so prose is left alone.
 */
function diagnoseSpan(template, braceIndex) {
  const { end, terminated } = matchBrace(template, braceIndex);
  const source = template.slice(braceIndex, terminated ? end + 1 : end);
  const inner = terminated ? source.slice(1, -1) : source.slice(1);
  if (!LOOKS_LIKE_EXPRESSION.test(inner)) return undefined;

  const at = (category, message, suggestion) => {
    const d = {
      index: braceIndex,
      message,
      source,
      category,
    };
    if (suggestion) d.suggestion = suggestion;
    return d;
  };

  /**
   * `join` and `time` sit in both tables, so the call shape is checked first.
   */
  const badArguments = (token) => {
    const lower = token.toLowerCase();
    const call = CALL_MODIFIERS.find(([name]) => name === lower);
    return at(
      'modifier-arguments',
      call
        ? `modifier \`${token}\` has invalid arguments; expected \`${lower}${ARGUMENT_EXAMPLES[call[1]]}\``
        : `modifier \`${token}\` takes no arguments`
    );
  };

  const scanner = new Scanner(source);
  scanner.eat('{');
  skipSpaces(scanner);

  /** An unknown field is the most common authoring error by far. */
  const checkHead = () => {
    const headStart = scanner.pos;
    while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
    const section = scanner.slice(headStart);
    if (!section || scanner.peek() !== '.') {
      // quoted literal or malformed head; the modifier pass may still explain it
      scanner.pos = headStart;
      return undefined;
    }
    scanner.pos += 1;
    const propertyStart = scanner.pos;
    while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
    const property = scanner.slice(propertyStart);
    if (!property || canonicaliseField(section, property)) return undefined;

    const suggestions = suggestField(section, property);
    const hint = suggestions.length
      ? ` — did you mean \`${suggestions.join('` or `')}\`?`
      : '';
    return at(
      'unknown-field',
      `unknown field \`${section}.${property}\`${hint}`,
      suggestions[0]
    );
  };

  const checkModifiers = () => {
    while (scanner.startsWith('::')) {
      const save = scanner.pos;
      scanner.pos += 2;
      // a comparator ends this operand rather than extending it
      if (comparatorNames.some((c) => scanner.startsWith(`${c}::`))) {
        scanner.pos = save;
        return undefined;
      }
      const modifierStart = scanner.pos;
      if (parseModifier(scanner)) {
        // a plain modifier matches even when followed by `(`, leaving the
        // argument list dangling for `eat('}')` to choke on later
        if (scanner.peek() === '(') {
          return badArguments(scanner.slice(modifierStart));
        }
        continue;
      }

      // prefix operators consume almost anything, so are never the culprit
      if (prefixOperators.some((operator) => scanner.startsWith(operator))) {
        scanner.pos = save;
        return undefined;
      }

      const tokenStart = scanner.pos;
      while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
      const token = scanner.slice(tokenStart);
      if (!token) return undefined;
      if (isKnownModifier(token)) return badArguments(token);

      const close = nearestName(token.toLowerCase(), knownModifierNames());
      return at(
        'unknown-modifier',
        `unknown modifier \`${token}\`${close ? ` — did you mean \`${close}\`?` : ''}`
      );
    }
    return undefined;
  };

  // operands, separated by comparators, mirroring parseExpression
  for (;;) {
    const head = checkHead();
    if (head) return head;
    const modifier = checkModifiers();
    if (modifier) return modifier;

    if (!scanner.startsWith('::')) break;
    const save = scanner.pos;
    scanner.pos += 2;
    const comparator = comparatorNames.find((c) => scanner.startsWith(`${c}::`));
    if (!comparator) {
      scanner.pos = save;
      break;
    }
    scanner.pos += comparator.length + 2;
  }

  // conditional, re-run the real grammar to find which part gave out
  if (scanner.peek() === '[') {
    let failure;
    parseCheck(scanner, (reason, position) => {
      if (!failure) failure = { reason, at: position };
    });
    if (failure) {
      const message = describeCheckFailure(source, failure.reason, failure.at);
      if (message) return at('conditional', message);
    }
  }

  if (!terminated) {
    return at('unterminated', 'unterminated expression: no closing `}`');
  }

  return at('unparseable', `unparseable expression: {${inner}}`);
}

/** Turns a `parseCheck` bail-out into something an author can act on. */
function describeCheckFailure(source, reason, at) {
  if (reason === 'no-open') return undefined;
  if (reason === 'missing-close') {
    return 'conditional is missing its closing `]`';
  }
  if (reason === 'missing-or') {
    return 'conditional branches must be separated by `||`';
  }

  if (at >= source.length) {
    return 'unterminated conditional branch: a nested `{` is missing its `}`, or the branch is missing its closing `"`';
  }
  if (source[at] === '\\' && source[at + 1] === '"') {
    return 'conditional branch starts with an escaped quote `\\"` — escapes only apply one nesting level deeper';
  }
  return 'conditional branch must start with `"`';
}

// -------------------------------------------------------------------- tokens
//
// Syntax-highlighting token stream, co-located with the parser so it reuses the
// same grammar primitives and cannot drift from what renders. `parseExpression`
// decides validity and extent; the sub-scan only labels an already-valid span.

export function tokenize(template) {
  const out = [];
  tokenizeRegion(template, 0, template.length, IDENTITY, 0, out);
  out.sort((a, b) => a.start - b.start);
  return out;
}

const IDENTITY = (index) => index;

/** Pushes a token, translating its local `[from, to)` span into document coords. */
function pushToken(out, map, from, to, kind, depth) {
  if (to <= from) return;
  const start = map(from);
  const end = map(to - 1) + 1;
  if (end > start) out.push({ start, end, kind, depth });
}

/** `{tools.*}` extent at `index`, or undefined. Case-insensitive, like the parser. */
function matchToolSpan(template, index, to) {
  // compared lower-to-lower, so the literals here are already lower-cased
  for (const tool of ['{tools.newline}', '{tools.removeline}']) {
    const end = index + tool.length;
    if (end <= to && template.slice(index, end).toLowerCase() === tool)
      return end;
  }
  return undefined;
}

/** Matching `?}` for the `{?` at `index`, allowing nested groups. */
function matchGroupSpan(template, index, to) {
  let pos = index + 2;
  let depth = 1;
  while (pos < to) {
    if (template.startsWith('{?', pos)) {
      depth += 1;
      pos += 2;
      continue;
    }
    if (template.startsWith('?}', pos)) {
      depth -= 1;
      if (depth === 0) return { bodyEnd: pos, end: pos + 2 };
      pos += 2;
      continue;
    }
    pos += 1;
  }
  return undefined;
}

function tokenizeRegion(text, from, to, map, depth, out) {
  let pos = from;
  let textStart = from;
  const flush = (end) =>
    pushToken(out, map, textStart, end, 'text', depth);

  while (pos < to) {
    if (text[pos] !== '{') {
      pos += 1;
      continue;
    }
    const braceIndex = pos;

    const toolEnd = matchToolSpan(text, braceIndex, to);
    if (toolEnd !== undefined) {
      flush(braceIndex);
      pushToken(out, map, braceIndex, toolEnd, 'tool', depth);
      pos = toolEnd;
      textStart = pos;
      continue;
    }

    if (text.startsWith('{?', braceIndex)) {
      const group = matchGroupSpan(text, braceIndex, to);
      if (group !== undefined) {
        flush(braceIndex);
        pushToken(out, map, braceIndex, braceIndex + 2, 'group-brace', depth);
        tokenizeRegion(
          text,
          braceIndex + 2,
          group.bodyEnd,
          map,
          depth + 1,
          out
        );
        pushToken(out, map, group.bodyEnd, group.end, 'group-brace', depth);
        pos = group.end;
        textStart = pos;
        continue;
      }
    }

    // the real grammar decides whether this is an expression and where it ends
    const probe = new Scanner(text, braceIndex);
    const node = parseExpression(probe);
    if (node && probe.pos <= to) {
      flush(braceIndex);
      tokenizeExpression(text, braceIndex, probe.pos, map, depth, out);
      pos = probe.pos;
      textStart = pos;
      continue;
    }

    // renders as literal text; labelled so an editor can dim a dead `{...}`
    flush(braceIndex);
    const matched = matchBrace(text, braceIndex);
    const invalidEnd = Math.min(
      matched.terminated ? matched.end + 1 : matched.end,
      to
    );
    if (invalidEnd > braceIndex) {
      pushToken(out, map, braceIndex, invalidEnd, 'invalid', depth);
      pos = invalidEnd;
    } else {
      pos = braceIndex + 1;
    }
    textStart = pos;
  }
  flush(to);
}

/** Labels an already-valid `{...}` at `[start, end)`. */
function tokenizeExpression(text, start, end, map, depth, out) {
  const scanner = new Scanner(text, start + 1);
  pushToken(out, map, start, start + 1, 'brace', depth);
  skipSpaces(scanner);

  tokenizeOperand(scanner, end, map, depth, out);

  while (scanner.pos < end && scanner.startsWith('::')) {
    const save = scanner.pos;
    scanner.pos += 2;
    const comparator = comparatorNames.find((c) => scanner.startsWith(`${c}::`));
    if (!comparator) {
      scanner.pos = save;
      break;
    }
    const cStart = save + 2;
    pushToken(out, map, save, cStart, 'separator', depth);
    pushToken(
      out,
      map,
      cStart,
      cStart + comparator.length,
      'comparator',
      depth
    );
    pushToken(
      out,
      map,
      cStart + comparator.length,
      cStart + comparator.length + 2,
      'separator',
      depth
    );
    scanner.pos = cStart + comparator.length + 2;
    tokenizeOperand(scanner, end, map, depth, out);
  }

  if (scanner.pos < end && scanner.peek() === '[') {
    tokenizeCheck(scanner, end, map, depth, out);
  }

  // the region is known-valid, so its last character is the closing brace
  if (text[end - 1] === '}') {
    pushToken(out, map, end - 1, end, 'brace', depth);
  }
}

function tokenizeOperand(scanner, end, map, depth, out) {
  const lead = scanner.peek();
  if (lead === "'" || lead === '"') {
    const litStart = scanner.pos;
    scanner.pos += 1;
    while (scanner.pos < end && scanner.peek() !== lead) scanner.pos += 1;
    if (scanner.peek() === lead) scanner.pos += 1;
    pushToken(out, map, litStart, scanner.pos, 'literal', depth);
  } else {
    const secStart = scanner.pos;
    while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
    pushToken(out, map, secStart, scanner.pos, 'section', depth);
    if (scanner.peek() === '.') {
      pushToken(out, map, scanner.pos, scanner.pos + 1, 'dot', depth);
      scanner.pos += 1;
      const propStart = scanner.pos;
      while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
      pushToken(out, map, propStart, scanner.pos, 'property', depth);
    }
  }

  while (scanner.pos < end && scanner.startsWith('::')) {
    const save = scanner.pos;
    scanner.pos += 2;
    // a comparator terminates the operand rather than extending it
    if (comparatorNames.some((cmp) => scanner.startsWith(`${cmp}::`))) {
      scanner.pos = save;
      break;
    }
    pushToken(out, map, save, save + 2, 'separator', depth);
    const before = scanner.pos;
    tokenizeModifier(scanner, map, depth, out);
    if (scanner.pos <= before) break;
  }
}

function tokenizeModifier(scanner, map, depth, out) {
  const start = scanner.pos;

  for (const [name, shape] of CALL_MODIFIERS) {
    if (!scanner.startsWith(`${name}(`)) continue;
    const nameEnd = start + name.length;
    scanner.pos = nameEnd;
    const argStart = scanner.pos;
    if (scanCallArguments(scanner, shape)) {
      pushToken(out, map, start, nameEnd, 'modifier', depth);
      pushToken(out, map, argStart, scanner.pos, 'call-args', depth);
      return;
    }
    scanner.pos = start;
    break;
  }

  for (const operator of prefixOperators) {
    if (!scanner.startsWith(operator)) continue;
    const opEnd = start + operator.length;
    pushToken(out, map, start, opEnd, 'prefix-op', depth);
    scanner.pos = opEnd;
    const argStart = scanner.pos;
    scanPrefixArgument(scanner);
    pushToken(out, map, argStart, scanner.pos, 'call-args', depth);
    return;
  }

  for (const name of plainModifiers()) {
    if (!scanner.startsWith(name)) continue;
    if (isIdentifierChar(scanner.peek(name.length))) continue;
    pushToken(out, map, start, start + name.length, 'modifier', depth);
    scanner.pos = start + name.length;
    return;
  }
}

function tokenizeCheck(scanner, end, map, depth, out) {
  pushToken(out, map, scanner.pos, scanner.pos + 1, 'bracket', depth);
  scanner.pos += 1;

  for (let branch = 0; branch < 3; branch++) {
    tokenizeBranch(scanner, end, map, depth, out);
    if (!scanner.startsWith('||')) break;
    pushToken(out, map, scanner.pos, scanner.pos + 2, 'pipe', depth);
    scanner.pos += 2;
  }

  if (scanner.peek() === ']') {
    pushToken(out, map, scanner.pos, scanner.pos + 1, 'bracket', depth);
    scanner.pos += 1;
  }
}

function tokenizeBranch(scanner, end, map, depth, out) {
  if (scanner.peek() !== '"') return;
  pushToken(out, map, scanner.pos, scanner.pos + 1, 'quote', depth);
  scanner.pos += 1;

  // Rebuild the branch's UNESCAPED text (mirroring parseCheck's branch scan) and
  // a map from its indices back into `text`. Recursing on the unescaped string is
  // what lets a nested `[\"...\"||...]` conditional tokenise instead of falling
  // back to a dead span, since parseExpression only understands real quotes.
  let branchText = '';
  const localToText = [];
  let braceDepth = 0;
  while (scanner.pos < end) {
    const char = scanner.peek();
    if (char === '\\' && scanner.peek(1) === '"') {
      localToText.push(scanner.pos);
      branchText += '"';
      scanner.pos += 2;
      continue;
    }
    if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === '"' && braceDepth === 0) break;
    localToText.push(scanner.pos);
    branchText += char;
    scanner.pos += 1;
  }
  const contentEnd = scanner.pos;

  // branch-local index -> position in `text` -> document offset
  const branchMap = (i) =>
    map(i >= 0 && i < localToText.length ? localToText[i] : contentEnd);
  tokenizeRegion(branchText, 0, branchText.length, branchMap, depth + 1, out);

  if (scanner.peek() === '"') {
    pushToken(out, map, contentEnd, contentEnd + 1, 'quote', depth);
    scanner.pos += 1;
  }
}

// ============================================================================
// Compiler
// ============================================================================

const MAX_TEMPLATE_DEPTH = 5;

/** Modifiers bound to their arguments once, rather than per render. */
function prepareOperand(node) {
  return {
    node,
    modifiers: node.modifiers.map((source) => ({
      source,
      apply: compileModifier(source),
    })),
  };
}

function isPresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return /\S/.test(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function resolveOperand(operand, parseValue, hooks) {
  if (operand.node.literal !== undefined) {
    const ctx = {
      resolveVariable: (source) => hooks.resolveVariable(source, parseValue),
    };
    let value = operand.node.literal;
    for (const { apply } of operand.modifiers) {
      const next = apply(value, parseValue, ctx);
      if (next === undefined) break;
      value = next;
    }
    return { result: value, present: true };
  }

  const section = parseValue[operand.node.section];
  if (!section) {
    return { error: `{unknown_variableType(${operand.node.section})}` };
  }

  const property = section[operand.node.property];
  if (property === undefined) {
    return {
      error: `{unknown_propertyName(${operand.node.section}.${operand.node.property})}`,
    };
  }

  const ctx = {
    resolveVariable: (source) => hooks.resolveVariable(source, parseValue),
  };

  // Scrub sentinels as the value enters, so stream data can never forge a
  // layout directive. Anything a modifier adds afterwards is template-authored
  // and therefore trusted.
  let result = property;
  if (typeof property === 'string') {
    result = sanitise(property);
  } else if (
    Array.isArray(property) &&
    property.some((item) => typeof item === 'string' && hasSentinel(item))
  ) {
    result = property.map((item) =>
      typeof item === 'string' ? sanitise(item) : item
    );
  }

  const present =
    isPresent(property) ||
    operand.modifiers.some(({ source }) =>
      source.toLowerCase().startsWith('default(')
    );

  for (const { source, apply } of operand.modifiers) {
    // the value this modifier is applied to, which a preceding modifier may
    // already have changed the type of
    const input = result;
    result = apply(input, parseValue, ctx);
    if (result !== undefined) continue;

    // a modifier on an absent value renders nothing
    if (input === null || input === undefined) return { result: '', present };

    return {
      error: `{unknown_${Array.isArray(input) ? 'array' : typeof input}_modifier(${source})}`,
    };
  }

  return { result, present };
}

function resolveExpression(node, operands, parseValue, hooks) {
  if (operands.length === 1) {
    return resolveOperand(operands[0], parseValue, hooks);
  }

  let present = operandPresence(operands[0]);
  for (let i = 1; i < operands.length; i++) {
    const next = operandPresence(operands[i]);
    present =
      node.comparators[i - 1] === 'or' ? present || next : present && next;
  }

  // mixing operators makes left-to-right evaluation order observable,
  // so short-circuiting is limited to uniform and/or chains, and a skipped tail operand is never resolved.
  const allSame = node.comparators.every((c) => c === node.comparators[0]);
  const canShortCircuit =
    allSame && (node.comparators[0] === 'and' || node.comparators[0] === 'or');

  let result = resolveOperand(operands[0], parseValue, hooks);

  for (let i = 1; i < operands.length; i++) {
    if (result.error !== undefined) return result;

    const comparator = node.comparators[i - 1];
    if (canShortCircuit) {
      if (comparator === 'and' && result.result === false)
        return { result: false, present };
      if (comparator === 'or' && result.result === true)
        return { result: true, present };
    }

    const next = resolveOperand(operands[i], parseValue, hooks);
    if (next.error !== undefined) return next;

    try {
      result = {
        result: hooks.comparators[comparator](result.result, next.result),
      };
    } catch (error) {
      return {
        error: `{unable_to_compare(<${result.result}>::${comparator}::<${next.result}>, ${error})}`,
      };
    }
  }

  return { result: result.result, present };

  function operandPresence(operand) {
    if (operand.node.literal !== undefined) return true;
    // default() supplies a value for an absent field, so the operand is present
    if (
      operand.modifiers.some(({ source }) =>
        source.toLowerCase().startsWith('default(')
      )
    )
      return true;
    const section = parseValue[operand.node.section];
    return section ? isPresent(section[operand.node.property]) : false;
  }
}

function compileNode(node, hooks, depth) {
  if (node.kind === 'raw') {
    // resolved per literal, so a value containing a backslash-n is untouched
    const text = node.text.replace(/\\n/g, '\n');
    return () => text;
  }

  if (node.kind === 'tool') {
    const sentinel =
      node.tool === 'newLine' ? NEW_LINE_SENTINEL : REMOVE_LINE_SENTINEL;
    return () => sentinel;
  }

  if (node.kind === 'group') return compileGroup(node, hooks, depth);

  const operands = node.operands.map(prepareOperand);

  if (!node.check) {
    return (parseValue) => {
      const resolved = resolveExpression(node, operands, parseValue, hooks);
      return resolved.error ?? String(resolved.result ?? '');
    };
  }

  const whenTrue = compileTemplate(node.check.trueTemplate, hooks, depth + 1);
  const whenFalse = compileTemplate(node.check.falseTemplate, hooks, depth + 1);
  const whenAbsent =
    node.check.absentTemplate === undefined
      ? undefined
      : compileTemplate(node.check.absentTemplate, hooks, depth + 1);

  return (parseValue) => {
    const resolved = resolveExpression(node, operands, parseValue, hooks);
    if (resolved.error !== undefined) return resolved.error;

    if (!isPresent(resolved.result)) {
      // absent renders nothing unless a third branch says otherwise; a present
      // value that is not a boolean is an authoring error worth surfacing
      return whenAbsent ? whenAbsent(parseValue) : '';
    }

    if (resolved.result !== true && resolved.result !== false) {
      return `{cannot_coerce_boolean_for_check_from(${resolved.result})}`;
    }
    return resolved.result ? whenTrue(parseValue) : whenFalse(parseValue);
  };
}

/** Renders only when every expression inside resolved to a present value. */
function compileGroup(node, hooks, depth) {
  const parts = node.nodes.map((child) => ({
    node: child,
    render: compileNode(child, hooks, depth),
    // a check produces output either way, so it never suppresses the group
    operands:
      child.kind === 'expression' && !child.check
        ? child.operands.map(prepareOperand)
        : undefined,
  }));

  return (parseValue) => {
    let out = '';
    for (const { node: child, render, operands } of parts) {
      if (operands) {
        const resolved = resolveExpression(
          child,
          operands,
          parseValue,
          hooks
        );
        if (resolved.error === undefined && resolved.present === false)
          return '';
      }
      out += render(parseValue);
    }
    return out;
  };
}

/**
 * Resolves a single expression against a value, unlike `compileTemplate` which
 * renders a whole template. `result` is the computed value before stringifying.
 */
export function evaluateExpression(node, parseValue, hooks) {
  const operands = node.operands.map(prepareOperand);
  return resolveExpression(node, operands, parseValue, hooks);
}

/** The `{tools.*}` post-pass is a whole-output concern, left to the caller. */
export function compileTemplate(template, hooks, depth = 0) {
  if (depth > MAX_TEMPLATE_DEPTH) {
    if (hooks.onDepthExceeded) hooks.onDepthExceeded(MAX_TEMPLATE_DEPTH);
    return () => template;
  }

  let source = template;
  if (hooks.debugMacros) {
    for (const [key, replacement] of Object.entries(hooks.debugMacros)) {
      source = source.replace(`{debug.${key}}`, replacement);
    }
  }

  const { nodes } = parseTemplate(source);
  const compiled = nodes.map((node) => compileNode(node, hooks, depth));

  if (compiled.length === 1) return compiled[0];

  return (parseValue) => {
    let out = '';
    for (const render of compiled) out += render(parseValue);
    return out;
  };
}

// ============================================================================
// Stream → ParseValue converter
// ============================================================================

/**
 * Maps a raw stream object (the AIOStreams ParsedStream shape, or any object
 * carrying the same fields) plus a context object to the ParseValue structure
 * consumed by the template engine.
 *
 * `context` carries the values that are not intrinsic to the stream itself:
 *   - addonName:        config.addonName
 *   - title:            metadata.title
 *   - queryType:        metadata.queryType
 *   - runtime:          metadata.runtime (minutes)
 *   - episodeRuntime:   metadata.episodeRuntime (minutes)
 *   - genres:           metadata.genres
 *   - year:             metadata.year
 *   - maxSeScore:       used to normalise seScore → nSeScore
 *   - maxRegexScore:    used to normalise regexScore → nRegexScore
 *   - originalLanguage: used to expand an `Original` placeholder in languages
 *   - userData:         optional — preferredLanguages, requiredLanguages, etc.
 *
 * Everything that comes from the stream itself is read off `stream`, with
 * `stream.parsedFile` flattened so both shapes work.
 */
export function convertStreamToParseValue(stream, context = {}) {
  stream = stream || {};
  context = context || {};
  const parsedFile = stream.parsedFile || {};

  const getPaddedNumber = (number, length) =>
    number.toString().padStart(length, '0');

  const seasons = parsedFile.seasons || stream.seasons;
  const episodes = parsedFile.episodes || stream.episodes;
  const folderSeasons = parsedFile.folderSeasons || stream.folderSeasons;
  const folderEpisodes = parsedFile.folderEpisodes || stream.folderEpisodes;

  const formattedSeasonString = seasons?.length
    ? seasons.length === 1
      ? `S${getPaddedNumber(seasons[0], 2)}`
      : `S${getPaddedNumber(seasons[0], 2)}-${getPaddedNumber(seasons[seasons.length - 1], 2)}`
    : undefined;
  const formattedEpisodeString = episodes?.length
    ? episodes.length === 1
      ? `E${getPaddedNumber(episodes[0], 2)}`
      : `E${getPaddedNumber(episodes[0], 2)}-${getPaddedNumber(episodes[episodes.length - 1], 2)}`
    : undefined;
  const seasonEpisode = [
    formattedSeasonString,
    formattedEpisodeString,
  ].filter((v) => v !== undefined);

  const formattedFolderSeasonString = folderSeasons?.length
    ? folderSeasons.length === 1
      ? `S${getPaddedNumber(folderSeasons[0], 2)}`
      : `S${getPaddedNumber(folderSeasons[0], 2)}-${getPaddedNumber(folderSeasons[folderSeasons.length - 1], 2)}`
    : undefined;

  const formattedFolderEpisodesString = folderEpisodes?.length
    ? folderEpisodes.length === 1
      ? `E${getPaddedNumber(folderEpisodes[0], 2)}`
      : `E${getPaddedNumber(folderEpisodes[0], 2)}-${getPaddedNumber(folderEpisodes[folderEpisodes.length - 1], 2)}`
    : undefined;

  // ---- user preference merge (languages / subtitles / audio) ----
  const userData = context.userData || {};
  const getFieldValues = (field) => {
    const key = field.charAt(0).toUpperCase() + field.slice(1);
    const preferred = userData[`preferred${key}`] || [];
    const required = userData[`required${key}`] || [];
    const included = userData[`included${key}`] || [];
    return [...preferred, ...required, ...included];
  };

  const sortByUserPreference = (items, userPrefs) => {
    if (!items) return null;
    if (!userPrefs.length) return items;
    return [...items].sort((a, b) => {
      const aIndex = userPrefs.indexOf(a);
      const bIndex = userPrefs.indexOf(b);
      const aInPrefs = aIndex !== -1;
      const bInPrefs = bIndex !== -1;
      if (aInPrefs && bInPrefs) {
        return aIndex - bIndex;
      }
      return aInPrefs ? -1 : bInPrefs ? 1 : 0;
    });
  };

  const expandOriginal = (lang) =>
    lang === 'Original' && context.originalLanguage
      ? context.originalLanguage
      : lang;

  const userSpecifiedLanguages = [
    ...new Set(getFieldValues('languages').map(expandOriginal)),
  ];
  const userSpecifiedSubtitles = [
    ...new Set(getFieldValues('subtitles').map(expandOriginal)),
  ];

  const applyModifiers = (list, ...modifiers) => {
    if (!list) return null;
    const modified = list.map((value) =>
      modifiers.reduce(
        (acc, modifier) =>
          acc !== undefined ? (modifier(acc) ?? acc) : undefined,
        value
      )
    );
    return [...new Set(modified.filter(Boolean))];
  };

  const buildLanguageVariants = (values, userSpecifiedValues) => {
    const sortedValues = sortByUserPreference(values, userSpecifiedValues);
    const userValues = sortedValues
      ? sortedValues.filter((value) => userSpecifiedValues.includes(value))
      : null;

    const emojis = applyModifiers(sortedValues, languageToEmoji);
    const userEmojis = applyModifiers(userValues, languageToEmoji);
    const codes = applyModifiers(sortedValues, (value) => languageToCode(value) || value.toUpperCase());
    const userCodes = applyModifiers(userValues, (value) => languageToCode(value) || value.toUpperCase());
    const smallCodes = applyModifiers(sortedValues, languageToCode, makeSmall);
    const userSmallCodes = applyModifiers(userValues, languageToCode, makeSmall);
    const usEmojis = applyModifiers(sortedValues, languageToEmoji, (emoji) =>
      emoji ? emoji.replace('🇬🇧', '🇺🇸🦅') : emoji
    );
    const userUsEmojis = applyModifiers(userValues, languageToEmoji, (emoji) =>
      emoji ? emoji.replace('🇬🇧', '🇺🇸🦅') : emoji
    );

    return {
      sortedValues,
      userValues,
      emojis,
      userEmojis,
      codes,
      userCodes,
      smallCodes,
      userSmallCodes,
      usEmojis,
      userUsEmojis,
    };
  };

  // built on first read: most templates reference none of the twenty
  // language/subtitle variants
  const memo = (build) => {
    let value;
    let built = false;
    return () => {
      if (!built) {
        value = build();
        built = true;
      }
      return value;
    };
  };

  const languageVariants = memo(() =>
    buildLanguageVariants(
      parsedFile.languages || stream.languages,
      userSpecifiedLanguages
    )
  );
  const subtitleVariants = memo(() =>
    buildLanguageVariants(
      parsedFile.subtitles || stream.subtitles,
      userSpecifiedSubtitles?.length ? userSpecifiedSubtitles : userSpecifiedLanguages
    )
  );
  const sortedAudioChannels = sortByUserPreference(
    parsedFile.audioChannels || stream.audioChannels,
    getFieldValues('audioChannels')
  );
  const sortedAudioTags = sortByUserPreference(
    parsedFile.audioTags || stream.audioTags,
    getFieldValues('audioTags')
  );
  const sortedVisualTags = sortByUserPreference(
    parsedFile.visualTags || stream.visualTags,
    getFieldValues('visualTags')
  );

  const streamAge = stream.age ?? stream.ageHours;
  const formattedAge = streamAge != null ? formatHours(streamAge) : null;

  const addonName =
    context.addonName || userData.addonName || stream.addonName || 'AIOStreams';

  const torrent = stream.torrent || {};

  // normalised scores
  const maxSeScore = context.maxSeScore;
  const maxRegexScore = context.maxRegexScore;
  const regexScore = stream.regexScore;
  const seScore = stream.streamExpressionScore;

  const nRegexScore =
    regexScore != undefined &&
    maxRegexScore != undefined &&
    maxRegexScore > 0
      ? Math.max(
          0,
          Math.min(100, Math.round((regexScore / maxRegexScore) * 100))
        )
      : null;

  const nSeScore =
    seScore != undefined &&
    maxSeScore != undefined &&
    maxSeScore > 0
      ? Math.max(0, Math.min(100, Math.round((seScore / maxSeScore) * 100)))
      : null;

  const rankedRegexMatched =
    (stream.rankedRegexesMatched || []).filter(
      (name) => typeof name === 'string'
    ) || [];
  const rseMatched =
    (stream.rankedStreamExpressionsMatched || []).filter(
      (name) => typeof name === 'string'
    ) || [];

  const parseValue = {
    config: {
      addonName,
    },
    stream: {
      filename: stream.filename || null,
      folderName: stream.folderName || null,
      size: stream.size || null,
      folderSize: stream.folderSize || null,
      library: stream.library ?? false,
      quality: parsedFile.quality || stream.quality || null,
      resolution: parsedFile.resolution || stream.resolution || null,
      subbed:
        parsedFile.subbed || stream.subbed || !!parsedFile.subtitles?.length,
      dubbed: parsedFile.dubbed || stream.dubbed || false,
      get languages() {
        return languageVariants().sortedValues;
      },
      get uLanguages() {
        return languageVariants().userValues;
      },
      get subtitles() {
        return subtitleVariants().sortedValues;
      },
      get uSubtitles() {
        return subtitleVariants().userValues;
      },
      get languageEmojis() {
        return languageVariants().emojis;
      },
      get uLanguageEmojis() {
        return languageVariants().userEmojis;
      },
      get subtitleEmojis() {
        return subtitleVariants().emojis;
      },
      get uSubtitleEmojis() {
        return subtitleVariants().userEmojis;
      },
      get languageCodes() {
        return languageVariants().codes;
      },
      get uLanguageCodes() {
        return languageVariants().userCodes;
      },
      get subtitleCodes() {
        return subtitleVariants().codes;
      },
      get uSubtitleCodes() {
        return subtitleVariants().userCodes;
      },
      get smallLanguageCodes() {
        return languageVariants().smallCodes;
      },
      get uSmallLanguageCodes() {
        return languageVariants().userSmallCodes;
      },
      get smallSubtitleCodes() {
        return subtitleVariants().smallCodes;
      },
      get uSmallSubtitleCodes() {
        return subtitleVariants().userSmallCodes;
      },
      get wedontknowwhatakilometeris() {
        return languageVariants().usEmojis;
      },
      get uWedontknowwhatakilometeris() {
        return languageVariants().userUsEmojis;
      },
      visualTags: sortedVisualTags,
      audioTags: sortedAudioTags,
      releaseGroup: parsedFile.releaseGroup || stream.releaseGroup || null,
      regexMatched:
        stream.regexMatched?.name || rankedRegexMatched[0] || null,
      rankedRegexMatched,
      regexScore: regexScore ?? null,
      nRegexScore,
      encode: parsedFile.encode || stream.encode || null,
      audioChannels: sortedAudioChannels || null,
      indexer: stream.indexer || null,
      seeders: torrent.seeders ?? stream.seeders ?? null,
      private: torrent.private ?? stream.private ?? false,
      freeleech: torrent.freeleech ?? stream.freeleech ?? null,
      year: parsedFile.year || stream.year || null,
      type: stream.type || null,
      title: parsedFile.title || stream.title || null,
      date: parsedFile.date || stream.date || null,
      season: seasons?.[0] ?? stream.season ?? null,
      formattedSeasons: formattedSeasonString || null,
      seasons: seasons || null,
      folderSeasons: folderSeasons || null,
      formattedFolderSeasons: formattedFolderSeasonString || null,
      episode: episodes?.[0] ?? stream.episode ?? null,
      formattedEpisodes: formattedEpisodeString || null,
      episodes: episodes || null,
      formattedFolderEpisodes: formattedFolderEpisodesString || null,
      folderEpisodes: folderEpisodes || null,
      seasonEpisode: seasonEpisode.length ? seasonEpisode : null,
      seasonPack: parsedFile.seasonPack ?? stream.seasonPack ?? false,
      duration: stream.duration || null,
      bitrate: stream.bitrate ?? null,
      infoHash: torrent.infoHash || stream.infoHash || null,
      age: formattedAge,
      ageHours: stream.age ?? stream.ageHours ?? null,
      message: stream.message || null,
      proxied: stream.proxied ?? false,
      edition: parsedFile.editions?.[0] || stream.edition || null,
      editions: parsedFile.editions || stream.editions || null,
      regraded: parsedFile.regraded ?? stream.regraded ?? false,
      remastered: null,
      repack: parsedFile.repack ?? stream.repack ?? false,
      proper: parsedFile.proper ?? stream.proper ?? false,
      uncensored: parsedFile.uncensored ?? stream.uncensored ?? false,
      unrated: parsedFile.unrated ?? stream.unrated ?? false,
      upscaled: parsedFile.upscaled ?? stream.upscaled ?? false,
      hasChapters: parsedFile.hasChapters ?? stream.hasChapters ?? false,
      network: parsedFile.network || stream.network || null,
      container: parsedFile.container || stream.container || null,
      extension: parsedFile.extension || stream.extension || null,
      seadex: stream.seadex?.isSeadex ?? stream.seadex ?? false,
      seadexBest: stream.seadex?.isBest ?? stream.seadexBest ?? false,
      nSeScore,
      seScore: seScore ?? null,
      seMatched: stream.streamExpressionMatched?.name || stream.seMatched || null,
      rseMatched,
      preloading: stream.preloading ?? false,
    },
    metadata: {
      queryType: context.queryType || stream.queryType || null,
      title: context.title || stream.metadataTitle || null,
      runtime: context.runtime ?? stream.runtime ?? null,
      episodeRuntime: context.episodeRuntime ?? stream.episodeRuntime ?? null,
      genres: context.genres || stream.genres || null,
      year: context.year ?? stream.metadataYear ?? null,
    },
    addon: {
      name: stream.addon?.name || stream.addonName || null,
      presetId: stream.addon?.preset?.type || stream.presetId || null,
      manifestUrl: stream.addon?.manifestUrl || stream.manifestUrl || null,
    },
    service: {
      id: stream.service?.id || stream.serviceId || null,
      shortName: stream.service?.shortName || stream.serviceShortName || null,
      name: stream.service?.name || stream.serviceName || null,
      cached:
        stream.service?.cached !== undefined
          ? stream.service?.cached
          : stream.serviceCached ?? null,
    },
  };

  parseValue.debug = {
    get json() {
      return JSON.stringify({ ...parseValue, debug: undefined });
    },
    get jsonf() {
      return JSON.stringify(
        { ...parseValue, debug: undefined },
        (_key, value) => value,
        2
      );
    },
  };
  return parseValue;
}

// ============================================================================
// Default hooks + post-processing
// ============================================================================

/**
 * The hooks used by both public entry points. `resolveVariable` is the helper
 * that backs `replace({config.addonName}, 'x')` — it looks the dotted path up
 * in the parseValue, falling back to undefined.
 */
export function defaultHooks(parseValue) {
  return {
    resolveVariable: (source, parseValue) => {
      const dot = source.indexOf('.');
      if (dot === -1) {
        const v = parseValue?.[source];
        return v == null ? undefined : String(v);
      }
      const section = source.slice(0, dot);
      const property = source.slice(dot + 1);
      const value = parseValue?.[section]?.[property];
      return value == null ? undefined : String(value);
    },
    comparators: comparatorFunctions,
    onDepthExceeded: (max) => {
      // no-op by default; callers can override by passing their own hooks
    },
  };
}

/**
 * Post-processing applied to a rendered template string:
 *   - split on `\n`
 *   - drop lines that are empty after trimming
 *   - drop lines that contain a REMOVE_LINE_SENTINEL (`{tools.removeLine}`)
 *   - join the survivors back on `\n`
 *   - replace every NEW_LINE_SENTINEL (`{tools.newLine}`) with `\n`
 */
export function applySentinelPostProcessing(rendered) {
  return rendered
    .split('\n')
    .filter(
      (line) => line.trim() !== '' && !line.includes(REMOVE_LINE_SENTINEL)
    )
    .join('\n')
    .replaceAll(NEW_LINE_SENTINEL, '\n');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Evaluates a template string against a data object.
 *
 * `data` is a ParseValue (or any object with the `section.property` shape the
 * template references). The template is compiled once and rendered, then the
 * sentinel post-processing is applied.
 */
export function evaluateTemplate(template, data) {
  const hooks = defaultHooks(data);
  const compiled = compileTemplate(template, hooks, 0);
  const rendered = compiled(data);
  return applySentinelPostProcessing(rendered);
}

/**
 * Formats a raw stream into `{ name, description }`.
 *
 * `context` is the same shape accepted by `convertStreamToParseValue`, plus
 * two template strings:
 *   - context.name        — template rendered into the `name` field
 *   - context.description — template rendered into the `description` field
 *
 * If the templates are absent, the corresponding output field is the empty
 * string.
 */
export function formatStream(stream, context = {}) {
  context = context || {};
  const parseValue = convertStreamToParseValue(stream, context);
  const hooks = defaultHooks(parseValue);

  let name = '';
  let description = '';

  if (context.name) {
    const compiledName = compileTemplate(context.name, hooks, 0);
    name = applySentinelPostProcessing(compiledName(parseValue));
  }
  if (context.description) {
    const compiledDesc = compileTemplate(context.description, hooks, 0);
    description = applySentinelPostProcessing(compiledDesc(parseValue));
  }

  return { name, description };
}

// ============================================================================
// Exports — every public symbol from the original modules is preserved so the
// file can be a drop-in replacement for the engine's public surface.
// ============================================================================

export {
  // sentinels (already exported above, re-listed for clarity)
  // comparators (already exported above)
  // utils (already exported above)
  // modifiers (already exported above)
  // parser (already exported above)
  // compiler (already exported above)
  // stream converter (already exported above)
};

export default {
  NEW_LINE_SENTINEL,
  REMOVE_LINE_SENTINEL,
  hasSentinel,
  sanitise,
  substituteTools,
  comparatorFunctions,
  comparatorNames,
  FIELD_REGISTRY,
  canonicaliseField,
  nearestName,
  suggestField,
  formatBytes,
  formatSmartBytes,
  formatBitrate,
  formatSmartBitrate,
  formatDuration,
  formatDurationPattern,
  formatDatePattern,
  formatHours,
  makeSmall,
  normaliseDuration,
  languageToCode,
  languageToEmoji,
  stringModifierNames,
  numberModifierNames,
  arrayModifierNames,
  booleanModifierNames,
  conditionalModifierNames,
  allModifierNames,
  prefixOperators,
  compileModifier,
  CALL_MODIFIERS,
  ARGUMENT_EXAMPLES,
  parseTemplate,
  tokenize,
  compileTemplate,
  evaluateExpression,
  convertStreamToParseValue,
  defaultHooks,
  applySentinelPostProcessing,
  evaluateTemplate,
  formatStream,
};

// === Browser global registration ===
// When loaded in a browser via <script type="module">, register on window
// so regular scripts can access the engine without dynamic import().
if (typeof window !== 'undefined') {
  window.__formatterEngine = {
    evaluateTemplate,
    formatStream,
    convertStreamToParseValue,
    compileTemplate,
    evaluateExpression,
    parseTemplate,
    tokenize,
    compileModifier,
    FIELD_REGISTRY,
    canonicaliseField,
  };
}
