# The office brief, run live and looked at

The owner's own brief for a hundred-person IT office, word for word, run through a host over its
bridge exactly as the editor runs it, then scored on what was built (ADR-028 D11). The card is
`tools/eval/cards/office-brief-live.json`; the loop is `tools/eval/live.ts`.

```
node node_modules/tsx/dist/cli.mjs tools/eval/live.ts \
  --host ws://127.0.0.1:4311/bridge --card office-brief-live --out <dir>
```

A host of its own, on another port and another data directory, so a run never touches the machine's
real projects. Out of it come `events.jsonl`, every picture the agent looked at, a picture of what it
built, the project, and `report.md` with each check PASS or FAIL. It exits 0 only when all pass.

## What it checks

The run finished by itself; a checked design was built; nothing was drawn by hand; the architect
looked at the design it handed on and wrote a LOOK verdict; the designer looked at what it built;
every room can be walked to; no room is reached only through another; there is a way in; no side of
the building is blank; little floor belongs to no room; every meeting room has a wall for its screen;
no screen is on glass or a window; the brief's rooms and furniture are there; `validate` is clean.

## Runs

The same brief, the same model (`hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS` on Ollama, greedy),
on 2026-09-22.

| Run | Checks | Minutes | What happened |
|---|---|---|---|
| 1 | 3 of 10 | 9 (cancelled) | The architect drew freehand, overlapped its rooms, left a band of meeting rooms five metres from the floor, and then sent one design six times word for word. No design passed, so nothing was built. |
| 2 | 6 of 10 | 10 | Drafted with `plan_rooms` and fixed its one error, looked at the plan twice and judged it correctly. The design was the packer's comb: a walled open office behind one door, a cafe in the middle with no daylight, the reception far from the entrance. The designer then stalled placing a server rack with no anchor. |
| 3 | 13 of 14 | 74 | Drew freehand: an L of open floor with no corridor, rooms down the west side, glass rooms along the glazed south, the reception at the entrance. A hundred desks in centred benches, every screen on plaster, nothing drawn by hand, `validate` clean. The one failure: the designer reached for `render`, which needs a browser tab, instead of the picture that needs none. |
| 4 | 4 of 14 | 53 | Three of five architect sub-runs died on their first reply, each at the five-minute request timeout. Told only that no design passed, the designer drew the building by hand: nine walls, ten rooms. One architect did reach a passing design, and it was not built. |
| 5 | 11 of 15 | 35 | The architect passed on its third try, looked at its plan, and the designer built and furnished it: a hundred and sixty desks, screens on plaster, validate clean. A seventh of the floor was in no room, one side was four fifths empty, and the verdict mentioned neither; the designer answered without looking at what it built; one wall was drawn by hand. |
| 6 | 10 of 15 | 17 | Passed, looked three times, wrote the whole checklist; built and furnished, nothing drawn by hand, validate clean. Left: rooms reached only through the server room, a side half empty, two glass rooms with nowhere for a screen. The run died at the end on a reply the server could not read. |

## What each run changed

Run 1: an identical design is refused rather than checked again; a step that repeats the one before
it has its next reply sampled; the axes are stated (y grows north); a room that touches no shared
floor is told the move that would reach it; overlaps are orange in the picture and a design the
builder refuses is still drawn as its rooms.

Run 2: an open office is open floor by default; the checklist asks about the reception, the zones
and daylight; the office skill says to draw an office rather than draft it with `plan_rooms`; an
empty reply is sent back once; `place_item` given a room alone puts the item in its middle.

Run 3: after the first design, a whole design with the same rooms is refused and the patch named; a
revision that changes nothing is refused; a room key is read as a key; the checklist and the eval
both count floor that belongs to no room; the designer's prompt names `preview_design`.

Run 4: a timed-out request says so and the loop asks for a shorter reply, twice, before the run
ends; the default timeout is fifteen minutes, since a local model's reply is minutes long; a sub-run
that dies says why. A code review of the work found six faults, fixed with it: a passing design
re-sent gets its id back; the look gate does not ask for a picture its budget would refuse; a verdict
in a bounced answer is kept; the sampled reply is the next one only; a revision of the circulation
list counts as a revision; a corner service room on a glazed side leaves no stub of glass.

The timeout matters on this machine: `.env` here sets `FPV_AGENT_TIMEOUT_MS=300000`, which is what
killed those sub-runs. Raise it, or delete the line and take the default.

Run 5: `tidy_design`, which does the arithmetic on request -- every room moved the least it can be so
that nothing overlaps and everything is inside the building, each move reported, the arrangement left
alone. A verdict that skips checklist lines is sent back once, naming them. The designer is asked
once, after it builds, to look at what it built. A bare compass word is read as an anchor.

Run 6: nothing. What is left is the model's judgement of its own plan -- a chain of rooms reached
only through the server room, a side half empty, a glass room with nowhere to hang a screen -- and
the walk and the picture both show all three. A tool that decided those would be deciding the
building, which is the model's job (D2).

## The same card on a hosted model

`gpt-5.6-luna` through OpenAI, the same brief and the same checks, on 2026-09-23. A run takes three
or four minutes rather than twenty to seventy-five, which is what makes the loop usable for
iteration at all.

| Run | Checks | Minutes | What happened |
|---|---|---|---|
| 7 | 5 of 10 | 2.4 | Nothing built. It moved a room by sending part of a rect, which we refused; wrote keys run together ("openoffice"); and was handed design ids the session had already dropped. |
| 8 | 4 of 10 | 3.0 | Nothing built, same evicted ids: the session kept eight designs and the architect checks ten. |
| 9 | 11 of 15 | 3.6 | Built and furnished, nothing drawn by hand, architect looked twice and judged, and for the first time in any run the designer looked at what it had built. Left: a fifth of the floor in no room, two sides mostly empty, two glass rooms with no wall for a screen. |

What those bought: a rect may be given in part, so moving a room is `rect: { y }`; a key is matched as
it is read, so "openoffice" finds `open_office`; a session keeps thirty-two designs and lists them
when one is unknown; `FPV_AGENT_VISION` says whether a hosted model can be shown a picture, since
only Ollama can be asked, and the host prints which it is on start. After run 9 the architect was
also told that every square metre inside the shell belongs to a room or an open zone, and that a
glass room needs one plaster wall for its screen.

## Where it stands

Of the six runs, three built the office: a checked design, built and furnished, validate clean, no
wall drawn by hand, every screen on plaster. The failures are no longer the tools refusing good
plans; they are the model's arithmetic, which `tidy_design` now does on request, and its judgement
of its own plan, which the checklist asks for and it sometimes skips. A run takes 20 to 75 minutes on
this machine.
