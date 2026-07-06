// 终端统计报告：哪些日期便宜、每轮抓取之间价格怎么变
// 用法: node flight_watch_stats.mjs [--watch <id>]
import { pathToFileURL } from 'node:url';
import {
  readJsonIfExists, watchPaths, loadConfig, selectWatches, currencySymbol,
} from './flight_watch_lib.mjs';

const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : 'n/a';

function money(v, sym) {
  return v == null ? 'n/a' : `${sym}${v}`;
}

function delta(v, sym) {
  if (v == null) return '—';
  if (v === 0) return '持平';
  return v > 0 ? `↑${sym}${v}` : `↓${sym}${-v}`;
}

// 把每个日期的 points 按 run_started_at 对齐到 runs 上
function pointsByRun(history) {
  const map = new Map(); // run_started_at -> [{departure_date, point}]
  for (const s of Object.values(history.series_by_departure_date)) {
    for (const p of s.points) {
      if (!map.has(p.run_started_at)) map.set(p.run_started_at, []);
      map.get(p.run_started_at).push({ departure_date: s.departure_date, point: p });
    }
  }
  return map;
}

export async function statsForWatch(watch) {
  const paths = watchPaths(watch.id);
  const history = await readJsonIfExists(paths.historyJson, null);
  const sym = currencySymbol(watch.currency);
  const lines = [];
  lines.push('');
  lines.push(`═══ ${watch.label}（${watch.id}）═══`);
  lines.push(`行程: ${watch.route_text}${watch.trip_length_days ? `，${watch.trip_length_days} 天` : ''} | 货币: ${watch.currency}`);

  if (!history?.runs?.length) {
    lines.push('还没有历史数据，先运行: node flight_watch_once.mjs');
    return lines.join('\n');
  }

  const runs = history.runs;
  const byRun = pointsByRun(history);
  lines.push(`抓取轮数: ${runs.length}（${fmtTime(runs[0].run_started_at)} ~ ${fmtTime(runs[runs.length - 1].run_started_at)}）`);

  // —— 功能1：哪些出发日期更便宜（按最新一轮） ——
  const latestPoints = [...byRun.get(runs[runs.length - 1].run_started_at) ?? []]
    .filter((x) => Number.isFinite(x.point.price_min));
  latestPoints.sort((a, b) => a.point.price_min - b.point.price_min);

  lines.push('');
  lines.push('【哪天出发更便宜】最新一轮价格从低到高:');
  if (!latestPoints.length) {
    lines.push('  最新一轮没有抓到价格');
  } else {
    for (const { departure_date, point } of latestPoints.slice(0, 8)) {
      const s = history.series_by_departure_date[departure_date];
      const ret = s?.return_date ? ` ~ ${s.return_date}` : '';
      lines.push(`  ${money(point.price_min, sym).padEnd(8)} ${departure_date}${ret}` +
        `（较上轮 ${delta(point.delta_vs_last_round, sym)}，较首次 ${delta(point.delta_vs_first_round, sym)}）`);
    }
  }

  // —— 功能2：不同抓取时间的价格对比 ——
  lines.push('');
  lines.push('【不同时间抓取的价格变化】每轮的全场最低价:');
  let prevMin = null;
  for (const run of runs) {
    const pts = (byRun.get(run.run_started_at) ?? []).map((x) => x.point.price_min).filter(Number.isFinite);
    const runMin = pts.length ? Math.min(...pts) : null;
    const d = runMin != null && prevMin != null ? runMin - prevMin : null;
    lines.push(`  ${fmtTime(run.run_started_at)}  全场最低 ${money(runMin, sym).padEnd(8)} 有价日期 ${pts.length}  ${d != null ? `较上轮 ${delta(d, sym)}` : ''}`);
    if (runMin != null) prevMin = runMin;
  }

  // 本轮 vs 上一轮逐日期对比
  if (runs.length >= 2) {
    const moves = [];
    let up = 0, down = 0, flat = 0, gained = 0, lost = 0;
    for (const s of Object.values(history.series_by_departure_date)) {
      const find = (runIso) => s.points.find((p) => p.run_started_at === runIso);
      const cur = find(runs[runs.length - 1].run_started_at);
      const prev = find(runs[runs.length - 2].run_started_at);
      const c = cur?.price_min, p = prev?.price_min;
      if (Number.isFinite(c) && Number.isFinite(p)) {
        const d = c - p;
        if (d > 0) up += 1; else if (d < 0) down += 1; else flat += 1;
        if (d !== 0) moves.push({ date: s.departure_date, d });
      } else if (Number.isFinite(c)) gained += 1;
      else if (Number.isFinite(p)) lost += 1;
    }
    moves.sort((a, b) => a.d - b.d);
    lines.push('');
    lines.push(`【本轮 vs 上一轮】下跌 ${down} 个日期，上涨 ${up} 个，持平 ${flat}` +
      `${gained ? `，新抓到 ${gained}` : ''}${lost ? `，丢失 ${lost}` : ''}`);
    for (const m of moves.slice(0, 3)) {
      if (m.d < 0) lines.push(`  跌最多: ${m.date} ${delta(m.d, sym)}`);
    }
    for (const m of moves.slice(-3).reverse()) {
      if (m.d > 0) lines.push(`  涨最多: ${m.date} ${delta(m.d, sym)}`);
    }
  }

  // 目标日期
  if (watch.target_departure_date) {
    const s = history.series_by_departure_date[watch.target_departure_date];
    const last = s?.points[s.points.length - 1];
    lines.push('');
    lines.push(`【目标日期 ${watch.target_departure_date}】` + (last
      ? `最新 ${money(last.price_min, sym)}（较上轮 ${delta(last.delta_vs_last_round, sym)}，较首次 ${delta(last.delta_vs_first_round, sym)}）`
      : '暂无数据'));
  }

  return lines.join('\n');
}

async function main() {
  const { watches } = await loadConfig();
  const selected = selectWatches(watches);
  for (const watch of selected) {
    console.log(await statsForWatch(watch));
  }
  console.log('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
