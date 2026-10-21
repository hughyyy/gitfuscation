// greymap.test.ts — image -> 5-level greyscale grid conversion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { luminanceLevel, quantizePixels, fitColumns } from '../src/greymap.ts';

test('luminance maps black to 0 and white to 4', () => {
  assert.equal(luminanceLevel(0, 0, 0), 0);
  assert.equal(luminanceLevel(255, 255, 255), 4);
});

test('luminance is monotonic and spans 0..4', () => {
  const levels = [0, 64, 128, 192, 255].map((v) => luminanceLevel(v, v, v));
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(levels[i] >= levels[i - 1], 'levels increase with brightness');
  }
  assert.deepEqual(levels, [0, 1, 2, 3, 4]);
});

test('quantizePixels produces a rows x cols grid of 0..4 levels', () => {
  // 2 rows x 3 cols of horizontal greyscale strip, RGBA.
  const pixels = new Uint8ClampedArray(2 * 3 * 4);
  const set = (row: number, col: number, v: number): void => {
    const i = (row * 3 + col) * 4;
    pixels[i] = v;
    pixels[i + 1] = v;
    pixels[i + 2] = v;
    pixels[i + 3] = 255;
  };
  set(0, 0, 0);
  set(0, 1, 64);
  set(0, 2, 128);
  set(1, 0, 192);
  set(1, 1, 255);
  set(1, 2, 255);
  const grid = quantizePixels(pixels, 3, 2);
  assert.deepEqual(grid, [
    [0, 1, 2],
    [3, 4, 4],
  ]);
});

test('fitColumns fits a 7-row-tall chart by aspect ratio', () => {
  assert.equal(fitColumns(14, 7, 52), 14); // 2:1 -> 2*7 wide
  assert.equal(fitColumns(7, 7, 52), 7); // square stays 7
  assert.equal(fitColumns(100, 10, 52), 52); // capped at window
  assert.equal(fitColumns(100, 10, 3), 3); // capped at maxCols
  assert.equal(fitColumns(1, 0, 52), 14); // zero height fallback
  assert.equal(fitColumns(1, 0, 2), 2);
});
