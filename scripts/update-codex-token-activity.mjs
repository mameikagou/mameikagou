#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT =
  "https://chatgpt.com/backend-api/wham/usage/daily-token-usage-breakdown";
const DAY_MS = 86_400_000;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(value, count) {
  return new Date(parseDate(value).getTime() + count * DAY_MS);
}

function todayIn(timeZone = DEFAULT_TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function splitDateRange(start, end, chunkDays = 30) {
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const candidateEnd = isoDate(addDays(cursor, chunkDays - 1));
    const chunkEnd = candidateEnd < end ? candidateEnd : end;
    chunks.push([cursor, chunkEnd]);
    cursor = isoDate(addDays(chunkEnd, 1));
  }
  return chunks;
}

function totalForDay(row) {
  return (row.models ?? []).reduce(
    (total, model) => total + (Number(model.credits) || 0),
    0,
  );
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function loadAuth(path) {
  const auth = await loadJson(path, null);
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!accessToken || !accountId) {
    throw new Error(`Codex login credentials are missing from ${path}`);
  }
  return { accessToken, accountId };
}

async function fetchChunk(start, end, authPath, attempt = 1) {
  const { accessToken, accountId } = await loadAuth(authPath);
  const url = new URL(ENDPOINT);
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);
  url.searchParams.set("group_by", "day");

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-ID": accountId,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(35_000),
    });
  } catch (error) {
    if (attempt < 3) return fetchChunk(start, end, authPath, attempt + 1);
    throw new Error(`Request ${start}..${end} failed: ${error.message}`);
  }

  if (!response.ok) {
    if (response.status >= 500 && attempt < 3) {
      return fetchChunk(start, end, authPath, attempt + 1);
    }
    throw new Error(`Request ${start}..${end} returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.data) || payload.units !== "percent") {
    throw new Error(`Unexpected response shape for ${start}..${end}`);
  }
  return payload.data;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function usageLevel(value) {
  if (!(value > 0)) return 0;
  if (value <= 20) return 1;
  if (value <= 40) return 2;
  if (value <= 60) return 3;
  if (value <= 80) return 4;
  return 5;
}

export function renderSvg(days, today) {
  const columns = 53;
  const rows = 7;
  const cell = 11;
  const gap = 3;
  const gridX = 24;
  const gridY = 48;
  const width = 790;
  const height = 176;
  const gridEndDate = addDays(today, 6 - parseDate(today).getUTCDay());
  const gridStartDate = new Date(gridEndDate.getTime() - (columns * rows - 1) * DAY_MS);
  const visibleStart = isoDate(addDays(today, -364));
  const cells = [];
  const monthLabels = [];
  let previousMonth = null;

  for (let index = 0; index < columns * rows; index += 1) {
    const date = new Date(gridStartDate.getTime() + index * DAY_MS);
    const dateKey = isoDate(date);
    const column = Math.floor(index / rows);
    const row = index % rows;
    const value = dateKey >= visibleStart && dateKey <= today
      ? Number(days[dateKey]?.percent) || 0
      : 0;
    const level = usageLevel(value);
    const x = gridX + column * (cell + gap);
    const y = gridY + row * (cell + gap);
    const month = date.getUTCMonth();

    if (
      dateKey >= visibleStart &&
      dateKey <= today &&
      month !== previousMonth &&
      date.getUTCDate() <= 7
    ) {
      monthLabels.push(
        `<text class="month" x="${x}" y="160">${date.toLocaleString("en", {
          month: "short",
          timeZone: "UTC",
        })}</text>`,
      );
      previousMonth = month;
    }

    const title = dateKey >= visibleStart && dateKey <= today
      ? `${dateKey}: ${value.toFixed(2)}%`
      : dateKey;
    cells.push(
      `<rect class="day level-${level}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2"><title>${escapeXml(title)}</title></rect>`,
    );
  }

  // Calculate statistics
  let maxPercent = 0;
  for (const [d, v] of Object.entries(days)) {
    if (d >= visibleStart && d <= today) {
      const p = Number(v?.percent) || 0;
      if (p > maxPercent) maxPercent = p;
    }
  }

  // Calculate streak ending today or yesterday
  let streak = 0;
  let checkCursor = (Number(days[today]?.percent) || 0) > 0 ? today : isoDate(addDays(today, -1));
  while (checkCursor >= visibleStart && (Number(days[checkCursor]?.percent) || 0) > 0) {
    streak += 1;
    checkCursor = isoDate(addDays(checkCursor, -1));
  }

  // Generate recent 7 days ticker
  const tickerItems = [];
  for (let i = 1; i <= 7; i += 1) {
    const d = isoDate(addDays(today, -i));
    const val = Number(days[d]?.percent) || 0;
    tickerItems.push({ date: d, percent: val });
  }

  const tickerElements = tickerItems.map((item, idx) => {
    return `<text class="ticker-item ticker-${idx}" x="766" y="27" text-anchor="end">Recent · ${item.date}: ${item.percent.toFixed(1)}%</text>`;
  }).join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 ${width} ${height}">
  <title id="title">Codex Token Activity</title>
  <desc id="desc">Daily Codex token usage over the last 365 days, measured as account usage percent.</desc>
  <style>
    .background { fill: #ffffff; }
    .heading { fill: #24292f; font: 600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .caption, .month { fill: #6e7781; font: 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .stat-badge { fill: #57606a; font: 500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .ticker-item {
      font: 600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      fill: #0969da;
      opacity: 0;
      animation: tickerFade 14s infinite;
    }
    .ticker-0 { animation-delay: 0s; }
    .ticker-1 { animation-delay: 2s; }
    .ticker-2 { animation-delay: 4s; }
    .ticker-3 { animation-delay: 6s; }
    .ticker-4 { animation-delay: 8s; }
    .ticker-5 { animation-delay: 10s; }
    .ticker-6 { animation-delay: 12s; }
    @keyframes tickerFade {
      0% { opacity: 0; }
      2% { opacity: 1; }
      12% { opacity: 1; }
      14% { opacity: 0; }
      100% { opacity: 0; }
    }
    .day { stroke: rgba(27, 31, 36, 0.04); stroke-width: 1; }
    .level-0 { fill: #f3f4f6; }
    .level-1 { fill: #dbeafe; }
    .level-2 { fill: #bfdbfe; }
    .level-3 { fill: #93c5fd; }
    .level-4 { fill: #60a5fa; }
    .level-5 { fill: #2563eb; }
    @media (prefers-color-scheme: dark) {
      .background { fill: #0d1117; }
      .heading { fill: #e6edf3; }
      .caption, .month { fill: #8b949e; }
      .stat-badge { fill: #8b949e; }
      .ticker-item { fill: #58a6ff; }
      .day { stroke: rgba(240, 246, 252, 0.04); }
      .level-0 { fill: #21262d; }
      .level-1 { fill: #0c2d6b; }
      .level-2 { fill: #1158c7; }
      .level-3 { fill: #1f6feb; }
      .level-4 { fill: #388bfd; }
      .level-5 { fill: #58a6ff; }
    }
  </style>
  <rect class="background" width="${width}" height="${height}" rx="12" />
  <text class="heading" x="24" y="27">Codex Token Activity</text>
  <text class="caption" x="205" y="27">daily usage · last 365 days</text>
  <text class="stat-badge" x="530" y="27" text-anchor="end">Peak: ${maxPercent.toFixed(1)}% · Streak: ${streak}d</text>
  ${tickerElements}
  ${cells.join("\n  ")}
  ${monthLabels.join("\n  ")}
</svg>
`;
}

function parseArgs(argv) {
  const options = {
    authPath: resolve(homedir(), ".codex/auth.json"),
    statePath: resolve(homedir(), ".local/share/codex-token-activity/usage.json"),
    outputPath: resolve("assets/codex-token-activity.svg"),
    timeZone: DEFAULT_TIME_ZONE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--auth") options.authPath = resolve(value);
    else if (name === "--state") options.statePath = resolve(value);
    else if (name === "--output") options.outputPath = resolve(value);
    else if (name === "--time-zone") options.timeZone = value;
    else continue;
    index += 1;
  }
  return options;
}

export async function update(options) {
  const today = todayIn(options.timeZone);
  const state = await loadJson(options.statePath, {
    version: 1,
    units: "percent",
    days: {},
  });
  const isInitialBackfill = Object.keys(state.days ?? {}).length === 0;
  const start = isoDate(addDays(today, isInitialBackfill ? -364 : -34));
  const chunks = splitDateRange(start, today);
  let successfulChunks = 0;

  for (const [chunkStart, chunkEnd] of chunks) {
    try {
      const rows = await fetchChunk(chunkStart, chunkEnd, options.authPath);
      for (const row of rows) {
        state.days[row.date] = {
          percent: Math.max(0, Math.min(100, totalForDay(row))),
        };
      }
      successfulChunks += 1;
    } catch (error) {
      console.warn(error.message);
    }
  }

  if (successfulChunks === 0 && Object.keys(state.days ?? {}).length === 0) {
    throw new Error("No Codex usage data could be downloaded");
  }

  const keepFrom = isoDate(addDays(today, -399));
  state.days = Object.fromEntries(
    Object.entries(state.days)
      .filter(([date]) => date >= keepFrom && date <= today)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  state.updatedAt = new Date().toISOString();
  state.timeZone = options.timeZone;

  await writeJsonAtomic(options.statePath, state);
  await mkdir(dirname(options.outputPath), { recursive: true });
  const temporaryOutput = `${options.outputPath}.tmp`;
  await writeFile(temporaryOutput, renderSvg(state.days, today), "utf8");
  await rename(temporaryOutput, options.outputPath);
  console.log(
    `Rendered ${Object.keys(state.days).length} days to ${options.outputPath}`,
  );
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  update(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
