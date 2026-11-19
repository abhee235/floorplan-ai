// Zips as the host reads them: stored or deflated, whatever made them, through node's inflater with a
// ceiling on what each entry may unpack to. Project archives and catalog libraries both arrive this way,
// and a person's zip tool decides how they were packed, not this app.
import { inflateRawSync } from "node:zlib";
import { readZip, type ZipEntry, ZipError } from "@fpv/exporters";

const inflate = (data: Uint8Array, maxBytes: number): Uint8Array =>
  new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) }));

/** The files in a zip; throws a ZipError saying why when it cannot be read. */
export function readHostZip(bytes: Uint8Array): ZipEntry[] {
  return readZip(bytes, { inflateRaw: inflate });
}

/** The same, except that a file which is not a zip at all is read as holding nothing. */
export function readZipOrNothing(bytes: Uint8Array): ZipEntry[] {
  try {
    return readHostZip(bytes);
  } catch (e) {
    if (e instanceof ZipError && e.code === "zip.not-zip") return [];
    throw e;
  }
}
