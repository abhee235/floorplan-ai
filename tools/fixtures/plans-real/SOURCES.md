# Real floor plans

Drawings made by other people, used to measure the DXF reader on real line
work (ADR-011 D6). Each has a `<name>.expected.json` with hand counts taken
from the drawing, never from the reader's output. They are scored with
`scoreRealPlan` in `packages/importers/src/metrics.ts`.

| File | Source | Licence |
|---|---|---|
| `us-house-imperial.dxf` | [bjnortier/dxf test/resources/floorplan.dxf](https://github.com/bjnortier/dxf/blob/develop/test/resources/floorplan.dxf), also shipped as jscad/sample-files dxf/dxf-parser/floorplan.dxf | MIT, Copyright (c) 2014-2018 Ben Nortier |
| `ceco-architecture.dxf` | [bjnortier/dxf test/resources/Ceco.NET-Architecture-Tm-53.dxf](https://github.com/bjnortier/dxf/blob/develop/test/resources/Ceco.NET-Architecture-Tm-53.dxf) | MIT, Copyright (c) 2014-2018 Ben Nortier |
| `courtyard-house.dxf` | [wieslawsoltes/KestrelCAD examples/courtyard.dxf](https://github.com/wieslawsoltes/KestrelCAD/blob/main/examples/courtyard.dxf) | MIT, Copyright (c) 2026 Kestrel CAD contributors |
| `bimcompiler-floor.dxf` | [red1oon/BIMCompiler deploy/dev/dxf/SH_FLOOR.dxf](https://github.com/red1oon/BIMCompiler/blob/master/deploy/dev/dxf/SH_FLOOR.dxf) | MIT, Copyright (c) 2025-2026 Redhuan D. Oon |
| `apartment-metres.dxf` | [DWG Viewer Online samples, floor-plan-apartment.dxf](https://dwgvieweronline.com/samples) | "Released for any use, personal, educational or commercial, with no attribution required" |

Files are stored byte for byte (`*.dxf -text` in `.gitattributes`).

## MIT licence text

The MIT-licensed drawings above are provided under this text, with the
copyright notices given in the table:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
