import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSvg,
  splitDateRange,
  usageLevel,
} from "./update-codex-token-activity.mjs";

test("splits a date range into bounded requests", () => {
  assert.deepEqual(splitDateRange("2026-01-01", "2026-02-02", 30), [
    ["2026-01-01", "2026-01-30"],
    ["2026-01-31", "2026-02-02"],
  ]);
});

test("maps daily usage percentages to six heatmap levels", () => {
  assert.deepEqual(
    [0, 0.01, 20, 20.01, 40, 60, 80, 100].map(usageLevel),
    [0, 1, 1, 2, 2, 3, 4, 5],
  );
});

test("renders a fixed 53 by 7 activity grid", () => {
  const svg = renderSvg(
    {
      "2026-08-22": { percent: 35 },
      "2026-08-23": { percent: 85 },
    },
    "2026-08-23",
  );
  assert.equal((svg.match(/class="day level-/g) ?? []).length, 371);
  assert.match(svg, /2026-08-22: 35\.00%/);
  assert.match(svg, /2026-08-23: 85\.00%/);
  assert.match(svg, /class="day level-5"/);
});

