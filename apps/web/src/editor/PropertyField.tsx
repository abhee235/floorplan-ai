// One row of the properties panel (ADR-017 D3): a label, a value, and — where the selection says the value
// can change — a field that commits what was typed.
//
// Enter or leaving the field commits; Escape puts the value back. What the typed text MEANS is not decided
// here: the row's `edit` comes from selection.ts, and this only runs the conversation around it — the
// draft, the refusal, and the round trip to the host.

import type { JSX, KeyboardEvent } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EditCommand, EditOutcome } from "./selection.js";
import { useEditor } from "./useEditor.js";

/** How a unit is read aloud; the printed unit is hidden from a screen reader in favour of this. */
const UNIT_NAMES: Record<string, string> = { mm: "millimetres" };

export interface PropertyFieldProps {
  id: string;
  label: string;
  value: string;
  unit?: string | undefined;
  align?: "left" | "right";
  edit?: ((text: string) => EditOutcome) | undefined;
  /** Resolves once the host has taken the command, and throws with its reason when it refuses. */
  send?: ((command: EditCommand) => Promise<void>) | undefined;
}

export function PropertyField({
  id,
  label,
  value,
  unit,
  align = "right",
  edit,
  send,
}: PropertyFieldProps): JSX.Element {
  const { announcer } = useEditor();
  const input = useRef<HTMLInputElement>(null);
  // What is typed but not yet taken, or null when the field shows the model. Kept in a ref as well as in
  // state, because a reply from the host can land after more typing and must not throw that typing away.
  const [draft, setDraftState] = useState<string | null>(null);
  const latest = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const errorId = `${id}-error`;

  const setDraft = (next: string | null): void => {
    latest.current = next;
    setDraftState(next);
  };

  const revert = (): void => {
    setDraft(null);
    setError(null);
    reselect.current = true;
  };

  const commit = async (how: "enter" | "blur"): Promise<void> => {
    const text = latest.current;
    if (!edit || !send || text === null) return;
    const outcome = edit(text);
    if (!outcome.ok) {
      announcer.alert(`${label} not changed. ${outcome.message}`);
      if (how === "enter") {
        // Still in the field, so the text stays for fixing; Escape is the way back.
        setError(outcome.message);
        return;
      }
      // Gone from the field, so the value goes back rather than leaving text that means nothing behind a
      // red border — but the reason stays in view, with what was kept.
      setDraft(null);
      setError(`${outcome.message} Kept ${value}${unit ? ` ${unit}` : ""}.`);
      return;
    }
    setError(null);
    if (!outcome.command) {
      setDraft(null);
      if (how === "enter") reselect.current = true;
      return;
    }
    try {
      await send(outcome.command);
      // The host sends its patch before its reply, so `value` already holds what was just set and the
      // field does not flick back to the old number on the way.
      announcer.say(`${label} ${outcome.said}.`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      announcer.alert(`${label} not changed: ${reason}`);
      setError(`Not changed: ${reason}`);
    }
    if (latest.current !== text) return;
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
    if (e.key === "Escape" && (draft !== null || error !== null)) {
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
    <div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-muted-foreground">
          {label}
          {unit ? <span className="sr-only">, in {UNIT_NAMES[unit] ?? unit}</span> : null}
        </Label>
        <div className="relative w-[150px] shrink-0">
          <Input
            ref={input}
            id={id}
            // Read-only rows stay focusable, because a disabled field drops out of the keyboard path. They
            // lose the field's border and fill, though: once some rows take typing, a row that looks like
            // it does but refuses every key is a trap.
            readOnly={!editable}
            value={draft ?? value}
            inputMode={editable && unit ? "decimal" : undefined}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
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
              unit ? "pr-10" : "",
              editable ? "" : "border-transparent bg-transparent shadow-none dark:bg-transparent",
            ]
              .filter(Boolean)
              .join(" ")}
          />
          {unit ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground"
            >
              {unit}
            </span>
          ) : null}
        </div>
      </div>
      {error ? (
        // Left-aligned across the row, not under the field alone: right-aligned, a two-line reason left its
        // last word stranded, and the message opens with the field's name, so it reads from the label.
        <p id={errorId} className="mt-1 text-xs leading-snug text-pretty text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
