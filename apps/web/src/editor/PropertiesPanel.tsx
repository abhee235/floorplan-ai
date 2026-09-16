// The properties panel (ADR-017 D3): the panel is the selection. With something selected it describes it;
// with nothing selected it shows the level and what the level holds, rather than blank fields.
//
// What an entity IS comes from selection.ts, not from here: the shell needs the same answers for its
// commands, and two places working it out separately is how they drift.

import type { JSX } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Replica } from "../replica.js";
import { Keyed } from "./Phrase.js";
import { describeEntity, type SelectedEntity } from "./selection.js";
import { countsText, formatMm } from "./status.js";
import { k, t } from "./tools.js";
import { useProject, useSelectionKey } from "./useReplica.js";

export function PropertiesPanel({ replica, level }: { replica: Replica; level: string | null }): JSX.Element {
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
              {entity.facts.map((fact) => (
                <Field
                  key={fact.label}
                  label={fact.label}
                  value={fact.value}
                  id={`${entity.id}-${fact.label}`}
                />
              ))}
            </Section>
          ))}

          {current ? (
            <Section title="Level">
              <Field label="Name" value={current.name} align="left" />
              <Field label="Elevation" value={`${formatMm(current.elevation)} mm`} />
              <Field label="Height" value={`${formatMm(current.height)} mm`} />
              <Field label="Floor" value={`${formatMm(current.floorThickness)} mm`} />
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

/** Read-only for now, but still focusable: a disabled field would drop out of the keyboard path. */
function Field({
  label,
  value,
  align = "right",
  id: idOverride,
}: {
  label: string;
  value: string;
  align?: "left" | "right";
  /** Entity fields pass their own, so two selected walls do not both claim `level-length`. */
  id?: string;
}): JSX.Element {
  const id = idOverride ?? `level-${label.toLowerCase()}`;
  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        readOnly
        value={value}
        className={`h-7 w-[150px] ${align === "right" ? "text-right tabular-nums" : ""}`}
      />
    </div>
  );
}
