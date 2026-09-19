import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_PROMPT_IMAGE_EDGE_PX, normalizeImageForSend } from "./normalize-image-for-send";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface FakeBitmap {
  width: number;
  height: number;
  close: () => void;
}

function makeBitmap(input: { width: number; height: number }): FakeBitmap {
  return { width: input.width, height: input.height, close: vi.fn() };
}

interface FakeCanvas {
  width: number;
  height: number;
  context: { drawImage: ReturnType<typeof vi.fn> } | null;
  toBlobOutput: Blob | null;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
}

function makeCanvas(output: Blob): FakeCanvas {
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    context: { drawImage: vi.fn() },
    toBlobOutput: output,
    getContext: vi.fn(function (this: FakeCanvas) {
      return this.context;
    }),
    toBlob: vi.fn(function (this: FakeCanvas, callback: (blob: Blob | null) => void) {
      callback(this.toBlobOutput);
    }),
  };
  return canvas;
}

function stubDom(bitmap: FakeBitmap | Error, canvas: FakeCanvas | null): FakeCanvas | null {
  vi.stubGlobal("createImageBitmap", async () => {
    if (bitmap instanceof Error) {
      throw bitmap;
    }
    return bitmap;
  });
  vi.stubGlobal("document", {
    createElement: vi.fn(() => canvas),
  });
  return canvas;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeImageForSend", () => {
  it("passes inputs through untouched when DOM image APIs are unavailable", async () => {
    const result = await normalizeImageForSend({
      data: "AA==",
      mimeType: "image/gif",
    });
    expect(result).toEqual({ data: "AA==", mimeType: "image/gif" });
  });

  it("transcodes non-png/jpeg formats to PNG", async () => {
    const canvas = stubDom(makeBitmap({ width: 100, height: 50 }), makeCanvas(new Blob(["x"])));

    const result = await normalizeImageForSend({
      data: PNG_1X1_BASE64,
      mimeType: "image/gif",
    });

    expect(result.mimeType).toBe("image/png");
    expect(canvas?.toBlob).toHaveBeenCalled();
    expect(canvas?.width).toBe(100);
    expect(canvas?.height).toBe(50);
  });

  it("passes through png/jpeg images within the dimension budget", async () => {
    const canvas = stubDom(makeBitmap({ width: 4000, height: 3000 }), makeCanvas(new Blob(["x"])));

    const result = await normalizeImageForSend({
      data: PNG_1X1_BASE64,
      mimeType: "image/png",
    });

    expect(result).toEqual({ data: PNG_1X1_BASE64, mimeType: "image/png" });
    expect(canvas?.toBlob).not.toHaveBeenCalled();
  });

  it("downscales images whose longest edge exceeds the limit", async () => {
    const canvas = stubDom(
      makeBitmap({ width: 16_000, height: 8_000 }),
      makeCanvas(new Blob(["x"])),
    );

    const result = await normalizeImageForSend({
      data: PNG_1X1_BASE64,
      mimeType: "image/jpeg",
    });

    expect(result.mimeType).toBe("image/png");
    expect(canvas?.width).toBe(MAX_PROMPT_IMAGE_EDGE_PX);
    expect(canvas?.height).toBe(MAX_PROMPT_IMAGE_EDGE_PX / 2);
  });

  it("passes through undecodable payloads", async () => {
    const canvas = stubDom(new Error("decode failed"), makeCanvas(new Blob(["x"])));

    const result = await normalizeImageForSend({
      data: PNG_1X1_BASE64,
      mimeType: "image/gif",
    });

    expect(result).toEqual({ data: PNG_1X1_BASE64, mimeType: "image/gif" });
    expect(canvas?.toBlob).not.toHaveBeenCalled();
  });
});
