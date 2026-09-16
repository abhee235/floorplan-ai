// The properties panel (ADR-017 D3): the panel is the selection. With nothing selected it shows the level
// and what the level holds. Binding it to a selected entity is the next increment; until then it says
// plainly that nothing is selected rather than showing blank fields.
//
// Field sizing comes from the density block in styles.css, not from here.

import type { JSX } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Replica } from "../replica.js";
import { countsText, formatMm } from "./status.js";
import { useProject, useSelectionKey } from "./useReplica.js";

export function PropertiesPanel({ replica, level }: { replica: Replica; level: string | null }): JSX.Element {
  const project = useProject(replica);
  const selectionKey = useSelectionKey(replica);
  const selected = selectionKey ? selectionKey.split(",") : [];
  const current = project?.levels.find((l) => l.id === level) ?? project?.levels[0] ?? null;

  return (
    <aside aria-label="Properties" className="flex min-h-0 w-72 flex-col border-l bg-card">
      <ScrollArea className="min-h-0 grow">
        <div className="pb-4">
          <Section title={heading(selected.length)}>
            <p className="leading-relaxed text-muted-foreground">
              {selected.length === 0
                ? "Click an entity, or press Tab to step through them. These settings apply to the level."
                : "Editing a selection arrives with the next tool; the plan still shows what is chosen."}
            </p>
          </Section>

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
      <p className="mb-2 text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

/** Read-only for now, but still focusable: a disabled field would drop out of the keyboard path. */
function Field({
  label,
  value,
  align = "right",
}: {
  label: string;
  value: string;
  align?: "left" | "right";
}): JSX.Element {
  const id = `level-${label.toLowerCase()}`;
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
