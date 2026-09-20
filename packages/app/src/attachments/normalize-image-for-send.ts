/**
 * Normalizes images before they are sent to an agent provider.
 *
 * Some providers reject animated GIFs, uncommon formats (WebP, BMP, TIFF,
 * AVIF, HEIC), and images with extreme dimensions. Decoding through
 * `createImageBitmap` collapses animated formats to their first frame and a
 * canvas re-encode converts everything to PNG, while oversized images are
 * downscaled to fit within {@link MAX_PROMPT_IMAGE_EDGE_PX} on the longest edge.
 *
 * `createImageBitmap`/canvas are only available on web and desktop; the native
 * picker already transcodes to PNG at persist time, so this is a pass-through
 * there.
 */

export const MAX_PROMPT_IMAGE_EDGE_PX = 8000;

export interface NormalizedImagePayload {
  data: string;
  mimeType: string;
}

const PASSTHROUGH_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);

function canTranscodeInProcess(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  );
}

function base64ToBytes(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function normalizeImageForSend(input: {
  data: string;
  mimeType: string;
}): Promise<NormalizedImagePayload> {
  const passthrough = (): NormalizedImagePayload => ({
    data: input.data,
    mimeType: input.mimeType,
  });

  if (!canTranscodeInProcess()) {
    return passthrough();
  }

  const bytes = base64ToBytes(input.data);
  if (!bytes || bytes.length === 0) {
    return passthrough();
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([bytes.buffer as ArrayBuffer], { type: input.mimeType }),
    );
  } catch {
    // Undecodable payloads pass through untouched so the provider surfaces its
    // own error rather than the attachment disappearing silently.
    return passthrough();
  }

  try {
    const normalizedMimeType = input.mimeType.toLowerCase();
    const needsTranscode = !PASSTHROUGH_MIME_TYPES.has(normalizedMimeType);
    const longestEdge = Math.max(bitmap.width, bitmap.height);
    const needsResize = longestEdge > MAX_PROMPT_IMAGE_EDGE_PX;
    if (!needsTranscode && !needsResize) {
      return passthrough();
    }

    const scale = needsResize ? MAX_PROMPT_IMAGE_EDGE_PX / longestEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return passthrough();
    }
    context.drawImage(bitmap, 0, 0, width, height);

    const pngBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!pngBlob) {
      return passthrough();
    }
    return { data: await blobToBase64(pngBlob), mimeType: "image/png" };
  } finally {
    bitmap.close();
  }
}
