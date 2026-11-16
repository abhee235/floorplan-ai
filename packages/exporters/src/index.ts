// @fpv/exporters: CSV, XLSX, GLB, DXF, PDF exports (ADR-013). Pure: every exporter returns text or bytes,
// and the host writes them.
export const PACKAGE = "exporters" as const;
export {
  bomToExportCsv,
  bomToXlsx,
  EXPORT_CSV_COLUMNS,
  type ExportProvenance,
  provenanceFor,
  type SourceLookup,
  sourceLookup,
} from "./bom-export.js";
export {
  catalogSnapshotOf,
  chooseScale,
  type DrawingProvenance,
  type LevelDrawing,
  levelDrawing,
  mountNote,
  PAPER_MM,
  type PaperSize,
  type ScheduleRow,
  STANDARD_SCALES,
  scheduleOf,
  tagName,
} from "./drawing.js";
export { DXF_LAYERS, type DxfDrawing, type DxfDrawingOptions, projectToDxf } from "./drawing-dxf.js";
export {
  type PdfDrawing,
  type PdfDrawingOptions,
  type PdfSheetReport,
  projectToPdf,
} from "./drawing-pdf.js";
export { type DxfLayer, DxfWriter, dxfText } from "./dxf.js";
export {
  type GlbExport,
  GlbExportError,
  type GlbNode,
  type GlbNodeKind,
  type GlbOptions,
  type GlbReport,
  type GlbScope,
  projectToGlb,
} from "./glb.js";
export { num as pdfNumber, PdfPage, PT_PER_MM, textWidth, winAnsi, writePdf } from "./pdf.js";
export {
  type Cell,
  type CellStyle,
  columnName,
  type ReadCell,
  readXlsxCells,
  type Sheet,
  STYLE_INDEX,
  sheetNames,
  writeXlsx,
} from "./xlsx.js";
export { crc32, unzipStore, type ZipEntry, zipStore } from "./zip.js";
