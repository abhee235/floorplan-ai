// A minimal ZIP writer (stored entries, no compression) for XLSX. Pure and deterministic: entries keep
// the given order and carry a fixed 1980-01-01 timestamp, so the same content always gives the same
// bytes. Spreadsheet applications read stored entries; BOM workbooks are small enough not to need
// deflate.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** DOS date for 1980-01-01 00:00:00, the earliest a ZIP can hold. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const names = new Set<string>();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    if (names.has(e.name)) throw new Error(`duplicate zip entry ${e.name}`);
    names.add(e.name);
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, e.data);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + end.length);
  let at = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Read the entries of a stored ZIP back (for tests and round trips); refuses compressed entries. */
/** Why a zip could not be read, said so a person can act on it. */
export class ZipError extends Error {
  constructor(
    readonly code: "zip.not-zip" | "zip.unsupported" | "zip.too-big" | "zip.corrupt",
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ReadZipOptions {
  /**
   * Inflates raw deflate data, stopping past `maxBytes`. Injected, as encodePng's deflate is, so this
   * stays pure; the host passes node's inflateRawSync. Without it a deflated entry is refused.
   */
  inflateRaw?: (data: Uint8Array, maxBytes: number) => Uint8Array;
  /** The most the whole archive may unpack to, so a small file cannot claim a disk's worth. */
  maxBytes?: number;
  maxEntries?: number;
}

/** What a zip may unpack to unless told otherwise: far past any library or project. */
export const ZIP_MAX_BYTES = 512 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 20_000;

/**
 * The files in a zip, as any tool writes one: stored or deflated, read from the central directory at
 * its end, which is where the sizes are when a tool streamed the entries and wrote them afterwards.
 * Folders are left out. Every entry's CRC is checked. Encrypted entries, ZIP64 and other compression
 * methods are refused with a reason rather than read wrongly.
 */
export function readZip(bytes: Uint8Array, options: ReadZipOptions = {}): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxBytes = options.maxBytes ?? ZIP_MAX_BYTES;
  const maxEntries = options.maxEntries ?? ZIP_MAX_ENTRIES;
  // the end-of-directory record is the last 22 bytes, unless a comment of up to 64 KB follows it
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1)
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw new ZipError("zip.not-zip", "the file is not a zip");
  const count = view.getUint16(end + 10, true);
  const dirSize = view.getUint32(end + 12, true);
  const dirAt = view.getUint32(end + 16, true);
  if (count === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff)
    throw new ZipError("zip.unsupported", "the zip is in the ZIP64 format, which is not read here");
  if (count > maxEntries)
    throw new ZipError("zip.too-big", `the zip holds ${count} files; the limit is ${maxEntries}`);
  if (dirAt + dirSize > end) throw new ZipError("zip.corrupt", "the zip's directory runs past its end");
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let total = 0;
  let at = dirAt;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      throw new ZipError("zip.corrupt", "the zip's directory is damaged");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new ZipError("zip.unsupported", `${name} is encrypted`);
    if (packed === 0xffffffff || size === 0xffffffff)
      throw new ZipError("zip.unsupported", "the zip is in the ZIP64 format, which is not read here");
    total += size;
    if (total > maxBytes)
      throw new ZipError(
        "zip.too-big",
        `the zip unpacks to more than ${Math.round(maxBytes / 1024 / 1024)} MB, the limit`,
      );
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50)
      throw new ZipError("zip.corrupt", `${name}: its header is not where the directory says`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + packed > bytes.length)
      throw new ZipError("zip.corrupt", `${name} runs past the end of the zip`);
    const raw = bytes.subarray(start, start + packed);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      if (!options.inflateRaw) throw new ZipError("zip.unsupported", `${name} is compressed`);
      try {
        data = options.inflateRaw(raw, size);
      } catch {
        throw new ZipError("zip.corrupt", `${name} could not be decompressed`);
      }
    } else
      throw new ZipError(
        "zip.unsupported",
        `${name} is compressed with method ${method}, which is not read here`,
      );
    if (data.length !== size) throw new ZipError("zip.corrupt", `${name} is not the size the zip says`);
    if (crc32(data) !== crc)
      throw new ZipError("zip.corrupt", `${name} is damaged (its checksum does not match)`);
    out.push({ name, data });
  }
  return out;
}

export function unzipStore(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let at = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    if (view.getUint16(at + 8, true) !== 0) throw new Error("compressed entries are not supported");
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const name = dec.decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extraLen;
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== view.getUint32(at + 14, true)) throw new Error(`crc mismatch in ${name}`);
    out.push({ name, data });
    at = start + size;
  }
  return out;
}
