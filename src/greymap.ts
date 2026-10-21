// greymap.ts — convert an image to a 5-level greyscale pixel grid for the
// contribution chart: dark pixels -> low levels (0 = empty), bright -> 4.
// Pure math; the browser UI mirrors these functions for canvas data.

/** 0..4 level for a single pixel's RGB: luminance scaled to quarter steps. */
export function luminanceLevel(r: number, g: number, b: number): number {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b; // 0..255
  return Math.min(4, Math.max(0, Math.round((lum * 4) / 255)));
}

/**
 * Quantize an RGBA pixel buffer into a rows x cols grid of levels 0..4.
 * `width`/`height` are the buffer's dimensions (draw the image scaled to the
 * target grid before calling).
 */
export function quantizePixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): number[][] {
  const grid: number[][] = [];
  for (let row = 0; row < height; row += 1) {
    const line: number[] = [];
    for (let col = 0; col < width; col += 1) {
      const idx = (row * width + col) * 4;
      line.push(
        luminanceLevel(
          pixels[idx] as number,
          pixels[idx + 1] as number,
          pixels[idx + 2] as number,
        ),
      );
    }
    grid.push(line);
  }
  return grid;
}

/**
 * Columns for an image fit onto the 7-row chart by aspect ratio,
 * clamped to the window width.
 */
export function fitColumns(imgWidth: number, imgHeight: number, maxCols: number): number {
  if (imgHeight <= 0) return Math.max(1, Math.min(maxCols, 14));
  const cols = Math.round((imgWidth / imgHeight) * 7);
  return Math.max(1, Math.min(maxCols, cols));
}
