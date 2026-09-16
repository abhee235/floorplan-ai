// The colour picker behind a colour row's swatch (P3-5 follow-up): a saturation and brightness square; a
// row of tools for the browser's eyedropper, fine sliders, a colour guide and the colour model; a hue bar;
// the colour as hex and as numbers; and a preview beside swatches to pick from.
//
// Every change is shown at once, on the plan and in 3D, through `onPick`; nothing is sent until the picker
// closes, and Escape closes it without keeping anything.
//
// Drawn to match the picker in the owner's own design editor (wizzel), which is the MIT package
// react-best-gradient-color-picker: its sizes, bars, handles, tool row and swatches are followed closely.
// The code is this project's own and uses no part of that package or its dependencies. There are no
// gradients or opacity in the model, so neither is offered.
import { cn } from "cn";
import { Palette, Pipette, SlidersVertical, TextCursorInput } from "lucide-react";
import { DropdownMenu as MenuPrimitive, Slider as SliderPrimitive } from "radix-ui";
import type { JSX, KeyboardEvent, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  CHANNELS,
  COLOUR_MODELS,
  type ColourModel,
  channelValues,
  fromChannels,
  type Hsv,
  harmonies,
  hexToHsv,
  hslToHsv,
  hsvToHex,
  hsvToHsl,
  INTERIOR_COLOURS,
  isLight,
} from "./colour.js";

export interface ColourPickerProps {
  /** The row's label; the swatch is "<label>, picker". */
  label: string;
  /** The colour shown, "#RRGGBB": what is typed or picked, else the model's, else the default. */
  value: string;
  /** Colours the project already uses. */
  swatches?: readonly string[] | undefined;
  /** Called with every colour picked while the picker is open. */
  onPick: (hex: string) => void;
  /** The picker closed: keep what was picked, or (Escape) put it all back. */
  onClose: (keep: boolean) => void;
  className?: string | undefined;
}

/** The model last chosen, so the next picker opens speaking it too. */
let lastModel: ColourModel = "rgb";

const WHITE: Hsv = { h: 0, s: 0, v: 1 };

interface EyeDropperResult {
  sRGBHex: string;
}
type EyeDropperCtor = new () => { open: () => Promise<EyeDropperResult> };
const eyeDropper = (): EyeDropperCtor | null =>
  typeof window !== "undefined" && "EyeDropper" in window
    ? ((window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper ?? null)
    : null;

// The package's palette: a lavender-grey tool row, a blue for what is switched on, dark grey marks.
const TOOL_ROW = "bg-[#e9e9f5] dark:bg-muted";
const MARK = "text-[#323136] dark:text-foreground";
const CAPTION = "text-[#565656] dark:text-muted-foreground";
const ON =
  "bg-white text-[#568cf5] shadow-[1px_1px_3px_rgba(0,0,0,0.2)] dark:bg-background dark:text-[#7aa5f8]";
/** The ring every handle wears. */
const HANDLE =
  "block size-[18px] rounded-full border-2 border-white shadow-[0_0_3px_rgba(0,0,0,0.5)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60";

export function ColourPicker({
  label,
  value,
  swatches = [],
  onPick,
  onClose,
  className,
}: ColourPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? WHITE);
  const [model, setModelState] = useState<ColourModel>(lastModel);
  const [advanced, setAdvanced] = useState(false);
  const [guide, setGuide] = useState(false);
  const cancelled = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // How far left of the swatch the picker opens: clear of the panel the swatch sits in, so the picker
  // covers the drawing beside it rather than the rows it is changing.
  const [offset, setOffset] = useState(4);
  const hex = hsvToHex(hsv);

  // A value that changes from outside while the picker is open (typed into the row before it opened, or
  // the host answering) is followed; the one this picker just produced is not, or the hue of a grey would
  // be lost on the way round. The colour is read here, not followed: following it would undo every change.
  useEffect(() => {
    if (value !== hsvToHex(hsv)) setHsv((now) => hexToHsv(value, now.h) ?? now);
  }, [value]);

  const choose = (next: Hsv): void => {
    setHsv(next);
    const nextHex = hsvToHex(next);
    if (nextHex !== hex) onPick(nextHex);
  };
  const chooseHex = (text: string): void => {
    const next = hexToHsv(text, hsv.h);
    if (next) choose(next);
  };
  const setModel = (next: ColourModel): void => {
    lastModel = next;
    setModelState(next);
  };

  const openChange = (next: boolean): void => {
    if (next) {
      const swatchBox = trigger.current?.getBoundingClientRect();
      const panelBox = trigger.current?.closest("aside")?.getBoundingClientRect();
      setOffset(swatchBox && panelBox ? Math.max(4, swatchBox.left - panelBox.left + 8) : 4);
      cancelled.current = false;
      setHsv(hexToHsv(value, hsv.h) ?? WHITE);
      setOpen(true);
      return;
    }
    setOpen(false);
    onClose(!cancelled.current);
    cancelled.current = false;
  };

  const Dropper = eyeDropper();
  const hsl = hsvToHsl(hsv);

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={`${label}, picker`}
          style={{ background: value }}
          className={cn(
            "size-4 shrink-0 cursor-pointer rounded-sm border border-black/15 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            className,
          )}
        />
      </PopoverTrigger>
      <PopoverContent
        aria-label={`${label}, picker`}
        side="left"
        align="start"
        sideOffset={offset}
        collisionPadding={8}
        className="w-[288px] rounded-lg p-3"
        onEscapeKeyDown={() => {
          cancelled.current = true;
        }}
      >
        <div className="flex flex-col select-none">
          <SaturationSquare hsv={hsv} onChange={choose} />

          <div className="mt-3 flex h-7 items-center justify-end">
            <div
              role="group"
              aria-label="Picker tools"
              className={cn("flex h-7 items-center rounded-md p-0.5", TOOL_ROW)}
            >
              {Dropper ? (
                <Tool
                  label="Pick a colour from the screen"
                  onClick={() => {
                    new Dropper()
                      .open()
                      .then((r) => chooseHex(r.sRGBHex))
                      .catch(() => undefined);
                  }}
                >
                  <Pipette aria-hidden />
                </Tool>
              ) : null}
              <Tool label="Fine sliders" pressed={advanced} onClick={() => setAdvanced(!advanced)}>
                <SlidersVertical aria-hidden />
              </Tool>
              <Tool label="Colour guide" pressed={guide} onClick={() => setGuide(!guide)}>
                <Palette aria-hidden />
              </Tool>
              <ModelMenu model={model} onChange={setModel} />
            </div>
          </div>

          {advanced ? (
            <div className="mt-4 flex flex-col gap-4">
              <Bar
                label="Saturation"
                value={Math.round(hsl.s * 100)}
                max={100}
                track={`linear-gradient(to right, hsl(${hsl.h} 0% ${hsl.l * 100}%), hsl(${hsl.h} 100% ${hsl.l * 100}%))`}
                thumb={hex}
                text={`${Math.round(hsl.s * 100)} percent`}
                named
                onChange={(n) => choose(hslToHsv({ ...hsl, h: hsv.h, s: n / 100 }))}
              />
              <Bar
                label="Lightness"
                value={Math.round(hsl.l * 100)}
                max={100}
                track={`linear-gradient(to right, hsl(${hsl.h} ${hsl.s * 100}% 0%), hsl(${hsl.h} ${hsl.s * 100}% 50%), hsl(${hsl.h} ${hsl.s * 100}% 100%))`}
                thumb={hex}
                text={`${Math.round(hsl.l * 100)} percent`}
                named
                onChange={(n) => choose(hslToHsv({ ...hsl, h: hsv.h, l: n / 100 }))}
              />
              <Bar
                label="Brightness"
                value={Math.round(hsv.v * 100)}
                max={100}
                track={`linear-gradient(to right, #000, ${hsvToHex({ ...hsv, v: 1 })})`}
                thumb={hex}
                text={`${Math.round(hsv.v * 100)} percent`}
                named
                onChange={(n) => choose({ ...hsv, v: n / 100 })}
              />
            </div>
          ) : null}

          {guide ? <Guide hsv={hsv} current={hex} onPick={chooseHex} /> : null}

          <div className="mt-4">
            <Bar
              label="Hue"
              value={Math.round(hsv.h)}
              max={359}
              track={HUE_TRACK}
              thumb={`hsl(${hsv.h} 100% 50%)`}
              text={`${Math.round(hsv.h)} degrees`}
              onChange={(h) => choose({ ...hsv, h })}
            />
          </div>

          <ColourInputs model={model} hsv={hsv} hex={hex} onChange={choose} onHex={chooseHex} />

          <div className="mt-3.5 flex justify-between gap-1.5">
            <div
              aria-hidden
              className={cn(
                "size-[50px] shrink-0 rounded-md",
                isLight(hex) ? "border border-[#96959c]/60" : "",
              )}
              style={{ background: hex }}
            />
            <Swatches name="Interior colours" colours={INTERIOR_COLOURS} current={hex} onPick={chooseHex} />
          </div>
          {swatches.length > 0 ? (
            <div className="mt-2.5 flex flex-col gap-1">
              <span aria-hidden className={cn("text-[11px] font-bold", CAPTION)}>
                In this project
              </span>
              <Swatches name="In this project" colours={swatches} current={hex} onPick={chooseHex} />
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Tool({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-6 w-[30px] cursor-pointer items-center justify-center rounded-[4px] outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4",
        pressed ? ON : cn(MARK, "hover:bg-white/60 dark:hover:bg-background/60"),
      )}
    >
      {children}
    </button>
  );
}

/** Which numbers sit beside the hex value: a small menu off the tool row, as the package has it. */
function ModelMenu({
  model,
  onChange,
}: {
  model: ColourModel;
  onChange: (m: ColourModel) => void;
}): JSX.Element {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        aria-label="Colour model"
        title="Colour model"
        className={cn(
          "flex h-6 w-[30px] cursor-pointer items-center justify-center rounded-[4px] outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4",
          MARK,
          "hover:bg-white/60 data-[state=open]:bg-white data-[state=open]:text-[#568cf5] data-[state=open]:shadow-[1px_1px_3px_rgba(0,0,0,0.2)] dark:hover:bg-background/60 dark:data-[state=open]:bg-background",
        )}
      >
        <TextCursorInput aria-hidden />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align="end"
          sideOffset={6}
          className={cn(
            "z-50 flex min-w-[76px] flex-col gap-0.5 rounded-md p-[5px] shadow-[1px_1px_14px_1px_rgba(0,0,0,0.25)] data-[state=open]:animate-in data-[state=open]:fade-in-0",
            TOOL_ROW,
          )}
        >
          <MenuPrimitive.RadioGroup
            value={model}
            onValueChange={(next) => onChange(next as ColourModel)}
            className="flex flex-col gap-0.5"
          >
            {COLOUR_MODELS.map((m) => (
              <MenuPrimitive.RadioItem
                key={m.value}
                value={m.value}
                className={cn(
                  "flex h-7 cursor-pointer items-center justify-center rounded-[4px] px-2 text-xs font-bold outline-none transition-all duration-150",
                  CAPTION,
                  "data-[highlighted]:bg-white/60 data-[state=checked]:bg-white data-[state=checked]:text-[#568cf5] data-[state=checked]:shadow-[1px_1px_3px_rgba(0,0,0,0.2)] dark:data-[highlighted]:bg-background/60 dark:data-[state=checked]:bg-background",
                )}
              >
                {m.label}
              </MenuPrimitive.RadioItem>
            ))}
          </MenuPrimitive.RadioGroup>
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const pct = (v: number): number => Math.round(v * 100);

/** Saturation across, brightness up: a two-way slider, by pointer or by arrow keys. */
function SaturationSquare({ hsv, onChange }: { hsv: Hsv; onChange: (next: Hsv) => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const at = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return;
    onChange({
      ...hsv,
      s: clamp01((e.clientX - r.left) / r.width),
      v: clamp01(1 - (e.clientY - r.top) / r.height),
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    onChange({ ...hsv, s: clamp01(hsv.s + move[0]), v: clamp01(hsv.v + move[1]) });
  };
  return (
    <div
      ref={box}
      role="slider"
      tabIndex={0}
      aria-label="Saturation and brightness"
      aria-roledescription="2D slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct(hsv.s)}
      aria-valuetext={`Saturation ${pct(hsv.s)} percent, brightness ${pct(hsv.v)} percent`}
      className="relative h-[200px] w-full cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      style={{
        background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.currentTarget.focus();
        at(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) at(e);
      }}
      onKeyDown={onKeyDown}
    >
      {/* Kept inside the square, as the package keeps its handle: a ring half out of the corner is hard
          to take hold of again. */}
      <span
        aria-hidden
        className={cn(HANDLE, "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2")}
        style={{
          left: `calc(9px + ${hsv.s} * (100% - 18px))`,
          top: `calc(9px + ${1 - hsv.v} * (100% - 18px))`,
        }}
      />
    </div>
  );
}

const HUE_TRACK =
  "linear-gradient(to right, #f00 0%, #ff0 16.66%, #0f0 33.33%, #0ff 50%, #00f 66.66%, #f0f 83.33%, #f00 100%)";

/** A 14 px bar with a ring handle; `named` prints the label inside the bar, as the fine sliders do. */
function Bar({
  label,
  value,
  max,
  track,
  thumb,
  text,
  named = false,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  track: string;
  thumb: string;
  text: string;
  named?: boolean;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <SliderPrimitive.Root
      min={0}
      max={max}
      step={1}
      value={[value]}
      onValueChange={([v]) => onChange(v ?? 0)}
      className="relative flex h-[18px] w-full cursor-ew-resize touch-none items-center select-none"
    >
      <SliderPrimitive.Track className="relative h-3.5 grow rounded-full" style={{ background: track }}>
        <SliderPrimitive.Range className="absolute h-full" />
      </SliderPrimitive.Track>
      {named ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs leading-none font-medium text-white [text-shadow:1px_1px_1px_rgba(0,0,0,0.6)]"
        >
          {label}
        </span>
      ) : null}
      <SliderPrimitive.Thumb
        aria-label={label}
        aria-valuetext={text}
        className={HANDLE}
        style={{ background: thumb }}
      />
    </SliderPrimitive.Root>
  );
}

/** The colour as numbers: hex always, then the chosen model's channels, each captioned underneath. */
function ColourInputs({
  model,
  hsv,
  hex,
  onChange,
  onHex,
}: {
  model: ColourModel;
  hsv: Hsv;
  hex: string;
  onChange: (next: Hsv) => void;
  onHex: (text: string) => void;
}): JSX.Element {
  // What is being typed into one input, until it leaves; the others follow the colour.
  const [typing, setTyping] = useState<{ key: string; text: string } | null>(null);
  const shown = (key: string, fallback: string) => (typing?.key === key ? typing.text : fallback);
  const channels = CHANNELS[model];
  const values = channelValues(model, hsv);
  const set = (key: string, n: number): void => onChange(fromChannels(model, { ...values, [key]: n }, hsv.h));

  return (
    <div className="mt-3.5 flex gap-1.5">
      <NumberBox caption="HEX" className="w-[76px] shrink-0">
        <input
          aria-label="Hex colour"
          value={shown("hex", hex.slice(1))}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          className={cn(BOX, "uppercase")}
          onChange={(e) => {
            setTyping({ key: "hex", text: e.target.value });
            if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(e.target.value.trim())) onHex(e.target.value);
          }}
          onBlur={() => setTyping(null)}
          onFocus={(e) => e.currentTarget.select()}
        />
      </NumberBox>
      {channels.map((c) => (
        <NumberBox key={c.key} caption={c.short} title={c.name} className="min-w-0 flex-1">
          <input
            aria-label={c.name}
            inputMode="numeric"
            autoComplete="off"
            value={shown(c.key, String(values[c.key] ?? 0))}
            className={BOX}
            onChange={(e) => {
              setTyping({ key: c.key, text: e.target.value });
              const n = Number(e.target.value);
              if (e.target.value.trim() !== "" && Number.isFinite(n)) set(c.key, n);
            }}
            onKeyDown={(e) => {
              if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
              e.preventDefault();
              setTyping(null);
              const step = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
              set(c.key, Math.min(c.max, Math.max(0, (values[c.key] ?? 0) + step)));
            }}
            onBlur={() => setTyping(null)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </NumberBox>
      ))}
    </div>
  );
}

const BOX =
  "h-8 w-full min-w-0 rounded-md border border-[#bebebe] bg-transparent p-0.5 text-center text-[15px] text-black outline-none focus-visible:border-[#568cf5] focus-visible:ring-2 focus-visible:ring-[#568cf5]/30 dark:border-input dark:text-foreground";

/** An input with its caption underneath; the input carries its own name, the caption is only printed. */
function NumberBox({
  caption,
  title,
  className,
  children,
}: {
  caption: string;
  title?: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cn("flex flex-col items-center", className)} title={title}>
      {children}
      <span aria-hidden className={cn("text-[11px] leading-[1.2] font-bold", CAPTION)}>
        {caption}
      </span>
    </div>
  );
}

function Guide({
  hsv,
  current,
  onPick,
}: {
  hsv: Hsv;
  current: string;
  onPick: (hex: string) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label="Colour guide" className="relative mt-2.5">
      <span aria-hidden className={cn("absolute top-0 left-0.5 text-[13px] font-semibold", MARK)}>
        Colour guide
      </span>
      {harmonies(hsv).map((row) => (
        <div key={row.name} role="group" aria-label={row.name} className="flex flex-col">
          <span aria-hidden className={cn("mt-1 text-center text-xs leading-5 font-medium", MARK)}>
            {row.name}
          </span>
          <div className="flex h-[30px] overflow-hidden rounded-[5px]">
            {row.colours.map((c, i) => (
              <button
                // a row can name one colour twice (a grey turned is still that grey), so the place counts
                key={`${c}-${i}`}
                type="button"
                aria-label={c}
                aria-pressed={c === current}
                title={c}
                onClick={() => onPick(c)}
                className="flex-1 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset"
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Swatches({
  name,
  colours,
  current,
  onPick,
}: {
  name: string;
  colours: readonly string[];
  current: string;
  onPick: (hex: string) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label={name} className="grid min-w-0 flex-1 grid-cols-9 content-start gap-[3px]">
      {colours.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          aria-pressed={c === current}
          title={c}
          onClick={() => onPick(c)}
          className={cn(
            "h-[23.5px] cursor-pointer rounded-[4px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-[#568cf5]",
            isLight(c) ? "border border-[#96959c]" : "",
            c === current ? "ring-2 ring-[#568cf5] ring-offset-1 ring-offset-popover" : "",
          )}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}
