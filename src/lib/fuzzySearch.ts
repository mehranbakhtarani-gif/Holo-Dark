/**
 * Persian & English Fuzzy Search Engine for Holoo Apex Data Tables.
 * 100% local, synchronous, zero network dependency.
 *
 * Supports:
 * - Strict Persian/Arabic normalization:
 *     ي / ى / ئ / ې -> ی
 *     ك / ګ / ڪ -> ک
 *     أ / إ / آ / ٱ -> ا
 *     ة / ۀ -> ه
 *     ؤ -> و
 *     Strips Arabic diacritics, hamza above (U+0654), tatweel (ـ), BOM, ZWJ, bidi marks
 *     Normalizes Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII (0-9)
 * - Seamless ZWNJ (نیم‌فاصله) & compound Persian word equivalence:
 *     "پیش‌فاکتور" === "پیش فاکتور" === "پیشفاکتور"
 *     "طرف‌حساب" === "طرف حساب" === "طرفحساب"
 *     "انبارگردانی" === "انبار گردانی"
 * - Multi-field, out-of-order (swapped word order), partial-word, and connector-tolerant matching
 * - Typo-tolerant Damerau-Levenshtein matching on individual words AND compound word pairs
 * - Accurate highlight segment extraction on original un-normalized Persian/English strings
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

const PERSIAN_CONNECTOR_STOPWORDS = new Set(['و', 'از', 'به', 'در', 'با', 'برای', 'را', 'تا', 'بر']);

const SEPARATOR_REGEX = /[\s\u200c\-_/#.,٬،؛:·—–٫()[\]«»"']+/g;
const WORD_SPLIT_REGEX = /[\s\u200c\-_/#.,٬،؛:·—–٫()[\]«»"']+/;

function isIgnorableCode(code: number): boolean {
  return (
    (code >= 0x064b && code <= 0x065f) || // Arabic harakat / diacritics incl. hamza above (0x0654)
    code === 0x0670 || // superscript alef
    code === 0x0640 || // tatweel (کشیـده)
    code === 0x200d || // zero-width joiner
    code === 0x200e || // LRM
    code === 0x200f || // RLM
    code === 0xfeff || // BOM
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings/overrides
    (code >= 0x2066 && code <= 0x2069) // bidi isolates
  );
}

export function normalizeFuzzyChar(ch: string): string {
  const pIdx = PERSIAN_DIGITS.indexOf(ch);
  if (pIdx !== -1) return String(pIdx);
  const aIdx = ARABIC_DIGITS.indexOf(ch);
  if (aIdx !== -1) return String(aIdx);
  switch (ch) {
    case 'ي':
    case 'ى':
    case 'ئ':
    case 'ې':
    case 'ۍ':
      return 'ی';
    case 'ك':
    case 'ګ':
    case 'ڪ':
      return 'ک';
    case 'أ':
    case 'إ':
    case 'آ':
    case 'ٱ':
      return 'ا';
    case 'ة':
    case 'ۀ':
      return 'ه';
    case 'ؤ':
      return 'و';
    case '\u200c': // ZWNJ (نیم‌فاصله) -> space for word boundary; stripped in compact form
      return ' ';
    case '٬': // Persian thousands separator
    case '،': // Arabic/Persian comma
      return ',';
    case '٫': // Persian decimal separator
      return '.';
    case '؛':
      return ';';
    case '؟':
      return '?';
    default:
      return ch.toLowerCase();
  }
}

export function normalizeFuzzyText(input: string): string {
  if (!input) return '';
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (isIgnorableCode(code)) {
      continue;
    }
    out += normalizeFuzzyChar(input[i]);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Compact alphanumeric/Persian form without separators (-, /, _, space, #, ZWNJ, Persian commas) */
export function stripSeparators(text: string): string {
  if (!text) return '';
  return text.replace(SEPARATOR_REGEX, '');
}

/** Fast bounded Damerau-Levenshtein distance with early exit */
function boundedEditDistance(a: string, b: string, maxDist: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const d: number[][] = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;

  for (let i = 1; i <= la; i++) {
    let rowMin = maxDist + 1;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, d[i - 2][j - 2] + 1);
      }
      d[i][j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  return d[la][lb];
}

export type FuzzyMatchKind = 'exact' | 'prefix' | 'substring' | 'subsequence' | 'typo' | 'none';

export interface TokenScoreResult {
  score: number;
  kind: FuzzyMatchKind;
}

interface PreparedTarget {
  norm: string;
  compact: string;
  words: string[];
  compoundPairs: string[];
}

function prepareTarget(rawTarget: string): PreparedTarget | null {
  const norm = normalizeFuzzyText(rawTarget);
  if (!norm) return null;
  const compact = stripSeparators(norm);
  const words = norm.split(WORD_SPLIT_REGEX).filter(Boolean);
  const compoundPairs: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    compoundPairs.push(words[i] + words[i + 1]);
  }
  return { norm, compact, words, compoundPairs };
}

function scorePreparedToken(token: string, prepared: PreparedTarget): TokenScoreResult {
  const { norm: target, compact: compactTarget, words, compoundPairs } = prepared;
  const compactToken = stripSeparators(token);
  if (!compactToken) return { score: 0, kind: 'none' };

  // 1. Exact full match (spaced or compact — e.g. "پیشفاکتور" === "پیش‌فاکتور")
  if (target === token) return { score: 100, kind: 'exact' };
  if (compactTarget === compactToken) return { score: 98, kind: 'exact' };

  // 2. Direct prefix match
  if (target.startsWith(token)) return { score: 94, kind: 'prefix' };
  if (compactToken.length >= 2 && compactTarget.startsWith(compactToken)) {
    return { score: 92, kind: 'prefix' };
  }

  // 3. Word-boundary exact / prefix match
  let bestWordScore = 0;
  let bestWordKind: FuzzyMatchKind = 'none';
  for (const w of words) {
    if (w === token || w === compactToken) return { score: 91, kind: 'exact' };
    if (w.startsWith(token) || (compactToken.length >= 2 && w.startsWith(compactToken))) {
      if (86 > bestWordScore) {
        bestWordScore = 86;
        bestWordKind = 'prefix';
      }
    }
  }
  if (bestWordScore > 0) return { score: bestWordScore, kind: bestWordKind };

  // 4. Adjacent compound Persian word-pair match (e.g. "پیشفاکتور" against "پیش فاکتور" / "پیش‌فاکتور")
  for (const pair of compoundPairs) {
    if (pair === compactToken) return { score: 90, kind: 'exact' };
    if (compactToken.length >= 2 && pair.startsWith(compactToken)) {
      return { score: 85, kind: 'prefix' };
    }
  }

  // 5. Contiguous substring match
  const subIdx = target.indexOf(token);
  if (subIdx !== -1) {
    const posBonus = Math.max(0, 6 - Math.floor(subIdx / 6));
    return { score: 76 + posBonus, kind: 'substring' };
  }

  // 6. Separator-stripped substring match (invoice numbers F-1404-101, amounts 185,000,000, compound Persian words)
  if (compactToken.length >= 2) {
    const compIdx = compactTarget.indexOf(compactToken);
    if (compIdx !== -1) {
      const posBonus = Math.max(0, 6 - Math.floor(compIdx / 6));
      return { score: 78 + posBonus, kind: 'substring' };
    }
  }

  // 7. Typo-tolerant Damerau-Levenshtein edit distance against individual words & compound pairs (length >= 3)
  if (compactToken.length >= 3) {
    const maxDist = compactToken.length >= 6 ? 2 : 1;
    let bestDist = maxDist + 1;

    const candidates = [...words, ...compoundPairs];
    if (compactTarget.length <= compactToken.length + maxDist + 3) {
      candidates.push(compactTarget);
    }

    for (const candidateWord of candidates) {
      if (candidateWord.length < 2) continue;
      // Full-word edit distance AND prefix-typo edit distance
      const sliceLen = Math.min(candidateWord.length, compactToken.length + maxDist);
      const prefixCand = candidateWord.slice(0, sliceLen);
      const dist = Math.min(
        boundedEditDistance(compactToken, candidateWord, maxDist),
        boundedEditDistance(compactToken, prefixCand, maxDist)
      );
      if (dist < bestDist) bestDist = dist;
      if (bestDist === 1) break;
    }
    if (bestDist <= maxDist) {
      return { score: bestDist === 1 ? 62 : 50, kind: 'typo' };
    }
  }

  // 8. Ordered character subsequence fuzzy match (e.g. "فرش" -> "فروش", "چص" -> "چک صیادی")
  if (compactToken.length >= 2 && compactTarget.length >= compactToken.length) {
    let ti = 0;
    let consecutive = 0;
    let maxConsecutive = 0;
    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < compactTarget.length && ti < compactToken.length; i++) {
      if (compactTarget[i] === compactToken[ti]) {
        if (firstIdx === -1) firstIdx = i;
        if (lastIdx === i - 1) {
          consecutive += 1;
          if (consecutive > maxConsecutive) maxConsecutive = consecutive;
        } else {
          consecutive = 1;
        }
        lastIdx = i;
        ti += 1;
      }
    }
    if (ti === compactToken.length) {
      const span = lastIdx - firstIdx + 1;
      const density = compactToken.length / span;
      if (density >= 0.42 || (compactToken.length >= 3 && density >= 0.25)) {
        const score = Math.round(48 + density * 18 + Math.min(6, maxConsecutive * 2));
        return { score: Math.min(72, score), kind: 'subsequence' };
      }
    }
  }

  return { score: 0, kind: 'none' };
}

/**
 * Scores how well a single query token matches a single target string.
 * Automatically normalizes both token and target for Persian/Arabic/digit consistency.
 */
export function fuzzyScoreToken(rawToken: string, rawTarget: string): TokenScoreResult {
  if (!rawToken || !rawTarget) return { score: 0, kind: 'none' };
  const token = normalizeFuzzyText(rawToken);
  if (!token) return { score: 0, kind: 'none' };
  const prepared = prepareTarget(rawTarget);
  if (!prepared) return { score: 0, kind: 'none' };
  return scorePreparedToken(token, prepared);
}

export interface FuzzyField {
  text: string | number | undefined | null;
  weight?: number;
}

export interface FuzzyScoreResult {
  score: number;
  isFuzzy: boolean;
  kind: FuzzyMatchKind;
}

const KIND_ORDER: Record<FuzzyMatchKind, number> = {
  exact: 5,
  prefix: 4,
  substring: 3,
  subsequence: 2,
  typo: 1,
  none: 0,
};

/**
 * Evaluates a multi-token query across weighted record fields.
 * Supports:
 * - Out-of-order / swapped word matching across multiple fields
 * - Compound Persian word equivalence ("پیش‌فاکتور" <-> "پیش فاکتور" <-> "پیشفاکتور")
 * - Persian connector stopword tolerance ("نخ و پنبه" matches "نخ پنبه")
 * - Cross-field compact fallback (e.g. typing code+name together)
 */
export function fuzzyScoreFields(query: string, fields: FuzzyField[]): FuzzyScoreResult {
  const normQuery = normalizeFuzzyText(query);
  if (!normQuery) return { score: 100, isFuzzy: false, kind: 'exact' };

  const rawTokens = normQuery.split(' ').filter(Boolean);
  if (rawTokens.length === 0) return { score: 100, isFuzzy: false, kind: 'exact' };

  const preparedFields: { prepared: PreparedTarget; weight: number }[] = [];
  for (const f of fields) {
    if (f.text === null || f.text === undefined) continue;
    const str = String(f.text);
    if (!str) continue;
    const prepared = prepareTarget(str);
    if (prepared) {
      preparedFields.push({ prepared, weight: f.weight ?? 1 });
    }
  }

  if (preparedFields.length === 0) return { score: 0, isFuzzy: false, kind: 'none' };

  // Fast path: Full compact phrase match against any single field (boosts exact/prefix compound matches!)
  const compactQuery = stripSeparators(normQuery);
  let bestPhraseBonus = 0;
  let bestPhraseDirect: FuzzyScoreResult | null = null;
  if (compactQuery.length >= 2) {
    for (const field of preparedFields) {
      if (field.prepared.norm === normQuery || field.prepared.compact === compactQuery) {
        const sc = Math.round(100 * field.weight) + 12;
        if (!bestPhraseDirect || sc > bestPhraseDirect.score) {
          bestPhraseDirect = { score: sc, isFuzzy: false, kind: 'exact' };
        }
      } else if (
        field.prepared.norm.startsWith(normQuery) ||
        field.prepared.compact.startsWith(compactQuery)
      ) {
        const sc = Math.round(93 * field.weight) + 8;
        if (!bestPhraseDirect || sc > bestPhraseDirect.score) {
          bestPhraseDirect = { score: sc, isFuzzy: false, kind: 'prefix' };
        }
      } else if (
        field.prepared.norm.includes(normQuery) ||
        field.prepared.compact.includes(compactQuery)
      ) {
        bestPhraseBonus = Math.max(bestPhraseBonus, 8);
      }
    }
  }
  if (bestPhraseDirect) {
    return bestPhraseDirect;
  }

  // Filter out standalone Persian connector words only when there are meaningful content tokens alongside them
  const contentTokens = rawTokens.filter((t) => !PERSIAN_CONNECTOR_STOPWORDS.has(t));
  const tokens = contentTokens.length > 0 ? contentTokens : rawTokens;

  let totalScore = 0;
  let usedFuzzy = false;
  let worstKind: FuzzyMatchKind = 'exact';
  let unmatchedCount = 0;

  for (const token of tokens) {
    let bestTokenWeighted = 0;
    let bestTokenRaw = 0;
    let bestKind: FuzzyMatchKind = 'none';

    for (const field of preparedFields) {
      const res = scorePreparedToken(token, field.prepared);
      if (res.score > 0) {
        const weighted = res.score * field.weight;
        if (weighted > bestTokenWeighted) {
          bestTokenWeighted = weighted;
          bestTokenRaw = res.score;
          bestKind = res.kind;
        }
      }
    }

    if (bestTokenRaw === 0) {
      unmatchedCount += 1;
      continue;
    }

    if (bestKind === 'subsequence' || bestKind === 'typo') {
      usedFuzzy = true;
    }
    if (KIND_ORDER[bestKind] < KIND_ORDER[worstKind]) {
      worstKind = bestKind;
    }
    totalScore += bestTokenWeighted;
  }

  if (unmatchedCount === 0) {
    return {
      score: Math.round(totalScore / tokens.length) + bestPhraseBonus,
      isFuzzy: usedFuzzy,
      kind: worstKind,
    };
  }

  // Fallback: Combined multi-field compact check (e.g., query spans two fields or joined without spaces)
  if (compactQuery.length >= 3) {
    const combinedCompact = preparedFields.map((f) => f.prepared.compact).join('');
    if (combinedCompact.includes(compactQuery)) {
      return { score: 78, isFuzzy: false, kind: 'substring' };
    }
    // Check if the full compact query is a typo match against any single field's compound words
    for (const field of preparedFields) {
      const res = scorePreparedToken(compactQuery, field.prepared);
      if (res.score > 0) {
        return {
          score: Math.round(res.score * field.weight),
          isFuzzy: res.kind === 'typo' || res.kind === 'subsequence',
          kind: res.kind,
        };
      }
    }
  }

  return { score: 0, isFuzzy: false, kind: 'none' };
}

export interface RankedFuzzyItem<T> {
  item: T;
  score: number;
  isFuzzy: boolean;
  kind: FuzzyMatchKind;
}

/**
 * Instant local fuzzy filtering and relevance ranking for any data table array.
 */
export function fuzzyFilterAndRank<T>(
  records: T[],
  query: string,
  getFields: (item: T) => FuzzyField[]
): RankedFuzzyItem<T>[] {
  const norm = normalizeFuzzyText(query);
  if (!norm) {
    return records.map((item) => ({ item, score: 100, isFuzzy: false, kind: 'exact' }));
  }

  const ranked: RankedFuzzyItem<T>[] = [];
  for (const item of records) {
    const res = fuzzyScoreFields(norm, getFields(item));
    if (res.score > 0) {
      ranked.push({ item, score: res.score, isFuzzy: res.isFuzzy, kind: res.kind });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Returns highlighted segments on the original (un-normalized) string matching:
 * 1. Contiguous normalized substrings (Arabic/Persian char & digit agnostic)
 * 2. Compact separator-stripped spans (e.g. "پیشفاکتور" highlights "پیش‌فاکتور", "1404101" highlights "F-1404-101")
 * 3. Typo-tolerant word matches (e.g. "فروس" highlights "فروش")
 * 4. Ordered character subsequence fallback
 */
export function getHighlightSegments(originalText: string, query: string): HighlightSegment[] {
  if (!originalText) return [];
  const normQuery = normalizeFuzzyText(query);
  if (!normQuery) return [{ text: originalText, match: false }];

  const rawTokens = normQuery.split(' ').filter(Boolean);
  if (rawTokens.length === 0) return [{ text: originalText, match: false }];
  const contentTokens = rawTokens.filter((t) => !PERSIAN_CONNECTOR_STOPWORDS.has(t));
  const tokens = contentTokens.length > 0 ? contentTokens : rawTokens;

  // Build 1-to-1 normalized char map AND compact (separator-free) char map back to originalText indices
  const normChars: string[] = [];
  const origIdxMap: number[] = [];
  const compactChars: string[] = [];
  const compactOrigIdxMap: number[] = [];

  for (let i = 0; i < originalText.length; i++) {
    const code = originalText.charCodeAt(i);
    if (isIgnorableCode(code)) continue;
    const nc = normalizeFuzzyChar(originalText[i]);
    normChars.push(nc);
    origIdxMap.push(i);
    if (stripSeparators(nc).length > 0) {
      compactChars.push(nc);
      compactOrigIdxMap.push(i);
    }
  }

  const normStr = normChars.join('');
  const compactStr = compactChars.join('');
  const matchedOrig = new Array<boolean>(originalText.length).fill(false);

  const highlightSpanInclusive = (startOrig: number, endOrig: number) => {
    for (let p = Math.max(0, startOrig); p <= Math.min(originalText.length - 1, endOrig); p++) {
      matchedOrig[p] = true;
    }
  };

  for (const token of tokens) {
    // 1. Contiguous normalized substring highlight
    const idx = normStr.indexOf(token);
    if (idx !== -1) {
      for (let k = idx; k < idx + token.length; k++) {
        matchedOrig[origIdxMap[k]] = true;
      }
      continue;
    }

    // 2. Compact separator-stripped highlight (handles ZWNJ "پیش‌فاکتور", codes "F-1404-101", amounts "185,000")
    const compactTok = stripSeparators(token);
    if (compactTok.length >= 2) {
      const cIdx = compactStr.indexOf(compactTok);
      if (cIdx !== -1) {
        const startOrig = compactOrigIdxMap[cIdx];
        const endOrig = compactOrigIdxMap[cIdx + compactTok.length - 1];
        highlightSpanInclusive(startOrig, endOrig);
        continue;
      }
    }

    // 3. Typo-tolerant word highlight (e.g. "فروس" -> highlights "فروش")
    if (compactTok.length >= 3) {
      const maxDist = compactTok.length >= 6 ? 2 : 1;
      let wordStart = -1;
      let bestSpan: [number, number] | null = null;
      let bestDist = maxDist + 1;

      for (let i = 0; i <= normChars.length; i++) {
        const isBoundary = i === normChars.length || WORD_SPLIT_REGEX.test(normChars[i]);
        if (!isBoundary && wordStart === -1) {
          wordStart = i;
        } else if (isBoundary && wordStart !== -1) {
          const word = normStr.slice(wordStart, i);
          if (word.length >= 2) {
            const prefixCand = word.slice(0, Math.min(word.length, compactTok.length + maxDist));
            const d = Math.min(
              boundedEditDistance(compactTok, word, maxDist),
              boundedEditDistance(compactTok, prefixCand, maxDist)
            );
            if (d < bestDist) {
              bestDist = d;
              bestSpan = [origIdxMap[wordStart], origIdxMap[i - 1]];
            }
          }
          wordStart = -1;
        }
      }
      if (bestSpan) {
        highlightSpanInclusive(bestSpan[0], bestSpan[1]);
        continue;
      }
    }

    // 4. Fallback: ordered character subsequence highlight
    if (compactTok.length >= 2) {
      const positions: number[] = [];
      let ti = 0;
      for (let i = 0; i < compactChars.length && ti < compactTok.length; i++) {
        if (compactChars[i] === compactTok[ti]) {
          positions.push(compactOrigIdxMap[i]);
          ti += 1;
        }
      }
      if (ti === compactTok.length) {
        for (const p of positions) {
          matchedOrig[p] = true;
        }
      }
    }
  }

  // Group contiguous runs
  const segments: HighlightSegment[] = [];
  let curText = '';
  let curMatch = matchedOrig[0] ?? false;

  for (let i = 0; i < originalText.length; i++) {
    if (matchedOrig[i] === curMatch) {
      curText += originalText[i];
    } else {
      if (curText) segments.push({ text: curText, match: curMatch });
      curText = originalText[i];
      curMatch = matchedOrig[i];
    }
  }
  if (curText) segments.push({ text: curText, match: curMatch });
  return segments;
}
