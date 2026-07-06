import { pathToFileURL } from 'node:url';
import { fs, readJsonIfExists, watchPaths, loadConfig, selectWatches } from './flight_watch_lib.mjs';

export async function updateHistory(watch) {
  const paths = watchPaths(watch.id);
  const latest = await readJsonIfExists(paths.latestJson, null);
  if (!latest?.rows || !Array.isArray(latest.rows)) {
    throw new Error(`${paths.latestJson} 不存在或无效，请先运行 run_flight_watch_round.mjs`);
  }

  const history = await readJsonIfExists(paths.historyJson, {
    created_at: new Date().toISOString(),
    watch_id: watch.id,
    label: watch.label,
    route: watch.route_text,
    currency: watch.currency,
    series_by_departure_date: {},
    runs: [],
  });

  // 同一轮数据只入库一次，重复执行不会产生重复记录
  const runId = latest.run_started_at;
  if (history.runs.some((r) => r.run_started_at === runId)) {
    return { watch_id: watch.id, skipped: 'already_recorded', runs: history.runs.length };
  }

  history.runs.push({
    run_started_at: runId,
    summary: latest.summary ?? null,
    rows_count: latest.rows.length,
  });

  for (const row of latest.rows) {
    const key = row.departure_date;
    if (!history.series_by_departure_date[key]) {
      history.series_by_departure_date[key] = {
        departure_date: key,
        return_date: row.return_date,
        points: [],
      };
    }
    history.series_by_departure_date[key].return_date = row.return_date;
    history.series_by_departure_date[key].points.push({
      run_started_at: runId,
      price_min: row.price_min,
      status: row.status,
      prices_found: row.prices_found,
      baseline_price: row.baseline_price,
      previous_price: row.previous_price,
      delta_vs_last_round: row.delta_vs_last_round,
      delta_vs_first_round: row.delta_vs_first_round,
    });
  }

  await fs.writeFile(paths.historyJson, JSON.stringify(history, null, 2));

  return {
    watch_id: watch.id,
    history_json: paths.historyJson,
    runs: history.runs.length,
    series: Object.keys(history.series_by_departure_date).length,
  };
}

async function main() {
  const { watches } = await loadConfig();
  const selected = selectWatches(watches);
  const results = [];
  for (const watch of selected) {
    results.push(await updateHistory(watch));
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
