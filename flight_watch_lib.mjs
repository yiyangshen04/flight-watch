import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根目录以本文件位置为准，脚本在任何目录下执行都可以
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(ROOT, 'flight_watch_config.json');
export const DATA_DIR = path.join(ROOT, 'data');

const SEAT_CODES = { economy: 1, premium_economy: 2, business: 3, first: 4 };

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', HKD: 'HK$',
  KRW: '₩', TWD: 'NT$', AUD: 'A$', CAD: 'C$', SGD: 'S$', CHF: 'CHF ',
};

export function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

export function parseIsoDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

export function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(isoDate, days) {
  const d = parseIsoDate(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

export function dateRange(startIso, endIso) {
  const out = [];
  const end = parseIsoDate(endIso);
  let d = parseIsoDate(startIso);
  while (d <= end) {
    out.push(toIsoDate(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function watchPaths(watchId) {
  const dir = path.join(DATA_DIR, watchId);
  return {
    dir,
    latestJson: path.join(dir, 'latest_round.json'),
    latestCsv: path.join(dir, 'latest_round.csv'),
    previousJson: path.join(dir, 'previous_round.json'),
    baselineJson: path.join(dir, 'baseline_snapshot.json'),
    historyJson: path.join(dir, 'price_history.json'),
    chartHtml: path.join(dir, 'overlay_chart.html'),
  };
}

// 出发窗口已完全过去的任务视为过期，定时抓取会跳过
export function isExpired(watch, todayIso = new Date().toISOString().slice(0, 10)) {
  return watch.departure_end < todayIso;
}

export function normalizeWatch(raw, index) {
  const w = { ...raw };
  if (!w.id) throw new Error(`watches[${index}] 缺少 id`);
  if (!/^[a-zA-Z0-9_-]+$/.test(w.id)) throw new Error(`watch id "${w.id}" 只能包含字母、数字、- 和 _（要用作文件夹名）`);
  if (!w.outbound?.from || !w.outbound?.to) throw new Error(`watch "${w.id}" 缺少 outbound.from / outbound.to`);
  if (!w.departure_start || !w.departure_end) throw new Error(`watch "${w.id}" 缺少 departure_start / departure_end`);
  parseIsoDate(w.departure_start);
  parseIsoDate(w.departure_end);

  w.enabled = w.enabled !== false;
  w.trip_type = w.trip_type ?? 'round_trip';
  if (!['round_trip', 'one_way'].includes(w.trip_type)) {
    throw new Error(`watch "${w.id}" trip_type 必须是 round_trip 或 one_way`);
  }
  if (w.trip_type === 'round_trip') {
    if (!Number.isInteger(w.trip_length_days) || w.trip_length_days < 0) {
      throw new Error(`watch "${w.id}" 往返行程需要 trip_length_days（整数，回程 = 出发日 + 该天数）`);
    }
    // 回程航段默认按去程反向；填不同机场即为开口行程（如 CHI->ROM 去、PAR->CHI 回）
    w.return = {
      from: w.return?.from ?? w.outbound.to,
      to: w.return?.to ?? w.outbound.from,
    };
  } else {
    w.return = null;
  }
  w.currency = (w.currency ?? 'USD').toUpperCase();
  w.seat = w.seat ?? 'economy';
  if (!(w.seat in SEAT_CODES)) throw new Error(`watch "${w.id}" seat 必须是 ${Object.keys(SEAT_CODES).join('/')}`);
  w.adults = Number.isInteger(w.adults) && w.adults > 0 ? w.adults : 1;
  if (w.max_stops != null && (!Number.isInteger(w.max_stops) || w.max_stops < 0)) {
    throw new Error(`watch "${w.id}" max_stops 需为 0 或正整数（0 = 只看直飞）`);
  }
  w.price_floor = w.price_floor ?? 30;
  w.price_ceiling = w.price_ceiling ?? 100000;
  w.target_departure_date = w.target_departure_date ?? null;
  if (w.target_departure_date) parseIsoDate(w.target_departure_date);

  const routeText = w.trip_type === 'one_way'
    ? `${w.outbound.from} -> ${w.outbound.to} (one way)`
    : `${w.outbound.from} -> ${w.outbound.to}, ${w.return.from} -> ${w.return.to}`;
  w.label = w.label ?? routeText;
  w.route_text = routeText;
  return w;
}

export async function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`读取 ${CONFIG_PATH} 失败: ${err.message}`);
  }
  const settings = {
    concurrency: raw.concurrency ?? 3,
    retry_count: raw.retry_count ?? 2,
    request_delay_ms: raw.request_delay_ms ?? 400,
  };
  if (!Array.isArray(raw.watches) || raw.watches.length === 0) {
    throw new Error('配置里没有任何 watches');
  }
  const watches = raw.watches.map(normalizeWatch);
  const ids = new Set();
  for (const w of watches) {
    if (ids.has(w.id)) throw new Error(`watch id 重复: ${w.id}`);
    ids.add(w.id);
  }
  return { settings, watches };
}

// 命令行 --watch <id> 只跑指定任务，否则跑所有 enabled 的任务
export function selectWatches(watches, argv = process.argv.slice(2)) {
  const idx = argv.indexOf('--watch');
  if (idx >= 0) {
    const id = argv[idx + 1];
    const found = watches.find((w) => w.id === id);
    if (!found) throw new Error(`找不到 watch "${id}"，现有: ${watches.map((w) => w.id).join(', ')}`);
    return [found];
  }
  return watches.filter((w) => w.enabled);
}

// ---- Google Flights ?tfs= protobuf URL 编码 ----
// 服务端会对这种 URL 直接渲染航班结果（老的 #flt= 锚点格式不会），无需浏览器即可抓价格。

function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}

function lenDelimited(fieldNo, bytes) {
  return [...varint((fieldNo << 3) | 2), ...varint(bytes.length), ...bytes];
}

function varintField(fieldNo, value) {
  return [...varint(fieldNo << 3), ...varint(value)];
}

function utf8(s) {
  return [...new TextEncoder().encode(s)];
}

function airportMsg(code) {
  return lenDelimited(2, utf8(code));
}

function legMsg(date, from, to, maxStops) {
  const bytes = [
    ...lenDelimited(2, utf8(date)),
    ...lenDelimited(13, airportMsg(from)),
    ...lenDelimited(14, airportMsg(to)),
  ];
  if (maxStops != null) bytes.push(...varintField(5, maxStops));
  return bytes;
}

export function buildFlightUrl(watch, departureDate, returnDate) {
  const legs = [{ date: departureDate, from: watch.outbound.from, to: watch.outbound.to }];
  if (watch.trip_type === 'round_trip') {
    legs.push({ date: returnDate, from: watch.return.from, to: watch.return.to });
  }
  const bytes = [];
  for (const leg of legs) {
    bytes.push(...lenDelimited(3, legMsg(leg.date, leg.from, leg.to, watch.max_stops)));
  }
  for (let i = 0; i < watch.adults; i += 1) bytes.push(...varintField(8, 1));
  bytes.push(...varintField(9, SEAT_CODES[watch.seat]));
  bytes.push(...varintField(19, watch.trip_type === 'one_way' ? 2 : 1));

  const tfs = Buffer.from(Uint8Array.from(bytes)).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `https://www.google.com/travel/flights/search?tfs=${tfs}&hl=en&gl=US&curr=${watch.currency}`;
}

// 价格出现在结果卡片的 aria-label 里，形如
// "From 710 US dollars round trip total. Nonstop flight with United. ..."
const PRICE_LABEL_RE = /From ([0-9][0-9,]*) ([A-Za-z][A-Za-z ]{1,30})/g;

export function extractPrices(html, watch) {
  const prices = [];
  for (const m of html.matchAll(PRICE_LABEL_RE)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n >= watch.price_floor && n <= watch.price_ceiling) {
      prices.push(n);
    }
  }
  return prices;
}

export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// 简单并发池：limit 个 worker 消费任务队列
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export { fs, path };
