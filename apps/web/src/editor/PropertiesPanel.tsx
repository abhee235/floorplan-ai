// The properties panel (ADR-017 D3): the panel is the selection. With something selected it describes it;
// with nothing selected it shows the level and what the level holds, rather than blank fields.
//
// What an entity IS comes from selection.ts, not from here: the shell needs the same answers for its
// commands, and two places working it out separately is how they drift. How it is LAID OUT is decided
// here. The idea comes from the owner's design editor (wizzel): a title, then bands, each a heading over
// fields set two to a line, so a selection takes half the height a column of rows did. The parts and the
// sizes are this app's own: its text size, its bordered fields, its spacing.

import { cn } from "cn";
import {
  DoorOpen,
  Grid2x2,
  Layers,
  type LucideIcon,
  Move,
  Move3d,
  Package,
  PaintRoller,
  Palette,
  PanelTop,
  Ruler,
  Scan,
  SquareDashed,
} from "lucide-react";
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
    prefix: markOf(fact),
    value: fact.value,
    unit: fact.unit,
    choices: fact.choices,
    empty: fact.empty,
    hint: fact.hint,
    colour: fact.colour,
    swatches: fact.colour ? swatches : undefined,
    toggle: fact.toggle,
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
        <div className="pb-2">
          {entities.length === 0 ? <SelectionNote count={selected.length} /> : null}

          {/* One block per selected entity. Beyond a handful this would want collapsing, but a long
              scroll is a better failure than hiding what is selected. */}
          {entities.map((entity) => {
            const kind = KIND_NAMES[entity.kind];
            return (
              <section key={entity.id} aria-labelledby={`${entity.id}-title`} className="border-b">
                <header className="px-4 pt-3.5 pb-1">
                  <h3 id={`${entity.id}-title`} className="line-clamp-2 font-semibold break-words">
                    {entity.title}
                  </h3>
                  {/* What it is, when its name does not say: a room is called Boardroom, a wall is called Wall. */}
                  {entity.title === kind ? null : <p className="text-muted-foreground">{kind}</p>}
                </header>
                {bands(entity.facts).map((band, index) => {
                  if (!band.title)
                    return (
                      <Grid key={`rows-${index}`} className="px-4 pt-2 pb-4">
                        {cells(entity, band.facts)}
                      </Grid>
                    );
                  // A named group, so a screen reader says "Position" on the way in and every cell need
                  // not repeat it.
                  const headingId = `${entity.id}-${slug(band.title)}-heading`;
                  const Icon = iconOf(band.title);
                  return (
                    <div
                      key={band.title}
                      role="group"
                      aria-labelledby={headingId}
                      className="border-t px-4 pt-3 pb-3.5"
                    >
                      <h4 id={headingId} className="mb-2.5 flex min-w-0 items-center gap-2 font-medium">
                        {Icon ? (
                          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : null}
                        <span className="truncate">{band.title}</span>
                      </h4>
                      <Grid>{cells(entity, band.facts)}</Grid>
                    </div>
                  );
                })}
              </section>
            );
          })}

          {/* The level is what the panel is about when nothing is selected; beside a selection it only
              pushed the selection's own values off the screen. */}
          {current && entities.length === 0 ? (
            <section aria-labelledby="level-title" className="border-b px-4 py-3.5">
              <h3 id="level-title" className="mb-3 flex items-center gap-2 font-medium">
                <Layers aria-hidden className="size-3.5 text-muted-foreground" />
                Level
              </h3>
              {/* "of level" in every name: the selection above can have a Name and a Height of its own, and two
                  fields that sound the same cannot be told apart by a screen reader or by voice. */}
              <Grid>
                <PropertyField
                  id="level-name"
                  label="Name of level"
                  caption="Name"
                  value={current.name}
                  className="col-span-2"
                />
                <PropertyField
                  id="level-elevation"
                  label="Elevation of level"
                  caption="Elevation"
                  prefix="E"
                  value={formatMm(current.elevation)}
                  unit="mm"
                />
                <PropertyField
                  id="level-height"
                  label="Height of level"
                  caption="Height"
                  prefix="H"
                  value={formatMm(current.height)}
                  unit="mm"
                />
                <PropertyField
                  id="level-floor"
                  label="Floor of level"
                  caption="Floor"
                  prefix="F"
                  value={formatMm(current.floorThickness)}
                  unit="mm"
                />
              </Grid>
            </section>
          ) : null}

          {entities.length === 0 ? (
            <section aria-labelledby="counts-title" className="px-4 py-3.5">
              <h3 id="counts-title" className="mb-1 font-medium">
                This level
              </h3>
              <p className="text-muted-foreground tabular-nums">{countsText(project)}</p>
            </section>
          ) : (
            <SelectionNote count={selected.length} />
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}

/** What is selected, and how to change that: first when nothing is, after the selection when something is. */
function SelectionNote({ count }: { count: number }): JSX.Element {
  return (
    <p className={cn("px-4 py-3 leading-relaxed text-muted-foreground", count === 0 ? "border-b" : "")}>
      <span className="font-medium text-foreground">{heading(count)}.</span>{" "}
      {count === 0 ? (
        <Keyed
          phrase={[
            t("Click an entity, or press "),
            k("Tab"),
            t(" to step through them. These settings apply to the level."),
          ]}
        />
      ) : (
        <Keyed phrase={[k("Del"), t(" removes it. Shift-click adds to it.")]} />
      )}
    </p>
  );
}

function heading(count: number): string {
  if (count === 0) return "Nothing selected";
  return count === 1 ? "One selected" : `${count} selected`;
}

const KIND_NAMES: Record<EntityKind, string> = {
  wall: "Wall",
  room: "Room",
  opening: "Opening",
  item: "Item",
  zone: "Desk cluster",
};

/** A small picture beside a band's name, so a long panel can be scanned by shape as well as by word. */
function iconOf(title: string): LucideIcon | null {
  if (/^(left|right) side/i.test(title)) return PaintRoller;
  const icons: Record<string, LucideIcon> = {
    Position: Move,
    Placement: Move3d,
    "Shape and size": Ruler,
    Size: Scan,
    Product: Package,
    Floor: SquareDashed,
    Ceiling: PanelTop,
    Swing: DoorOpen,
    Layout: Grid2x2,
    Holds: Package,
  };
  // what is left is an item's parts: Top, Legs, Fabric, Frame and the like
  return icons[title] ?? Palette;
}

/** Words that carry no meaning in a field's mark: "Height at end" is HE, not HAE. */
const SMALL_WORDS = new Set(["at", "of", "in", "the", "from", "on", "to"]);

/**
 * The letter or two inside a number's field, which is also the handle to drag it by: the axis of a
 * coordinate where there is one, else the initials of the name the caption prints — L for Length, HE for
 * Height at end, W for the opening's gap From west end. A value with no unit is not a number to drag and
 * gets no mark.
 */
export function markOf(fact: Fact): string | undefined {
  if (fact.prefix) return fact.prefix;
  if (!fact.unit) return undefined;
  const name = fact.caption || fact.label;
  // "From west end" is the gap to that end of the wall, and the compass word is what tells the two apart.
  if (/^from\s/i.test(name)) return name.split(/\s+/)[1]?.[0]?.toUpperCase();
  const words = name.split(/[\s,]+/).filter((w) => w.length > 0 && !SMALL_WORDS.has(w.toLowerCase()));
  const initials = words.map((w) => (w[0] as string).toUpperCase()).join("");
  return initials.slice(0, 2) || undefined;
}

/** Two columns, and never more: a value gets half the panel, or all of it. */
function Grid({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn("grid grid-cols-2 gap-x-3 gap-y-3", className)}>{children}</div>;
}

/** A cell of a band's grid; `first` starts a line, which the grid would otherwise fill from the one above. */
type Cell = { span: 1 | 2; first: boolean } & (
  | { kind: "field"; fact: Fact }
  | { kind: "fill"; material: Fact; colour: Fact }
);

const place = (cell: Cell): string =>
  cn(cell.span === 2 ? "col-span-2" : "", cell.first ? "col-start-1" : "");

const isMaterial = (f: Fact | undefined): boolean => f?.choices?.some((c) => c.value === PAINT) ?? false;

/**
 * The band's cells in the order selection.ts gave them, each half the panel or all of it. The whole width
 * goes to what needs it: a name, a surface's colour and material together (texture names are long), a list
 * with long entries, a number whose empty meaning is too long for half the panel, and long text that is
 * only read. A coordinate pair always starts its own line, so X and Y sit side by side.
 */
export function layout(facts: readonly Fact[]): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < facts.length; i += 1) {
    const f = facts[i] as Fact;
    const next = facts[i + 1];
    if (isMaterial(f) && next?.colour) {
      cells.push({ kind: "fill", material: f, colour: next, span: 2, first: false });
      i += 1;
      continue;
    }
    const wide =
      f.align === "left" ||
      isMaterial(f) ||
      (f.choices?.some((c) => c.label.length > 14) ?? false) ||
      (f.value === "" && (f.empty?.shown.length ?? 0) > 16) ||
      (!f.edit && !f.unit && !f.choices && f.value.length > 16);
    cells.push({ kind: "field", fact: f, span: wide ? 2 : 1, first: f.prefix === "X" });
  }
  return cells;
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
