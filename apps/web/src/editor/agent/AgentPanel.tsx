// What is inside the chat window: the transcript, and the box you type in (ADR-022).
//
// The transcript is the run made visible. A tool card is not a log line — it says what the agent is
// doing in words ("Drawing 4 points of wall"), shows whether it worked, and can point at what moved,
// because the thing a person wants after "it placed eight chairs" is to see the eight chairs.
//
// Nothing here decides anything about the run. Every rule about what a card is lives in the store,
// which is why this file has no state beyond what is being typed.

import { AlertTriangle, ArrowUp, Check, CircleSlash, Loader2, Paperclip, Undo2, X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgentItem, AgentState } from "./agent-store.js";

export interface AgentPanelProps {
  state: AgentState;
  /** Send a message, with whatever is attached. */
  onSend(text: string, files: File[]): void;
  onCancel(): void;
  onAnswer(questionId: string, answer: string): void;
  /** Take the whole run back, from the checkpoint it started at. */
  onUndoRun(checkpointId: string): void;
  /** Show what a tool changed: select it and bring it into view. */
  onShow(ids: string[]): void;
  /** Ask the host for the events this tab missed. */
  onCatchUp(): void;
}

export function AgentPanel({
  state,
  onSend,
  onCancel,
  onAnswer,
  onUndoRun,
  onShow,
  onCatchUp,
}: AgentPanelProps): JSX.Element {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = state.status === "running" || state.status === "waiting" || state.status === "cancelling";

  // Follow the transcript while it grows. Only while the run is live: scrolling somebody back to the
  // bottom while they are reading what happened earlier is the rudest thing a chat does.
  useEffect(() => {
    // Called through an optional check: not every environment that renders this has scrollIntoView,
    // and a transcript that cannot follow itself is still a transcript worth showing.
    if (busy) endRef.current?.scrollIntoView?.({ block: "end" });
  }, [state.items.length, busy]);

  const send = () => {
    const said = text.trim();
    if ((!said && files.length === 0) || busy) return;
    onSend(said, files);
    setText("");
    setFiles([]);
  };

  if (!state.available)
    return (
      <div className="flex grow flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-muted-foreground text-sm">There is no agent on this host.</p>
        {state.note ? <p className="text-muted-foreground text-xs">{state.note}</p> : null}
      </div>
    );

  return (
    <>
      <div className="min-h-0 grow overflow-y-auto p-3">
        {state.items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="text-muted-foreground text-sm">Ask for what you want built.</p>
            <p className="text-muted-foreground text-xs">
              "A 10-seat boardroom with a display" — or attach a floor plan and say "build this".
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {state.items.map((item) => (
              <li key={item.id}>
                <Card item={item} onAnswer={onAnswer} onShow={onShow} busy={busy} />
              </li>
            ))}
          </ol>
        )}
        {state.missed ? (
          <div className="mt-2 rounded-md border border-dashed p-2 text-center">
            <p className="text-muted-foreground text-xs">Some of this run did not reach this tab.</p>
            <Button variant="ghost" size="sm" onClick={onCatchUp}>
              Catch up
            </Button>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <footer className="shrink-0 border-t p-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="truncate text-muted-foreground text-xs">
            {busy
              ? `${state.status === "waiting" ? "Waiting for you" : state.status === "cancelling" ? "Stopping" : "Working"} · step ${state.steps}`
              : (state.model ?? "")}
          </span>
          <span className="grow" />
          {state.checkpointId && !busy ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onUndoRun(state.checkpointId as string)}
              title="Take the project back to before this run. Only while this host is running."
            >
              <Undo2 aria-hidden /> Undo this run
            </Button>
          ) : null}
          {busy ? (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={state.status === "cancelling"}>
              <X aria-hidden /> Stop
            </Button>
          ) : null}
        </div>

        {files.length > 0 ? (
          <ul className="mb-1 flex flex-wrap gap-1">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${f.size}`}
                className="flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-xs"
              >
                <span className="max-w-40 truncate">{f.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles(files.filter((_, k) => k !== i))}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Attach a plan"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip aria-hidden />
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.pdf,.dxf"
            multiple
            className="hidden"
            onChange={(e) => {
              setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 3));
              e.target.value = "";
            }}
          />
          <textarea
            aria-label="Ask the agent"
            className="max-h-32 min-h-9 grow resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring"
            rows={1}
            placeholder={busy ? "It is working…" : "Build a 10-seat boardroom…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line: the shape everyone already knows.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
              // Escape leaves the box rather than closing the window, so the next shortcut reaches
              // the editor instead of the field.
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
          <Button size="icon-sm" aria-label="Send" onClick={send} disabled={busy}>
            <ArrowUp aria-hidden />
          </Button>
        </div>
      </footer>
    </>
  );
}

function Card({
  item,
  onAnswer,
  onShow,
  busy,
}: {
  item: AgentItem;
  onAnswer(questionId: string, answer: string): void;
  onShow(ids: string[]): void;
  busy: boolean;
}): JSX.Element {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-6 rounded-lg bg-primary px-2.5 py-1.5 text-primary-foreground text-sm">
          <p className="whitespace-pre-wrap break-words">{item.text}</p>
          {item.attachments.length > 0 ? (
            <p className="mt-1 text-xs opacity-80">{item.attachments.map((a) => a.name).join(", ")}</p>
          ) : null}
        </div>
      );

    case "assistant":
      return (
        <div className="whitespace-pre-wrap break-words text-sm">
          {item.text}
          {item.streaming ? <span className="ml-0.5 animate-pulse">▌</span> : null}
        </div>
      );

    case "tool":
      return <ToolCard item={item} onShow={onShow} />;

    case "notes":
      return (
        <details className="rounded-md border bg-muted/30 p-2" open>
          <summary className="cursor-pointer font-medium text-muted-foreground text-xs">
            Notes · {item.text.length} characters
          </summary>
          <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">{item.text}</pre>
        </details>
      );

    case "plan":
      return (
        <div className="rounded-md border bg-muted/30 p-2">
          <p className="mb-1 font-medium text-muted-foreground text-xs">
            Plan · {item.items.filter((i) => i.status === "done").length} of {item.items.length} done
          </p>
          <ul className="flex flex-col gap-0.5 text-sm">
            {item.items.map((job) => (
              <li key={job.id} className="flex items-start gap-1.5">
                <span aria-hidden className="mt-0.5 text-xs">
                  {job.status === "done"
                    ? "✓"
                    : job.status === "doing"
                      ? "▸"
                      : job.status === "skipped"
                        ? "–"
                        : "○"}
                </span>
                <span
                  className={
                    job.status === "done" || job.status === "skipped"
                      ? "text-muted-foreground line-through"
                      : job.status === "doing"
                        ? "font-medium"
                        : ""
                  }
                >
                  {job.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );

    case "question":
      return (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-2">
          <p className="mb-1.5 text-sm">{item.text}</p>
          {item.ask === "consent" && item.ids.length > 0 ? (
            <p className="mb-1.5 text-muted-foreground text-xs">
              Your work:{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => onShow(item.ids)}
              >
                {item.ids.length === 1 ? "1 thing" : `${item.ids.length} things`}
              </button>{" "}
              on the plan.
            </p>
          ) : null}
          {item.answered ? (
            <p className="text-muted-foreground text-xs">You said: {item.answered}</p>
          ) : item.ask === "choice" || item.ask === "consent" ? (
            <div className="flex flex-wrap gap-1">
              {item.options.map((o) => (
                <Button
                  key={o.id}
                  size="sm"
                  variant="outline"
                  onClick={() => onAnswer(item.questionId, o.id)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          ) : (
            <AnswerBox
              questionId={item.questionId}
              hint={
                item.ask === "scale"
                  ? "A unit (mm, m, ft) or a known length — or set the scale in the review panel and commit it there."
                  : undefined
              }
              onAnswer={onAnswer}
              disabled={!busy}
            />
          )}
        </div>
      );

    case "note":
      return (
        <p
          className={`flex items-start gap-1.5 text-xs ${
            item.tone === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {item.tone === "error" ? <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /> : null}
          <span>{item.text}</span>
        </p>
      );
  }
}

function ToolCard({
  item,
  onShow,
}: {
  item: Extract<AgentItem, { kind: "tool" }>;
  onShow(ids: string[]): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const moved = [...(item.changed?.added ?? []), ...(item.changed?.updated ?? [])].map(
    (r) => (r as { id: string }).id,
  );
  return (
    <div className="rounded-md border bg-background/60 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="shrink-0">
          {item.status === "running" ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : item.status === "ok" ? (
            <Check className="size-3.5 text-emerald-600" />
          ) : item.status === "interrupted" ? (
            <CircleSlash className="size-3.5 text-muted-foreground" />
          ) : (
            <AlertTriangle className="size-3.5 text-destructive" />
          )}
        </span>
        <button
          type="button"
          className="grow truncate text-left text-sm"
          onClick={() => setOpen(!open)}
          title={item.name}
        >
          {item.summary}
        </button>
        {moved.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => onShow(moved)}>
            Show
          </Button>
        ) : null}
      </div>

      {item.error ? (
        <p className="mt-1 text-destructive text-xs">
          {item.error.message}
          {item.error.hint ? ` — ${item.error.hint}` : ""}
        </p>
      ) : null}

      {item.display?.kind === "image" ? (
        <img src={item.display.dataUrl} alt={item.display.caption} className="mt-1.5 w-full rounded border" />
      ) : null}

      {open && item.preview ? (
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-1.5 text-[11px] leading-snug">
          {item.preview}
        </pre>
      ) : null}
    </div>
  );
}

function AnswerBox({
  questionId,
  hint,
  onAnswer,
  disabled,
}: {
  questionId: string;
  hint?: string | undefined;
  onAnswer(questionId: string, answer: string): void;
  disabled: boolean;
}): JSX.Element {
  const [value, setValue] = useState("");
  return (
    <div>
      <div className="flex gap-1">
        <input
          aria-label="Your answer"
          className="grow rounded border bg-background px-1.5 py-1 text-sm outline-none focus-visible:border-ring"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              e.preventDefault();
              onAnswer(questionId, value.trim());
            }
          }}
        />
        <Button
          size="sm"
          disabled={!value.trim() || disabled}
          onClick={() => onAnswer(questionId, value.trim())}
        >
          Answer
        </Button>
      </div>
      {hint ? <p className="mt-1 text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
