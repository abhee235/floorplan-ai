# Layout quality

What `tools/score-layouts.ts` measures, per brief. Correctness is the checker's column and is
mostly zero; the rest is whether anybody would want to be in the building. Proportion is the
share of rooms no longer than two and a half times their own width, and it is the column that
the current packer fails.

Recorded 2026-09-21, after the shell was made to follow from the rooms rather than from a fixed
proportion. The mean was 0.751 before that change and is 0.826 after it, with no brief worse than
it was and the four-bedroom house, the control, unchanged.

The hotel floor is the change in one line: 0.60 to 0.96, and a 29.4 by 21.0 m building with guest
rooms 2.6 m wide became a 47.0 by 13.9 m one with rooms 4 m wide. The office is still the worst of
the six, because one room being 73 per cent of the floor is a different problem and needs zones.

| brief | quality | proportion | daylight | circulation | adjacency | slivers | checker errors | shell m |
|---|---|---|---|---|---|---|---|---|
| office-100 | 0.58 | 20% | 100% | 5% | 50% | 12 | 0 | 54.1x29.3 |
| hotel-floor | 0.96 | 91% | 100% | 13% | 100% | 2 | 3 | 47.0x13.9 |
| clinic | 0.89 | 92% | 100% | 14% | 22% | 1 | 0 | 25.3x11.3 |
| school-wing | 0.93 | 83% | 100% | 8% | 100% | 2 | 0 | 33.6x19.5 |
| mixed-floor | 0.80 | 63% | 100% | 12% | 50% | 3 | 0 | 20.2x13.4 |
| four-bed-house | 0.79 | 73% | 100% | 12% | 0% | 3 | 0 | 15.2x9.9 |
