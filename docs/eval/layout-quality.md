# Layout quality

What `tools/score-layouts.ts` measures, per brief. Correctness is the checker's column and is
mostly zero; the rest is whether anybody would want to be in the building. Proportion is the
share of rooms no longer than two and a half times their own width, and it is the column that
the current packer fails.

Recorded 2026-09-20, packer at the strip layout.

| brief | quality | proportion | daylight | circulation | adjacency | slivers | checker errors | shell m |
|---|---|---|---|---|---|---|---|---|
| office-100 | 0.57 | 20% | 100% | 5% | 50% | 12 | 0 | 47.5x33.9 |
| hotel-floor | 0.60 | 0% | 100% | 11% | 100% | 22 | 3 | 29.4x21.0 |
| clinic | 0.86 | 85% | 100% | 11% | 22% | 2 | 3 | 19.3x13.8 |
| school-wing | 0.89 | 75% | 100% | 7% | 100% | 3 | 0 | 30.2x21.5 |
| mixed-floor | 0.80 | 63% | 100% | 12% | 50% | 3 | 0 | 19.2x13.6 |
| four-bed-house | 0.79 | 73% | 100% | 12% | 0% | 3 | 0 | 14.1x10.1 |
