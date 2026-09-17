// One cell of the properties panel (ADR-017 D3): a caption over a field, made of the app's own components
// at the app's own sizes. The panel places the cells two to a line; a number is changed by dragging its
// caption sideways, as design tools do.
//
// What is typed shows on the plan and in 3D as it is typed, without being sent: Enter or leaving the field
// sends it, as one change, and Escape puts the value back. A list commits as soon as something is picked.
// What the value MEANS is not decided here: the row's `edit` comes from selection.ts, and this only runs
// the conversation around it — the draft, the refusal, and the round trip to the host.

import { cn } from "cn";
import { ChevronsLeftRight, RotateCcw } from "lucide-react";
import type { JSX, KeyboardEvent, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ColourPicker } from "./ColourPicker.js";
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
  /**
   * Printed inside the field ahead of the value, and hidden from a screen reader, which has the label: the
   * axis of a coordinate. It is a handle to drag the number by, as the caption is.
   */
  prefix?: string | undefined;
  value: string;
  unit?: string | undefined;
  choices?: readonly Choice[] | undefined;
  /** What an empty field stands for, on a row that may be emptied. */
  empty?: EmptyMeaning | undefined;
  /** Read to a screen reader as the field's description. */
  hint?: string | undefined;
  /** A colour row: a swatch opens the colour picker, and shows `effective` while the value is empty. */
  colour?: { effective: string } | undefined;
  /** For a colour row: the colours the project already uses, offered in the picker. */
  swatches?: readonly string[] | undefined;
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
  /** Where the cell sits in the panel's grid. */
  className?: string | undefined;
  /** Something at the field's right edge, inside it: a colour row's material list. */
  trailing?: ReactNode | undefined;
  /** A list shown as a small button alone, to sit inside another field; its name is its label. */
  bare?: boolean | undefined;
  /** For a colour row wearing a texture: the texture's picture, shown on the swatch. */
  swatchImage?: string | undefined;
}

/**
 * A value that is only read: the field's shape without its border, on a quiet fill, so its text lines up with
 * the fields beside it and it still cannot be mistaken for one that takes typing.
 */
const READ_ONLY = "border-transparent bg-muted/60 shadow-none dark:bg-muted/40";

/** What every draggable number field adds to its own description. */
export const NUMBER_HELP =
  "Up and Down arrows change the number, ten at a time with Shift. Dragging the field's name sideways does too.";

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
  className,
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
  // The name sits beside the box rather than over it, as a checkbox's does, so the cell takes one line.
  return (
    <div className={cn("flex min-w-0 flex-col justify-end", className)}>
      <div className="flex h-8 items-center gap-2">
        <Checkbox
          id={id}
          checked={value === "true"}
          aria-label={nameOf(label, undefined)}
          aria-invalid={report.error ? true : undefined}
          aria-describedby={describedBy(id, hint, report.error)}
          onCheckedChange={(next) => void flip(next === true)}
        />
        <Label htmlFor={id} className="block min-w-0 truncate font-normal">
          {caption ?? label}
        </Label>
      </div>
      <Notes id={id} hint={hint} error={report.error} />
    </div>
  );
}

function TextField({
  id,
  label,
  caption,
  prefix,
  value,
  unit,
  choices,
  empty,
  hint,
  colour,
  swatches,
  edit,
  send,
  preview,
  className,
  trailing,
  swatchImage,
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
  // A number with a unit can be dragged and stepped; a colour, a name or a unit-less count cannot.
  const scrub = editable && !colour ? scrubKindOf(unit) : null;
  // A list shown read-only still reads as its label, not as the value the model stores.
  const shown = choices?.find((c) => c.value === value)?.label ?? value;
  // An empty field that stands for something shows that instead, greyed, with its own unit: the unit
  // beside the field would otherwise follow "straight" as "straight °".
  const showingEmpty = empty !== undefined && (draft ?? shown) === "";
  const printedUnit = unit && !showingEmpty ? unit : null;
  const resettable = editable && empty !== undefined && value !== "";
  // What sits inside the field's left edge, in order: the axis, the swatch, the reset button. The text
  // starts clear of all of them.
  const lead = (prefix ? 20 : 0) + (colour && editable ? 24 : 0) + (resettable ? 26 : 0);

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

  // The picker shows every colour as it is picked and commits once, when it closes: sending each one would
  // leave a history entry per pixel dragged across the square. Escape closes it keeping nothing.
  const closePicker = (keep: boolean): void => {
    if (keep) void commit("enter");
    else if (latest.current !== null) revert();
  };

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
      hint={hint}
      error={report.error}
      onScrub={scrub ? startScrub : undefined}
      className={className}
    >
      {lead > 0 ? (
        // First in the DOM, so the focus order runs left to right as the eye does.
        <span className="absolute inset-y-0 left-1 z-10 flex items-center">
          {prefix ? (
            <span
              aria-hidden
              onPointerDown={scrub ? startScrub : undefined}
              className={cn(
                "flex h-full w-5 items-center justify-center text-muted-foreground select-none",
                scrub ? "cursor-ew-resize hover:text-foreground" : "",
              )}
            >
              {prefix}
            </span>
          ) : null}
          {colour && editable ? (
            <ColourPicker
              label={label}
              // What is being typed, once it is a colour; otherwise the model's colour, or the default.
              value={parseHexColour(draft ?? "") ?? parseHexColour(value) ?? colour.effective}
              swatches={swatches}
              image={draft === null ? swatchImage : undefined}
              onPick={type}
              onClose={closePicker}
              className="mx-1"
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
        // Read-only cells stay focusable, because a disabled field drops out of the keyboard path. They have
        // no fill, though: once some cells take typing, one that looks like it does but refuses every key is
        // a trap.
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
        style={lead > 0 ? { paddingLeft: lead + 8 } : undefined}
        className={cn(
          "h-8 tabular-nums",
          editable ? "" : READ_ONLY,
          // Room for the unit, and no more: "mm" wants a gap before it, a degree sign sits against its
          // number, and a word such as "seats" needs its own width.
          printedUnit ? (printedUnit.length > 2 ? "pr-14" : printedUnit.length > 1 ? "pr-10" : "pr-6") : "",
          trailing ? "pr-9" : "",
        )}
      />
      {trailing ? (
        <span className="absolute inset-y-0 right-1 z-10 flex items-center">{trailing}</span>
      ) : null}
      {printedUnit ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground"
        >
          {printedUnit}
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
  className,
  bare,
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

  const items = choices.map((choice) => (
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
  ));

  if (bare)
    // Only the arrow shows; the chosen value is still read out with the name, and a refusal is on its title.
    return (
      <Select value={value} onValueChange={(next) => void pick(next)}>
        <SelectTrigger
          id={id}
          size="sm"
          aria-label={nameOf(label, undefined)}
          aria-invalid={report.error ? true : undefined}
          aria-describedby={describedBy(id, hint, report.error)}
          title={report.error ?? label}
          className="size-6 justify-center gap-0 rounded-sm border-transparent bg-transparent p-0 shadow-none hover:bg-accent data-[size=sm]:h-6 dark:bg-transparent"
        >
          <span className="sr-only">
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
        <Notes id={id} hint={hint} error={null} />
      </Select>
    );

  return (
    <Row id={id} label={label} caption={caption} hint={hint} error={report.error} className={className}>
      <Select value={value} onValueChange={(next) => void pick(next)}>
        <SelectTrigger
          id={id}
          size="sm"
          aria-label={nameOf(label, undefined)}
          aria-invalid={report.error ? true : undefined}
          aria-describedby={describedBy(id, hint, report.error)}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
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

/** The caption, the control under it, and the reason under that when there is one. */
function Row({
  id,
  label,
  caption,
  hint,
  error,
  children,
  onScrub,
  className,
}: {
  id: string;
  label: string;
  caption?: string | undefined;
  hint?: string | undefined;
  error: string | null;
  children: ReactNode;
  /** Makes the printed name a handle to drag the number with. */
  onScrub?: ((e: ReactPointerEvent<HTMLElement>) => void) | undefined;
  className?: string | undefined;
}): JSX.Element {
  const printed = caption ?? label;
  return (
    <div className={cn("min-w-0", className)}>
      {/* Printed only. The whole name travels on the control as aria-label (see nameOf): the rest of it
          used to sit here in a visually hidden span, and because that span is absolutely positioned,
          Chrome padded it with a space and named the field "Finish , left side". A cell whose name the
          one beside it prints (the Y of a pair) keeps the line, so the two fields stay level. */}
      <Label
        htmlFor={id}
        onPointerDown={onScrub}
        className={cn(
          "group/caption mb-1 block h-[18px] min-w-0 truncate leading-[18px] font-normal text-muted-foreground",
          onScrub ? "cursor-ew-resize select-none hover:text-foreground" : "",
        )}
      >
        {printed}
        {onScrub && printed ? (
          // Says, on the way past, that the name is a handle: drag it sideways to change the number. It takes
          // no width, so a caption that only just fits is not cut short for a mark that is mostly hidden.
          <span aria-hidden className="inline-block w-0 overflow-visible whitespace-nowrap">
            <ChevronsLeftRight className="ml-1 inline-block size-3 align-[-1px] opacity-0 transition-opacity group-hover/caption:opacity-70" />
          </span>
        ) : null}
      </Label>
      <div className="relative">{children}</div>
      <Notes id={id} hint={hint} error={error} steps={onScrub !== undefined} />
    </div>
  );
}

/** A cell's description and refusal: the hint and the steps help hidden, the refusal in view. */
function Notes({
  id,
  hint,
  error,
  steps = false,
}: {
  id: string;
  hint?: string | undefined;
  error: string | null;
  steps?: boolean;
}): JSX.Element {
  return (
    <>
      {hint ? (
        // hidden, not visually hidden: a description is still read from a hidden element, and this way it
        // is not also read aloud in passing by a screen reader walking the panel line by line.
        <span id={hintId(id)} hidden>
          {hint}
        </span>
      ) : null}
      {steps ? (
        <span id={stepsId(id)} hidden>
          {NUMBER_HELP}
        </span>
      ) : null}
      {error ? (
        <p id={errorId(id)} className="mt-1 leading-snug text-pretty text-destructive">
          {error}
        </p>
      ) : null}
    </>
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
