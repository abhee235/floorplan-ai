// The colour picker behind a colour row's swatch (P3-5 follow-up), laid out as design tools lay theirs out:
// a saturation and brightness square, a hue slider, the colour in whichever model suits (hex, RGB, HSL,
// HSB or CMYK), an eyedropper where the browser has one, a guide of colours that go with it, and swatches
// of the colours the project already uses.
//
// Every change is shown at once, on the plan and in 3D, through `onPick`; nothing is sent until the picker
// closes, and Escape closes it without keeping anything.
//
// Laid out like the picker in the owner's own design editor (wizzel), which uses the MIT package
// react-best-gradient-color-picker. Written here without that package or its dependencies: there are no
// gradients or opacity to pick in the model, and the eyedropper is the browser's own where it has one.
import { cn } from "cn";
import { Palette, Pipette } from "lucide-react";
import { Slider as SliderPrimitive } from "radix-ui";
import type { JSX, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import {
  CHANNELS,
  COLOUR_MODELS,
  type ColourModel,
  channelValues,
  fromChannels,
  type Hsv,
  harmonies,
  hexToHsv,
  hsvToHex,
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
let lastModel: ColourModel = "hex";

const WHITE: Hsv = { h: 0, s: 0, v: 1 };

interface EyeDropperResult {
  sRGBHex: string;
}
type EyeDropperCtor = new () => { open: () => Promise<EyeDropperResult> };
const eyeDropper = (): EyeDropperCtor | null =>
  typeof window !== "undefined" && "EyeDropper" in window
    ? ((window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper ?? null)
    : null;

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
  const [start, setStart] = useState(value);
  const [model, setModelState] = useState<ColourModel>(lastModel);
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
      setStart(value);
      setHsv(hexToHsv(value, hsv.h) ?? WHITE);
      setOpen(true);
      return;
    }
    setOpen(false);
    onClose(!cancelled.current);
    cancelled.current = false;
  };

  const Dropper = eyeDropper();

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={`${label}, picker`}
          style={{ background: value }}
          className={cn(
            "size-4 shrink-0 cursor-pointer rounded-sm border border-input outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            className,
          )}
        />
      </PopoverTrigger>
      <PopoverContent
        aria-label={`${label}, picker`}
        side="left"
        align="start"
        sideOffset={offset}
        className="w-60 p-3"
        onEscapeKeyDown={() => {
          cancelled.current = true;
        }}
      >
        <div className="flex flex-col gap-3 select-none">
          <SaturationSquare hsv={hsv} onChange={choose} />
          <div className="flex items-center gap-1">
            {Dropper ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Pick a colour from the screen"
                title="Pick a colour from the screen"
                onClick={() => {
                  new Dropper()
                    .open()
                    .then((r) => chooseHex(r.sRGBHex))
                    .catch(() => undefined);
                }}
              >
                <Pipette aria-hidden />
              </Button>
            ) : null}
            <Select value={model} onValueChange={(next) => setModel(next as ColourModel)}>
              <SelectTrigger size="sm" aria-label="Colour model" className="h-7 grow data-[size=sm]:h-7">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COLOUR_MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Toggle
              size="sm"
              aria-label="Colour guide"
              title="Colour guide"
              pressed={guide}
              onPressedChange={setGuide}
              className="size-7 min-w-7"
            >
              <Palette aria-hidden />
            </Toggle>
          </div>
          <HueSlider hsv={hsv} onChange={choose} />
          <ColourInputs model={model} hsv={hsv} hex={hex} onChange={choose} onHex={chooseHex} />
          {guide ? <Guide hsv={hsv} current={hex} onPick={chooseHex} /> : null}
          <div className="flex gap-2">
            <div className="flex h-12 w-9 shrink-0 flex-col overflow-hidden rounded-md border">
              <div className="grow" style={{ background: hex }} title={`Now ${hex}`} />
              <button
                type="button"
                className="grow cursor-pointer"
                style={{ background: start }}
                aria-label={`Back to ${start}`}
                title={`Back to ${start}`}
                onClick={() => chooseHex(start)}
              />
            </div>
            <div className="flex min-w-0 grow flex-col gap-1.5">
              {swatches.length > 0 ? (
                <Swatches name="In this project" colours={swatches} current={hex} onPick={chooseHex} />
              ) : null}
              <Swatches name="Interior colours" colours={INTERIOR_COLOURS} current={hex} onPick={chooseHex} />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
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
      className="relative h-36 w-full cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
      <span
        aria-hidden
        className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
        style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }}
      />
    </div>
  );
}

const HUE_TRACK =
  "linear-gradient(to right, #f00 0%, #ff0 16.66%, #0f0 33.33%, #0ff 50%, #00f 66.66%, #f0f 83.33%, #f00 100%)";

function HueSlider({ hsv, onChange }: { hsv: Hsv; onChange: (next: Hsv) => void }): JSX.Element {
  const hue = Math.round(hsv.h);
  return (
    <SliderPrimitive.Root
      min={0}
      max={359}
      step={1}
      value={[hue]}
      onValueChange={([h]) => onChange({ ...hsv, h: h ?? 0 })}
      className="relative flex h-3 w-full touch-none items-center"
    >
      <SliderPrimitive.Track className="relative h-3 grow rounded-full" style={{ background: HUE_TRACK }}>
        <SliderPrimitive.Range className="absolute h-full" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label="Hue"
        aria-valuetext={`${hue} degrees`}
        className="block size-3.5 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        style={{ background: `hsl(${hsv.h} 100% 50%)` }}
      />
    </SliderPrimitive.Root>
  );
}

/** The colour as numbers: one hex field, or one field per channel of the chosen model. */
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

  if (model === "hex")
    return (
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted-foreground"
        >
          #
        </span>
        <Input
          aria-label="Hex colour"
          value={shown("hex", hex.slice(1))}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          className="h-7 pl-5 font-mono uppercase"
          onChange={(e) => {
            setTyping({ key: "hex", text: e.target.value });
            if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(e.target.value.trim())) onHex(e.target.value);
          }}
          onBlur={() => setTyping(null)}
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
    );

  const channels = CHANNELS[model];
  const values = channelValues(model, hsv);
  const set = (key: string, n: number): void => onChange(fromChannels(model, { ...values, [key]: n }, hsv.h));
  return (
    <div className="flex gap-1">
      {channels.map((c) => (
        <label key={c.key} className="flex min-w-0 flex-1 flex-col items-center gap-0.5" title={c.name}>
          <Input
            aria-label={c.name}
            inputMode="numeric"
            autoComplete="off"
            value={shown(c.key, String(values[c.key] ?? 0))}
            className="h-7 px-1 text-center tabular-nums"
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
          <span aria-hidden className="text-[10px] text-muted-foreground">
            {c.short}
          </span>
        </label>
      ))}
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
    <div className="flex flex-col gap-1.5">
      {harmonies(hsv).map((row) => (
        <div key={row.name} role="group" aria-label={row.name} className="flex flex-col gap-0.5">
          <span aria-hidden className="text-[11px] text-muted-foreground">
            {row.name}
          </span>
          <div className="flex overflow-hidden rounded-md border">
            {row.colours.map((c, i) => (
              <button
                // a harmony can name one colour twice (a grey turned is still that grey), so the place counts
                key={`${c}-${i}`}
                type="button"
                aria-label={c}
                aria-pressed={c === current}
                title={c}
                onClick={() => onPick(c)}
                className="h-6 flex-1 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
    <div role="group" aria-label={name} className="flex flex-col gap-0.5">
      <span aria-hidden className="text-[11px] text-muted-foreground">
        {name}
      </span>
      <div className="grid grid-cols-9 gap-1">
        {colours.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            aria-pressed={c === current}
            title={c}
            onClick={() => onPick(c)}
            className={cn(
              "relative aspect-square cursor-pointer rounded-sm border border-black/10 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              c === current
                ? isLight(c)
                  ? "ring-1 ring-black/60 ring-inset"
                  : "ring-1 ring-white ring-inset"
                : "",
            )}
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  );
}
