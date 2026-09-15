// Canonical make spellings and manufacturer domains (ADR-008 D3 steps 1 and 5). A page on one of a
// make's domains counts as the manufacturer's own; everything else is a third party.
import { normaliseText } from "../search.js";

export interface MakeRecord {
  make: string;
  aliases: readonly string[];
  domains: readonly string[];
}

export const MAKES: readonly MakeRecord[] = [
  { make: "Samsung", aliases: ["samsung electronics"], domains: ["samsung.com"] },
  { make: "LG", aliases: ["lg electronics", "lge"], domains: ["lg.com", "lgbusiness.com"] },
  { make: "Sony", aliases: ["sony electronics"], domains: ["sony.com", "pro.sony"] },
  {
    make: "NEC",
    aliases: ["sharp nec", "nec display"],
    domains: ["sharpnecdisplays.us", "nec.com", "sharpnecdisplays.eu"],
  },
  { make: "Logitech", aliases: ["logi"], domains: ["logitech.com"] },
  { make: "Poly", aliases: ["polycom", "hp poly", "plantronics"], domains: ["poly.com", "hp.com"] },
  { make: "Yealink", aliases: [], domains: ["yealink.com"] },
  { make: "Cisco", aliases: ["webex"], domains: ["cisco.com", "webex.com"] },
  { make: "Neat", aliases: [], domains: ["neat.no"] },
  { make: "Jabra", aliases: ["gn audio"], domains: ["jabra.com"] },
  { make: "Shure", aliases: [], domains: ["shure.com"] },
  { make: "Sennheiser", aliases: [], domains: ["sennheiser.com"] },
  { make: "Biamp", aliases: ["biamp systems"], domains: ["biamp.com"] },
  { make: "QSC", aliases: ["q-sys", "qsys"], domains: ["qsc.com"] },
  { make: "JBL", aliases: ["jbl professional", "harman"], domains: ["jblpro.com", "jbl.com"] },
  { make: "Crestron", aliases: ["crestron electronics"], domains: ["crestron.com"] },
  { make: "Extron", aliases: [], domains: ["extron.com"] },
  { make: "Steelcase", aliases: [], domains: ["steelcase.com"] },
  {
    make: "Herman Miller",
    aliases: ["hermanmiller", "millerknoll"],
    domains: ["hermanmiller.com", "store.hermanmiller.com"],
  },
  { make: "Quartet", aliases: ["acco"], domains: ["quartet.com"] },
];

function key(s: string): string {
  return normaliseText(s)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Canonical make for a typed make: "Samsung Electronics" and "samsung" both give "Samsung". */
export function canonicalMake(make: string): string {
  const k = key(make);
  for (const m of MAKES) if (key(m.make) === k || m.aliases.some((a) => key(a) === k)) return m.make;
  return make.trim();
}

export function makeDomains(make: string): readonly string[] {
  const canonical = canonicalMake(make);
  return MAKES.find((m) => m.make === canonical)?.domains ?? [];
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * True when the URL is on the manufacturer's domain. For an unknown make, a host whose registrable
 * part contains the make's letters counts ("acme" on acme-av.com) so small vendors are not penalised.
 */
export function isManufacturerUrl(url: string, make: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  const domains = makeDomains(make);
  if (domains.length > 0) return domains.some((d) => host === d || host.endsWith(`.${d}`));
  const letters = key(make).replace(/ /g, "");
  if (letters.length < 3) return false;
  const labels = host.split(".");
  const registrable = labels.slice(-2, -1)[0] ?? "";
  return registrable.replace(/[^a-z0-9]/g, "").includes(letters);
}
