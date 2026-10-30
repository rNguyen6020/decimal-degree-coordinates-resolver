/**
 * ParseError is thrown for unparseable input. It subclasses Error so that
 * callers can distinguish parse failures from genuine runtime errors via
 * `instanceof`. We do not export a sentinel-return variant because the
 * common caller path wants to skip bad rows cheaply, and a try/catch at
 * the row level reads more clearly than threading an error channel
 * through every call site.
 */
export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

// Whitespace class covers ASCII spaces and tabs, plus the common Unicode
// space characters that appear in data pasted from GIS tools and PDFs.
// We intentionally exclude thin/non-breaking spaces because in practice
// they more often indicate a damaged paste than a meaningful separator.
const WHITESPACE = /[\s\u00A0\u2028\u2029]/;

// Cardinal letters. Case-insensitive throughout. The combined +/− form
// matches the U+2212 minus sign used in ISO 6709 and by some spreadsheet
// exporters; treating it as ASCII '-' here means downstream math is uniform.
const CARDINALS = new Set(['N', 'S', 'E', 'W']);

/**
 * Sign-correct a decimal value based on the cardinal direction.
 * N/E are positive; S/W make the value negative regardless of any leading
 * minus on the digits. This mirrors how surveyors annotate coordinates:
 * the sign lives in the letter, not the number.
 */
function applyCardinalSign(value, cardinal) {
  if (cardinal === 'N' || cardinal === 'E') return value;
  if (cardinal === 'S' || cardinal === 'W') return -Math.abs(value);
  // Unreachable: callers only pass validated cardinals.
  return value;
}

/**
 * Merge a leading sign character (if any) with a trailing cardinal letter
 * (if any). The rule: if both are present and disagree, the string is
 * contradictory and we throw. If only the sign is present it governs; if
 * only the cardinal is present, applyCardinalSign handles it. We never
 * silently let a leading '-' and a trailing 'N' produce -north.
 */
function combineSigns(value, signChar, cardinal) {
  if (signChar === '-' && (cardinal === 'N' || cardinal === 'E')) {
    throw new ParseError('negative sign contradicts N/E cardinal');
  }
  if (signChar === '+' && (cardinal === 'S' || cardinal === 'W')) {
    throw new ParseError('positive sign contradicts S/W cardinal');
  }
  if (signChar === '-') value = -Math.abs(value);
  if (cardinal) value = applyCardinalSign(value, cardinal);
  return value;
}

function isSignChar(ch) {
  return ch === '+' || ch === '-' || ch === '\u2212';
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

/**
 * Read a run of digits starting at position i. Returns {value, next} where
 * value is the integer parsed (0 if no digits) and next is the index just
 * past the last digit. We do not accumulate into a Number piecewise to
 * avoid precision loss on large degree values; parseInt on the matched
 * substring is sufficient because all inputs are coordinate-scale.
 */
function readDigits(s, i) {
  const start = i;
  while (i < s.length && isDigit(s[i])) i += 1;
  if (i === start) return { value: NaN, next: i };
  return { value: parseInt(s.slice(start, i), 10), next: i };
}

/**
 * Skip whitespace at position i, returning the new index.
 */
function skipWhitespace(s, i) {
  while (i < s.length && WHITESPACE.test(s[i])) i += 1;
  return i;
}

/**
 * Pull a trailing cardinal letter off the string at position i, if present.
 * Returns {cardinal, next} where cardinal is uppercase or null.
 */
function readCardinal(s, i) {
  if (i < s.length) {
    const up = s[i].toUpperCase();
    if (CARDINALS.has(up)) {
      return { cardinal: up, next: i + 1 };
    }
  }
  return { cardinal: null, next: i };
}

/**
 * Find the split point between latitude and longitude components. We scan
 * from left to right looking for a separator that sits between two complete
 * DMS-style components (each of which may contain spaces, digits, dots,
 * signs, and a trailing cardinal). A separator after a cardinal letter
 * is the boundary between the two components; a separator after a digit
 * is treated as intra-component (e.g. between degrees and minutes) unless
 * the next non-whitespace character is a sign, which indicates the start
 * of the second signed component.
 */
function findSplit(s) {
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isDigit(ch) || isSignChar(ch) || ch === '.') {
      i += 1;
    } else if (ch === ',') {
      return i;
    } else if (WHITESPACE.test(ch)) {
      // Peek: if the previous non-space char was a cardinal, this space
      // is the boundary between latitude and longitude.
      let j = i - 1;
      while (j >= 0 && WHITESPACE.test(s[j])) j -= 1;
      if (j >= 0 && CARDINALS.has(s[j].toUpperCase())) {
        return i;
      }
      // If the previous non-space char was a digit and the next non-space
      // char is a sign, this space is the boundary between two signed
      // decimal components (e.g. "-48.8566 -2.3522").
      if (j >= 0 && isDigit(s[j])) {
        let k = i + 1;
        while (k < s.length && WHITESPACE.test(s[k])) k += 1;
        if (k < s.length && isSignChar(s[k])) {
          return i;
        }
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return -1;
}

/**
 * Parse a single degrees-minutes-seconds component string into a signed
 * decimal-degree float. Accepts D, D.d, D M, D M.m, D M S, D M S.s,
 * with optional leading sign and optional trailing cardinal letter.
 * Throws ParseError on malformed input.
 *
 * The internal pipeline is strictly positional: read optional sign, read
 * the first numeric (degrees), then repeatedly read (separator? number)
 * for minutes and seconds. We do not support 'DMS' packed strings like
 * "481230N" because in practice those come with their own format spec
 * and ambiguous field widths; callers should normalise those upstream.
 */
function parseComponent(raw) {
  if (typeof raw !== 'string') {
    throw new ParseError('expected a string, got ' + typeof raw);
  }
  const s = raw.trim();
  if (s.length === 0) throw new ParseError('empty coordinate string');

  let i = 0;
  // Leading sign (optional). U+2212 minus normalised to ASCII.
  let signChar = null;
  if (isSignChar(s[i])) {
    signChar = s[i] === '\u2212' ? '-' : s[i];
    i += 1;
  }

  // Degrees (integer part required).
  const degRead = readDigits(s, i);
  if (Number.isNaN(degRead.value)) {
    throw new ParseError('expected degree digits at position ' + i);
  }
  i = degRead.next;
  let degrees = degRead.value;

  // Optional degree fraction.
  if (i < s.length && s[i] === '.') {
    i += 1;
    const fStart = i;
    while (i < s.length && isDigit(s[i])) i += 1;
    if (i === fStart) throw new ParseError('trailing dot with no fractional digits');
    degrees += parseInt(s.slice(fStart, i), 10) / Math.pow(10, i - fStart);
  }

  // Minutes (optional). A separator (space or comma) may precede it.
  let minutes = 0;
  let sawMinutes = false;
  if (i < s.length && (WHITESPACE.test(s[i]) || s[i] === ',')) {
    const savedI = i;
    i = skipWhitespace(s, i);
    if (s[i] === ',') i += 1;
    i = skipWhitespace(s, i);
    const minRead = readDigits(s, i);
    if (!Number.isNaN(minRead.value)) {
      sawMinutes = true;
      minutes = minRead.value;
      i = minRead.next;
      if (i < s.length && s[i] === '.') {
        i += 1;
        const fStart = i;
        while (i < s.length && isDigit(s[i])) i += 1;
        if (i === fStart) throw new ParseError('trailing dot with no fractional digits');
        minutes += parseInt(s.slice(fStart, i), 10) / Math.pow(10, i - fStart);
      }
    } else {
      i = savedI;
    }
  }

  // Seconds (optional). Same separator rules.
  let seconds = 0;
  if (sawMinutes && i < s.length && (WHITESPACE.test(s[i]) || s[i] === ',')) {
    const savedI = i;
    i = skipWhitespace(s, i);
    if (s[i] === ',') i += 1;
    i = skipWhitespace(s, i);
    const secRead = readDigits(s, i);
    if (!Number.isNaN(secRead.value)) {
      seconds = secRead.value;
      i = secRead.next;
      if (i < s.length && s[i] === '.') {
        i += 1;
        const fStart = i;
        while (i < s.length && isDigit(s[i])) i += 1;
        if (i === fStart) throw new ParseError('trailing dot with no fractional digits');
        seconds += parseInt(s.slice(fStart, i), 10) / Math.pow(10, i - fStart);
      }
    } else {
      i = savedI;
    }
  }

  // Trailing cardinal (optional).
  i = skipWhitespace(s, i);
  const card = readCardinal(s, i);
  i = card.next;
  i = skipWhitespace(s, i);
  if (i !== s.length) {
    throw new ParseError('unexpected trailing characters: ' + s.slice(i));
  }

  // Range sanity. We allow minutes up to 59.999... and seconds likewise.
  // Degrees can exceed 90/180 in the raw component because the caller may
  // be parsing a single axis without knowing which; range checks against
  // lat/long bounds happen at the parseCoordinate level, not here.
  if (minutes >= 60) throw new ParseError('minutes must be < 60, got ' + minutes);
  if (seconds >= 60) throw new ParseError('seconds must be < 60, got ' + seconds);

  let value = degrees + minutes / 60 + seconds / 3600;
  value = combineSigns(value, signChar, card.cardinal);
  return value;
}

/**
 * Parse a full coordinate string into a {latitude, longitude} pair of
 * decimal-degree floats. Accepts either a single string with both
 * components separated by whitespace/comma, or a two-element array.
 *
 * Interpretation chosen (stated plainly): latitude first, longitude
 * second, matching the GeoJSON / RFC 7946 axis order for positions.
 * We do NOT support longitude-first order even though some older CSV
 * exports use it; mixing the two is how coordinates end up in the ocean.
 *
 * Range checks: latitude must be in [-90, 90], longitude in [-180, 180].
 * Out-of-range values throw ParseError rather than clamping, because a
 * clamp would silently relocate a mistyped coordinate by thousands of
 * kilometres.
 */
export function parseCoordinate(input) {
  let latRaw, lonRaw;

  if (Array.isArray(input)) {
    if (input.length !== 2) {
      throw new ParseError('expected a two-element array, got length ' + input.length);
    }
    latRaw = input[0];
    lonRaw = input[1];
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) throw new ParseError('empty coordinate string');

    // Find the boundary between the latitude and longitude components.
    // A separator following a cardinal letter marks the split; a comma
    // always marks the split. This lets each component contain internal
    // spaces (e.g. "48 51 24 N 2 21 8 E").
    const splitIdx = findSplit(trimmed);
    if (splitIdx < 0) {
      throw new ParseError('could not split input into latitude and longitude');
    }
    latRaw = trimmed.slice(0, splitIdx).trim();
    let rest = trimmed.slice(splitIdx);
    if (rest[0] === ',') rest = rest.slice(1);
    lonRaw = rest.trim();
  } else {
    throw new ParseError('expected a string or array, got ' + typeof input);
  }

  const latitude = parseComponent(String(latRaw));
  const longitude = parseComponent(String(lonRaw));

  if (Math.abs(latitude) > 90) {
    throw new ParseError('latitude out of range: ' + latitude);
  }
  if (Math.abs(longitude) > 180) {
    throw new ParseError('longitude out of range: ' + longitude);
  }

  return { latitude, longitude };
}
