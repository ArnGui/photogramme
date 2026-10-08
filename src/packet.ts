// Miroir de photogramme-core/src/packet.rs :
// [longueur de l'en-tête, u32 petit-boutiste][en-tête JSON UTF-8][pixels].

import type { FrameData } from "./types";

/** Paquet générique : en-tête JSON + pixels RVBA (vue sans copie). */
export function decodeRaw<H extends { width: number; height: number }>(buf: ArrayBuffer): { header: H; rgba: Uint8ClampedArray } {
  if (buf.byteLength < 4) throw new Error("Truncated packet.");
  const n = new DataView(buf).getUint32(0, true);
  if (n > 64 * 1024 || buf.byteLength < 4 + n) throw new Error("Invalid packet header.");
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as H;
  const rgba = new Uint8ClampedArray(buf, 4 + n);
  if (rgba.length !== header.width * header.height * 4) throw new Error("Incomplete frame.");
  return { header, rgba };
}

export function decodePacket(buf: ArrayBuffer): FrameData {
  if (buf.byteLength < 4) throw new Error("Truncated packet.");
  const n = new DataView(buf).getUint32(0, true);
  if (n > 64 * 1024 || buf.byteLength < 4 + n) throw new Error("Invalid packet header.");
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  // Vue sans copie sur les pixels.
  const rgba = new Uint8ClampedArray(buf, 4 + n);
  if (rgba.length !== header.width * header.height * 4) throw new Error("Incomplete frame.");
  return {
    frame: header.frame,
    timecode: header.timecode,
    width: header.width,
    height: header.height,
    palette: header.palette ?? [],
    shot: header.shot ?? null,
    clip: header.clip ?? null,
    job: header.job ?? null,
    total: header.total ?? null,
    rgba,
  };
}

export function encodePacket(header: object, pixels: Uint8ClampedArray | Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + pixels.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(pixels, 4 + json.length);
  return out;
}
