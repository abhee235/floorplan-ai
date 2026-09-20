# Layout quality

What `tools/score-layouts.ts` measures, per brief. Correctness is the checker's column and is
mostly zero; the rest is whether anybody would want to be in the building. Proportion is the
share of rooms no longer than two and a half times their own width, and it is the column that
the current packer fails.

Recorded 2026-09-20, packer at the strip layout.

| brief | quality | proportion | daylight | circulation | adjacency | slivers | checker errors | shell m |
|---|---|---|---|---|---|---|---|---|
| office-100 | 0.78 | 93% | 64% | 10% | 0% | 1 | 0 | 58.5x28.8 |
| hotel-floor | 0.96 | 91% | 100% | 13% | 100% | 2 | 0 | 47.0x13.9 |
| clinic | 0.89 | 92% | 100% | 14% | 22% | 1 | 0 | 25.3x11.3 |
| school-wing | 0.93 | 83% | 100% | 8% | 100% | 2 | 0 | 33.6x19.5 |
| mixed-floor | 0.89 | 100% | 80% | 24% | 50% | 0 | 0 | 27.8x11.4 |
| four-bed-house | 0.79 | 73% | 100% | 12% | 0% | 3 | 0 | 15.2x9.9 |
