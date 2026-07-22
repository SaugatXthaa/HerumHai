// packages/core/src/formatters/engine/ast.ts
function rawText(text) {
  return { kind: "raw", text };
}

// packages/core/src/formatters/engine/fields.ts
var FIELD_REGISTRY = {
  config: ["addonName"],
  stream: [
    "filename",
    "folderName",
    "size",
    "bitrate",
    "folderSize",
    "library",
    "quality",
    "resolution",
    "subbed",
    "dubbed",
    "languages",
    "uLanguages",
    "subtitles",
    "uSubtitles",
    "languageEmojis",
    "uLanguageEmojis",
    "subtitleEmojis",
    "uSubtitleEmojis",
    "languageCodes",
    "uLanguageCodes",
    "subtitleCodes",
    "uSubtitleCodes",
    "smallLanguageCodes",
    "uSmallLanguageCodes",
    "smallSubtitleCodes",
    "uSmallSubtitleCodes",
    "wedontknowwhatakilometeris",
    "uWedontknowwhatakilometeris",
    "visualTags",
    "audioTags",
    "releaseGroup",
    "regexMatched",
    "rankedRegexMatched",
    "regexScore",
    "nRegexScore",
    "encode",
    "audioChannels",
    "edition",
    "editions",
    "remastered",
    "regraded",
    "repack",
    "proper",
    "uncensored",
    "unrated",
    "upscaled",
    "hasChapters",
    "network",
    "container",
    "extension",
    "indexer",
    "year",
    "title",
    "date",
    "folderSeasons",
    "formattedFolderSeasons",
    "seasons",
    "season",
    "formattedSeasons",
    "episodes",
    "episode",
    "formattedEpisodes",
    "folderEpisodes",
    "formattedFolderEpisodes",
    "seasonEpisode",
    "seasonPack",
    "seeders",
    "private",
    "freeleech",
    "age",
    "ageHours",
    "duration",
    "infoHash",
    "type",
    "message",
    "proxied",
    "seadex",
    "seadexBest",
    "seScore",
    "nSeScore",
    "seMatched",
    "rseMatched",
    "preloading"
  ],
  metadata: [
    "queryType",
    "title",
    "runtime",
    "genres",
    "year",
    "episodeRuntime"
  ],
  service: ["id", "shortName", "name", "cached"],
  addon: ["name", "presetId", "manifestUrl"],
  debug: ["json", "jsonf"]
};
var CANONICAL_FIELDS = new Map(
  Object.entries(FIELD_REGISTRY).flatMap(
    ([section, properties]) => properties.map(
      (property) => [`${section}.${property}`.toLowerCase(), [section, property]]
    )
  )
);
function canonicaliseField(section, property) {
  return CANONICAL_FIELDS.get(`${section}.${property}`.toLowerCase());
}
var PROPERTY_INDEX = (() => {
  const index = /* @__PURE__ */ new Map();
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
function distanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return void 0;
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
    if (best > max) return void 0;
    previous = current;
  }
  const distance = previous[b.length];
  return distance <= max ? distance : void 0;
}
function budget(word) {
  return Math.min(2, Math.floor(word.length / 3));
}
function nearestName(word, candidates) {
  return nearest(word, candidates)[0];
}
function nearest(word, candidates) {
  const max = budget(word);
  if (max < 1) return [];
  const lower = word.toLowerCase();
  let best = max + 1;
  let matches = [];
  for (const candidate of candidates) {
    const distance = distanceAtMost(lower, candidate.toLowerCase(), max);
    if (distance === void 0 || distance > best) continue;
    if (distance < best) {
      best = distance;
      matches = [];
    }
    matches.push(candidate);
  }
  return matches;
}
function suggestField(section, property) {
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
  return nearest(section, sections).map((name) => canonicaliseField(name, property)).filter((field) => field !== void 0).map(([s, p]) => `${s}.${p}`);
}

// packages/core/src/formatters/utils.ts
function formatBytes(bytes, k, round = false) {
  if (bytes === 0) return "0 B";
  const sizes = k === 1024 ? ["B", "KiB", "MiB", "GiB", "TiB"] : ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  let value = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
  if (round) {
    value = Math.round(value);
  }
  return value + " " + sizes[i];
}
function formatSmartBytes(bytes, k) {
  if (bytes === 0) return "0 B";
  const sizes = k === 1024 ? ["B", "KiB", "MiB", "GiB", "TiB"] : ["B", "KB", "MB", "GB", "TB"];
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
  return formattedValue + " " + sizes[i];
}
function formatBitrate(bitrate, round = false) {
  if (!Number.isFinite(bitrate) || bitrate <= 0) return "0 bps";
  const k = 1e3;
  const sizes = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  const i = Math.min(
    sizes.length - 1,
    Math.max(0, Math.floor(Math.log(bitrate) / Math.log(k)))
  );
  let value = bitrate / Math.pow(k, i);
  value = round ? Math.round(value) : parseFloat(value.toFixed(2));
  return `${value} ${sizes[i]}`;
}
function formatSmartBitrate(bitrate) {
  if (!Number.isFinite(bitrate) || bitrate <= 0) return "0 bps";
  const k = 1e3;
  const sizes = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
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
function formatDuration(durationInMs) {
  const seconds = Math.floor(durationInMs / 1e3);
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
function renderPattern(pattern, resolve) {
  const stack = [{ text: "", zero: true, sawToken: false }];
  const closeGroup = () => {
    const group = stack.pop();
    const parent = stack[stack.length - 1];
    if (!group.sawToken || !group.zero) {
      parent.text += group.text;
      parent.sawToken ||= group.sawToken;
      if (!group.zero) parent.zero = false;
    }
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const top = stack[stack.length - 1];
    if (char === "%") {
      const next = pattern[i + 1];
      if (next === void 0) {
        top.text += "%";
        break;
      }
      if (next === "%" || next === "[" || next === "]") {
        top.text += next;
        i += 1;
        continue;
      }
      const token = next === "-" ? pattern.slice(i + 1, i + 3) : next;
      const resolved = resolve(token);
      if (resolved === void 0) {
        top.text += `%${token}`;
      } else {
        top.text += resolved.text;
        top.sawToken = true;
        if (!resolved.zero) top.zero = false;
      }
      i += token.length;
      continue;
    }
    if (char === "[") {
      stack.push({ text: "", zero: true, sawToken: false });
      continue;
    }
    if (char === "]" && stack.length > 1) {
      closeGroup();
      continue;
    }
    top.text += char;
  }
  while (stack.length > 1) closeGroup();
  return stack[0].text;
}
var DURATION_UNITS = ["H", "M", "S"];
function normaliseDuration(duration) {
  if (duration < 0) {
    return 0;
  }
  if (duration < 1e3) {
    return duration * 60 * 1e3;
  }
  return duration;
}
function formatDurationPattern(durationInMs, pattern) {
  const units = /* @__PURE__ */ new Set();
  renderPattern(pattern, (token) => {
    const unit = token.startsWith("-") ? token.slice(1) : token;
    if (!DURATION_UNITS.includes(unit)) {
      return void 0;
    }
    units.add(unit);
    return { text: "" };
  });
  const totalSeconds = Math.max(0, Math.floor(durationInMs / 1e3));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const values = {
    H: Math.floor(totalSeconds / 3600),
    M: units.has("H") ? totalMinutes % 60 : totalMinutes,
    S: units.has("H") || units.has("M") ? totalSeconds % 60 : totalSeconds
  };
  return renderPattern(pattern, (token) => {
    const padded = !token.startsWith("-");
    const value = values[padded ? token : token.slice(1)];
    if (value === void 0) return void 0;
    return {
      text: padded ? String(value).padStart(2, "0") : String(value),
      zero: value === 0
    };
  });
}
var MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
var DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
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
function formatDatePattern(value, pattern) {
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
  if (!parts) return value;
  const [year, month, day] = [
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3])
  ];
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return value;
  }
  const tokens = {
    Y: String(year),
    y: String(year % 100).padStart(2, "0"),
    m: String(month + 1).padStart(2, "0"),
    "-m": String(month + 1),
    d: String(day).padStart(2, "0"),
    "-d": String(day),
    o: ordinalise(day),
    B: MONTH_NAMES[month],
    b: MONTH_NAMES[month].slice(0, 3),
    A: DAY_NAMES[date.getUTCDay()],
    a: DAY_NAMES[date.getUTCDay()].slice(0, 3)
  };
  return renderPattern(
    pattern,
    (token) => tokens[token] !== void 0 ? { text: tokens[token] } : void 0
  );
}
function makeSmall(code) {
  return code.split("").map((char) => SMALL_CAPS_MAP[char.toUpperCase()] || char).join("");
}
var SMALL_CAPS_MAP = {
  A: "\u1D00",
  // U+1D00
  B: "\u0299",
  // U+0299
  C: "\u1D04",
  // U+1D04
  D: "\u1D05",
  // U+1D05
  E: "\u1D07",
  // U+1D07
  F: "\u0493",
  // U+0493
  G: "\u0262",
  // U+0262
  H: "\u029C",
  // U+029C
  I: "\u026A",
  // U+026A
  J: "\u1D0A",
  // U+1D0A
  K: "\u1D0B",
  // U+1D0B
  L: "\u029F",
  // U+029F
  M: "\u1D0D",
  // U+1D0D
  N: "\u0274",
  // U+0274
  O: "\u1D0F",
  // U+1D0F
  P: "\u1D18",
  // U+1D18
  Q: "\u01EB",
  // U+01EB
  R: "\u0280",
  // U+0280
  S: "\uA731",
  // U+A731
  T: "\u1D1B",
  // U+1D1B
  U: "\u1D1C",
  // U+1D1C
  V: "\u1D20",
  // U+1D20
  W: "\u1D21",
  // U+1D21
  // There is no widely supported small-cap X; fall back to "x".
  X: "x",
  Y: "\u028F",
  // U+028F
  Z: "\u1D22"
  // U+1D22
};

// packages/core/src/formatters/engine/sentinels.ts
var NEW_LINE_SENTINEL = "";
var REMOVE_LINE_SENTINEL = "";
var SENTINEL_PATTERN = /[\u0011\u0012]/g;
function hasSentinel(text) {
  return text.includes(NEW_LINE_SENTINEL) || text.includes(REMOVE_LINE_SENTINEL);
}
function sanitise(text) {
  return hasSentinel(text) ? text.replace(SENTINEL_PATTERN, "") : text;
}
function substituteTools(text) {
  return text.replaceAll("{tools.newLine}", NEW_LINE_SENTINEL).replaceAll("{tools.removeLine}", REMOVE_LINE_SENTINEL);
}

// packages/core/src/formatters/engine/modifiers.ts
var stringModifiers = {
  upper: (value) => value.toUpperCase(),
  lower: (value) => value.toLowerCase(),
  title: (value) => value.split(" ").map((word) => word.toLowerCase()).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" "),
  length: (value) => value.length.toString(),
  reverse: (value) => value.split("").reverse().join(""),
  // not btoa: it throws above U+00FF, which real release names hit constantly
  base64: (value) => Buffer.from(value, "utf8").toString("base64"),
  string: (value) => value,
  smallcaps: (value) => makeSmall(value),
  subscript: (value) => mapChars(value, DIGITS, SUBSCRIPT_DIGITS),
  superscript: (value) => mapChars(value, DIGITS, SUPERSCRIPT_DIGITS)
};
var DIGITS = "0123456789+-=()";
var SUBSCRIPT_DIGITS = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089\u208A\u208B\u208C\u208D\u208E";
var SUPERSCRIPT_DIGITS = "\u2070\xB9\xB2\xB3\u2074\u2075\u2076\u2077\u2078\u2079\u207A\u207B\u207C\u207D\u207E";
function mapChars(value, from, to) {
  const table = /* @__PURE__ */ new Map();
  const source = [...from];
  const target = [...to];
  for (let i = 0; i < source.length && i < target.length; i++) {
    table.set(source[i], target[i]);
  }
  return [...value].map((char) => table.get(char) ?? char).join("");
}
var arrayGetOrDefault = (value, index) => value.length > 0 ? String(value[index]) : "";
var sortBy = (ascending) => (value) => [...value].sort((a, b) => {
  const result = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), void 0, { numeric: true });
  return ascending ? result : -result;
});
var stars = (padWithEmpty) => (value) => {
  const FULL = "\u2605";
  const HALF = "\u2BEA";
  const EMPTY = "\u2606";
  const full = Math.floor(value / 20);
  const half = value % 20 >= 10 ? 1 : 0;
  return FULL.repeat(full) + HALF.repeat(half) + (padWithEmpty ? EMPTY.repeat(5 - full - half) : "");
};
var arrayModifiers = {
  join: (value) => value.join(", "),
  length: (value) => value.length.toString(),
  first: (value) => arrayGetOrDefault(value, 0),
  last: (value) => arrayGetOrDefault(value, value.length - 1),
  random: (value) => arrayGetOrDefault(value, Math.floor(Math.random() * value.length)),
  sort: sortBy(true),
  rsort: sortBy(false),
  lsort: (value) => [...value].sort(),
  reverse: (value) => [...value].reverse(),
  string: (value) => value.toString()
};
var numberModifiers = {
  comma: (value) => value.toLocaleString(),
  hex: (value) => value.toString(16),
  octal: (value) => value.toString(8),
  binary: (value) => value.toString(2),
  bytes: (value) => formatBytes(value, 1e3),
  sbytes: (value) => formatSmartBytes(value, 1e3),
  sbytes10: (value) => formatSmartBytes(value, 1e3),
  sbytes2: (value) => formatSmartBytes(value, 1024),
  rbytes: (value) => formatBytes(value, 1e3, true),
  bytes10: (value) => formatBytes(value, 1e3),
  rbytes10: (value) => formatBytes(value, 1e3, true),
  bytes2: (value) => formatBytes(value, 1024),
  rbytes2: (value) => formatBytes(value, 1024, true),
  bitrate: (value) => formatBitrate(value),
  rbitrate: (value) => formatBitrate(value, true),
  sbitrate: (value) => formatSmartBitrate(value),
  string: (value) => value.toString(),
  time: (value) => formatDuration(normaliseDuration(value)),
  star: stars(false),
  pstar: stars(true)
};
var booleanModifiers = {
  string: (value) => String(value)
};
var conditionalModifiers = {
  exact: {
    istrue: (value) => value === true,
    isfalse: (value) => value === false,
    exists: (value) => {
      if (value === void 0 || value === null) return false;
      if (typeof value === "string") return /\S/.test(value);
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }
  },
  prefix: {
    $: (value, check) => typeof value === "string" ? value.startsWith(check) : value?.[0] === check,
    "^": (value, check) => typeof value === "string" ? value.endsWith(check) : value?.[value.length - 1] === check,
    "~": (value, check) => value.includes(check),
    "=": (value, check) => value === check,
    ">=": (value, check) => value >= check,
    ">": (value, check) => value > check,
    "<=": (value, check) => value <= check,
    "<": (value, check) => value < check
  }
};
var stringModifierNames = Object.keys(stringModifiers);
var numberModifierNames = Object.keys(numberModifiers);
var arrayModifierNames = Object.keys(arrayModifiers);
var booleanModifierNames = Object.keys(booleanModifiers);
var conditionalModifierNames = Object.keys(
  conditionalModifiers.exact
);
var allModifierNames = [
  ...stringModifierNames,
  ...booleanModifierNames,
  ...numberModifierNames,
  ...arrayModifierNames,
  ...conditionalModifierNames
];
var prefixOperators = Object.keys(conditionalModifiers.prefix).sort(
  (a, b) => b.length - a.length
);
function quotedArguments(inner) {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'/g;
  let match;
  while ((match = pattern.exec(inner)) !== null) {
    args.push(match[1] ?? match[2] ?? "");
  }
  return args;
}
function unquote(arg) {
  const quote = arg[0];
  return arg.length >= 2 && (quote === "'" || quote === '"') && arg.endsWith(quote) ? arg.slice(1, -1) : void 0;
}
function compileConditional(lower) {
  const exact = conditionalModifiers.exact;
  const isExact = Object.prototype.hasOwnProperty.call(exact, lower);
  const operator = prefixOperators.find((op) => lower.startsWith(op));
  if (!isExact && !operator) return void 0;
  const rawCheck = operator ? lower.slice(operator.length) : "";
  const isArrayCapable = operator ? ["$", "^", "~"].includes(operator) : false;
  const isNumericCapable = operator ? ["<", "<=", ">", ">=", "="].includes(operator) : false;
  return (value) => {
    try {
      if (!exact.exists(value)) return false;
      if (isExact) return exact[lower](value);
      const arrayValue = Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.toLowerCase()) : void 0;
      const stringValue = String(value).toLowerCase();
      const check = /\s/.test(stringValue) ? rawCheck : rawCheck.replace(/\s/g, "");
      const numericValue = Number(stringValue.replace(/,\s/g, ""));
      const numericCheck = Number(check.replace(/,\s/g, ""));
      const numeric = isNumericCapable && !isNaN(numericValue) && !isNaN(numericCheck);
      const compare = conditionalModifiers.prefix[operator];
      return compare(
        numeric ? numericValue : (isArrayCapable ? arrayValue : void 0) ?? stringValue,
        numeric ? numericCheck : check
      );
    } catch {
      return false;
    }
  };
}
function compileParameterised(source, lower) {
  const open = source.indexOf("(");
  if (open === -1 || !source.endsWith(")")) return void 0;
  const name = lower.slice(0, open);
  const inner = source.slice(open + 1, -1);
  switch (name) {
    case "replace": {
      const variableForm = /^\s*\{([^}]+)\}\s*,\s*(['"])([\s\S]*)\2\s*$/.exec(
        inner
      );
      if (variableForm) {
        const [, variablePath, , rawReplacement] = variableForm;
        const replacementText2 = substituteTools(rawReplacement);
        return (value, parseValue, ctx) => {
          if (typeof value !== "string") return void 0;
          const resolved = ctx.resolveVariable(variablePath, parseValue);
          return resolved ? value.replaceAll(resolved, replacementText2) : value;
        };
      }
      const openQuote = source.charAt("replace(".length);
      const closeQuote = source.charAt(source.length - 2);
      const body = source.slice("replace(".length + 1, -2);
      const [rawSearch, replacement, extra] = body.split(
        new RegExp(`${openQuote}\\s*,\\s*${closeQuote}`)
      );
      if (extra !== void 0 || !rawSearch || replacement === void 0) {
        return (value) => typeof value === "string" ? value : void 0;
      }
      const variableKey = rawSearch.startsWith("{") && rawSearch.endsWith("}") ? rawSearch.slice(1, -1) : void 0;
      const replacementText = substituteTools(replacement);
      return (value, parseValue, ctx) => {
        if (typeof value !== "string") return void 0;
        if (!variableKey) return value.replaceAll(rawSearch, replacementText);
        const resolved = ctx.resolveVariable(variableKey, parseValue);
        if (!resolved) return value;
        return value.replaceAll(resolved, replacementText);
      };
    }
    case "remove": {
      const args = quotedArguments(inner);
      if (args.length === 0) return () => void 0;
      const targets = args.filter(Boolean);
      return (value) => {
        if (typeof value === "string") {
          let result = value;
          for (const target of targets) result = result.replaceAll(target, "");
          return result;
        }
        if (Array.isArray(value)) return value.filter((v) => !args.includes(v));
        return void 0;
      };
    }
    case "join": {
      const raw = unquote(inner);
      if (raw === void 0) return void 0;
      const separator = substituteTools(raw);
      return (value) => Array.isArray(value) ? value.join(separator) : void 0;
    }
    case "truncate": {
      const limit = parseInt(inner, 10);
      if (isNaN(limit) || limit < 0) return void 0;
      const segmenter = new Intl.Segmenter();
      return (value) => {
        if (typeof value !== "string") return void 0;
        const graphemes = [...segmenter.segment(value)];
        if (graphemes.length <= limit) return value;
        return graphemes.slice(0, limit).map((s) => s.segment).join("").replace(/\s+$/, "") + "\u2026";
      };
    }
    case "slice": {
      const parts = inner.split(",").map((part) => parseInt(part.trim(), 10));
      if (isNaN(parts[0])) return void 0;
      const [start, end] = [
        parts[0],
        parts.length > 1 && !isNaN(parts[1]) ? parts[1] : void 0
      ];
      return (value) => Array.isArray(value) ? value.slice(start, end) : void 0;
    }
    case "default": {
      const fallback = unquote(inner);
      if (fallback === void 0) return void 0;
      return (value) => conditionalModifiers.exact.exists(value) ? value : fallback;
    }
    case "translate": {
      const [from, to] = quotedArguments(inner);
      if (from === void 0 || to === void 0) return void 0;
      return (value) => typeof value === "string" ? mapChars(value, from, to) : void 0;
    }
    case "in": {
      const options = quotedArguments(inner).map(
        (option) => option.toLowerCase()
      );
      if (options.length === 0) return void 0;
      const set = new Set(options);
      return (value) => {
        if (value === null || value === void 0) return false;
        if (Array.isArray(value)) {
          return value.some(
            (item) => typeof item === "string" && set.has(item.toLowerCase())
          );
        }
        return set.has(String(value).toLowerCase());
      };
    }
    case "time": {
      const pattern = unquote(inner);
      if (pattern === void 0) return void 0;
      return (value) => typeof value === "number" ? formatDurationPattern(normaliseDuration(value), pattern) : void 0;
    }
    case "date": {
      const pattern = unquote(inner);
      if (pattern === void 0) return void 0;
      return (value) => typeof value === "string" ? formatDatePattern(value, pattern) : void 0;
    }
    default:
      return void 0;
  }
}
function compilePlain(lower) {
  return (value) => {
    if (typeof value === "string") {
      const fn = stringModifiers[lower];
      return fn ? fn(value) : void 0;
    }
    if (Array.isArray(value)) {
      const fn = arrayModifiers[lower];
      return fn ? fn(value) : void 0;
    }
    if (typeof value === "number") {
      const fn = numberModifiers[lower];
      return fn ? fn(value) : void 0;
    }
    if (typeof value === "boolean") {
      const fn = booleanModifiers[lower];
      return fn ? fn(value) : void 0;
    }
    return void 0;
  };
}
function compileModifier(source) {
  const lower = source.toLowerCase();
  return compileConditional(lower) ?? compileParameterised(source, lower) ?? compilePlain(lower);
}

// packages/core/src/formatters/engine/comparators.ts
var comparatorFunctions = {
  and: (a, b) => a && b,
  or: (a, b) => a || b,
  xor: (a, b) => (a || b) && !(a && b),
  neq: (a, b) => a !== b,
  equal: (a, b) => a === b,
  left: (a) => a,
  right: (_, b) => b
};
var comparatorNames = Object.keys(comparatorFunctions);

// packages/core/src/formatters/engine/parser.ts
var comparators = () => comparatorNames;
var plainModifiers = () => PLAIN_MODIFIERS;
var PLAIN_MODIFIERS = [...allModifierNames].map((name) => name.toLowerCase()).sort((a, b) => b.length - a.length);
var PREFIX_OPERATORS = prefixOperators;
var CALL_MODIFIERS = [
  ["replace", "replaceArgs"],
  ["remove", "loose"],
  ["join", "quoted"],
  ["truncate", "digits"],
  ["slice", "digitsOrPair"],
  ["time", "quoted"],
  ["date", "quoted"],
  ["default", "quoted"],
  ["in", "loose"],
  ["translate", "quotedPair"]
];
var LOOKS_LIKE_EXPRESSION = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*\.\s*[A-Za-z_][A-Za-z0-9_]*/;
var MAX_DIAGNOSTICS = 25;
var MAX_SPAN_SCAN = 4e3;
var NESTED_SAFE_CATEGORIES = /* @__PURE__ */ new Set([
  "unknown-field",
  "unknown-modifier",
  "modifier-arguments"
]);
var Scanner = class {
  constructor(input, pos = 0) {
    this.input = input;
    this.pos = pos;
  }
  input;
  pos;
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
    return this.input.substr(this.pos, literal.length).toLowerCase() === literal.toLowerCase();
  }
  slice(from, to = this.pos) {
    return this.input.slice(from, to);
  }
};
function isIdentifierChar(char) {
  return char !== void 0 && /[A-Za-z0-9_]/.test(char);
}
function scanPrefixArgument(scanner) {
  while (!scanner.atEnd) {
    const char = scanner.peek();
    if (char === "}" || char === "[" || char === "]") break;
    if (char === ":" && scanner.peek(1) === ":") break;
    scanner.pos += 1;
  }
}
function scanQuotedArgument(scanner) {
  const quote = scanner.peek();
  if (quote !== "'" && quote !== '"') return false;
  scanner.pos += 1;
  while (!scanner.atEnd) {
    if (scanner.peek() === quote) {
      const after = scanner.peek(1);
      if (after === void 0 || after === "," || after === ")" || /\s/.test(after)) {
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
  while (scanner.peek() !== void 0 && /\d/.test(scanner.peek())) {
    scanner.pos += 1;
  }
  return scanner.pos > start;
}
function skipSpaces(scanner) {
  while (scanner.peek() !== void 0 && /\s/.test(scanner.peek())) {
    scanner.pos += 1;
  }
}
function scanLooseArgument(scanner) {
  let lastParen = -1;
  while (!scanner.atEnd) {
    const char = scanner.peek();
    if (char === "}" || char === "[" || char === "]") break;
    if (char === ":" && scanner.peek(1) === ":") break;
    if (char === ")") lastParen = scanner.pos;
    scanner.pos += 1;
  }
  if (lastParen === -1) return false;
  scanner.pos = lastParen;
  return true;
}
function scanCallArguments(scanner, shape) {
  if (!scanner.eat("(")) return false;
  switch (shape) {
    case "quoted":
      if (!scanQuotedArgument(scanner)) return false;
      break;
    case "quotedPair":
      if (!scanQuotedArgument(scanner)) return false;
      skipSpaces(scanner);
      if (!scanner.eat(",")) return false;
      skipSpaces(scanner);
      if (!scanQuotedArgument(scanner)) return false;
      break;
    case "replaceArgs":
      if (scanner.peek() === "{") {
        while (!scanner.atEnd && scanner.peek() !== "}") scanner.pos += 1;
        if (!scanner.eat("}")) return false;
      } else if (!scanQuotedArgument(scanner)) {
        return false;
      }
      skipSpaces(scanner);
      if (!scanner.eat(",")) return false;
      skipSpaces(scanner);
      if (!scanQuotedArgument(scanner)) return false;
      break;
    case "digits":
      if (!scanDigits(scanner)) return false;
      break;
    case "digitsOrPair":
      skipSpaces(scanner);
      if (!scanDigits(scanner)) return false;
      skipSpaces(scanner);
      if (scanner.eat(",")) {
        skipSpaces(scanner);
        if (!scanDigits(scanner)) return false;
        skipSpaces(scanner);
      }
      break;
    case "loose":
      return scanLooseArgument(scanner) && scanner.eat(")");
  }
  return scanner.eat(")");
}
function parseModifier(scanner) {
  const start = scanner.pos;
  for (const [name, shape] of CALL_MODIFIERS) {
    if (!scanner.startsWith(`${name}(`)) continue;
    scanner.pos += name.length;
    if (scanCallArguments(scanner, shape)) return scanner.slice(start);
    scanner.pos = start;
    break;
  }
  for (const operator of PREFIX_OPERATORS) {
    if (scanner.startsWith(operator)) {
      scanner.pos += operator.length;
      scanPrefixArgument(scanner);
      return scanner.slice(start);
    }
  }
  for (const name of plainModifiers()) {
    if (!scanner.startsWith(name)) continue;
    const after = scanner.peek(name.length);
    if (isIdentifierChar(after)) continue;
    scanner.pos += name.length;
    return scanner.slice(start);
  }
  scanner.pos = start;
  return void 0;
}
function parseOperandHead(scanner) {
  const start = scanner.pos;
  while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
  let section = scanner.slice(start);
  if (!section || scanner.peek() !== ".") {
    scanner.pos = start;
    return void 0;
  }
  scanner.pos += 1;
  const propertyStart = scanner.pos;
  while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
  let property = scanner.slice(propertyStart);
  if (!property) {
    scanner.pos = start;
    return void 0;
  }
  const canonical = canonicaliseField(section, property);
  if (!canonical) {
    scanner.pos = start;
    return void 0;
  }
  [section, property] = canonical;
  return { section, property };
}
function parseOperand(scanner) {
  let head;
  if (scanner.peek() === "'" || scanner.peek() === '"') {
    const quote = scanner.peek();
    const start = scanner.pos;
    scanner.pos += 1;
    const from = scanner.pos;
    while (!scanner.atEnd && scanner.peek() !== quote) scanner.pos += 1;
    if (scanner.atEnd) {
      scanner.pos = start;
      return void 0;
    }
    const literal = scanner.slice(from);
    scanner.pos += 1;
    head = { section: "", property: "", literal };
  } else {
    head = parseOperandHead(scanner);
  }
  if (!head) return void 0;
  const modifiers = [];
  while (scanner.startsWith("::")) {
    const save = scanner.pos;
    scanner.pos += 2;
    if (comparators().some((c) => scanner.startsWith(`${c}::`))) {
      scanner.pos = save;
      break;
    }
    const modifier = parseModifier(scanner);
    if (modifier === void 0) {
      scanner.pos = save;
      break;
    }
    modifiers.push(modifier);
  }
  return { ...head, modifiers };
}
function parseCheck(scanner, onFail) {
  const start = scanner.pos;
  const fail = (reason) => {
    onFail?.(reason, scanner.pos);
    scanner.pos = start;
    return void 0;
  };
  if (!scanner.eat("[")) return fail("no-open");
  const branch = () => {
    if (!scanner.eat('"')) return void 0;
    let text = "";
    let depth = 0;
    while (!scanner.atEnd) {
      const char = scanner.peek();
      if (char === "\\" && scanner.peek(1) === '"') {
        text += '"';
        scanner.pos += 2;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
      else if (char === '"' && depth === 0) {
        scanner.pos += 1;
        return text;
      }
      text += char;
      scanner.pos += 1;
    }
    return void 0;
  };
  const trueStart = scanner.pos + 1;
  const trueTemplate = branch();
  if (trueTemplate === void 0) return fail("true-branch");
  if (!scanner.eat("||")) return fail("missing-or");
  const falseStart = scanner.pos + 1;
  const falseTemplate = branch();
  if (falseTemplate === void 0) return fail("false-branch");
  let absentTemplate;
  let absentStart;
  if (scanner.startsWith("||")) {
    scanner.pos += 2;
    absentStart = scanner.pos + 1;
    absentTemplate = branch();
    if (absentTemplate === void 0) return fail("absent-branch");
  }
  if (!scanner.eat("]")) return fail("missing-close");
  return {
    trueTemplate,
    falseTemplate,
    trueStart,
    falseStart,
    ...absentTemplate !== void 0 ? { absentTemplate, absentStart } : {}
  };
}
function parseGroupBody(scanner) {
  const start = scanner.pos;
  if (!scanner.eat("{?")) return void 0;
  const from = scanner.pos;
  let depth = 1;
  while (!scanner.atEnd) {
    if (scanner.startsWith("{?")) {
      depth += 1;
      scanner.pos += 2;
      continue;
    }
    if (scanner.startsWith("?}")) {
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
  return void 0;
}
function parseTool(scanner) {
  const start = scanner.pos;
  for (const tool of ["newLine", "removeLine"]) {
    if (scanner.eat(`{tools.${tool}}`)) return { kind: "tool", tool };
    scanner.pos = start;
  }
  return void 0;
}
function parseExpression(scanner) {
  const start = scanner.pos;
  const fail = () => {
    scanner.pos = start;
    return void 0;
  };
  if (!scanner.eat("{")) return fail();
  skipSpaces(scanner);
  const operands = [];
  const found = [];
  const first = parseOperand(scanner);
  if (!first) return fail();
  operands.push(first);
  while (scanner.startsWith("::")) {
    const save = scanner.pos;
    scanner.pos += 2;
    const comparator = comparators().find(
      (name) => scanner.startsWith(`${name}::`)
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
  const check = scanner.peek() === "[" ? parseCheck(scanner) : void 0;
  skipSpaces(scanner);
  if (!scanner.eat("}")) return fail();
  return {
    kind: "expression",
    source: scanner.slice(start),
    operands,
    comparators: found,
    start,
    end: scanner.pos,
    ...check ? { check } : {}
  };
}
function offsetNodes(nodes, delta) {
  for (const node of nodes) {
    if (node.start !== void 0) node.start += delta;
    if (node.end !== void 0) node.end += delta;
    if (node.kind === "group") offsetNodes(node.nodes, delta);
    if (node.kind === "expression" && node.check) {
      const c = node.check;
      if (c.trueStart !== void 0) c.trueStart += delta;
      if (c.falseStart !== void 0) c.falseStart += delta;
      if (c.absentStart !== void 0) c.absentStart += delta;
    }
  }
}
function parseTemplate(template) {
  const scanner = new Scanner(template);
  const nodes = [];
  const diagnostics = [];
  let literalStart = 0;
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
    if (scanner.peek() !== "{") {
      scanner.pos += 1;
      continue;
    }
    const braceIndex = scanner.pos;
    if (scanner.startsWith("{?")) {
      const body = parseGroupBody(scanner);
      if (body !== void 0) {
        flushLiteral(braceIndex);
        const inner = parseTemplate(body);
        const offset = braceIndex + 2;
        diagnostics.push(
          ...inner.diagnostics.map((d) => ({ ...d, index: d.index + offset }))
        );
        offsetNodes(inner.nodes, offset);
        nodes.push({
          kind: "group",
          nodes: inner.nodes,
          start: braceIndex,
          end: scanner.pos
        });
        literalStart = scanner.pos;
        continue;
      }
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push({
          index: braceIndex,
          message: "unterminated group: no matching `?}`",
          source: template.slice(braceIndex, braceIndex + 2),
          category: "unterminated-group"
        });
      }
    }
    const node = parseTool(scanner) ?? parseExpression(scanner);
    if (!node) {
      const closing = template.indexOf("}", braceIndex);
      const inner = closing === -1 ? "" : template.slice(braceIndex + 1, closing);
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        const diagnostic = diagnoseSpan(template, braceIndex);
        const nested = braceIndex < recoveringUntil;
        if (diagnostic && (!nested || NESTED_SAFE_CATEGORIES.has(diagnostic.category))) {
          diagnostics.push(diagnostic);
        }
      }
      recoveringUntil = Math.max(
        recoveringUntil,
        matchBrace(template, braceIndex).end
      );
      if (!inner.includes("{") && LOOKS_LIKE_EXPRESSION.test(inner)) {
        flushLiteral(braceIndex);
        nodes.push({
          kind: "raw",
          text: `{invalid_expression(${inner.trim()})}`,
          start: braceIndex,
          end: closing + 1
        });
        scanner.pos = closing + 1;
        literalStart = scanner.pos;
        continue;
      }
      scanner.pos = braceIndex + 1;
      continue;
    }
    flushLiteral(braceIndex);
    if (node.start === void 0) node.start = braceIndex;
    if (node.end === void 0) node.end = scanner.pos;
    nodes.push(node);
    literalStart = scanner.pos;
  }
  flushLiteral(template.length);
  return { nodes, diagnostics };
}
var ARGUMENT_EXAMPLES = {
  quoted: "('text')",
  quotedPair: "('from', 'to')",
  replaceArgs: "('find', 'replaceWith')",
  digits: "(3)",
  digitsOrPair: "(0, 3)",
  loose: "('a', 'b')"
};
function matchBrace(template, braceIndex) {
  let depth = 0;
  const limit = Math.min(template.length, braceIndex + MAX_SPAN_SCAN);
  for (let i = braceIndex; i < limit; i++) {
    const char = template[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { end: i, terminated: true };
    }
  }
  return { end: limit, terminated: false };
}
function knownModifierNames() {
  return [
    .../* @__PURE__ */ new Set([...plainModifiers(), ...CALL_MODIFIERS.map(([name]) => name)])
  ];
}
function isKnownModifier(token) {
  return knownModifierNames().includes(token.toLowerCase());
}
function diagnoseSpan(template, braceIndex) {
  const { end, terminated } = matchBrace(template, braceIndex);
  const source = template.slice(braceIndex, terminated ? end + 1 : end);
  const inner = terminated ? source.slice(1, -1) : source.slice(1);
  if (!LOOKS_LIKE_EXPRESSION.test(inner)) return void 0;
  const at = (category, message, suggestion) => ({
    index: braceIndex,
    message,
    source,
    category,
    ...suggestion ? { suggestion } : {}
  });
  const badArguments = (token) => {
    const lower = token.toLowerCase();
    const call = CALL_MODIFIERS.find(([name]) => name === lower);
    return at(
      "modifier-arguments",
      call ? `modifier \`${token}\` has invalid arguments; expected \`${lower}${ARGUMENT_EXAMPLES[call[1]]}\`` : `modifier \`${token}\` takes no arguments`
    );
  };
  const scanner = new Scanner(source);
  scanner.eat("{");
  skipSpaces(scanner);
  const checkHead = () => {
    const headStart = scanner.pos;
    while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
    const section = scanner.slice(headStart);
    if (!section || scanner.peek() !== ".") {
      scanner.pos = headStart;
      return void 0;
    }
    scanner.pos += 1;
    const propertyStart = scanner.pos;
    while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
    const property = scanner.slice(propertyStart);
    if (!property || canonicaliseField(section, property)) return void 0;
    const suggestions = suggestField(section, property);
    const hint = suggestions.length ? ` \u2014 did you mean \`${suggestions.join("` or `")}\`?` : "";
    return at(
      "unknown-field",
      `unknown field \`${section}.${property}\`${hint}`,
      suggestions[0]
    );
  };
  const checkModifiers = () => {
    while (scanner.startsWith("::")) {
      const save = scanner.pos;
      scanner.pos += 2;
      if (comparators().some((c) => scanner.startsWith(`${c}::`))) {
        scanner.pos = save;
        return void 0;
      }
      const modifierStart = scanner.pos;
      if (parseModifier(scanner)) {
        if (scanner.peek() === "(") {
          return badArguments(scanner.slice(modifierStart));
        }
        continue;
      }
      if (PREFIX_OPERATORS.some((operator) => scanner.startsWith(operator))) {
        scanner.pos = save;
        return void 0;
      }
      const tokenStart = scanner.pos;
      while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
      const token = scanner.slice(tokenStart);
      if (!token) return void 0;
      if (isKnownModifier(token)) return badArguments(token);
      const close = nearestName(token.toLowerCase(), knownModifierNames());
      return at(
        "unknown-modifier",
        `unknown modifier \`${token}\`${close ? ` \u2014 did you mean \`${close}\`?` : ""}`
      );
    }
    return void 0;
  };
  for (; ; ) {
    const head = checkHead();
    if (head) return head;
    const modifier = checkModifiers();
    if (modifier) return modifier;
    if (!scanner.startsWith("::")) break;
    const save = scanner.pos;
    scanner.pos += 2;
    const comparator = comparators().find((c) => scanner.startsWith(`${c}::`));
    if (!comparator) {
      scanner.pos = save;
      break;
    }
    scanner.pos += comparator.length + 2;
  }
  if (scanner.peek() === "[") {
    let failure;
    parseCheck(scanner, (reason, position) => {
      failure ??= { reason, at: position };
    });
    if (failure) {
      const message = describeCheckFailure(source, failure.reason, failure.at);
      if (message) return at("conditional", message);
    }
  }
  if (!terminated) {
    return at("unterminated", "unterminated expression: no closing `}`");
  }
  return at("unparseable", `unparseable expression: {${inner}}`);
}
function describeCheckFailure(source, reason, at) {
  if (reason === "no-open") return void 0;
  if (reason === "missing-close") {
    return "conditional is missing its closing `]`";
  }
  if (reason === "missing-or") {
    return "conditional branches must be separated by `||`";
  }
  if (at >= source.length) {
    return 'unterminated conditional branch: a nested `{` is missing its `}`, or the branch is missing its closing `"`';
  }
  if (source[at] === "\\" && source[at + 1] === '"') {
    return 'conditional branch starts with an escaped quote `\\"` \u2014 escapes only apply one nesting level deeper';
  }
  return 'conditional branch must start with `"`';
}
function tokenize(template) {
  const out = [];
  tokenizeRegion(template, 0, template.length, IDENTITY, 0, out);
  out.sort((a, b) => a.start - b.start);
  return out;
}
var IDENTITY = (index) => index;
function pushToken(out, map, from, to, kind, depth) {
  if (to <= from) return;
  const start = map(from);
  const end = map(to - 1) + 1;
  if (end > start) out.push({ start, end, kind, depth });
}
function matchToolSpan(template, index, to) {
  for (const tool of ["{tools.newline}", "{tools.removeline}"]) {
    const end = index + tool.length;
    if (end <= to && template.slice(index, end).toLowerCase() === tool)
      return end;
  }
  return void 0;
}
function matchGroupSpan(template, index, to) {
  let pos = index + 2;
  let depth = 1;
  while (pos < to) {
    if (template.startsWith("{?", pos)) {
      depth += 1;
      pos += 2;
      continue;
    }
    if (template.startsWith("?}", pos)) {
      depth -= 1;
      if (depth === 0) return { bodyEnd: pos, end: pos + 2 };
      pos += 2;
      continue;
    }
    pos += 1;
  }
  return void 0;
}
function tokenizeRegion(text, from, to, map, depth, out) {
  let pos = from;
  let textStart = from;
  const flush = (end) => pushToken(out, map, textStart, end, "text", depth);
  while (pos < to) {
    if (text[pos] !== "{") {
      pos += 1;
      continue;
    }
    const braceIndex = pos;
    const toolEnd = matchToolSpan(text, braceIndex, to);
    if (toolEnd !== void 0) {
      flush(braceIndex);
      pushToken(out, map, braceIndex, toolEnd, "tool", depth);
      pos = toolEnd;
      textStart = pos;
      continue;
    }
    if (text.startsWith("{?", braceIndex)) {
      const group = matchGroupSpan(text, braceIndex, to);
      if (group !== void 0) {
        flush(braceIndex);
        pushToken(out, map, braceIndex, braceIndex + 2, "group-brace", depth);
        tokenizeRegion(
          text,
          braceIndex + 2,
          group.bodyEnd,
          map,
          depth + 1,
          out
        );
        pushToken(out, map, group.bodyEnd, group.end, "group-brace", depth);
        pos = group.end;
        textStart = pos;
        continue;
      }
    }
    const probe = new Scanner(text, braceIndex);
    const node = parseExpression(probe);
    if (node && probe.pos <= to) {
      flush(braceIndex);
      tokenizeExpression(text, braceIndex, probe.pos, map, depth, out);
      pos = probe.pos;
      textStart = pos;
      continue;
    }
    flush(braceIndex);
    const matched = matchBrace(text, braceIndex);
    const invalidEnd = Math.min(
      matched.terminated ? matched.end + 1 : matched.end,
      to
    );
    if (invalidEnd > braceIndex) {
      pushToken(out, map, braceIndex, invalidEnd, "invalid", depth);
      pos = invalidEnd;
    } else {
      pos = braceIndex + 1;
    }
    textStart = pos;
  }
  flush(to);
}
function tokenizeExpression(text, start, end, map, depth, out) {
  const scanner = new Scanner(text, start + 1);
  pushToken(out, map, start, start + 1, "brace", depth);
  skipSpaces(scanner);
  tokenizeOperand(scanner, end, map, depth, out);
  while (scanner.pos < end && scanner.startsWith("::")) {
    const save = scanner.pos;
    scanner.pos += 2;
    const comparator = comparators().find((c) => scanner.startsWith(`${c}::`));
    if (!comparator) {
      scanner.pos = save;
      break;
    }
    const cStart = save + 2;
    pushToken(out, map, save, cStart, "separator", depth);
    pushToken(
      out,
      map,
      cStart,
      cStart + comparator.length,
      "comparator",
      depth
    );
    pushToken(
      out,
      map,
      cStart + comparator.length,
      cStart + comparator.length + 2,
      "separator",
      depth
    );
    scanner.pos = cStart + comparator.length + 2;
    tokenizeOperand(scanner, end, map, depth, out);
  }
  if (scanner.pos < end && scanner.peek() === "[") {
    tokenizeCheck(scanner, end, map, depth, out);
  }
  if (text[end - 1] === "}") {
    pushToken(out, map, end - 1, end, "brace", depth);
  }
}
function tokenizeOperand(scanner, end, map, depth, out) {
  const lead = scanner.peek();
  if (lead === "'" || lead === '"') {
    const litStart = scanner.pos;
    scanner.pos += 1;
    while (scanner.pos < end && scanner.peek() !== lead) scanner.pos += 1;
    if (scanner.peek() === lead) scanner.pos += 1;
    pushToken(out, map, litStart, scanner.pos, "literal", depth);
  } else {
    const secStart = scanner.pos;
    while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
    pushToken(out, map, secStart, scanner.pos, "section", depth);
    if (scanner.peek() === ".") {
      pushToken(out, map, scanner.pos, scanner.pos + 1, "dot", depth);
      scanner.pos += 1;
      const propStart = scanner.pos;
      while (isIdentifierChar(scanner.peek())) scanner.pos += 1;
      pushToken(out, map, propStart, scanner.pos, "property", depth);
    }
  }
  while (scanner.pos < end && scanner.startsWith("::")) {
    const save = scanner.pos;
    scanner.pos += 2;
    if (comparators().some((cmp) => scanner.startsWith(`${cmp}::`))) {
      scanner.pos = save;
      break;
    }
    pushToken(out, map, save, save + 2, "separator", depth);
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
      pushToken(out, map, start, nameEnd, "modifier", depth);
      pushToken(out, map, argStart, scanner.pos, "call-args", depth);
      return;
    }
    scanner.pos = start;
    break;
  }
  for (const operator of PREFIX_OPERATORS) {
    if (!scanner.startsWith(operator)) continue;
    const opEnd = start + operator.length;
    pushToken(out, map, start, opEnd, "prefix-op", depth);
    scanner.pos = opEnd;
    const argStart = scanner.pos;
    scanPrefixArgument(scanner);
    pushToken(out, map, argStart, scanner.pos, "call-args", depth);
    return;
  }
  for (const name of plainModifiers()) {
    if (!scanner.startsWith(name)) continue;
    if (isIdentifierChar(scanner.peek(name.length))) continue;
    pushToken(out, map, start, start + name.length, "modifier", depth);
    scanner.pos = start + name.length;
    return;
  }
}
function tokenizeCheck(scanner, end, map, depth, out) {
  pushToken(out, map, scanner.pos, scanner.pos + 1, "bracket", depth);
  scanner.pos += 1;
  for (let branch = 0; branch < 3; branch++) {
    tokenizeBranch(scanner, end, map, depth, out);
    if (!scanner.startsWith("||")) break;
    pushToken(out, map, scanner.pos, scanner.pos + 2, "pipe", depth);
    scanner.pos += 2;
  }
  if (scanner.peek() === "]") {
    pushToken(out, map, scanner.pos, scanner.pos + 1, "bracket", depth);
    scanner.pos += 1;
  }
}
function tokenizeBranch(scanner, end, map, depth, out) {
  if (scanner.peek() !== '"') return;
  pushToken(out, map, scanner.pos, scanner.pos + 1, "quote", depth);
  scanner.pos += 1;
  let branchText = "";
  const localToText = [];
  let braceDepth = 0;
  while (scanner.pos < end) {
    const char = scanner.peek();
    if (char === "\\" && scanner.peek(1) === '"') {
      localToText.push(scanner.pos);
      branchText += '"';
      scanner.pos += 2;
      continue;
    }
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === '"' && braceDepth === 0) break;
    localToText.push(scanner.pos);
    branchText += char;
    scanner.pos += 1;
  }
  const contentEnd = scanner.pos;
  const branchMap = (i) => map(i >= 0 && i < localToText.length ? localToText[i] : contentEnd);
  tokenizeRegion(branchText, 0, branchText.length, branchMap, depth + 1, out);
  if (scanner.peek() === '"') {
    pushToken(out, map, contentEnd, contentEnd + 1, "quote", depth);
    scanner.pos += 1;
  }
}

// packages/core/src/formatters/engine/compile.ts
var MAX_TEMPLATE_DEPTH = 5;
function prepareOperand(node) {
  return {
    node,
    modifiers: node.modifiers.map((source) => ({
      source,
      apply: compileModifier(source)
    }))
  };
}
function resolveOperand(operand, parseValue, hooks) {
  if (operand.node.literal !== void 0) {
    const ctx2 = {
      resolveVariable: (source) => hooks.resolveVariable(source, parseValue)
    };
    let value = operand.node.literal;
    for (const { apply } of operand.modifiers) {
      const next = apply(value, parseValue, ctx2);
      if (next === void 0) break;
      value = next;
    }
    return { result: value, present: true };
  }
  const section = parseValue[operand.node.section];
  if (!section) {
    return { error: `{unknown_variableType(${operand.node.section})}` };
  }
  const property = section[operand.node.property];
  if (property === void 0) {
    return {
      error: `{unknown_propertyName(${operand.node.section}.${operand.node.property})}`
    };
  }
  const ctx = {
    resolveVariable: (source) => hooks.resolveVariable(source, parseValue)
  };
  let result = property;
  if (typeof property === "string") {
    result = sanitise(property);
  } else if (Array.isArray(property) && property.some((item) => typeof item === "string" && hasSentinel(item))) {
    result = property.map(
      (item) => typeof item === "string" ? sanitise(item) : item
    );
  }
  const present = isPresent(property) || operand.modifiers.some(
    ({ source }) => source.toLowerCase().startsWith("default(")
  );
  for (const { source, apply } of operand.modifiers) {
    const input = result;
    result = apply(input, parseValue, ctx);
    if (result !== void 0) continue;
    if (input === null || input === void 0) return { result: "", present };
    return {
      error: `{unknown_${Array.isArray(input) ? "array" : typeof input}_modifier(${source})}`
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
    present = node.comparators[i - 1] === "or" ? present || next : present && next;
  }
  const allSame = node.comparators.every((c) => c === node.comparators[0]);
  const canShortCircuit = allSame && (node.comparators[0] === "and" || node.comparators[0] === "or");
  let result = resolveOperand(operands[0], parseValue, hooks);
  for (let i = 1; i < operands.length; i++) {
    if (result.error !== void 0) return result;
    const comparator = node.comparators[i - 1];
    if (canShortCircuit) {
      if (comparator === "and" && result.result === false)
        return { result: false, present };
      if (comparator === "or" && result.result === true)
        return { result: true, present };
    }
    const next = resolveOperand(operands[i], parseValue, hooks);
    if (next.error !== void 0) return next;
    try {
      result = {
        result: hooks.comparators[comparator](result.result, next.result)
      };
    } catch (error) {
      return {
        error: `{unable_to_compare(<${result.result}>::${comparator}::<${next.result}>, ${error})}`
      };
    }
  }
  return { result: result.result, present };
  function operandPresence(operand) {
    if (operand.node.literal !== void 0) return true;
    if (operand.modifiers.some(
      ({ source }) => source.toLowerCase().startsWith("default(")
    ))
      return true;
    const section = parseValue[operand.node.section];
    return section ? isPresent(section[operand.node.property]) : false;
  }
}
function compileNode(node, hooks, depth) {
  if (node.kind === "raw") {
    const text = node.text.replace(/\\n/g, "\n");
    return () => text;
  }
  if (node.kind === "tool") {
    const sentinel = node.tool === "newLine" ? NEW_LINE_SENTINEL : REMOVE_LINE_SENTINEL;
    return () => sentinel;
  }
  if (node.kind === "group") return compileGroup(node, hooks, depth);
  const operands = node.operands.map(prepareOperand);
  if (!node.check) {
    return (parseValue) => {
      const resolved = resolveExpression(node, operands, parseValue, hooks);
      return resolved.error ?? String(resolved.result ?? "");
    };
  }
  const whenTrue = compileTemplate(node.check.trueTemplate, hooks, depth + 1);
  const whenFalse = compileTemplate(node.check.falseTemplate, hooks, depth + 1);
  const whenAbsent = node.check.absentTemplate === void 0 ? void 0 : compileTemplate(node.check.absentTemplate, hooks, depth + 1);
  return (parseValue) => {
    const resolved = resolveExpression(node, operands, parseValue, hooks);
    if (resolved.error !== void 0) return resolved.error;
    if (!isPresent(resolved.result)) {
      return whenAbsent ? whenAbsent(parseValue) : "";
    }
    if (resolved.result !== true && resolved.result !== false) {
      return `{cannot_coerce_boolean_for_check_from(${resolved.result})}`;
    }
    return resolved.result ? whenTrue(parseValue) : whenFalse(parseValue);
  };
}
function isPresent(value) {
  if (value === void 0 || value === null) return false;
  if (typeof value === "string") return /\S/.test(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
function compileGroup(node, hooks, depth) {
  const parts = node.nodes.map((child) => ({
    node: child,
    render: compileNode(child, hooks, depth),
    // a check produces output either way, so it never suppresses the group
    operands: child.kind === "expression" && !child.check ? child.operands.map(prepareOperand) : void 0
  }));
  return (parseValue) => {
    let out = "";
    for (const { node: child, render, operands } of parts) {
      if (operands) {
        const resolved = resolveExpression(
          child,
          operands,
          parseValue,
          hooks
        );
        if (resolved.error === void 0 && resolved.present === false)
          return "";
      }
      out += render(parseValue);
    }
    return out;
  };
}
function evaluateExpression(node, parseValue, hooks) {
  const operands = node.operands.map(prepareOperand);
  return resolveExpression(node, operands, parseValue, hooks);
}
function compileTemplate(template, hooks, depth = 0) {
  if (depth > MAX_TEMPLATE_DEPTH) {
    hooks.onDepthExceeded?.(MAX_TEMPLATE_DEPTH);
    return () => template;
  }
  let source = template;
  for (const [key, replacement] of Object.entries(hooks.debugMacros ?? {})) {
    source = source.replace(`{debug.${key}}`, replacement);
  }
  const { nodes } = parseTemplate(source);
  const compiled = nodes.map((node) => compileNode(node, hooks, depth));
  if (compiled.length === 1) return compiled[0];
  return (parseValue) => {
    let out = "";
    for (const render of compiled) out += render(parseValue);
    return out;
  };
}

// packages/core/src/utils/formatter-definitions.ts
var BUILTIN_FORMATTER_DEFINITIONS = {
  torrentio: {
    name: `{stream.proxied::istrue["\u{1F575}\uFE0F\u200D\u2642\uFE0F "||""]}{stream.private::istrue["\u{1F511} "||""]}{stream.type::=p2p["[P2P] "||""]}{service.id::exists["[{service.shortName}"||""]}{service.cached::istrue["+] "||""]}{service.cached::isfalse[" download] "||""]}{addon.name} {stream.resolution::exists["{stream.resolution}"||"Unknown"]}
{?{stream.visualTags::join(' | ')}?}`,
    description: `{?\u2139\uFE0F{stream.message}?}
{?{stream.folderName}?}
{?{stream.filename}?}
{stream.size::>0["\u{1F4BE}{stream.size::bytes2} "||""]}{stream.folderSize::>0["/ \u{1F4BE}{stream.folderSize::bytes2}"||""]}{stream.seeders::>=0["\u{1F464}{stream.seeders} "||""]}{?\u{1F4C5}{stream.age} ?}{?\u2699\uFE0F{stream.indexer}?}
{?{stream.languageEmojis::join(' / ')}?}{stream.subtitles::exists::and::stream.languageEmojis::exists[" "||""]}{stream.subtitles::exists["Subs / {stream.subtitleEmojis::join(' / ')}"||""]}
`
  },
  torbox: {
    name: `{stream.proxied::istrue["\u{1F575}\uFE0F\u200D\u2642\uFE0F "||""]}{stream.private::istrue["\u{1F511} "||""]}{stream.type::=p2p["[P2P] "||""]}{addon.name}{stream.library::istrue[" (Your Media) "||""]}{service.cached::istrue[" (Instant "||""]}{service.cached::isfalse[" ("||""]}{service.id::exists["{service.shortName})"||""]}{? ({stream.resolution})?}`,
    description: `Quality: {stream.quality::exists["{stream.quality}"||"Unknown"]}
Name: {stream.filename::exists["{stream.filename}"||"Unknown"]}
Size: {stream.size::>0["{stream.size::bytes} "||""]}{stream.folderSize::>0["/ {stream.folderSize::bytes} "||""]}{?| Source: {stream.indexer} ?}{stream.duration::>0["| Duration: {stream.duration::time} "||""]}
Languages: {?{stream.languages::join(', ')}?}{stream.subtitles::exists::and::stream.languages::exists[" | "||""]}{?Subtitles: {stream.subtitles::join(', ')}?}
{?Message: {stream.message}?}`
  },
  gdrive: {
    name: `{stream.proxied::istrue["\u{1F575}\uFE0F "||""]}{stream.private::istrue["\u{1F511} "||""]}{stream.type::=p2p["[P2P] "||""]}{?[{service.shortName}?}{service.cached::istrue["\u26A1] "||""]}{service.cached::isfalse["\u23F3] "||""]}{addon.name}{stream.library::istrue[" (Your Media)"||""]} {?{stream.resolution}?}{stream.seadexBest::istrue[" (Best)"||""]}{stream.seadex::istrue::and::stream.seadexBest::isfalse[" (SeaDex Alt.)"||""]}{stream.rseMatched::exists::and::stream.seadex::isfalse::and::stream.rseMatched::string::~T1::or::stream.rseMatched::string::~T2::or::stream.rseMatched::string::~T3::or::stream.rseMatched::string::~T4::or::stream.rseMatched::string::~T5::or::stream.rseMatched::string::~T6::or::stream.rseMatched::string::~T7::or::stream.rseMatched::string::~T8[" ({stream.rseMatched::first})"||""]}{stream.regexMatched::exists::and::stream.rseMatched::exists::isfalse::and::stream.seadex::isfalse[" ({stream.regexMatched})"||""]}`,
    description: `{?\u{1F3A5} {stream.quality} ?}{?\u{1F39E}\uFE0F {stream.encode} ?}{?\u{1F3F7}\uFE0F {stream.releaseGroup} ?}{?\u{1F4E1} {stream.network} ?}
{?\u{1F4FA} {stream.visualTags::join(' | ')} ?}{?\u{1F3A7} {stream.audioTags::join(' | ')} ?}{?\u{1F50A} {stream.audioChannels::join(' | ')}?}
{stream.size::>0["\u{1F4E6} {stream.size::sbytes} "||""]}{stream.folderSize::>0["/ {stream.folderSize::sbytes} "||""]}{stream.bitrate::>0["({stream.bitrate::sbitrate})"||""]}{stream.duration::>0["\u23F1\uFE0F {stream.duration::time} "||""]}{stream.seeders::>0["\u{1F465} {stream.seeders} "||""]}{?\u{1F4C5} {stream.age} ?}{?\u{1F50D} {stream.indexer}?}
{?\u{1F30E} {stream.languages::join(' | ')}?}{?\u{1F4DD} {stream.subtitles::join(' | ')}?}
{stream.filename::exists["\u{1F4C1}"||""]} {?{stream.folderName}/?}{?{stream.filename}?}
{?\u2139\uFE0F {stream.message}?}
      `
  },
  lightgdrive: {
    name: `{stream.proxied::istrue["\u{1F575}\uFE0F "||""]}{stream.private::istrue["\u{1F511} "||""]}{stream.type::=p2p["[P2P] "||""]}{?[{service.shortName}?}{stream.library::istrue["\u2601\uFE0F"||""]}{service.cached::istrue["\u26A1] "||""]}{service.cached::isfalse["\u23F3] "||""]}{addon.name}{? {stream.resolution}?}{stream.seadexBest::istrue[" (Best)"||""]}{stream.seadex::istrue::and::stream.seadexBest::isfalse[" (SeaDex Alt.)"||""]}{stream.rseMatched::exists::and::stream.seadex::isfalse::and::stream.rseMatched::string::~T1::or::stream.rseMatched::string::~T2::or::stream.rseMatched::string::~T3::or::stream.rseMatched::string::~T4::or::stream.rseMatched::string::~T5::or::stream.rseMatched::string::~T6::or::stream.rseMatched::string::~T7::or::stream.rseMatched::string::~T8[" ({stream.rseMatched::first})"||""]}{stream.regexMatched::exists::and::stream.rseMatched::exists::isfalse::and::stream.seadex::isfalse[" ({stream.regexMatched})"||""]}`,
    description: `{?\u{1F4C1} {stream.title::title}?}{? ({stream.year})?}{? {stream.seasonEpisode::join(' \u2022 ')}?}
{?\u{1F3A5} {stream.quality} ?}{?\u{1F39E}\uFE0F {stream.encode} ?}{?\u{1F3F7}\uFE0F {stream.releaseGroup}?}{?\u{1F4E1} {stream.network} ?}
{?\u{1F4FA} {stream.visualTags::join(' \u2022 ')} ?}{?\u{1F3A7} {stream.audioTags::join(' \u2022 ')} ?}{?\u{1F50A} {stream.audioChannels::join(' \u2022 ')}?}
{stream.size::>0["\u{1F4E6} {stream.size::sbytes} "||""]}{stream.folderSize::>0["/ {stream.folderSize::sbytes} "||""]}{stream.duration::>0["\u23F1\uFE0F {stream.duration::time} "||""]}{?\u{1F4C5} {stream.age} ?}{?\u{1F50D} {stream.indexer}?}
{?\u{1F310} {stream.languageEmojis::join(' / ')}?}{stream.subtitles::exists["\u{1F4DD} {stream.subtitleEmojis::join(' / ')}"||""]}
{?\u2139\uFE0F {stream.message}?}`
  },
  minimalisticgdrive: {
    name: `{stream.resolution::exists["{stream.resolution::replace('2160p','\u2728 4K')::replace('1440p','\u{1F4C0} 2K')::replace('1080p','\u{1F9FF}1080p')::replace('720p','\u{1F4BF}720p')}"||"N/A"]}{service.cached::istrue[" \u{1F3AB} "||""]}{service.cached::isfalse[" \u{1F39F}\uFE0F "||""]}
{?{stream.quality::upper}?}
`,
    description: `{?\u{1F506} {stream.visualTags::join(' \u2022 ')}  ?}{?\u{1F50A} {stream.audioTags::join(' \u2022 ')}?}
{stream.size::>0["\u{1F4E6} {stream.size::sbytes} "||""]}
{?\u{1F30E} {stream.languages::join(' \u2022 ')}?}{?\u{1F4DD} {stream.subtitles::join(' \u2022 ')}?}
`
  },
  prism: {
    name: `{stream.resolution::exists["{stream.resolution::replace('2160p', '\u{1F525}4K UHD')::replace('1440p','\u2728 QHD')::replace('1080p','\u{1F680} FHD')::replace('720p','\u{1F4BF} HD')::replace('576p','\u{1F4A9} Low Quality')::replace('480p','\u{1F4A9} Low Quality')::replace('360p','\u{1F4A9} Low Quality')::replace('240p','\u{1F4A9} Low Quality')::replace('144p','\u{1F4A9} Low Quality')}"||"\u{1F4A9} Unknown"]}`,
    description: `{?\u{1F3AC} {stream.title::title} ?}{?({stream.year}) ?}{?\u{1F342} {stream.formattedSeasons} ?}{?\u{1F39E}\uFE0F {stream.formattedEpisodes}?}{stream.seadexBest::istrue["\u{1F39A}\uFE0F Best "||""]}{stream.seadex::istrue::and::stream.seadexBest::isfalse["\u{1F39A}\uFE0F Alternative"||""]}{stream.rseMatched::exists::and::stream.seadex::isfalse::and::stream.rseMatched::string::~T1::or::stream.rseMatched::string::~T2::or::stream.rseMatched::string::~T3::or::stream.rseMatched::string::~T4::or::stream.rseMatched::string::~T5::or::stream.rseMatched::string::~T6::or::stream.rseMatched::string::~T7::or::stream.rseMatched::string::~T8[" \u{1F39A}\uFE0F {stream.rseMatched::first}"||""]}{stream.regexMatched::exists::and::stream.rseMatched::exists::isfalse::and::stream.seadex::isfalse["\u{1F39A}\uFE0F {stream.regexMatched} "||""]}
{?\u{1F3A5} {stream.quality} ?}{?\u{1F4FA} {stream.visualTags::join(' | ')} ?}{?\u{1F39E}\uFE0F {stream.encode} ?}{stream.duration::>0["\u23F1\uFE0F {stream.duration::time} "||""]}
{?\u{1F3A7} {stream.audioTags::join(' | ')} ?}{?\u{1F50A} {stream.audioChannels::join(' | ')} ?}{stream.languages::exists["\u{1F5E3}\uFE0F {stream.languageEmojis::join(' / ')}"||""]}{stream.subtitles::exists["\u{1F4DD} {stream.subtitleEmojis::join(' / ')}"||""]}
{stream.size::>0["\u{1F4E6} {stream.size::sbytes} "||""]}{stream.folderSize::>0["/ {stream.folderSize::sbytes} "||""]}{stream.bitrate::>0["\u{1F4CA} {stream.bitrate::sbitrate} "||""]}{service.cached::isfalse::or::stream.type::=p2p::and::stream.seeders::>0["\u{1F331} {stream.seeders} "||""]}{stream.type::=usenet::and::stream.age::exists["\u{1F4C5} {stream.age} "||""]}
{?\u{1F3F7}\uFE0F {stream.releaseGroup} ?}{?\u{1F4E1} {stream.indexer} ?}{?\u{1F3AD} {stream.network}?}
{service.cached::istrue["\u26A1Ready "||""]}{service.cached::isfalse["\u274C Not Ready "||""]}{service.id::exists["({service.shortName}) "||""]}{stream.library::istrue["\u{1F4CC} Library "||""]}{stream.type::=Usenet["\u{1F4F0} Usenet "||""]}{stream.type::=p2p["\u26A0\uFE0F P2P "||""]}{stream.type::=http["\u{1F4BB} Web Link "||""]}{stream.type::=youtube["\u25B6\uFE0F Youtube "||""]}{stream.type::=live["\u{1F4FA} Live "||""]}{stream.proxied::istrue["\u{1F512} Proxied "||""]}{stream.private::istrue["\u{1F511} Private "||""]}\u{1F50D}{addon.name} 
{?\u2139\uFE0F {stream.message}?}
`
  },
  tamtaro: {
    name: `{stream.resolution::exists["{stream.resolution::replace('2160p','\xA0\xA0\xA04K\xA0')::replace('1440p','\xA0\xA0\xA0\xA02K\xA0')::replace('p','P')}\u200D"||"\u200D\xA0\xA0\xA0\xA0\xA0"]}{?\u200D{stream.type::replace('debrid','\xA0\xA0\xA0\xA0')::replace('p2p','\u207D\u1D56\xB2\u1D56\u207E')::replace('live','\u207D\u02E1\u1DA6\u1D5B\u1D49\u207E')::replace('http','\u207D\u02B7\u1D49\u1D47\u207E')::replace('usenet','\u200D\u207D\u207F\u1DBB\u1D47\u207E\u200D')::replace('stremio-usenet','\u200F\u207D\u207F\u1DBB\u1D47\u207E')::replace('info','\u207D\u1DA6\u207F\u1DA0\u1D52\u207E')::replace('statistic','\u207D\u02E2\u1D57\u1D43\u1D57\u02E2\u207E')::replace('external','\u207D\u1D49\u02E3\u1D57\u207E')::replace('error','\u207D\u1D49\u02B3\u02B3\u1D52\u02B3\u207E')::replace('youtube','\u207D\u02B8\u1D57\u207E')}\u200D\u200D\u200D?}{service.cached["\u26A1"||"\u200D\u23F3\u200D\u200B"||""]}{?\u200D\u200D
\xA0\xA0\u2329{stream.quality::title::replace('Bluray Remux','Remux')::replace('Web-dl','Web\u200D-\u200Ddl')::replace('Hc Hd-rip','HC\xA0HDRip')::replace('Hdrip','HDRip')}\u232A\u200D\xA0\xA0\xA0\xA0\xA0?}{stream.message::~Download["{tools.removeLine}
"||""]}{?\u200D
\xA0\xA0{stream.nSeScore::star::replace('\u2BEA','\u2606')}\xA0\xA0\xA0\xA0\xA0\xA0\xA0\xA0\xA0\xA0\xA0\xA0?}{stream.message::~Download["{tools.removeLine}
"||""]}`,
    description: `{stream.title::exists["{stream.library[\\"\u2601\uFE0E  {stream.title::title::truncate(15)} \\"||\\"\u270E  {stream.title::title::truncate(15)}\\"||\\"\\"]}"||""]}{stream.year::exists::and::stream.episodes::exists::isfalse::and::stream.seasons::exists::isfalse[" ({stream.year})"||""]}{?  {stream.seasonEpisode::join('\xB7')::replace('E','\u1D07')::replace('S','s')::translate('0123456789','\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089')}?}
{stream.visualTags::=IMAX["{tools.removeLine}
"||"{tools.removeLine}
"]}{?\u25A3  {stream.encode}  ?}{stream.visualTags::exists::and::stream.visualTags::=IMAX::isfalse["{stream.visualTags::in('DV','HDR','HDR10','HDR10+')[\\"\u2726  \\"||\\"\u2727  \\"]}{stream.visualTags::sort::join(' \xB7 ')::replace('HDR \xB7 HDR','HDR')::replace(' \xB7 IMAX','')} "||""]}
{?\u266C  {stream.audioTags::lsort::join(' \xB7 ')::replace('DD \xB7 DD','DD')::replace('DTS \xB7 DTS','DTS')}  ?}{?\u266F  {stream.audioChannels::join(' \xB7 ')} ?}
{stream.size::>0["{stream.seasonPack[\\"\u2756  \\"||\\"\u25C8  \\"||\\"\\"]}"||""]}{stream.size::>0["{stream.size::sbytes}"||""]}{stream.folderSize::>0["/{stream.folderSize::sbytes}"||""]}{? \xB7 {stream.bitrate::sbitrate::replace('Mbps','\u1D39\u1D47\u1D56\u02E2')::replace('Kbps','\u1D37\u1D47\u1D56\u02E2')} ?}{stream.message::~Download["{tools.removeLine}"||""]}{service.cached::isfalse::or::stream.type::=p2p::and::stream.seeders::>0["\u21C4 {stream.seeders}\u2766 "||""]}{?\xB7 {stream.age}?}
{stream.proxied::istrue["\u26CA  "||"\u26C9  "]}{?[{service.shortName}] ?}{addon.name}{stream.private::istrue[" \u26BF \u1D18\u0280\u026A\u1D20\u1D00\u1D1B\u1D07 "||""]}{? \xB7 {stream.releaseGroup::truncate(13)}?}{stream.indexer::exists::and::stream.type::~usenet[" \xB7 {stream.indexer::truncate(13)}"||""]}{stream.message::~Download["{tools.removeLine}
"||""]}
{stream.uLanguages::exists["\u26FF  {stream.uSmallLanguageCodes::join(' \xB7 ')::replace('\uA730','\u0493')::replace('x','\u0445')::replace('\uA7AF','\u03D9')::replace('\uA731','s')::replace('\u1D05\u1D1C\u1D00\u029F \u1D00\u1D1C\u1D05\u026A\u1D0F','\u1D05\u1D1C\u1D0F')::replace('\u1D05\u1D1C\u0299\u0299\u1D07\u1D05','\u1D05\u1D1C\u0299')}  "||""]}{stream.subbed::istrue["{stream.uLanguages::exists[\\"\xB7 s\u1D1C\u0299 \\"||\\"\u26FF  s\u1D1C\u0299 \\"]}"||""]}{stream.uSubtitles::exists["({stream.uSmallSubtitleCodes::join(' \xB7 ')::replace('\uA730','\u0493')::replace('x','\u0445')::replace('\uA7AF','\u03D9')::replace('\uA731','s')})  "||""]}{stream.seadex::or::stream.seScore::>0::or::stream.seScore::<0::or::stream.message::exists::or::stream.rseMatched::length::>0[" \xBB  "||""]}{stream.seadexBest::istrue[" \u0299\u1D07s\u1D1B \u0280\u1D07\u029F\u1D07\u1D00s\u1D07 "||""]}{stream.seadex::istrue::and::stream.seadexBest::isfalse[" \u1D00\u029F\u1D1B \u0299\u1D07s\u1D1B \u0280\u1D07\u029F\u1D07\u1D00s\u1D07 "||""]}{stream.seadex::isfalse::and::stream.rseMatched::length::>0["{stream.rseMatched::remove('TrueHD ATMOS','DD+ ATMOS','ATMOS','TrueHD','DTS-HD MA','FLAC','DTS-HD HRA','DD+','DD','DTS-ES','DTS X','DTS','AAC','Opus','DV (Disk)','DV','HDR10+ Boost','HDR','UHD Streaming Boost','HD Streaming Boost','INTERNAL','No-RlsGroup','FHD','UHD','HD','4K','126811','SiC','FraMeSToR','TheFarm','hallowed','BHDStudio','FLUX','Season Pack')::join('  ')::replace('UHD ','')::replace('HD ','')::replace('Movies Anywhere','MA')::upper::replace('F','\u0493')::replace('X','\u0445')::replace('Q','\u03D9')::translate('0123456789','\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089')::smallcaps::replace('\uA731','s')} "||""]}{stream.message::exists[" {stream.message::replace('NZB Health: \u2705','\u2705 \u0274\u1D22\u0299')::replace('NZB Health: \u{1F9DD}','\u{1F9DD} \u0274\u1D22\u0299')::replace('AvailNZB \u{1F49A}','\u{1F49A} \u0274\u1D22\u0299')::replace('NZB Health: \u26A0\uFE0F','\u1D1C\u0274\u1D20\u1D07\u0280\u026A\u0493\u026A\u1D07\u1D05 \u0274\u1D22\u0299')::replace('NZB Health: \u{1F6AB}','\u2718\u0274\u1D22\u0299')::smallcaps} "||""]}{stream.seScore::>0::or::stream.seScore::<0["{stream.seScore::string::translate('0123456789','\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089')}"||""]}{stream.message::~Download["{tools.removeLine}"||""]}{service.cached::istrue::and::stream.message::~Download::istrue["
\u27A5 DL Stream"||""]}`
  }
};

// engine-only-entry.ts
function evaluateTemplate(template, data) {
  if (!template) return "";
  const compiled = compileTemplate(template, {
    comparators: comparatorFunctions,
    resolveVariable: (source, parseValue) => {
      const parts = source.split(".");
      let val = parseValue;
      for (const p of parts) {
        if (val == null) return void 0;
        val = val[p];
      }
      return val;
    },
    onDepthExceeded: () => {
    }
  });
  return compiled(data);
}
if (typeof window !== "undefined") {
  window.__formatterEngine = { evaluateTemplate, BUILTIN_FORMATTER_DEFINITIONS };
}
export {
  BUILTIN_FORMATTER_DEFINITIONS,
  FIELD_REGISTRY,
  NEW_LINE_SENTINEL,
  REMOVE_LINE_SENTINEL,
  allModifierNames,
  canonicaliseField,
  comparatorFunctions,
  comparatorNames,
  compileModifier,
  compileTemplate,
  evaluateExpression,
  evaluateTemplate,
  formatBitrate,
  formatBytes,
  formatDuration,
  formatSmartBitrate,
  formatSmartBytes,
  makeSmall,
  parseTemplate,
  sanitise,
  substituteTools,
  tokenize
};
