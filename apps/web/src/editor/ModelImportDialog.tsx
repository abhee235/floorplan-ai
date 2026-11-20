// A 3D model made into a product (ADR-010 D10, PRD P3-8): what it is, which way it faces, what its file's
// numbers mean, and how big it is. The preview shows it as it will stand, so turning it until it faces you
// along the arrow is the whole of "fix the front". The size starts from the model and can be typed over.
import type { Size3 } from "@fpv/ir";
import { Loader2, RotateCcw, Undo2 } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type * as THREE from "three";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type Extent,
  MODEL_CATEGORIES,
  type ModelUnits,
  modelNameFromFile,
  SIDE_RANGE,
  shapedExtent,
  sizeInMm,
  suggestUnits,
  UNIT_CHOICES,
  validSide,
  withSide,
} from "./model-import.js";
import type { ModelPreview } from "./model-preview.js";

export interface ModelChoice {
  fileName: string;
  extent: Extent;
  scene: THREE.Object3D;
  /** A .gltf and its files, written out as one .glb in the browser. */
  converted: boolean;
}

export interface ModelImportSettings {
  name: string;
  category: string;
  units: ModelUnits;
  turn: number;
  tip: number;
  /** The size asked for, or null for the model's own. */
  size: Size3 | null;
}

export interface ModelImportDialogProps {
  model: ModelChoice | null;
  busy: boolean;
  /** Why the last attempt was refused, in the host's words. */
  error: string | null;
  onCancel: () => void;
  onImport: (settings: ModelImportSettings) => void;
  /** Builds the preview on the dialog's canvas; null where there is no WebGL, as in tests. */
  preview: ((canvas: HTMLCanvasElement) => ModelPreview) | null;
}

const SIDES: readonly { key: keyof Size3; label: string }[] = [
  { key: "w", label: "Width" },
  { key: "d", label: "Depth" },
  { key: "h", label: "Height" },
];

export function ModelImportDialog({
  model,
  busy,
  error,
  onCancel,
  onImport,
  preview,
}: ModelImportDialogProps): JSX.Element {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("other");
  const [units, setUnits] = useState<ModelUnits>("m");
  const [turn, setTurn] = useState(0);
  const [tip, setTip] = useState(0);
  const [typed, setTyped] = useState<Record<keyof Size3, string> | null>(null);
  const [proportional, setProportional] = useState(true);
  const [previewOk, setPreviewOk] = useState(true);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const previewRef = useRef<ModelPreview | null>(null);
  const ids = { name: useId(), category: useId(), units: useId(), measured: useId(), front: useId() };

  // a new model starts from its own name, its file's likely units, as it is, at its own size
  useEffect(() => {
    if (!model) return;
    setName(modelNameFromFile(model.fileName));
    setCategory("other");
    setUnits(suggestUnits(model.extent));
    setTurn(0);
    setTip(0);
    setTyped(null);
    setProportional(true);
    setPreviewOk(true);
  }, [model]);

  const measured = model ? sizeInMm(shapedExtent(model.extent, turn, tip), units) : null;
  const asText = (s: Size3) => ({ w: String(s.w), d: String(s.d), h: String(s.h) });
  const shown = typed ?? (measured ? asText(measured) : { w: "", d: "", h: "" });
  const size = { w: Number(shown.w), d: Number(shown.d), h: Number(shown.h) };
  const sizeOk = SIDES.every((s) => validSide(size[s.key]));
  const own = !!measured && size.w === measured.w && size.d === measured.d && size.h === measured.h;
  const ready = !!model && sizeOk && name.trim() !== "" && !busy;

  // The preview lives as long as its canvas. The dialog's portal puts the canvas in the page a render
  // after the dialog opens, so the preview is built when the canvas arrives, not when the model does:
  // built on the model's arrival it found no canvas, and the preview stayed blank.
  useEffect(() => {
    if (!model || !canvas || !preview) return;
    let made: ModelPreview;
    try {
      made = preview(canvas);
    } catch {
      setPreviewOk(false);
      return;
    }
    previewRef.current = made;
    return () => {
      made.dispose();
      previewRef.current = null;
    };
  }, [model, preview, canvas]);
  useEffect(() => {
    if (model && canvas) previewRef.current?.show(model.scene, turn, tip);
  }, [model, turn, tip, canvas]);

  const setSide = (side: keyof Size3, text: string) => {
    const digits = text.replace(/[^\d]/g, "");
    const value = Number(digits);
    // in proportion to the model itself, not to the last keystroke: typing 1600 passes through 1, 16
    // and 160, and scaling from each of those in turn would run the other sides away
    if (proportional && validSide(value) && measured) setTyped(asText(withSide(measured, side, value, true)));
    else setTyped({ ...shown, [side]: digits });
  };
  // turning, standing up or other units measure the model again, over anything typed
  const reshape = (next: () => void) => {
    next();
    setTyped(null);
  };

  return (
    <Dialog open={model !== null} onOpenChange={(next) => (next || busy ? undefined : onCancel())}>
      <DialogContent className="max-w-lg sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) onImport({ name: name.trim(), category, units, turn, tip, size: own ? null : size });
          }}
        >
          <DialogHeader>
            <DialogTitle>Import a 3D model</DialogTitle>
            <DialogDescription>
              It becomes a product in the catalog at the size you give. Turn it until its front faces you,
              along the blue arrow.
            </DialogDescription>
          </DialogHeader>
          {model ? (
            <div className="flex flex-col gap-2">
              {preview && previewOk ? (
                <canvas
                  ref={setCanvas}
                  className="h-56 w-full rounded border border-border"
                  role="img"
                  aria-describedby={ids.front}
                  aria-label={`${model.fileName} as it will stand`}
                />
              ) : (
                <p className="rounded border border-border p-3 text-[12px] text-muted-foreground">
                  The preview needs WebGL, which this browser does not offer. The model can still be imported.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-7 gap-1.5 text-[12px]"
                  onClick={() => reshape(() => setTurn((t) => (t + 1) % 4))}
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Turn
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-7 gap-1.5 text-[12px]"
                  aria-describedby={ids.front}
                  onClick={() => reshape(() => setTip((t) => (t + 1) % 4))}
                >
                  <Undo2 className="size-3.5 rotate-90" aria-hidden />
                  Stand up
                </Button>
                <span id={ids.front} className="text-[12px] text-muted-foreground" aria-live="polite">
                  {turn === 0 && tip === 0
                    ? "As the file has it."
                    : `Turned ${turn * 90}°${tip ? `, tipped ${tip * 90}°` : ""}.`}{" "}
                  Stand up is for a model that arrives lying on its back.
                </span>
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
            <Label htmlFor={ids.name} className="text-[13px]">
              Name
            </Label>
            <Input
              id={ids.name}
              className="h-8"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
            <Label htmlFor={ids.category} className="text-[13px]">
              Category
            </Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id={ids.category} size="sm" className="h-8 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label htmlFor={ids.units} className="text-[13px]">
              File units
            </Label>
            <Select value={units} onValueChange={(v) => reshape(() => setUnits(v as ModelUnits))}>
              <SelectTrigger id={ids.units} size="sm" className="h-8 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNIT_CHOICES.map((u) => (
                  <SelectItem key={u.value} value={u.value}>
                    {u.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[13px]">Size</span>
            <fieldset className="flex flex-wrap items-center gap-2" aria-describedby={ids.measured}>
              <legend className="sr-only">Size in millimetres</legend>
              {SIDES.map((s) => (
                <label key={s.key} className="flex items-center gap-1 text-[12px] text-muted-foreground">
                  <span aria-hidden>{s.key.toUpperCase()}</span>
                  <Input
                    className="h-8 w-20 text-right tabular-nums"
                    inputMode="numeric"
                    aria-label={s.label}
                    value={shown[s.key]}
                    aria-invalid={!validSide(size[s.key])}
                    onChange={(e) => setSide(s.key, e.target.value)}
                  />
                </label>
              ))}
              <span className="text-[12px] text-muted-foreground">mm</span>
            </fieldset>
            <span />
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12px]">
                <Checkbox checked={proportional} onCheckedChange={(v) => setProportional(v === true)} />
                Keep proportions
              </label>
              <span id={ids.measured} className="text-[12px] text-muted-foreground" aria-live="polite">
                {!sizeOk
                  ? `Each side from ${SIDE_RANGE.min} to ${SIDE_RANGE.max.toLocaleString("en")} mm`
                  : own || !measured
                    ? "The model's own size, in the units above."
                    : `The model measures ${measured.w} × ${measured.d} × ${measured.h} mm; it will be scaled to this.`}
              </span>
            </div>
          </div>
          {model?.converted ? (
            <p className="text-[12px] text-muted-foreground">
              The .gltf and its files are sent as one .glb file.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="h-8" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" className="h-8 gap-1.5" disabled={!ready}>
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              Add to catalog
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
