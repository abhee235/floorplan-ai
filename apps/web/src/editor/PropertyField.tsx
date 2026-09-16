// One row of the properties panel (ADR-017 D3): a label, a value, and — where the selection says the value
// can change — a field that commits what was typed or picked.
//
// What is typed shows on the plan and in 3D as it is typed, without being sent: Enter or leaving the field
// sends it, as one change, and Escape puts the value back. A list commits as soon as something is picked. What the value MEANS is not decided here: the row's `edit` comes from selection.ts, and this
// only runs the conversation around it — the draft, the refusal, and the round trip to the host.

import { RotateCcw } from "lucide-react";
import type { JSX, KeyboardEvent, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PatternSwatch } from "./PatternSwatch.js";
import { beginScrub, paceOf, scrubKindOf, scrubStart, scrubText } from "./scrub.js";
import type { Choice, EditCommand, EditOutcome, EmptyMeaning } from "./selection.js";
import { parseHexColour } from "./status.js";
import { useEditor } from "./useEditor.js";

/** How a unit is read aloud; the printed unit is hidden from a screen reader in favour of this. */
const UNIT_NAMES: Record<string, string> = { mm: "millimetres", "°": "degrees", seats: "seats" };

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
  /** What an empty field stands for, on a row that may be emptied. */
  empty?: EmptyMeaning | undefined;
  /** Read to a screen reader as the field's description. */
  hint?: string | undefined;
  /** A colour row: a swatch opens the system picker, and shows `effective` while the value is empty. */
  colour?: { effective: string } | undefined;
  /** A yes-or-no row, drawn as a checkbox; `value` is "true" or "false". */
  toggle?: boolean | undefined;
  edit?: ((text: string) => EditOutcome) | undefined;
  /** Resolves once the host has taken the command, and throws with its reason when it refuses. */
  send?: ((command: EditCommand) => Promise<void>) | undefined;
  /**
   * Shows what a command would do without sending it, while a value is typed, dragged or picked; null
   * puts back what the host last agreed.
   */
  preview?: ((command: EditCommand | null) => void) | undefined;
}

/** What every draggable number field adds to its own description. */
export const NUMBER_HELP =
  "Up and Down arrows change the number, ten at a time with Shift. Dragging the row's name sideways does too.";

export function PropertyField(props: PropertyFieldProps): JSX.Element {
  const { choices, toggle, edit, send } = props;
  if (toggle && edit && send) return <ToggleField {...props} edit={edit} send={send} />;
  if (choices && edit && send) return <ChoiceField {...props} choices={choices} edit={edit} send={send} />;
  return <TextField {...props} />;
}

/** A yes-or-no value. Like a list, the click is the commit; the box shows the model's value, so it moves
 *  when the host's patch lands and stays put if the host refuses. */
function ToggleField({
  id,
  label,
  caption,
  value,
  hint,
  edit,
  send,
}: PropertyFieldProps & { edit: (value: string) => EditOutcome }): JSX.Element {
  const report = useReport(label, send);
  const flip = async (next: boolean): Promise<void> => {
    const outcome = edit(String(next));
    if (!outcome.ok) {
      report.refuse(outcome.message);
      return;
    }
    report.clear();
    if (outcome.command) await report.deliver(outcome.command, outcome.said);
  };
  return (
    <Row id={id} label={label} caption={caption} hint={hint} error={report.error}>
      <div className="flex h-7 items-center justify-end pr-3">
        <Checkbox
          id={id}
          checked={value === "true"}
          aria-label={nameOf(label, undefined)}
          aria-invalid={report.error ? true : undefined}
          aria-describedby={describedBy(id, hint, report.error)}
          onCheckedChange={(next) => void flip(next === true)}
        />
      </div>
    </Row>
  );
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
  empty,
  hint,
  colour,
  edit,
  send,
  preview,
}: PropertyFieldProps): JSX.Element {
  const report = useReport(label, send);
  const input = useRef<HTMLInputElement>(null);
  const swatch = useRef<HTMLInputElement>(null);
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
  // A number with a unit can be dragged and stepped; a colour, a name or a unit-less count cannot.
  const scrub = editable && !colour ? scrubKindOf(unit) : null;
  // A list shown read-only still reads as its label, not as the value the model stores.
  const shown = choices?.find((c) => c.value === value)?.label ?? value;
  // An empty field that stands for something shows that instead, greyed, with its own unit: the unit
  // beside the field would otherwise follow "straight" as "straight °".
  const showingEmpty = empty !== undefined && (draft ?? shown) === "";
  const resettable = editable && empty !== undefined && value !== "";
  // Controls inside the field's left edge, which a right-aligned value leaves empty: the swatch, then the
  // reset button. The text keeps clear of however many there are.
  const leading = (colour && editable ? 1 : 0) + (resettable ? 1 : 0);

  // The edit as it was when the draft began. Once a preview is shown the panel is drawn from the previewed
  // project, and an edit taken from that would measure its change from the preview: a typed position
  // would be moved to twice over.
  const editAtDraft = useRef<PropertyFieldProps["edit"]>(undefined);
  // Whether this field has a preview up, and the newest way to take it down, for when the field goes.
  const previewing = useRef(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(
    () => () => {
      if (previewing.current) previewRef.current?.(null);
    },
    [],
  );

  const setDraft = (next: string | null): void => {
    latest.current = next;
    if (next === null) editAtDraft.current = undefined;
    else editAtDraft.current ??= edit;
    setDraftState(next);
  };

  /** Shows what the draft would do, or nothing when it would do nothing or cannot be taken. */
  const show = (text: string): void => {
    if (!preview) return;
    const outcome = (editAtDraft.current ?? edit)?.(text);
    const command = outcome?.ok ? outcome.command : null;
    if (!command && !previewing.current) return;
    previewing.current = command !== null;
    preview(command);
  };

  /** Takes a preview down, before the real command goes or when the draft is dropped. */
  const unshow = (): void => {
    if (!previewing.current) return;
    previewing.current = false;
    preview?.(null);
  };

  const type = (text: string): void => {
    setDraft(text);
    if (report.error) report.clear();
    show(text);
  };

  const revert = (): void => {
    unshow();
    setDraft(null);
    report.clear();
    reselect.current = true;
  };

  const commit = async (how: "enter" | "blur"): Promise<void> => {
    const text = latest.current;
    const editing = editAtDraft.current ?? edit;
    if (!editing || text === null) return;
    const outcome = editing(text);
    // The host's patch has to land on what it knows, so the preview goes before anything is sent.
    unshow();
    // Typing on while this is on its way starts from the host's project again.
    editAtDraft.current = undefined;
    if (!outcome.ok) {
      if (how === "enter") {
        // Still in the field, so the text stays for fixing; Escape is the way back.
        report.refuse(outcome.message);
        return;
      }
      // Gone from the field, so the value goes back rather than leaving text that means nothing behind a
      // red border — but the reason stays in view, with what was kept.
      setDraft(null);
      const kept = value === "" ? "it empty" : `${value}${unit ? ` ${unit}` : ""}`;
      report.refuse(outcome.message, `${outcome.message} Kept ${kept}.`);
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

  /** The reset button: empties the field through the same edit that typing nothing would make. */
  const clear = async (): Promise<void> => {
    if (!edit) return;
    unshow();
    const outcome = edit("");
    if (!outcome.ok) {
      report.refuse(outcome.message);
      return;
    }
    setDraft(null);
    report.clear();
    if (outcome.command) await report.deliver(outcome.command, outcome.said);
    // The button goes once the field is empty, and focus would go with it to the page.
    input.current?.focus();
  };

  // The picker commits on the native change event, when a colour is settled, not on every input event
  // React reports while the picker is open: those only preview the colour, or dragging across the picker
  // would leave a history entry per pixel. The listener reads the newest commit through a ref.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    const el = swatch.current;
    if (!el) return;
    const settle = (): void => void commitRef.current("enter");
    el.addEventListener("change", settle);
    return () => el.removeEventListener("change", settle);
  }, []);

  /**
   * A drag on the row's name or axis letter (see scrub.ts). The edit is the one this render was given:
   * each preview re-renders the row from the previewed project, and an edit made from that would measure
   * its change from the preview rather than from what the host holds.
   */
  const startScrub = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!scrub || !edit) return;
    const from = scrubStart(latest.current ?? value, empty?.shown);
    if (from === null) return;
    const editAtStart = editAtDraft.current ?? edit;
    let at = from;
    let good: { text: string; command: EditCommand; said: string } | null = null;
    beginScrub(e.nativeEvent, e.currentTarget, {
      start: () => {
        report.clear();
        input.current?.focus();
      },
      move: (dx, mods) => {
        at += dx * scrub.perPx * paceOf(mods);
        const text = scrubText(scrub, at);
        setDraft(text);
        editAtDraft.current = editAtStart;
        const outcome = editAtStart(text);
        // out of range, or back where it began: show the last good value, or nothing changed
        if (!outcome.ok) return;
        good = outcome.command ? { text, command: outcome.command, said: outcome.said } : null;
        previewing.current = outcome.command !== null;
        preview?.(outcome.command);
      },
      end: (commit) => {
        previewing.current = false;
        preview?.(null);
        const chosen = good;
        if (!commit || !chosen) {
          setDraft(null);
          return;
        }
        setDraft(chosen.text);
        void report.deliver(chosen.command, chosen.said).then(() => {
          if (latest.current === chosen.text) setDraft(null);
        });
      },
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (!editable) return;
    if (scrub && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      // One step at a time, committed as it goes, as a design tool steps a number.
      const from = scrubStart(latest.current ?? value, empty?.shown);
      if (from === null) return;
      e.preventDefault();
      const next = from + (e.key === "ArrowUp" ? 1 : -1) * scrub.step * (e.shiftKey ? 10 : 1);
      setDraft(scrubText(scrub, next));
      void commit("enter");
      return;
    }
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
    <Row
      id={id}
      label={label}
      caption={caption}
      unit={unit}
      hint={hint}
      error={report.error}
      onScrub={scrub ? startScrub : undefined}
    >
      {leading > 0 ? (
        // Beside the field these took the width the label needed, and "Height at end" broke onto two lines.
        // First in the DOM, so the focus order runs left to right as the eye does.
        <span className="absolute inset-y-0 left-0.5 z-10 flex items-center gap-0.5">
          {colour && editable ? (
            <input
              ref={swatch}
              type="color"
              aria-label={`${label}, picker`}
              // What is being typed, once it is a colour; otherwise the model's colour, or the default.
              value={(parseHexColour(draft ?? "") ?? parseHexColour(value) ?? colour.effective).toLowerCase()}
              onChange={(e) => type(e.target.value.toUpperCase())}
              className="ml-1 size-4 shrink-0 cursor-pointer appearance-none rounded-sm border border-input bg-transparent p-0 [&::-moz-color-swatch]:rounded-[3px] [&::-moz-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-[3px] [&::-webkit-color-swatch]:border-none"
            />
          ) : null}
          {resettable ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${empty.action} (${label})`}
                  className="text-muted-foreground"
                  onClick={() => void clear()}
                >
                  <RotateCcw aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{empty.action}</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      ) : null}
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
        placeholder={empty?.shown}
        aria-label={nameOf(label, unit)}
        aria-invalid={report.error ? true : undefined}
        aria-describedby={describedBy(id, hint, report.error, scrub ? stepsId(id) : null)}
        onChange={(e) => type(e.target.value)}
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
          prefix || leading === 1 ? "pl-7" : leading === 2 ? "pl-12" : "",
          // Room for the unit, and no more: "mm" wants a gap before it, a degree sign sits against its
          // number, and a word such as "seats" needs its own width.
          unit && !showingEmpty ? (unit.length > 2 ? "pr-14" : unit.length > 1 ? "pr-10" : "pr-5") : "",
          editable ? "" : "border-transparent bg-transparent shadow-none dark:bg-transparent",
        ]
          .filter(Boolean)
          .join(" ")}
      />
      {prefix ? (
        <span
          aria-hidden
          onPointerDown={scrub ? startScrub : undefined}
          className={[
            "absolute inset-y-0 left-1 flex items-center px-2 text-muted-foreground select-none",
            scrub ? "cursor-ew-resize hover:text-foreground" : "pointer-events-none",
          ].join(" ")}
        >
          {prefix}
        </span>
      ) : null}
      {unit && !showingEmpty ? (
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
  hint,
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
    <Row id={id} label={label} caption={caption} hint={hint} error={report.error}>
      <Select value={value} onValueChange={(next) => void pick(next)}>
        <SelectTrigger
          id={id}
          size="sm"
          aria-label={nameOf(label, undefined)}
          aria-invalid={report.error ? true : undefined}
          aria-describedby={describedBy(id, hint, report.error)}
          className="w-full data-[size=sm]:h-7"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.swatch ? <PatternSwatch pattern={choice.swatch} /> : null}
              {choice.image ? (
                // decoration: the name beside it says what it is
                <img
                  src={choice.image}
                  alt=""
                  aria-hidden="true"
                  className="size-4 shrink-0 rounded-sm border object-cover"
                />
              ) : null}
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

const errorId = (id: string): string => `${id}-error`;
const hintId = (id: string): string => `${id}-hint`;
const stepsId = (id: string): string => `${id}-steps`;

/**
 * A control's accessible name: the row's whole label and its unit in words, "Start Y, in millimetres". What
 * the row prints is always the start of this, so what a sighted person reads is what a speech user says to
 * reach the field.
 */
function nameOf(label: string, unit: string | undefined): string {
  return unit ? `${label}, in ${UNIT_NAMES[unit] ?? unit}` : label;
}

/** The hint first, then the refusal: the reason something was refused reads best after what it is. */
function describedBy(
  id: string,
  hint: string | undefined,
  error: string | null,
  shared: string | null = null,
): string | undefined {
  const ids = [hint ? hintId(id) : null, shared, error ? errorId(id) : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

/** The label, the control, and the reason under them when there is one. */
function Row({
  id,
  label,
  caption,
  unit,
  hint,
  error,
  children,
  onScrub,
}: {
  id: string;
  label: string;
  caption?: string | undefined;
  unit?: string | undefined;
  hint?: string | undefined;
  error: string | null;
  children: ReactNode;
  /** Makes the printed name a handle to drag the number with. */
  onScrub?: ((e: ReactPointerEvent<HTMLElement>) => void) | undefined;
}): JSX.Element {
  const printed = caption ?? label;
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        {/* Printed only. The whole name travels on the control as aria-label (see nameOf): the rest of it
            used to sit here in a visually hidden span, and because that span is absolutely positioned,
            Chrome padded it with a space and named the field "Finish , left side". */}
        <Label
          htmlFor={id}
          onPointerDown={onScrub}
          className={
            onScrub
              ? "cursor-ew-resize text-muted-foreground select-none hover:text-foreground"
              : "text-muted-foreground"
          }
        >
          {printed}
        </Label>
        <div className="relative w-[150px] shrink-0">{children}</div>
      </div>
      {hint ? (
        // hidden, not visually hidden: a description is still read from a hidden element, and this way it
        // is not also read aloud in passing by a screen reader walking the panel line by line.
        <span id={hintId(id)} hidden>
          {hint}
        </span>
      ) : null}
      {onScrub ? (
        <span id={stepsId(id)} hidden>
          {NUMBER_HELP}
        </span>
      ) : null}
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
