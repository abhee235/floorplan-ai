// A picture made into a texture (ADR-010 D10, PRD P3-8): the picture, what to call it, and how big it is
// in reality. A texture repeats at its real size, so the width is the one question worth asking: a 600 mm
// tile and a six-metre mural can be the same file. The height follows the picture's shape.

import { Loader2 } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
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

/** A real-world width when none is given, as the host assumes: a typical tile or board. */
export const DEFAULT_WIDTH_MM = 200;
/** The host's limits on a real-world width, in millimetres. */
export const WIDTH_RANGE = { min: 10, max: 100_000 } as const;
/** Past this many pixels on the long side, the host suggests a smaller copy. */
export const LARGE_PX = 2048;

/** A texture's name from a file's: "oak-plank_02.jpg" reads "Oak plank 02". */
export function nameFromFile(fileName: string): string {
  const bare = fileName
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : "Imported texture";
}

/** The real height for a width, from the picture's shape, as the host works it out. */
export function heightFor(widthMm: number, picture: { width: number; height: number }): number {
  return Math.max(1, Math.round((widthMm * picture.height) / picture.width));
}

export interface TexturePicture {
  /** An object URL the preview shows. */
  url: string;
  fileName: string;
  width: number;
  height: number;
}

export interface TextureImportDialogProps {
  picture: TexturePicture | null;
  busy: boolean;
  /** Why the last attempt was refused, in the host's words. */
  error: string | null;
  onCancel: () => void;
  onImport: (name: string, widthMm: number) => void;
}

export function TextureImportDialog({
  picture,
  busy,
  error,
  onCancel,
  onImport,
}: TextureImportDialogProps): JSX.Element {
  const [name, setName] = useState("");
  const [width, setWidth] = useState(String(DEFAULT_WIDTH_MM));
  const ids = { name: useId(), width: useId(), height: useId() };
  // a new picture starts from its own name and the usual width
  useEffect(() => {
    if (!picture) return;
    setName(nameFromFile(picture.fileName));
    setWidth(String(DEFAULT_WIDTH_MM));
  }, [picture]);

  const widthMm = Number(width);
  const widthOk = Number.isInteger(widthMm) && widthMm >= WIDTH_RANGE.min && widthMm <= WIDTH_RANGE.max;
  const ready = !!picture && widthOk && name.trim() !== "" && !busy;
  const large = picture ? Math.max(picture.width, picture.height) > LARGE_PX : false;

  return (
    <Dialog open={picture !== null} onOpenChange={(next) => (next || busy ? undefined : onCancel())}>
      <DialogContent className="max-w-md sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) onImport(name.trim(), widthMm);
          }}
        >
          <DialogHeader>
            <DialogTitle>Use a picture as a material</DialogTitle>
            <DialogDescription>
              It repeats at the size you give, so measure the surface in the picture: one tile, one board, or
              the whole patch shown.
            </DialogDescription>
          </DialogHeader>
          {picture ? (
            <div className="flex gap-3">
              <img
                src={picture.url}
                alt=""
                className="h-24 w-24 shrink-0 rounded border border-border bg-[repeating-conic-gradient(#e5e5e5_0_25%,#fff_0_50%)] bg-[length:12px_12px] object-contain"
              />
              <div className="flex min-w-0 flex-col justify-center gap-1 text-[12px] text-muted-foreground">
                <span className="truncate text-foreground" title={picture.fileName}>
                  {picture.fileName}
                </span>
                <span>
                  {picture.width} × {picture.height} pixels
                </span>
                {large ? (
                  <span>A smaller copy would look the same in the plan and use less memory.</span>
                ) : null}
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
            <Label htmlFor={ids.width} className="text-[13px]">
              Real width
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={ids.width}
                className="h-8 w-28 text-right tabular-nums"
                inputMode="numeric"
                value={width}
                autoFocus
                aria-invalid={!widthOk}
                aria-describedby={ids.height}
                onChange={(e) => setWidth(e.target.value.replace(/[^\d]/g, ""))}
              />
              <span className="text-[12px] text-muted-foreground">mm</span>
            </div>
            <span className="text-[13px] text-muted-foreground">Height</span>
            <span id={ids.height} className="text-[12px] text-muted-foreground" aria-live="polite">
              {picture && widthOk
                ? `${heightFor(widthMm, picture)} mm, from the picture's shape`
                : `A width from ${WIDTH_RANGE.min} to ${WIDTH_RANGE.max.toLocaleString("en")} mm`}
            </span>
          </div>
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
              Add material
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
