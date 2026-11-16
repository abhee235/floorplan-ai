// The marker that says the host is running code older than what is written, or that the app has not been
// built since its source changed (see apps/host/src/staleness.ts for how that is decided).
//
// It is a mark in the app bar that opens what it has to say when it is pressed, NOT a strip across the
// editor. A warning that takes a row of its own pushes the plan, the 3D view and the panel down the
// moment it appears and pulls them back up when it goes; the editor is not allowed to move under someone
// working in it. The app bar always has room, the mark is the only amber thing on screen, and the words
// are one click away for whoever wants them.
//
// A screen reader gets the sentence the first time it appears rather than an icon it cannot see.

import { TriangleAlert } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEditor } from "./useEditor.js";

export function StaleNote({ note }: { note: string | null }): JSX.Element {
  const { announcer } = useEditor();
  const said = useRef<string | null>(null);
  useEffect(() => {
    if (!note || said.current === note) return;
    said.current = note;
    announcer.say(note);
  }, [note, announcer]);
  if (!note) return <></>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="What is out of date"
          className="size-7 text-[#a05a00] hover:bg-[#fdf4e0] hover:text-[#6b4d0f]"
        >
          <TriangleAlert aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-xs leading-relaxed text-pretty">
        {note}
      </PopoverContent>
    </Popover>
  );
}
