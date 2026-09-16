// The properties panel (ADR-017 D3): the panel is the selection. With nothing selected it shows the level
// and what the level holds. Binding it to a selected entity is the next increment; until then it says
// plainly that nothing is selected rather than showing blank fields.

import type { JSX } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { Replica } from "../replica.js";
import { countsText, formatMm } from "./status.js";
import { useProject, useSelectionKey } from "./useReplica.js";

export function PropertiesPanel({ replica, level }: { replica: Replica; level: string | null }): JSX.Element {
  const project = useProject(replica);
  const selectionKey = useSelectionKey(replica);
  const selected = selectionKey ? selectionKey.split(",") : [];
  const current = project?.levels.find((l) => l.id === level) ?? project?.levels[0] ?? null;

  return (
    <aside aria-label="Properties" className="flex min-h-0 w-[296px] flex-col border-l bg-card">
      <ScrollArea className="min-h-0 grow">
        <div className="space-y-3 px-3 py-2.5">
          <SectionHeading>
            {selected.length === 0
              ? "Nothing selected"
              : selected.length === 1
                ? "One entity selected"
                : `${selected.length} entities selected`}
          </SectionHeading>
          <p className="text-muted-foreground">
            {selected.length === 0
              ? "Click an entity in the plan, or press Tab to step through them. These settings apply to the level."
              : "Editing a selection arrives with the next tool; the plan still shows what is chosen."}
          </p>

          {current ? (
            <>
              <Separator />
              <SectionHeading>Level</SectionHeading>
              <Field label="Name" value={current.name} align="left" />
              <Field label="Elevation" value={`${formatMm(current.elevation)} mm`} />
              <Field label="Height" value={`${formatMm(current.height)} mm`} />
              <Field label="Floor" value={`${formatMm(current.floorThickness)} mm`} />
            </>
          ) : null}

          <Separator />
          <SectionHeading>This level</SectionHeading>
          <p className="text-muted-foreground">{countsText(project)}</p>
        </div>
      </ScrollArea>
    </aside>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="text-muted-foreground text-[11px] tracking-wider uppercase">{children}</p>;
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
      <Label htmlFor={id} className="text-muted-foreground font-normal">
        {label}
      </Label>
      <Input
        id={id}
        readOnly
        value={value}
        className={`h-7 w-[120px] ${align === "right" ? "text-right tabular-nums" : ""}`}
      />
    </div>
  );
}
