import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pictures a tool shows the model. The log names each one by the hash of its bytes; the bytes are kept in the
 * run's artifacts folder under that hash, where nothing rewrites them. A model request is therefore still a
 * function of the log: the same events name the same pictures.
 */

export type StoredImage = { sha256: string; media_type: string; bytes: number };

/** Largest picture a tool may attach. Providers refuse larger ones. */
export const MAX_IMAGE_BYTES = 3_500_000;

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** The media type, read from the first bytes of the file. The file name is not trusted. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return undefined;
}

const fileFor = (artifactsDir: string, sha256: string, mediaType: string) => join(artifactsDir, `${sha256}.${EXTENSIONS[mediaType] ?? "bin"}`);

export class ImageError extends Error {}

/** Copies a picture into the artifacts folder and returns how the log should name it. */
export async function storeImage(artifactsDir: string, path: string): Promise<StoredImage> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new ImageError("there is no file there");
  if (info.size > MAX_IMAGE_BYTES) {
    throw new ImageError(`it is ${(info.size / 1_000_000).toFixed(1)} MB, and the most a picture can be is ${(MAX_IMAGE_BYTES / 1_000_000).toFixed(1)} MB`);
  }
  const bytes = await readFile(path);
  const mediaType = sniffImage(bytes);
  if (!mediaType) throw new ImageError("it is not a PNG, JPEG, WebP or GIF picture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(fileFor(artifactsDir, sha256, mediaType), bytes);
  return { sha256, media_type: mediaType, bytes: bytes.length };
}

/** The stored picture as base64, or nothing if it is missing or no longer matches its hash. */
export async function loadImage(artifactsDir: string, sha256: string, mediaType: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(fileFor(artifactsDir, sha256, mediaType));
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) return undefined;
    return bytes.toString("base64");
  } catch {
    return undefined;
  }
}
