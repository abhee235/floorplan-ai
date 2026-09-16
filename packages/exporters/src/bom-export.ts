// BOM spreadsheets (ADR-013 D2, D3): CSV and XLSX renderings of a computed BOM with provenance and the
// verification status of every line. Formatting only: what the lines are is decided by getBom.
import type { Bom, BomLine } from "@fpv/catalog";
import type { Project } from "@fpv/ir";
import { type Cell, type CellStyle, type Sheet, writeXlsx } from "./xlsx.js";

export interface ExportProvenance {
  projectName: string;
  appVersion: string;
  exportedAt: string;
  scope: string;
  currency: string;
  catalogSnapshotAt: string;
  rulesPack: { id: string; version: string };
  /** Exported with `force` over validation errors: every sheet says DRAFT. */
  draft: boolean;
  validationErrors: number;
  /** Exported with `includeUnverified` while unverified or placeholder lines exist. */
  includesUnverified: boolean;
}

export function provenanceFor(
  bom: Bom,
  project: Project,
  options: {
    appVersion: string;
    exportedAt: string;
    scope: string;
    validationErrors: number;
    draft: boolean;
  },
): ExportProvenance {
  return {
    projectName: project.meta.name,
    appVersion: options.appVersion,
    exportedAt: options.exportedAt,
    scope: options.scope,
    currency: bom.currency,
    catalogSnapshotAt: bom.catalogSnapshotAt,
    rulesPack: bom.rulesPack,
    draft: options.draft,
    validationErrors: options.validationErrors,
    includesUnverified: bom.lines.some((l) => l.status === "unverified" || l.status === "placeholder"),
  };
}

/** Source URLs of a product: the project's snapshot first, then the live catalog. */
export type SourceLookup = (productId: string) => readonly string[];

export function sourceLookup(
  project: Project,
  catalog?: { product?(id: string): unknown } | null,
): SourceLookup {
  return (id) => {
    const raw = (project.catalogRefs[id] ?? catalog?.product?.(id)) as
      | { verification?: { sources?: unknown }; priceRecord?: unknown }
      | null
      | undefined;
    const sources = raw?.verification?.sources;
    return Array.isArray(sources) ? sources.filter((s): s is string => typeof s === "string") : [];
  };
}

interface Names {
  level(id: string | null): string;
  room(id: string | null): string;
}

function namesOf(project: Project): Names {
  const levels = new Map(project.levels.map((l) => [l.id, l.name]));
  const rooms = new Map(project.rooms.map((r) => [r.id, r.name ?? r.id]));
  return {
    level: (id) => (id === null ? "" : (levels.get(id) ?? id)),
    room: (id) => (id === null ? "" : (rooms.get(id) ?? id)),
  };
}

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? null : Math.round(n * 100) / 100;
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

function scopeLabel(l: BomLine, names: Names): string {
  if (l.scope.levelId === null) return "project";
  return names.level(l.scope.levelId);
}

function reasonText(l: BomLine): string {
  return `${l.reason.kind}: ${l.reason.ids.join(" ")}`;
}

function provenanceLines(p: ExportProvenance): [string, string][] {
  const out: [string, string][] = [
    ["project", p.projectName],
    ["scope", p.scope],
    ["exported at", p.exportedAt],
    ["app version", p.appVersion],
    ["rules pack", `${p.rulesPack.id} ${p.rulesPack.version}`],
    ["catalog snapshot", p.catalogSnapshotAt],
    ["currency", p.currency],
    ["units", "quantities as counted; lengths in mm"],
  ];
  if (p.draft) out.push(["status", `DRAFT: exported with ${p.validationErrors} validation error(s)`]);
  if (p.includesUnverified)
    out.push(["verification", "contains unverified or placeholder lines; check before ordering"]);
  return out;
}

// ---- CSV ------------------------------------------------------------------------------------------------

export const EXPORT_CSV_COLUMNS = [
  "scope",
  "room",
  "category",
  "make",
  "model",
  "product id",
  "description",
  "quantity",
  "unit",
  "unit price",
  "currency",
  "total",
  "price type",
  "price captured",
  "status",
  "reason",
  "rule",
  "source URLs",
] as const;

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n#]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * The CSV of ADR-013 D3: UTF-8 with a byte order mark, provenance as leading `# key: value` lines, one
 * header row, one row per line, CRLF line ends.
 */
export function bomToExportCsv(
  bom: Bom,
  project: Project,
  provenance: ExportProvenance,
  sources: SourceLookup,
): string {
  const names = namesOf(project);
  const rows: string[] = ["# floorplan-ai bill of materials"];
  for (const [k, v] of provenanceLines(provenance)) rows.push(csvCell(`# ${k}: ${v}`));
  rows.push(EXPORT_CSV_COLUMNS.join(","));
  for (const l of bom.lines)
    rows.push(
      [
        scopeLabel(l, names),
        names.room(l.scope.roomId),
        l.category,
        l.make,
        l.model,
        l.productId ?? l.recipe,
        l.description,
        l.quantity,
        l.unit,
        l.unitPrice ? l.unitPrice.amount.toFixed(2) : null,
        l.unitPrice?.currency ?? null,
        l.total === null ? null : l.total.toFixed(2),
        l.unitPrice?.type ?? null,
        day(l.unitPrice?.capturedAt),
        l.status,
        reasonText(l),
        l.reason.ruleId,
        l.productId ? sources(l.productId).join(" ") : null,
      ]
        .map(csvCell)
        .join(","),
    );
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

// ---- XLSX -----------------------------------------------------------------------------------------------

const LINE_COLUMNS = [
  "Category",
  "Make",
  "Model",
  "Product id",
  "Description",
  "Quantity",
  "Unit",
  "Unit price",
  "Currency",
  "Total",
  "Price type",
  "Price captured",
  "Status",
  "Reason",
  "Rule",
  "Source URLs",
];
const LINE_WIDTHS = [16, 14, 18, 26, 44, 9, 7, 11, 9, 11, 10, 13, 12, 34, 14, 40];

function lineStyle(l: BomLine): CellStyle | undefined {
  if (l.status === "unverified") return "unverified";
  if (l.status === "placeholder") return "placeholder";
  return undefined;
}

function lineCells(l: BomLine, sources: SourceLookup): Cell[] {
  const hl = lineStyle(l);
  const text = (v: string | number | null): Cell => (hl ? { v, s: hl } : { v });
  const num = (v: number | null): Cell => (hl ? { v, s: hl } : { v, s: "money" });
  return [
    text(l.category),
    text(l.make),
    text(l.model),
    text(l.productId ?? l.recipe),
    text(l.description),
    text(l.quantity),
    text(l.unit),
    num(money(l.unitPrice?.amount)),
    text(l.unitPrice?.currency ?? null),
    num(money(l.total)),
    text(l.unitPrice?.type ?? null),
    text(day(l.unitPrice?.capturedAt) || null),
    text(l.status),
    text(reasonText(l)),
    text(l.reason.ruleId),
    text(l.productId ? sources(l.productId).join(" ") || null : null),
  ];
}

function banner(p: ExportProvenance): Cell[][] {
  const rows: Cell[][] = [];
  if (p.draft)
    rows.push([{ v: `DRAFT: exported with ${p.validationErrors} validation error(s)`, s: "draft" }]);
  if (p.includesUnverified)
    rows.push([
      { v: "Contains unverified or placeholder lines (highlighted); check before ordering", s: "draft" },
    ]);
  return rows;
}

function lineSheet(
  name: string,
  title: string,
  lines: readonly BomLine[],
  p: ExportProvenance,
  sources: SourceLookup,
  withScope: boolean,
  names: Names,
): Sheet {
  const top: Cell[][] = [[{ v: title, s: "title" }], ...banner(p)];
  const header: Cell[] = [...(withScope ? ["Scope"] : []), ...LINE_COLUMNS].map((v) => ({ v, s: "header" }));
  const rows = lines.map((l) => [
    ...(withScope ? [{ v: scopeLabel(l, names) } as Cell] : []),
    ...lineCells(l, sources),
  ]);
  return {
    name,
    rows: [...top, header, ...rows],
    widths: withScope ? [14, ...LINE_WIDTHS] : LINE_WIDTHS,
    headerRow: top.length,
  };
}

/** The workbook of ADR-013 D3: Summary, one sheet per room, Project, Products, Provenance. */
export function bomToXlsx(
  bom: Bom,
  project: Project,
  provenance: ExportProvenance,
  sources: SourceLookup,
): Uint8Array {
  const names = namesOf(project);
  const cur = bom.currency;
  const t = bom.totals;
  const summary: Cell[][] = [
    [{ v: `Bill of materials: ${provenance.projectName}`, s: "title" }],
    ...banner(provenance),
    [],
    [
      { v: "Status", s: "header" },
      { v: "Lines", s: "header" },
      { v: `Total (${cur})`, s: "header" },
    ],
    ...(["verified", "unverified", "placeholder", "labour"] as const).map((status): Cell[] => {
      const style: CellStyle | undefined =
        status === "unverified" ? "unverified" : status === "placeholder" ? "placeholder" : undefined;
      const cell = (v: string | number): Cell => (style ? { v, s: style } : { v });
      return [
        cell(status),
        cell(bom.lines.filter((l) => l.status === status).length),
        style ? { v: t[status], s: style } : { v: t[status], s: "money" },
      ];
    }),
    [
      { v: "all", s: "bold" },
      { v: bom.lines.length, s: "bold" },
      { v: t.all, s: "money" },
    ],
  ];
  if (t.excludedCurrencies.length > 0)
    summary.push([{ v: `Not in totals: prices in ${t.excludedCurrencies.join(", ")}` }]);
  summary.push(
    [],
    [
      { v: "Room", s: "header" },
      { v: "Lines", s: "header" },
      { v: `Total (${cur})`, s: "header" },
    ],
  );
  for (const r of bom.byRoom)
    summary.push([{ v: r.name ?? r.roomId }, { v: r.lines }, { v: r.total, s: "money" }]);
  const outside = bom.lines.filter((l) => l.scope.roomId === null);
  summary.push([
    { v: "Project and level" },
    { v: outside.length },
    { v: money(outside.reduce((s, l) => s + (l.total ?? 0), 0)), s: "money" },
  ]);

  const sheets: Sheet[] = [{ name: "Summary", rows: summary, widths: [34, 10, 16] }];
  for (const r of bom.byRoom) {
    const label = names.room(r.roomId);
    sheets.push(
      lineSheet(
        label,
        `Room: ${label}`,
        bom.lines.filter((l) => l.scope.roomId === r.roomId),
        provenance,
        sources,
        false,
        names,
      ),
    );
  }
  sheets.push(lineSheet("Project", "Project and level lines", outside, provenance, sources, true, names));

  const products = new Map<string, BomLine>();
  for (const l of bom.lines) if (l.productId && !products.has(l.productId)) products.set(l.productId, l);
  const productRows: Cell[][] = [...products.values()]
    .sort((a, b) => (a.productId as string).localeCompare(b.productId as string))
    .map((l) => {
      const hl = lineStyle(l);
      const c = (v: string | number | null): Cell => (hl ? { v, s: hl } : { v });
      return [
        c(l.productId),
        c(l.make),
        c(l.model),
        c(l.description),
        c(l.category),
        c(l.status),
        hl ? { v: money(l.unitPrice?.amount), s: hl } : { v: money(l.unitPrice?.amount), s: "money" },
        c(l.unitPrice?.currency ?? null),
        c(l.unitPrice?.type ?? null),
        c(day(l.unitPrice?.capturedAt) || null),
        c(l.unitPrice?.sourceUrl ?? null),
        c(sources(l.productId as string).join(" ") || null),
      ];
    });
  sheets.push({
    name: "Products",
    rows: [
      [
        "Product id",
        "Make",
        "Model",
        "Name",
        "Category",
        "Status",
        "Unit price",
        "Currency",
        "Price type",
        "Price captured",
        "Price source",
        "Verification sources",
      ].map((v): Cell => ({ v, s: "header" })),
      ...productRows,
    ],
    widths: [28, 14, 18, 44, 16, 12, 11, 9, 10, 13, 36, 48],
    headerRow: 0,
  });
  sheets.push({
    name: "Provenance",
    rows: [
      [{ v: "Provenance", s: "title" }],
      ...provenanceLines(provenance).map(([k, v]): Cell[] => [{ v: k, s: "bold" }, { v }]),
    ],
    widths: [20, 70],
  });
  return writeXlsx(sheets);
}
