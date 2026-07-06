import { pathToFileURL } from 'node:url';
import {
  fs, addDays, dateRange, readJsonIfExists, watchPaths,
  loadConfig, selectWatches, buildFlightUrl, extractPrices,
  sleep, mapPool, median, mean,
} from './flight_watch_lib.mjs';

async function fetchMinPrice(watch, settings, departureDate, returnDate) {
  const url = buildFlightUrl(watch, departureDate, returnDate);
  const attempts = [];

  for (let i = 0; i <= settings.retry_count; i += 1) {
    // 请求间隔 + 随机抖动，避免频率过高被限制
    await sleep(settings.request_delay_ms + Math.random() * 300);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'cache-control': 'no-cache',
        },
      });
      const html = await res.text();
      const prices = extractPrices(html, watch);
      attempts.push({ attempt: i + 1, ok: res.ok, statusCode: res.status, prices_found: prices.length });

      if (prices.length > 0) {
        return {
          url,
          priceMin: Math.min(...prices),
          pricesFound: prices.length,
          status: 'ok',
          attempts,
        };
      }
    } catch (err) {
      attempts.push({ attempt: i + 1, ok: false, error: String(err?.message || err) });
    }
  }

  return { url, priceMin: null, pricesFound: 0, status: 'no_prices_found', attempts };
}

function toCsv(rows, currency) {
  const headers = [
    'departure_date', 'return_date', 'currency',
    'baseline_price', 'previous_price', 'price_min',
    'delta_vs_last_round', 'delta_vs_first_round',
    'prices_found', 'status',
  ];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => esc(h === 'currency' ? currency : r[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export async function runRound(watch, settings) {
  const paths = watchPaths(watch.id);
  await fs.mkdir(paths.dir, { recursive: true });

  const previousRows = await readJsonIfExists(paths.previousJson, []);
  const baselineRows = await readJsonIfExists(paths.baselineJson, []);
  const prevMap = new Map(previousRows.map((r) => [r.departure_date, r]));
  const baselineMap = new Map(baselineRows.map((r) => [r.departure_date, r]));

  const runStartedAtIso = new Date().toISOString();
  const departures = dateRange(watch.departure_start, watch.departure_end);

  const roundRows = await mapPool(departures, settings.concurrency, async (departureDate) => {
    const returnDate = watch.trip_type === 'round_trip' ? addDays(departureDate, watch.trip_length_days) : null;
    const result = await fetchMinPrice(watch, settings, departureDate, returnDate);

    const previousPrice = prevMap.get(departureDate)?.price_min ?? null;
    const baselinePrice = baselineMap.get(departureDate)?.baseline_price ?? null;

    return {
      departure_date: departureDate,
      return_date: returnDate,
      baseline_price: baselinePrice,
      previous_price: previousPrice,
      price_min: result.priceMin,
      delta_vs_last_round: result.priceMin != null && previousPrice != null ? result.priceMin - previousPrice : null,
      delta_vs_first_round: result.priceMin != null && baselinePrice != null ? result.priceMin - baselinePrice : null,
      prices_found: result.pricesFound,
      status: result.status,
      debug: { url: result.url, attempts: result.attempts },
    };
  });

  // 基准价只在第一次抓到价格时记录，之后保持不变，用来对比"从开始监控到现在涨/跌了多少"
  const newBaselineRows = roundRows.map((row) => {
    const old = baselineMap.get(row.departure_date);
    if (old?.baseline_price != null) return old;
    return {
      departure_date: row.departure_date,
      return_date: row.return_date,
      baseline_price: row.price_min,
      baseline_recorded_at: row.price_min != null ? runStartedAtIso : null,
    };
  });

  const good = roundRows.map((r) => r.price_min).filter((n) => Number.isFinite(n));

  const targetRow = watch.target_departure_date
    ? roundRows.find((r) => r.departure_date === watch.target_departure_date) ?? null
    : null;

  const summary = {
    run_started_at: runStartedAtIso,
    watch_id: watch.id,
    label: watch.label,
    route: watch.route_text,
    trip_type: watch.trip_type,
    currency: watch.currency,
    adults: watch.adults,
    seat: watch.seat,
    departure_start: watch.departure_start,
    departure_end: watch.departure_end,
    trip_length_days: watch.trip_type === 'round_trip' ? watch.trip_length_days : null,
    rows_total: roundRows.length,
    rows_with_price: good.length,
    min: good.length ? Math.min(...good) : null,
    median: median(good),
    mean: mean(good),
    max: good.length ? Math.max(...good) : null,
    target_row: targetRow,
    cheapest_5_dates: [...roundRows]
      .filter((r) => Number.isFinite(r.price_min))
      .sort((a, b) => a.price_min - b.price_min)
      .slice(0, 5)
      .map((r) => ({ departure_date: r.departure_date, return_date: r.return_date, price_min: r.price_min })),
    notes: good.length === 0
      ? ['本轮没有抓到任何价格；可能是被 Google 限流了，或页面结构变化，可打开 rows 里 debug.url 的链接人工核对。']
      : [],
  };

  await fs.writeFile(paths.latestJson, JSON.stringify({ run_started_at: runStartedAtIso, rows: roundRows, summary }, null, 2));
  await fs.writeFile(paths.latestCsv, toCsv(roundRows, watch.currency));
  await fs.writeFile(paths.previousJson, JSON.stringify(roundRows, null, 2));
  await fs.writeFile(paths.baselineJson, JSON.stringify(newBaselineRows, null, 2));

  return {
    watch_id: watch.id,
    rows_total: roundRows.length,
    rows_with_price: good.length,
    min: summary.min,
    latest_json: paths.latestJson,
  };
}

async function main() {
  const { settings, watches } = await loadConfig();
  const selected = selectWatches(watches);
  const results = [];
  for (const watch of selected) {
    results.push(await runRound(watch, settings));
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
