// One row of the properties panel (ADR-017 D3): a label, a value, and — where the selection says the value
// can change — a field that commits what was typed or picked.
//
// Enter or leaving a text field commits; Escape puts the value back. A list commits as soon as something
// is picked. What the value MEANS is not decided here: the row's `edit` comes from selection.ts, and this
// only runs the conversation around it — the draft, the refusal, and the round trip to the host.

import type { JSX, KeyboardEvent, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Choice, EditCommand, EditOutcome } from "./selection.js";
import { useEditor } from "./useEditor.js";

/** How a unit is read aloud; the printed unit is hidden from a screen reader in favour of this. */
const UNIT_NAMES: Record<string, string> = { mm: "millimetres" };

export interface PropertyFieldProps {
  id: string;
  label: string;
  /** The leading part of `label` to print, when that is less than all of it. */
  caption?: string | undefined;
  /** Printed inside the field ahead of the value, and hidden from a screen reader, which has the label. */
  prefix?: string | undefined;
  value: string;
  unit?: string | undefined;
  align?: "left" | "right";
  choices?: readonly Choice[] | undefined;
  edit?: ((text: string) => EditOutcome) | undefined;
  /** Resolves once the host has taken the command, and throws with its reason when it refuses. */
  send?: ((command: EditCommand) => Promise<void>) | undefined;
}

export function PropertyField(props: PropertyFieldProps): JSX.Element {
  const { choices, edit, send } = props;
  if (choices && edit && send) return <ChoiceField {...props} choices={choices} edit={edit} send={send} />;
  return <TextField {...props} />;
}

function TextField({
  id,
  label,
  caption,
  prefix,
  value,
  unit,
  align = "right",
  choices,
  edit,
  send,
}: PropertyFieldProps): JSX.Element {
  const report = useReport(label, send);
  const input = useRef<HTMLInputElement>(null);
  // What is typed but not yet taken, or null when the field shows the model. Kept in a ref as well as in
  // state, because a reply from the host can land after more typing and must not throw that typing away.
  const [draft, setDraftState] = useState<string | null>(null);
  const latest = useRef<string | null>(null);
  // Selecting the text has to wait for the render that puts the new value in: setting an input's value
  // moves the caret to the end, which would undo a selection made first.
  const reselect = useRef(false);
  // A click that focuses the field ends in a mouseup that clears the focus-time selection, so that one
  // mouseup is swallowed. Only that one: a click in a field already focused still places the caret.
  const clickedIn = useRef(false);

  useLayoutEffect(() => {
    if (!reselect.current) return;
    reselect.current = false;
    if (document.activeElement === input.current) input.current?.select();
  });

  const editable = edit !== undefined && send !== undefined;
  // A list shown read-only still reads as its label, not as the value the model stores.
  const shown = choices?.find((c) => c.value === value)?.label ?? value;

  const setDraft = (next: string | null): void => {
    latest.current = next;
    setDraftState(next);
  };

  const revert = (): void => {
    setDraft(null);
    report.clear();
    reselect.current = true;
  };

  const commit = async (how: "enter" | "blur"): Promise<void> => {
    const text = latest.current;
    if (!edit || text === null) return;
    const outcome = edit(text);
    if (!outcome.ok) {
      if (how === "enter") {
        // Still in the field, so the text stays for fixing; Escape is the way back.
        report.refuse(outcome.message);
        return;
      }
      // Gone from the field, so the value goes back rather than leaving text that means nothing behind a
      // red border — but the reason stays in view, with what was kept.
      setDraft(null);
      report.refuse(outcome.message, `${outcome.message} Kept ${value}${unit ? ` ${unit}` : ""}.`);
      return;
    }
    report.clear();
    if (outcome.command) await report.deliver(outcome.command, outcome.said);
    if (latest.current !== text) return;
    // The host sends its patch before its reply, so `value` already holds what was just set and the field
    // does not flick back to the old number on the way.
    setDraft(null);
    if (how === "enter") reselect.current = true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (!editable) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void commit("enter");
      return;
    }
    if (e.key === "Escape" && (draft !== null || report.error !== null)) {
      // Taken only when there is something to put back. Otherwise Escape carries on to the shell, which
      // returns to the select tool from anywhere (ADR-017 D2).
      e.preventDefault();
      e.stopPropagation();
      revert();
      return;
    }
    if (draft !== null && (e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase())) {
      // Mid-edit, undo belongs to the text being typed, not to the model behind it.
      e.stopPropagation();
    }
  };

  return (
    <Row id={id} label={label} caption={caption} unit={unit} error={report.error}>
      <Input
        ref={input}
        id={id}
        // Read-only rows stay focusable, because a disabled field drops out of the keyboard path. They lose
        // the field's border and fill, though: once some rows take typing, a row that looks like it does
        // but refuses every key is a trap.
        readOnly={!editable}
        value={draft ?? shown}
        inputMode={editable && unit ? "decimal" : undefined}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={report.error ? true : undefined}
        aria-describedby={report.error ? errorId(id) : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          if (report.error) report.clear();
        }}
        onFocus={(e) => {
          if (editable) e.currentTarget.select();
        }}
        onMouseDown={(e) => {
          clickedIn.current = editable && document.activeElement !== e.currentTarget;
        }}
        onMouseUp={(e) => {
          if (!clickedIn.current) return;
          clickedIn.current = false;
          e.preventDefault();
        }}
        onBlur={() => void commit("blur")}
        onKeyDown={onKeyDown}
        className={[
          "h-7",
          // Left alignment is for text being typed into a visible box. Without the box, a left-aligned
          // value floats in the middle of the row, away from the column every other value ends on.
          align === "right" || !editable ? "text-right tabular-nums" : "",
          prefix ? "pl-7" : "",
          unit ? "pr-10" : "",
          editable ? "" : "border-transparent bg-transparent shadow-none dark:bg-transparent",
        ]
          .filter(Boolean)
          .join(" ")}
      />
      {prefix ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground"
        >
          {prefix}
        </span>
      ) : null}
      {unit ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground"
        >
          {unit}
        </span>
      ) : null}
    </Row>
  );
}

/** A value picked from a list. There is no draft to hold: the pick is the commit. */
function ChoiceField({
  id,
  label,
  caption,
  value,
  choices,
  edit,
  send,
}: PropertyFieldProps & {
  choices: readonly Choice[];
  edit: (value: string) => EditOutcome;
}): JSX.Element {
  const report = useReport(label, send);

  const pick = async (next: string): Promise<void> => {
    const outcome = edit(next);
    if (!outcome.ok) {
      report.refuse(outcome.message);
      return;
    }
    report.clear();
    // The list shows `value`, which is the model's, so it moves to the pick when the host's patch lands
    // and stays put when the host refuses.
    if (outcome.command) await report.deliver(outcome.command, outcome.said);
  };

  return (
    <Row id={id} label={label} caption={caption} error={report.error}>
      <Select value={value} onValueChange={(next) => void pick(next)}>
        <SelectTrigger
          id={id}
          size="sm"
          aria-invalid={report.error ? true : undefined}
          aria-describedby={report.error ? errorId(id) : undefined}
          className="w-full data-[size=sm]:h-7"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

const errorId = (id: string): string => `${id}-error`;

/** The label, the control, and the reason under them when there is one. */
function Row({
  id,
  label,
  caption,
  unit,
  error,
  children,
}: {
  id: string;
  label: string;
  caption?: string | undefined;
  unit?: string | undefined;
  error: string | null;
  children: ReactNode;
}): JSX.Element {
  const printed = caption ?? label;
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-muted-foreground">
          {printed}
          {/* The rest of the name, and the unit in words. Printed plus heard is always the whole label, so
              what a sighted person reads is what a speech user says to reach the field. */}
          <span className="sr-only">
            {label.slice(printed.length)}
            {unit ? `, in ${UNIT_NAMES[unit] ?? unit}` : ""}
          </span>
        </Label>
        <div className="relative w-[150px] shrink-0">{children}</div>
      </div>
      {error ? (
        // Left-aligned across the row, not under the field alone: right-aligned, a two-line reason left its
        // last word stranded, and the message opens with the field's name, so it reads from the label.
        <p id={errorId(id)} className="mt-1 text-xs leading-snug text-pretty text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The refusal shown under a row, and the announcements that go with sending an edit or refusing one. */
function useReport(label: string, send: PropertyFieldProps["send"]) {
  const { announcer } = useEditor();
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    clear: (): void => setError(null),
    /** `shown` is what stays under the field, when that needs more than the reason itself. */
    refuse: (message: string, shown = message): void => {
      announcer.alert(`${label} not changed. ${message}`);
      setError(shown);
    },
    deliver: async (command: EditCommand, said: string): Promise<void> => {
      if (!send) return;
      try {
        await send(command);
        announcer.say(`${label} ${said}.`);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        announcer.alert(`${label} not changed: ${reason}`);
        setError(`Not changed: ${reason}`);
      }
    },
  };
}
