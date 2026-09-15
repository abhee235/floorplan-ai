// Reading a room brief (spec 04 create_room_from_brief): size, seats, purpose and AV needs from one
// sentence, by rules rather than a model, so the same brief always gives the same room. Anything the
// brief leaves out is assumed and said so, so the caller can correct it.
import type { Room } from "@fpv/ir";

type RoomPurpose = Room["purpose"];

export interface BriefUnderstanding {
  purpose: RoomPurpose;
  capacity: number;
  /** Clear inside size in mm; width runs west to east, depth south to north. */
  widthMm: number;
  depthMm: number;
  av: string[];
  name: string;
  /** What was not in the brief and had to be assumed. */
  assumed: string[];
}

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fourteen: 14,
  sixteen: 16,
  eighteen: 18,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

/** Floor area per seat by purpose, m². */
const AREA_PER_SEAT: Partial<Record<RoomPurpose, number>> = {
  huddle: 2.5,
  meeting: 3,
  boardroom: 3.5,
  training: 2.2,
};

const UNIT = String.raw`(mm|cm|m|metres?|meters?|ft|feet|foot|')`;
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const SIZE = new RegExp(String.raw`${NUM}\s*${UNIT}?\s*(?:x|×|\*|by)\s*${NUM}\s*${UNIT}?`, "i");
const AREA = new RegExp(String.raw`${NUM}\s*(?:m2|m²|sq\.?\s*m|sqm|square\s+met(?:re|er)s?)`, "i");
const SEATS = new RegExp(
  String.raw`(\d+|${Object.keys(WORD_NUMBERS).join("|")})\s*-?\s*(?:seats?|seater|people|persons?|person|pax|attendees|delegates|participants)`,
  "i",
);
const FOR = new RegExp(String.raw`\bfor\s+(\d+|${Object.keys(WORD_NUMBERS).join("|")})\b`, "i");

function toMm(value: string, unit: string | undefined): number {
  const n = Number(value.replace(",", "."));
  const u = unit?.toLowerCase();
  if (u === "mm") return n;
  if (u === "cm") return n * 10;
  if (u === "ft" || u === "feet" || u === "foot" || u === "'") return n * 304.8;
  if (u?.startsWith("m")) return n * 1000;
  return n <= 50 ? n * 1000 : n; // bare numbers: metres when small, millimetres otherwise
}

function count(text: string): number {
  const n = Number(text);
  return Number.isFinite(n) ? n : (WORD_NUMBERS[text.toLowerCase()] ?? Number.NaN);
}

const roundUp = (mm: number, step = 100) => Math.ceil(mm / step) * step;

export function parseBrief(brief: string): BriefUnderstanding {
  const text = brief.trim();
  const lower = text.toLowerCase();
  const assumed: string[] = [];

  let capacity: number | null = null;
  const seats = SEATS.exec(text) ?? FOR.exec(text);
  if (seats) {
    const n = count(seats[1] as string);
    if (Number.isFinite(n) && n > 0) capacity = Math.round(n);
  }

  let purpose: RoomPurpose | null = null;
  if (/board\s*room/.test(lower)) purpose = "boardroom";
  else if (/huddle|focus room|phone booth/.test(lower)) purpose = "huddle";
  else if (/training|classroom|lecture|seminar/.test(lower)) purpose = "training";
  else if (/meeting|conference/.test(lower)) purpose = "meeting";

  let widthMm: number | null = null;
  let depthMm: number | null = null;
  const size = SIZE.exec(text);
  if (size) {
    const unit = size[4] ?? size[2];
    widthMm = Math.round(toMm(size[1] as string, size[2] ?? unit));
    depthMm = Math.round(toMm(size[3] as string, unit));
  }
  const area = AREA.exec(text);

  if (!purpose) {
    const c = capacity ?? 8;
    purpose = c <= 4 ? "huddle" : c <= 20 ? "meeting" : "training";
    assumed.push(`purpose not stated; assumed ${purpose}`);
  }
  if (capacity === null) {
    const m2 =
      widthMm && depthMm
        ? (widthMm * depthMm) / 1e6
        : area
          ? Number((area[1] as string).replace(",", "."))
          : null;
    capacity = m2
      ? Math.max(2, Math.floor(m2 / (AREA_PER_SEAT[purpose] ?? 3)))
      : purpose === "huddle"
        ? 4
        : purpose === "training"
          ? 24
          : 8;
    assumed.push(`seats not stated; assumed ${capacity}`);
  }
  if (widthMm === null || depthMm === null) {
    const m2 = area
      ? Number((area[1] as string).replace(",", "."))
      : Math.max(9, capacity * (AREA_PER_SEAT[purpose] ?? 3));
    widthMm = roundUp(Math.sqrt(m2 * 1.6) * 1000);
    depthMm = roundUp((m2 * 1e6) / widthMm);
    assumed.push(`size not stated; assumed ${widthMm / 1000} by ${depthMm / 1000} m`);
  }

  const av: string[] = [];
  if (/video\s*-?\s*conferenc|\bvc\b|zoom|teams|webex|video call|hybrid/.test(lower))
    av.push("video-conferencing");
  if (/display|screen|\btv\b|monitor|presentation/.test(lower)) av.push("display");
  if (/audio|speaker|sound|microphone|\bmics?\b/.test(lower)) av.push("audio");
  if (/whiteboard/.test(lower)) av.push("whiteboard");
  if (/scheduler|booking panel|room booking/.test(lower)) av.push("scheduler");

  const name = purpose === "boardroom" ? "Boardroom" : `${purpose[0]?.toUpperCase()}${purpose.slice(1)} room`;
  return { purpose, capacity, widthMm, depthMm, av, name, assumed };
}
