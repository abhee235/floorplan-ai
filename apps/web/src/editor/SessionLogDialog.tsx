// Help ▸ Session log (ADR-019 D7): the run's own record, in the editor.
//
// The log has been readable from a terminal since it was written, which is no use to someone who is in
// the editor when the thing they want to report happens. This is the same file, asked for over the
// bridge and drawn rather than printed: the host owns the files and the tab asks.
//
// It shows objects, not the CLI's formatted lines. A terminal and a panel are different media — a panel
// can colour a kind, right-align a time and fold a change list — and both read the same JSONL, so the
// two presentations cannot disagree about what happened.

import { Circle, Pause, Play } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** How often a followed run is asked for again. */
const FOLLOW_MS = 700;
/** How many lines are held in view; a run of thousands shows its tail. */
const KEEP = 600;

export interface LogEntry {
  ts?: string;
  seq?: number;
  kind?: string;
  source?: string;
  [field: string]: unknown;
}

export interface LogRun {
  name: string;
  at: string | null;
  bytes: number;
  current: boolean;
}

/** Asks the host; resolves with the result body, or throws with the host's reason. */
export type AskLog = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface SessionLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ask: AskLog;
}

/** The fields that are the line's own furniture rather than part of what it says. */
const COMMON = new Set(["ts", "seq", "kind", "source", "changed", "entities"]);

/** A colour per kind, so a page of lines has a shape before it is read. */
const TONE: Record<string, string> = {
  command: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  transaction: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  gesture: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  undo: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  redo: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  tool: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  problem: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

function brief(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= 160 ? text : `${text.slice(0, 157)}…`;
}

/**
 * The headline of a line: what it was, then everything on it that is not furniture.
 *
 * Only the field actually used as the lead is left out of the rest. Excluding a fixed list dropped the
 * one that mattered: a gesture says `what: "tool"` with a detail field also called `tool` naming the
 * tool picked, so "picked the cluster tool" rendered as "tool from=select" — the answer removed.
 */
function headline(entry: LogEntry): string {
  const kind = String(entry.kind ?? "");
  const leadKey =
    kind === "gesture"
      ? "what"
      : (["command", "tool", "label", "event"].find((k) => entry[k] !== undefined) ?? "");
  const lead = leadKey ? String(entry[leadKey] ?? "") : "";
  const rest = Object.entries(entry)
    .filter(([k]) => !COMMON.has(k) && k !== leadKey)
    .map(([k, v]) => `${k}=${brief(v)}`);
  return [lead, ...rest].filter(Boolean).join("  ");
}

function Line({ entry }: { entry: LogEntry }): JSX.Element {
  const kind = String(entry.kind ?? "?");
  const text = headline(entry);
  const changed = Array.isArray(entry.changed) ? (entry.changed as Record<string, unknown>[]) : [];
  const gone = (entry.entities as { removed?: string[] } | undefined)?.removed ?? [];
  return (
    <div className="border-border/60 border-b px-3 py-1.5 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="w-10 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
          {entry.seq ?? ""}
        </span>
        <span className="w-16 shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {typeof entry.ts === "string" ? entry.ts.slice(11, 19) : ""}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE[kind] ?? "bg-muted text-muted-foreground"}`}
        >
          {kind}
        </span>
        {/* Two lines at most. The host's opening lines carry a full argv and two absolute paths, and
            left to run they push everything worth reading off the top of the view. */}
        <span className="line-clamp-2 min-w-0 flex-1 break-all text-[12px] leading-5" title={text}>
          {text}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{String(entry.source ?? "")}</span>
      </div>
      {changed.length > 0 || gone.length > 0 ? (
        <div className="mt-1 ml-[7.5rem] space-y-0.5 font-mono text-[11px] leading-4 text-muted-foreground">
          {changed.map((c, i) => (
            <div key={`${String(c.entity)}-${String(c.at)}-${i}`} className="break-all">
              <span className="text-foreground">{String(c.entity ?? "?")}</span> {String(c.at ?? "")}{" "}
              {"from" in c ? `${brief(c.from)} → ` : ""}
              {"to" in c ? brief(c.to) : String(c.op ?? "")}
            </div>
          ))}
          {/* A removal's patch points at an index that has gone, so the ids are all that is left. */}
          {gone.length > 0 ? <div className="break-all">removed {gone.join(", ")}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function SessionLogDialog({ open, onOpenChange, ask }: SessionLogDialogProps): JSX.Element {
  const [runs, setRuns] = useState<LogRun[]>([]);
  const [run, setRun] = useState<string>("");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [find, setFind] = useState("");
  const [following, setFollowing] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [path, setPath] = useState<string>("");
  const at = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  /** Ask for a run from the beginning, replacing what is shown. */
  const load = useCallback(
    async (which: string) => {
      at.current = 0;
      setEntries([]);
      try {
        const body = await ask({ type: "log", op: "read", run: which, limit: KEEP });
        at.current = Number(body.end ?? 0);
        setPath(String(body.path ?? ""));
        setEntries((body.entries as LogEntry[]) ?? []);
        setNote(null);
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
      }
    },
    [ask],
  );

  // The runs, and the newest one, whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const body = await ask({ type: "log", op: "runs" });
        if (cancelled) return;
        const list = (body.runs as LogRun[]) ?? [];
        setRuns(list);
        const first = list[0]?.name ?? "";
        setRun(first);
        if (first) await load(first);
        else setNote("No runs have been written yet.");
      } catch (e) {
        if (!cancelled) setNote(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, ask, load]);

  // Following: ask for whatever is new, which is why the host takes a byte offset.
  useEffect(() => {
    if (!open || !following || !run) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const body = await ask({ type: "log", op: "read", run, from: at.current, limit: KEEP });
          at.current = Number(body.end ?? at.current);
          const fresh = (body.entries as LogEntry[]) ?? [];
          if (fresh.length > 0) setEntries((prev) => [...prev, ...fresh].slice(-KEEP));
        } catch {
          // a run that went away, or a host that closed: the next tick says so or it comes back
        }
      })();
    }, FOLLOW_MS);
    return () => clearInterval(timer);
  }, [open, following, run, ask]);

  const shown = find
    ? entries.filter((e) => JSON.stringify(e).toLowerCase().includes(find.toLowerCase()))
    : entries;

  // Following means watching the end of it.
  useEffect(() => {
    if (following) bottom.current?.scrollIntoView({ block: "end" });
  }, [following]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col gap-3 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Session log</DialogTitle>
          <DialogDescription>
            Everything this session did, as it happened: the commands, what moved, the tools, and what you did
            to cause them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2">
          <Select
            value={run}
            onValueChange={(next) => {
              setRun(next);
              void load(next);
            }}
          >
            <SelectTrigger size="sm" aria-label="Run" className="w-[230px] gap-1 data-[size=sm]:h-8">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {runs.map((r) => (
                <SelectItem key={r.name} value={r.name}>
                  {(r.at ?? r.name).replace("T", " ").slice(0, 19)}
                  {r.current ? " · this one" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Only lines holding…  e.g. an id"
            aria-label="Only lines holding this text"
            className="h-8 flex-1"
          />

          <Button
            variant={following ? "default" : "outline"}
            className="h-8 gap-1.5"
            aria-pressed={following}
            onClick={() => setFollowing((f) => !f)}
          >
            {following ? <Circle className="size-2.5 fill-current" /> : <Play className="size-3.5" />}
            {following ? "Following" : "Follow"}
            {following ? <Pause className="size-3.5" /> : null}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-card">
          {note ? <p className="p-4 text-sm text-muted-foreground">{note}</p> : null}
          {shown.map((entry, i) => (
            <Line key={`${String(entry.seq ?? i)}-${String(entry.ts ?? i)}`} entry={entry} />
          ))}
          {!note && shown.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {entries.length === 0 ? "Nothing written yet." : "No line holds that text."}
            </p>
          ) : null}
          <div ref={bottom} />
        </div>

        <p className="shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={path}>
          {path}
        </p>
      </DialogContent>
    </Dialog>
  );
}
