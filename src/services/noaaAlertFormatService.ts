import type { NoaaAlert } from './noaaAlertsService';

// NOAA SWPC alerts arrive as a telegraphic text blob: a header of bureaucratic "Label: value"
// lines (message code, serial numbers, issue time) followed by a free-text condition line and a
// few measured/forecast fields. This service parses that blob into the handful of pieces an
// operator actually needs — what happened, how severe, when, and which orbits it touches — and
// drops the serial-number noise. It is intentionally tolerant: anything it can't classify still
// surfaces the raw condition line plus the original message.

export type AlertTone = 'info' | 'elevated' | 'high';

export interface AlertHighlight {
  label: string;
  value: string;
}

// Parsed instants from the bulletin that tell an operator *when* the event reaches / affects
// Earth. Kept as ISO strings (now-independent) so the panel can render an absolute time on the
// server and a live "in ~6 h / since 2 h ago" countdown once a client clock is available.
export interface AlertTiming {
  onsetIso: string | null; // "Begin Time" — when the event started / will start
  validFromIso: string | null; // "Valid From" — start of a forecast effect window
  validToIso: string | null; // "Valid To" — end of that window
  isPrediction: boolean; // Watch/Warning bulletins describe a future/forecast effect
}

export interface HumanizedAlert {
  kind: string; // Watch | Warning | Alert | Summary | Cancellation | Bulletin
  title: string; // plain-English phenomenon
  tone: AlertTone;
  noaaScale: string | null; // e.g. "G2 — Moderate"
  condition: string | null; // NOAA's own one-line condition sentence
  highlights: AlertHighlight[]; // a few key parsed fields (time window, peak value…)
  impacts: string | null; // NOAA "Potential Impacts" text, if present
  relevance: string | null; // which orbit classes it matters for, in plain language
  issuedLabel: string | null; // formatted issue time
  issuedMs: number | null; // parsed issue time, for sorting / dedup
  dedupeKey: string; // groups NOAA's daily "continued" re-issues of the same alert product
  timing: AlertTiming | null; // when it reaches / is affecting Earth, when derivable
  raw: string; // original message, for the "show original" disclosure
}

interface ParsedField {
  label: string;
  value: string;
}

// The leading keyword of a NOAA bulletin's condition line maps to a bulletin kind + a baseline
// severity tone (later bumped by the NOAA G/S/R scale, if the message carries one).
const KIND_LABELS: Record<string, { kind: string; tone: AlertTone }> = {
  WATCH: { kind: 'Watch', tone: 'info' },
  WARNING: { kind: 'Warning', tone: 'elevated' },
  'EXTENDED WARNING': { kind: 'Warning', tone: 'elevated' },
  ALERT: { kind: 'Alert', tone: 'elevated' },
  'CONTINUED ALERT': { kind: 'Alert', tone: 'elevated' },
  SUMMARY: { kind: 'Summary', tone: 'info' },
};

// Header fields the operator never needs to read — hidden from the parsed output.
const NOISE_LABELS = /^(Space Weather Message Code|Serial Number|Continuation of Serial Number|Station|Description)$/i;

// Fields worth surfacing as compact highlights, with a friendlier label.
const HIGHLIGHT_LABELS: { match: RegExp; label: string }[] = [
  { match: /^Valid From$/i, label: 'From' },
  { match: /^Valid To$/i, label: 'To' },
  { match: /^Begin Time$/i, label: 'Began' },
  { match: /^End Time$/i, label: 'Ended' },
  { match: /^Threshold Reached$/i, label: 'Reached' },
  { match: /^(Maximum|Max) Time$/i, label: 'Peak' },
  { match: /^X-ray Class$/i, label: 'Class' },
  { match: /^Highest Storm Level Predicted by Day$/i, label: 'Predicted' },
  { match: /Maximum.*Flux$/i, label: 'Peak flux' },
];

/** Split the NOAA message into ordered "Label: value" fields, folding wrapped continuation lines. */
function parseFields(message: string): ParsedField[] {
  const fields: ParsedField[] = [];
  let current: ParsedField | null = null;

  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      current = null;
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9 ./()'-]*?):\s*(.*)$/);
    if (match) {
      current = { label: match[1].trim(), value: match[2].trim() };
      fields.push(current);
    } else if (current) {
      // Continuation of the previous field (e.g. a wrapped "Potential Impacts" paragraph).
      current.value = `${current.value} ${line}`.trim();
    } else {
      fields.push({ label: '', value: line });
    }
  }
  return fields;
}

/** "2026 Jun 15 1235 UTC" → "15 Jun 2026 · 12:35 UTC"; otherwise returned unchanged. */
function prettyTime(value: string): string {
  const m = value.match(/^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2})(\d{2})\s*UTC$/);
  return m ? `${m[3]} ${m[2]} ${m[1]} · ${m[4]}:${m[5]} UTC` : value;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse a NOAA timestamp ("2026 Jun 15 1235 UTC") to a Date, or null if it doesn't match. */
function parseNoaaTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = value.match(/(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2})(\d{2})\s*UTC/);
  if (!m) return null;
  const month = MONTH_INDEX[m[2].toLowerCase()];
  if (month === undefined) return null;
  return new Date(Date.UTC(Number(m[1]), month, Number(m[3]), Number(m[4]), Number(m[5])));
}

/** Map the condition text to a plain-English title + which orbit classes it actually affects. */
function classify(text: string): { title: string; relevance: string | null; strong: boolean } {
  const t = text.toLowerCase();
  if (/electron/.test(t)) {
    return {
      title: 'High-energy electron flux',
      relevance: 'Mainly GEO/MEO — internal (deep-dielectric) charging risk to electronics.',
      strong: /exceeded|1000|10000/.test(t),
    };
  }
  if (/proton|radiation storm|\bsep\b|solar energetic/.test(t)) {
    return {
      title: 'Solar radiation (proton) storm',
      relevance: 'All orbits, worst for polar LEO and high altitude — single-event upsets, added radiation dose, solar-array degradation.',
      strong: true,
    };
  }
  if (/k-?index|geomagnetic|storm|sudden impulse|aurora/.test(t)) {
    return {
      title: 'Geomagnetic storm',
      relevance: 'LEO — extra atmospheric drag and orbit-determination error; high-latitude GNSS/HF degradation.',
      strong: false,
    };
  }
  if (/x-?ray|flare|radio blackout|\br[1-5]\b/.test(t)) {
    return {
      title: 'Solar flare / radio blackout',
      relevance: 'Dayside HF radio blackout and possible GNSS/comms degradation; no direct effect on the spacecraft body.',
      strong: false,
    };
  }
  if (/radio emission|10\s?cm|tenflare|type (ii|iv)/.test(t)) {
    return {
      title: 'Solar radio burst',
      relevance: 'Possible interference on radio links and GNSS during the event.',
      strong: false,
    };
  }
  return { title: text.trim() || 'Space weather bulletin', relevance: null, strong: false };
}

export function humanizeNoaaAlert(alert: NoaaAlert): HumanizedAlert {
  const message = alert.message ?? '';
  const fields = parseFields(message);
  const getField = (re: RegExp) => fields.find(field => re.test(field.label))?.value ?? null;

  // Bulletin kind + condition sentence from the leading keyword line.
  let kind = 'Bulletin';
  let baseTone: AlertTone = 'info';
  let condition: string | null = null;
  for (const field of fields) {
    const key = field.label.toUpperCase();
    if (KIND_LABELS[key]) {
      ({ kind, tone: baseTone } = KIND_LABELS[key]);
      condition = field.value || null;
      break;
    }
    if (/^CANCEL/.test(key)) {
      kind = 'Cancellation';
      baseTone = 'info';
      condition = field.value || null;
      break;
    }
  }

  const noaaScaleRaw = getField(/^NOAA Scale$/i);
  const scaleLevel = noaaScaleRaw?.match(/\b[GSR]\s?([1-5])\b/i)?.[1] ?? null;
  const { title, relevance, strong } = classify(condition ?? message);

  let tone = baseTone;
  if (scaleLevel) tone = Number(scaleLevel) >= 3 ? 'high' : 'elevated';
  if (strong) tone = 'high';
  if (kind === 'Cancellation') tone = 'info';

  const highlights: AlertHighlight[] = [];
  for (const field of fields) {
    if (NOISE_LABELS.test(field.label)) continue;
    const hit = HIGHLIGHT_LABELS.find(entry => entry.match.test(field.label));
    if (hit && field.value) {
      highlights.push({ label: hit.label, value: prettyTime(field.value) });
      if (highlights.length >= 3) break;
    }
  }

  const issuedRaw = getField(/^Issue Time$/i) ?? alert.issue_datetime;
  const issuedMs = (() => {
    if (!issuedRaw) return null;
    const noaa = parseNoaaTime(issuedRaw);
    if (noaa) return noaa.getTime();
    const parsed = Date.parse(issuedRaw);
    return Number.isNaN(parsed) ? null : parsed;
  })();

  // NOAA re-issues a "CONTINUED ALERT" each day while a condition persists; every re-issue shares
  // the same Space Weather Message Code (e.g. ALTEF3). Grouping by it lets the panel keep only the
  // latest, instead of stacking near-identical cards.
  const messageCode = getField(/^Space Weather Message Code$/i);
  const dedupeKey = messageCode ?? alert.product_id ?? title;

  // When does this reach / affect Earth? Prefer the bulletin's own onset and forecast window.
  const onset = parseNoaaTime(getField(/^Begin Time$/i));
  const validFrom = parseNoaaTime(getField(/^Valid From$/i));
  const validTo = parseNoaaTime(getField(/^Valid To$/i));
  const timing: AlertTiming | null = onset || validFrom || validTo
    ? {
        onsetIso: onset?.toISOString() ?? null,
        validFromIso: validFrom?.toISOString() ?? null,
        validToIso: validTo?.toISOString() ?? null,
        isPrediction: kind === 'Watch' || kind === 'Warning',
      }
    : null;

  return {
    kind,
    title,
    tone,
    noaaScale: noaaScaleRaw ? noaaScaleRaw.replace(/\s*-\s*/, ' — ') : null,
    condition,
    highlights,
    impacts: getField(/^Potential Impacts$/i),
    relevance,
    issuedLabel: issuedRaw ? prettyTime(issuedRaw) : null,
    issuedMs,
    dedupeKey,
    timing,
    raw: message,
  };
}
