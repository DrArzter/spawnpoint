// Prepares a profile picture in the browser: a centred square, 256 by 256,
// WebP (JPEG where the browser cannot encode WebP). The backend takes only
// JPEG, PNG or WebP of at most 256 KB, so the page never sends more.

export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 256 * 1024;
export const AVATAR_ACCEPT = "image/*";
const QUALITY = 0.85;
const NOT_A_PICTURE = "Choose a JPEG, PNG or WebP picture.";

export type AvatarSource = Readonly<{ width: number; height: number }>;

/** A drawing surface of one fixed size. The browser supplies a canvas; a test supplies a recorder. */
export type AvatarSurface = Readonly<{
  /** Draws the square `side` pixels wide at (`x`, `y`) of the source over the whole surface. */
  draw: (source: AvatarSource, x: number, y: number, side: number) => void;
  /** Resolves to null when the browser cannot encode the type. */
  encode: (type: string, quality: number) => Promise<Blob | null>;
}>;

export type AvatarEnvironment = Readonly<{
  decode: (file: Blob) => Promise<AvatarSource>;
  surface: (size: number) => AvatarSurface;
}>;

export type PreparedAvatar = Readonly<{ base64: string; type: "image/webp" | "image/jpeg"; bytes: number }>;

/** The largest centred square of a width by height image. */
export function squareCrop(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export async function prepareAvatar(file: Blob, environment: AvatarEnvironment): Promise<PreparedAvatar> {
  let source: AvatarSource;
  try {
    source = await environment.decode(file);
  } catch {
    throw new Error(NOT_A_PICTURE);
  }
  if (!(source.width > 0 && source.height > 0)) throw new Error(NOT_A_PICTURE);
  const { x, y, side } = squareCrop(source.width, source.height);
  const surface = environment.surface(AVATAR_SIZE);
  surface.draw(source, x, y, side);
  // A browser that cannot encode WebP answers with another type or nothing.
  let type: PreparedAvatar["type"] = "image/webp";
  let blob = await surface.encode(type, QUALITY);
  if (blob?.type !== type) {
    type = "image/jpeg";
    blob = await surface.encode(type, QUALITY);
  }
  if (blob?.type !== type) throw new Error("This browser cannot prepare the picture.");
  if (blob.size > AVATAR_MAX_BYTES) throw new Error("The picture is too large. Choose a simpler one.");
  return { base64: base64Of(new Uint8Array(await blob.arrayBuffer())), type, bytes: blob.size };
}

/** The browser's own decoder and canvas. */
export const browserAvatarEnvironment: AvatarEnvironment = {
  decode: (file) => createImageBitmap(file),
  surface: (size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    return {
      draw: (source, x, y, side) => {
        if (!context) throw new Error("This browser cannot prepare the picture.");
        context.drawImage(source as ImageBitmap, x, y, side, side, 0, 0, size, size);
      },
      encode: (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
    };
  },
};
