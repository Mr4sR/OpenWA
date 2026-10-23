import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPx, dragOffset } from './usePaneResizer.ts';

// Pure geometry of the sash drag: the signed offset from the pane's fixed edge and its clamp.
// The live DOM path is exercised by a manual browser smoke; these pin the math.

test('a start-edge drag measures rightward distance from the left anchor', () => {
  assert.equal(dragOffset(480, 320, true), 160);
  assert.equal(dragOffset(200, 320, true), -120); // inward past the anchor is negative → clamps to min
});

test('an end-edge drag measures leftward distance from the right anchor', () => {
  // The preview pane grows leftward: a pointer left of the right edge widens it.
  assert.equal(dragOffset(900, 1200, false), 300);
  assert.equal(dragOffset(1250, 1200, false), -50); // past the edge → clamps to min
});

test('clamp keeps the width inside the configured bounds', () => {
  assert.equal(clampPx(160, 220, 560), 220); // below min → min
  assert.equal(clampPx(900, 220, 560), 560); // above max → max
  assert.equal(clampPx(386, 220, 560), 386); // inside → exact
});

test('clamp tolerates a degenerate range by never going negative', () => {
  assert.equal(clampPx(-50, 0, 0), 0);
});
