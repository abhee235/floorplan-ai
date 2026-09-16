// The properties panel (ADR-017 D3): the panel is the selection. With something selected it describes it;
// with nothing selected it shows the level and what the level holds, rather than blank fields.
//
// What an entity IS comes from selection.ts, not from here: the shell needs the same answers for its
// commands, and two places working it out separately is how they drift.

import type { JSX } from "react";
import { Fragment } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Replica } from "../replica.js";
import { Keyed } from "./Phrase.js";
import { PropertyField } from "./PropertyField.js";
import { describeEntity, type EditCommand, type Fact, type SelectedEntity } from "./selection.js";
import { countsText, formatMm } from "./status.js";
import { k, t } from "./tools.js";
import { useProject, useSelectionKey } from "./useReplica.js";

export function PropertiesPanel({
  replica,
  level,
  send,
}: {
  replica: Replica;
  level: string | null;
  /** Sends an edit to the host; throws with the host's reason when it is refused. */
  send: (command: EditCommand) => Promise<void>;
}): JSX.Element {
  const project = useProject(replica);
  const selectionKey = useSelectionKey(replica);
  const selected = selectionKey ? selectionKey.split(",") : [];
  const current = project?.levels.find((l) => l.id === level) ?? project?.levels[0] ?? null;
  // An id can outlive what it named — a patch may have removed it between the selection arriving and
  // this render — so anything describeEntity cannot find is dropped rather than shown as a blank band.
  const entities: SelectedEntity[] = project
    ? selected.flatMap((id) => {
        const found = describeEntity(project, id);
        return found ? [found] : [];
      })
    : [];

  return (
    <aside aria-label="Properties" className="flex min-h-0 w-72 flex-col border-l bg-card">
      <ScrollArea className="min-h-0 grow">
        <div className="pb-4">
          <Section title={heading(selected.length)}>
            {selected.length === 0 ? (
              <p className="leading-relaxed text-muted-foreground">
                <Keyed
                  phrase={[
                    t("Click an entity, or press "),
                    k("Tab"),
                    t(" to step through them. These settings apply to the level."),
                  ]}
                />
              </p>
            ) : (
              <p className="leading-relaxed text-muted-foreground">
                <Keyed phrase={[k("Del"), t(" removes the selection. Shift-click adds to it.")]} />
              </p>
            )}
          </Section>

          {/* One band per selected entity. Beyond a handful this would want collapsing, but a long
              scroll is a better failure than hiding what is selected. */}
          {entities.map((entity) => (
            <Section key={entity.id} title={entity.title}>
              {bands(entity.facts).map((band, index) => {
                const rows = band.facts.map((fact) => (
                  <PropertyField
                    key={fact.label}
                    // Per entity, so two selected walls do not both claim one id; the label is slugged
                    // because an id with a space in it is not one a label's htmlFor can name.
                    id={`${entity.id}-${slug(fact.label)}`}
                    label={fact.label}
                    caption={fact.caption}
                    prefix={fact.prefix}
                    value={fact.value}
                    unit={fact.unit}
                    choices={fact.choices}
                    empty={fact.empty}
                    hint={fact.hint}
                    colour={fact.colour}
                    toggle={fact.toggle}
                    {...(fact.align ? { align: fact.align } : {})}
                    edit={fact.edit}
                    send={send}
                  />
                ));
                if (!band.title) return <Fragment key={`rows-${index}`}>{rows}</Fragment>;
                // A named group, so a screen reader says "Position" on the way in and every row need not
                // repeat it. A div rather than a fieldset: a legend is laid out in the fieldset's border,
                // which put the band's spacing under its heading instead of above it.
                const headingId = `${entity.id}-${slug(band.title)}-heading`;
                return (
                  <div
                    key={band.title}
                    role="group"
                    aria-labelledby={headingId}
                    className="space-y-1.5 pt-2.5"
                  >
                    <p id={headingId} className="text-xs font-medium text-foreground">
                      {band.title}
                    </p>
                    {rows}
                  </div>
                );
              })}
            </Section>
          ))}

          {current ? (
            <Section title="Level">
              {/* "of level" in every name: the selection above can have a Name and a Height of its own, and two
                  fields that sound the same cannot be told apart by a screen reader or by voice. */}
              <PropertyField
                id="level-name"
                label="Name of level"
                caption="Name"
                value={current.name}
                align="left"
              />
              <PropertyField
                id="level-elevation"
                label="Elevation of level"
                caption="Elevation"
                value={`${formatMm(current.elevation)} mm`}
              />
              <PropertyField
                id="level-height"
                label="Height of level"
                caption="Height"
                value={`${formatMm(current.height)} mm`}
              />
              <PropertyField
                id="level-floor"
                label="Floor of level"
                caption="Floor"
                value={`${formatMm(current.floorThickness)} mm`}
              />
            </Section>
          ) : null}

          <Section title="This level">
            <p className="text-muted-foreground tabular-nums">{countsText(project)}</p>
          </Section>
        </div>
      </ScrollArea>
    </aside>
  );
}

function heading(count: number): string {
  if (count === 0) return "Nothing selected";
  return count === 1 ? "One entity selected" : `${count} entities selected`;
}

/** Sections carry their own divider, so the panel reads as bands rather than a run of paragraphs. */
function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="border-b px-3 py-2 last:border-b-0">
      {/* text-foreground, not muted. The heading is what tells you WHICH band of the panel you are reading,
          so it is the one line that has to survive a glance; muting it left the panel a uniform grey wash
          with only the field values carrying any weight. Uppercase and tracking already mark it as a
          heading, so the colour is free to do contrast instead of hierarchy. */}
      <p className="mb-2 text-xs font-medium tracking-[0.06em] text-foreground uppercase">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
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
