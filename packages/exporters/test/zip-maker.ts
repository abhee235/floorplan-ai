// Zips written the way other tools write them, for tests that read zips: stored or deflated, with sizes
// in the local headers or only after the data, and a central directory at the end.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/index.js";

export interface Entry {
  name: string;
  data?: Uint8Array;
  /** Deflate it, as most tools do. */
  deflate?: boolean;
  /** Leave the sizes out of the local header and put them after the data, as a streaming tool does. */
  streamed?: boolean;
  flags?: number;
  method?: number;
  crc?: number;
}

/** A zip written the way other tools write them, with a central directory at the end. */
export function makeZip(entries: readonly Entry[]): Uint8Array {
  const chunks: number[] = [];
  const dir: number[] = [];
  const u16 = (out: number[], v: number) => out.push(v & 255, (v >>> 8) & 255);
  const u32 = (out: number[], v: number) =>
    out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const enc = new TextEncoder();
  for (const e of entries) {
    const data = e.data ?? new Uint8Array();
    const packed = e.deflate ? new Uint8Array(deflateRawSync(data)) : data;
    const method = e.method ?? (e.deflate ? 8 : 0);
    const flags = (e.flags ?? 0) | (e.streamed ? 8 : 0) | 0x800;
    const crc = e.crc ?? crc32(data);
    const name = enc.encode(e.name);
    const offset = chunks.length;
    u32(chunks, 0x04034b50);
    u16(chunks, 20);
    u16(chunks, flags);
    u16(chunks, method);
    u32(chunks, 0);
    u32(chunks, e.streamed ? 0 : crc);
    u32(chunks, e.streamed ? 0 : packed.length);
    u32(chunks, e.streamed ? 0 : data.length);
    u16(chunks, name.length);
    u16(chunks, 0);
    chunks.push(...name, ...packed);
    if (e.streamed) {
      u32(chunks, 0x08074b50);
      u32(chunks, crc);
      u32(chunks, packed.length);
      u32(chunks, data.length);
    }
    u32(dir, 0x02014b50);
    u16(dir, 20);
    u16(dir, 20);
    u16(dir, flags);
    u16(dir, method);
    u32(dir, 0);
    u32(dir, crc);
    u32(dir, packed.length);
    u32(dir, data.length);
    u16(dir, name.length);
    u16(dir, 0);
    u16(dir, 0);
    u16(dir, 0);
    u16(dir, 0);
    u32(dir, 0);
    u32(dir, offset);
    dir.push(...name);
  }
  const at = chunks.length;
  const end: number[] = [];
  u32(end, 0x06054b50);
  u16(end, 0);
  u16(end, 0);
  u16(end, entries.length);
  u16(end, entries.length);
  u32(end, dir.length);
  u32(end, at);
  u16(end, 0);
  return new Uint8Array([...chunks, ...dir, ...end]);
}
