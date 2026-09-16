// The properties panel (ADR-017 D3): the panel is the selection. With something selected it describes it;
// with nothing selected it shows the level and what the level holds, rather than blank fields.
//
// What an entity IS comes from selection.ts, not from here: the shell needs the same answers for its
// commands, and two places working it out separately is how they drift. How it is LAID OUT is decided
// here, as the owner's design editor (wizzel) lays out its own panel: a title bar, then sections with a
// small heading over a grid, where short values share a line, a surface's material and colour are one
// field, and names and long text take the whole line. That keeps a selection's properties on one screen
// far more often than a column of one row per value did.

import { cn } from "cn";
import { MoveHorizontal, RotateCw, Spline, Users } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Replica } from "../replica.js";
import { projectColours } from "./colour.js";
import { Keyed } from "./Phrase.js";
import { PropertyField, type PropertyFieldProps } from "./PropertyField.js";
import {
  describeEntity,
  type EditCommand,
  type EntityKind,
  type Fact,
  PAINT,
  type SelectedEntity,
  type TextureChoice,
} from "./selection.js";
import { countsText, formatMm } from "./status.js";
import { k, t } from "./tools.js";
import { useProject, useSelectionKey } from "./useReplica.js";

export function PropertiesPanel({
  replica,
  level,
  send,
  textures = [],
  preview,
}: {
  replica: Replica;
  level: string | null;
  /** The catalog's textures, for the material rows (P3-5). */
  textures?: readonly TextureChoice[];
  /** Shows a dragged number's command without sending it; null puts the host's project back. */
  preview?: (command: EditCommand | null) => void;
  /** Sends an edit to the host; throws with the host's reason when it is refused. */
  send: (command: EditCommand) => Promise<void>;
}): JSX.Element {
  const project = useProject(replica);
  const selectionKey = useSelectionKey(replica);
  const selected = selectionKey ? selectionKey.split(",") : [];
  const current = project?.levels.find((l) => l.id === level) ?? project?.levels[0] ?? null;
  // From the host's project, not the one on screen: a colour being dragged across the picker is not yet
  // one the project uses, and would jump about in the swatches as it changed.
  const agreed = replica.agreed ?? project;
  const swatches = useMemo(() => (agreed ? projectColours(agreed) : []), [agreed]);
  // An id can outlive what it named — a patch may have removed it between the selection arriving and
  // this render — so anything describeEntity cannot find is dropped rather than shown as a blank band.
  const entities: SelectedEntity[] = project
    ? selected.flatMap((id) => {
        const found = describeEntity(project, id, { textures });
        return found ? [found] : [];
      })
    : [];

  const propsOf = (entity: SelectedEntity, fact: Fact): PropertyFieldProps => ({
    // Per entity, so two selected walls do not both claim one id; the label is slugged because an id
    // with a space in it is not one a label's htmlFor can name.
    id: `${entity.id}-${slug(fact.label)}`,
    label: fact.label,
    caption: fact.caption,
    prefix: fact.prefix,
    glyph: glyphOf(fact),
    value: fact.value,
    unit: fact.unit,
    choices: fact.choices,
    empty: fact.empty,
    hint: fact.hint,
    colour: fact.colour,
    swatches: fact.colour ? swatches : undefined,
    toggle: fact.toggle,
    showUnit: fact.unit !== "mm",
    edit: fact.edit,
    send,
    preview,
  });

  const cells = (entity: SelectedEntity, facts: readonly Fact[]): ReactNode[] =>
    layout(facts).map((cell) => {
      if (cell.kind === "field")
        return (
          <PropertyField key={cell.fact.label} {...propsOf(entity, cell.fact)} className={place(cell)} />
        );
      // A surface's material and colour, as one field: picking one clears the other, so they are one
      // choice. The colour is typed or picked; the list at its end holds paint and the textures.
      const { material, colour } = cell;
      const worn =
        material.value === PAINT ? null : material.choices?.find((c) => c.value === material.value);
      return (
        <PropertyField
          key={colour.label}
          {...propsOf(entity, colour)}
          empty={worn && colour.empty ? { ...colour.empty, shown: worn.label } : colour.empty}
          swatchImage={worn?.image}
          className={place(cell)}
          trailing={<PropertyField {...propsOf(entity, material)} bare />}
        />
      );
    });

  return (
    <aside aria-label="Properties" className="flex h-full min-h-0 flex-col">
      {/* Radix sizes the scrolled content as a table, which lets one long title widen the whole panel
          past its edge; as a block, long text truncates where it should. */}
      <ScrollArea className="min-h-0 grow [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="pb-3">
          {/* With nothing selected, how to select comes first; with a selection, the selection does, and how
              to change it waits at the end. */}
          {entities.length === 0 ? <SelectionNote count={selected.length} /> : null}

          {/* One block per selected entity. Beyond a handful this would want collapsing, but a long
              scroll is a better failure than hiding what is selected. */}
          {entities.map((entity) => (
            <section key={entity.id} aria-labelledby={`${entity.id}-title`} className="border-b">
              <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
                <h3
                  id={`${entity.id}-title`}
                  title={entity.title}
                  className="min-w-0 truncate text-[13px] font-medium text-foreground"
                >
                  {entity.title}
                </h3>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">
                  {KIND_NAMES[entity.kind]}
                </span>
              </div>
              {bands(entity.facts).map((band, index) => {
                if (!band.title)
                  return (
                    <Grid key={`rows-${index}`} className="px-3 pt-1 pb-2">
                      {cells(entity, band.facts)}
                    </Grid>
                  );
                // A named group, so a screen reader says "Position" on the way in and every cell need not
                // repeat it.
                const headingId = `${entity.id}-${slug(band.title)}-heading`;
                return (
                  <div
                    key={band.title}
                    role="group"
                    aria-labelledby={headingId}
                    className="border-t border-border/60 px-3 pt-2 pb-2"
                  >
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <h4 id={headingId} className="min-w-0 truncate text-xs font-semibold text-foreground">
                        {band.title}
                      </h4>
                      {band.facts.some((f) => f.unit === "mm") ? <MillimetresNote /> : null}
                    </div>
                    <Grid>{cells(entity, band.facts)}</Grid>
                  </div>
                );
              })}
            </section>
          ))}

          {/* The level is what the panel is about when nothing is selected; beside a selection it only
              pushed the selection's own values off the screen. */}
          {current && entities.length === 0 ? (
            <section aria-labelledby="level-title" className="border-b px-3 pt-2.5 pb-2.5">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <h3 id="level-title" className="text-xs font-semibold text-foreground">
                  Level
                </h3>
                <MillimetresNote />
              </div>
              {/* "of level" in every name: the selection above can have a Name and a Height of its own, and two
                  fields that sound the same cannot be told apart by a screen reader or by voice. */}
              <Grid>
                <PropertyField
                  id="level-name"
                  label="Name of level"
                  caption="Name"
                  value={current.name}
                  className={SPAN[6]}
                />
                <PropertyField
                  id="level-elevation"
                  label="Elevation of level"
                  caption="Elevation"
                  glyph="E"
                  value={formatMm(current.elevation)}
                  unit="mm"
                  showUnit={false}
                  className={SPAN[2]}
                />
                <PropertyField
                  id="level-height"
                  label="Height of level"
                  caption="Height"
                  glyph="H"
                  value={formatMm(current.height)}
                  unit="mm"
                  showUnit={false}
                  className={SPAN[2]}
                />
                <PropertyField
                  id="level-floor"
                  label="Floor of level"
                  caption="Floor"
                  glyph="F"
                  value={formatMm(current.floorThickness)}
                  unit="mm"
                  showUnit={false}
                  className={SPAN[2]}
                />
              </Grid>
            </section>
          ) : null}

          {entities.length > 0 ? <SelectionNote count={selected.length} /> : null}

          {entities.length === 0 ? (
            <section aria-labelledby="counts-title" className="px-3 pt-2.5">
              <h3 id="counts-title" className="mb-1 text-xs font-semibold text-foreground">
                This level
              </h3>
              <p className="text-xs text-muted-foreground tabular-nums">{countsText(project)}</p>
            </section>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

function SelectionNote({ count }: { count: number }): JSX.Element {
  return (
    <p
      className={cn(
        "px-3 py-2 text-[11px] leading-relaxed text-muted-foreground",
        count === 0 ? "border-b" : "",
      )}
    >
      <span className="font-medium text-foreground">{heading(count)}</span>
      {" · "}
      {count === 0 ? (
        <Keyed
          phrase={[
            t("Click an entity, or press "),
            k("Tab"),
            t(" to step through them. These settings apply to the level."),
          ]}
        />
      ) : (
        <Keyed phrase={[k("Del"), t(" removes, Shift-click adds")]} />
      )}
    </p>
  );
}

function heading(count: number): string {
  return count === 0 ? "Nothing selected" : `${count} selected`;
}

const KIND_NAMES: Record<EntityKind, string> = {
  wall: "Wall",
  room: "Room",
  opening: "Opening",
  item: "Item",
};

/** Said once per band instead of in every field: the band's lengths are millimetres. */
function MillimetresNote(): JSX.Element {
  return (
    <span
      className="shrink-0 text-[10px] text-muted-foreground"
      title="Lengths in this band are in millimetres"
    >
      mm
    </span>
  );
}

/** Six columns: a half is three of them, a third two, the whole line six. */
function Grid({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn("grid grid-cols-6 gap-x-2 gap-y-1.5", className)}>{children}</div>;
}

const SPAN: Record<number, string> = { 2: "col-span-2", 3: "col-span-3", 4: "col-span-4", 6: "col-span-6" };
const place = (cell: Cell): string => cn(SPAN[cell.span], cell.first ? "col-start-1" : "");

/** A cell of a band's grid; `first` starts a line, which the grid would otherwise fill from the one above. */
type Cell = { span: number; first: boolean } & (
  | { kind: "field"; fact: Fact }
  | { kind: "fill"; material: Fact; colour: Fact }
);

const isMaterial = (f: Fact | undefined): boolean => f?.choices?.some((c) => c.value === PAINT) ?? false;

/**
 * The band's cells, packed into lines of six columns in the order selection.ts gave them. Each cell asks
 * for the least it can be read in: a third for a short number, a choice beside a colour, or a checkbox; a
 * half for anything else, and for a number whose empty meaning is long ("level · 2 700 mm"); two thirds
 * for a surface's colour and material; the whole line for a name, a list with long entries or long text.
 * A coordinate pair always has a line to itself. A line left short is widened, cells that can grow taking
 * half each, so a lone number does not stretch across the panel.
 */
export function layout(facts: readonly Fact[]): Cell[] {
  const items: { cell: Cell; grows: boolean; ownLine: boolean }[] = [];
  for (let i = 0; i < facts.length; i += 1) {
    const f = facts[i] as Fact;
    const next = facts[i + 1];
    if (isMaterial(f) && next?.colour) {
      items.push({
        cell: { kind: "fill", material: f, colour: next, span: 4, first: false },
        grows: false,
        ownLine: false,
      });
      i += 1;
      continue;
    }
    const afterFill = items.at(-1)?.cell.kind === "fill";
    const wide =
      f.align === "left" ||
      isMaterial(f) ||
      (f.choices?.some((c) => c.label.length > 16) ?? false) ||
      (!f.edit && !f.unit && !f.toggle && !f.choices && f.value.length > 14);
    let span = 3;
    let grows = false;
    if (wide) span = 6;
    else if (f.prefix) span = 3;
    else if (f.toggle) [span, grows] = [2, true];
    else if (f.unit) {
      const longEmpty = f.value === "" && (f.empty?.shown.length ?? 0) > 9;
      [span, grows] = longEmpty ? [3, false] : [2, true];
    } else if (f.choices && afterFill) span = 2;
    items.push({ cell: { kind: "field", fact: f, span, first: false }, grows, ownLine: f.prefix === "X" });
  }

  const lines: (typeof items)[] = [];
  let line: typeof items = [];
  let used = 0;
  for (const item of items) {
    if (line.length > 0 && (item.ownLine || used + item.cell.span > 6)) {
      lines.push(line);
      line = [];
      used = 0;
    }
    line.push(item);
    used += item.cell.span;
  }
  if (line.length > 0) lines.push(line);

  for (const l of lines) {
    if (l[0]) l[0].cell.first = true;
    let sum = l.reduce((n, item) => n + item.cell.span, 0);
    for (const item of l)
      if (item.grows && item.cell.span === 2 && sum < 6) {
        item.cell.span = 3;
        sum += 1;
      }
  }
  return items.map((item) => item.cell);
}

/**
 * The mark inside a number's field, which is also its handle: the axis of a coordinate, an icon where one
 * says it better than a letter, and otherwise the first letter of the name the caption prints.
 */
export function glyphOf(fact: Fact): ReactNode {
  if (fact.prefix) return fact.prefix;
  if (!fact.unit) return undefined;
  const printed = fact.caption || fact.label;
  if (fact.unit === "°") return /rotation/i.test(printed) ? <RotateCw aria-hidden /> : <Spline aria-hidden />;
  if (fact.unit === "seats") return <Users aria-hidden />;
  if (/^from /i.test(printed)) return <MoveHorizontal aria-hidden />;
  return printed.charAt(0).toUpperCase();
}

/** Runs of rows that share a group, in the order selection.ts gave them. */
function bands(facts: readonly Fact[]): { title: string | null; facts: Fact[] }[] {
  const out: { title: string | null; facts: Fact[] }[] = [];
  for (const fact of facts) {
    const title = fact.group ?? null;
    const last = out.at(-1);
    if (last && last.title === title) last.facts.push(fact);
    else out.push({ title, facts: [fact] });
  }
  return out;
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
