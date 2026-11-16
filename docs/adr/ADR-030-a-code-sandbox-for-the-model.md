# ADR-030: A code sandbox the model can think in

Status: Proposed
Date: 2026-09-24
Related: ADR-029 (the providers this runs on), ADR-027 D3 (`look_at`), ADR-028 D6 (a picture is copied,
not paraphrased) and D11 (look before calling it done), ADR-011 (the plan reader), ADR-022 (roles),
ADR-023 (consent, which every call from the sandbox still passes through), ADR-026 (skills);
`docs/eval/plan-from-image.md`

## Context

On 2026-09-24 the owner gave Claude Code, working over the bridge like any outside agent, a picture of
an office: seven named areas, a glass partition, a band of windows, two double doors, and ninety-one
pieces of furniture, with no dimensions anywhere. It came out close to the drawing -- every wall,
opening and item on its counterpart when the built model was drawn back over the picture. An earlier
session of the same model on the same picture, working from what it could see, came out upside down,
with a 24 by 15 m shell of round numbers and a double door read as "a wavy divider".

The difference was not the model. It was that the second time it could run code:

1. decode the picture to pixels and find the walls as bands of dark ink four to ten pixels thick;
2. sample across each wall line to tell a solid wall from a window's thin triple line from glass;
3. cut enlarged crops with a coordinate grid over them, and read furniture positions off the grid;
4. write the arithmetic once -- image pixels to plan millimetres with y flipped, a point to a fraction
   along a wall, a chair's rotation from the point it faces -- instead of doing it in its head per call;
5. place all ninety-one items in one loop;
6. draw the built model back over the picture and look for what does not sit on its ink.

None of that is a tool we have, and all of it was invented for this picture. The in-app agent, by
contrast, has a fixed set of tools and nowhere to put a thought that is a program. Asked to read the
same picture it would get the reader's single guess at coordinates on a 0 to 1000 grid, no pixel
correction (the picture is a JPEG, and the refinement reads PNG only), no furniture (the reader's reply
has no place for it), and no way to measure anything.

Two ways to close that gap were discussed with the owner. One is to write each of those steps as a
fixed tool. The other is to give the model the thing that let it invent them: somewhere to run code,
with the picture and the tools in reach. The owner's point was that the second is what made the
difference, and that a fixed pipeline is exactly the thing that failed on a picture nobody had planned
for. Both vendors of the models we use now describe the same pattern -- the model writes a program that
calls tools rather than calling them one JSON object at a time.

## Decision

### D1. One tool, `run_code`, that runs JavaScript in a sandbox

`run_code({ code, reset? })` evaluates JavaScript and returns what it printed, the value of its last
expression, any pictures it made, and the tool calls it made. It is a registry tool like any other: it
appears in the transcript and the session log, it has a timeout, and its result is cut like every
result.

The engine is **QuickJS compiled to WebAssembly** (`quickjs-emscripten`, MIT). It is a complete
JavaScript engine that runs inside our process with no native module, and inside it there is nothing
but what we put there: no file system, no network, no timers, no `require`, no host objects. It has an
interrupt hook, which is how a time limit is enforced, and a memory limit of its own.

### D2. It keeps its state, like a REPL

A variable set in one call is there in the next, for the same session, so a model can work the way
the investigation above worked: decode, look, try a threshold, look again. `reset: true` starts again.
A session's sandbox is dropped after fifteen idle minutes, when its limits are hit, or when the host
restarts; the model is told when it has been dropped, so it never trusts a variable that is gone.

### D3. What is in reach

Only these, all provided by the host and all checked on the way in:

| Name | What it is |
|---|---|
| `console.log(...)` | printed text, returned with the result |
| `attachments()` | the pictures attached to this conversation: id, name, size |
| `image(id)` | an attachment decoded to pixels: `{ width, height, gray: Uint8Array }`, PNG or JPEG |
| `crop(img, { x, y, w, h, scale?, grid? })` | a region, enlarged, with a labelled coordinate grid, as a picture to look at |
| `draw(img, marks)` | lines, rectangles, polygons and text over a picture, as a picture to look at |
| `show(picture, caption?)` | hand a picture back with the result, so the model sees it |
| `tools.call(name, args)` | any tool in the registry, returning its envelope |
| `project()` | the scene as `get_scene` would give it, read-only |

The heavy pixel work stays in the sandbox rather than in host helpers on purpose: the point is that
the model decides how to measure. An interpreter is slower than V8, and a full scan of an 800 by 600
picture costs about a second. Pictures are decoded at no more than 4,000 pixels on their long side, and
a helper that scans in native code is added only when a measured run shows the time going there.

### D4. Every tool call from the sandbox is an ordinary tool call

`tools.call` goes through `call.tools.call`, as `batch` does: the same validation, the same consent
(ADR-023), the same history and the same log. The sandbox gets no power the model did not already have
through the tools it is offered, and a tool it is not offered is refused. Each call is its own history
entry; a failed call inside a script does not undo the others, because a script that handles its own
errors is the point. A script is limited to 500 tool calls.

### D5. Limits

Thirty seconds of running time per call, 256 MB of memory, 16,000 characters of printed output (cut
with a note, like every result), four pictures per call. A script that exceeds a limit is stopped, and
the result says which limit and how far it got.

### D6. The model is taught the method, not given the pipeline

A skill, `reading-a-picture-with-code` (ADR-026), carries what worked above as advice: find walls as
thick ink bands and check the numbers; sample across a line before calling it a wall; read furniture
from gridded crops, not from the whole picture; write the pixel-to-millimetre conversion once, with y
flipped; say the scale is an assumption when the picture has no dimensions, and what it was based on;
draw the result back over the picture before calling it done. It is advice, so the model can do
something else when a picture needs it.

Live runs showed three parts of it are not taken as advice, so once a run has used `run_code` on an
attached picture the host holds it to them (`agent-runs.ts`):

- `copy.no-architect`: `design_layout` and `furnish_room` are refused, called directly, in a batch or
  from a script. One run sent a measured picture to the architect, which designed a different
  building; another furnished a room from the catalog with pieces the picture did not have.
- `copy.count-first`: the first call that changes the project is refused until notes hold an
  `INVENTORY walls=N doors=N windows=N passages=N rooms=N items=N` line, and that line, as it stood
  then, is what the build is held to before the run may finish. One run wrote its count after
  building, equal to what it had built.
- Compare before finishing: a run that changed the project since it last drew its build over the
  picture (`draw` and `show` in one script) is asked, once, to do so before it answers. A set of four
  pictures on gpt-6-luna never did, and its openings and furniture sat off their ink.

Each fires a bounded number of times, so a model that has a reason to differ can still finish.

Scale is the one piece of arithmetic the sandbox does for the model. Live copies of pictures without
dimensions came out 5 to 42 per cent off scale, each from one object read at one guessed size.
`scaleFrom([{ kind, px }, ...])` turns each measurement of a thing of known size into a range of
millimetres per pixel and returns where most of them agree, naming those that do not. The model still
finds and measures the things; nothing in the sandbox looks at the picture for it.

### D7. Who gets it

`run_code` is offered to every profile that calls tools. A model that cannot see still gets the
numbers; one that can also gets the pictures. It is not offered to the architect's sub-run, which
designs rather than reads.

## Alternatives considered

- **The steps above as fixed tools** (`trace_walls`, a gridded `look_at`, furniture in the reader's
  reply, an overlay tool). Not rejected, deferred: each is a good helper once a sandbox run shows it is
  the step that repeats. Built first, they would be one picture's pipeline again.
- **Node's `vm` module.** Rejected: it is not a security boundary; code in it can reach the host.
- **`isolated-vm`.** Rejected: a native module, which this project has avoided since ADR-008 chose
  `node:sqlite`.
- **A separate process or container.** Rejected: the host is one process (ADR-005), and a sandbox that
  has to be deployed is a second service.
- **Python.** Rejected: the project is TypeScript end to end, and a Python runtime in WebAssembly is an
  order of magnitude larger to ship for no gain the model would notice.

## Consequences

- `@fpv/tools` gains `quickjs-emscripten` and `jpeg-js` (BSD-3-Clause).
- A run can now do in one step what took forty, which changes what the step budget and the stall
  breaker are measuring; both stay as they are until a run shows otherwise.
- The eval gains a picture card for the office in `docs/eval/plan-from-image.md`, scored against the
  hand-read build, so the sandbox is measured rather than admired.
