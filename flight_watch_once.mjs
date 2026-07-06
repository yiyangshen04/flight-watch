// 一键执行：抓取一轮 -> 入库历史 -> 生成走势图
// 用法: node flight_watch_once.mjs [--watch <id>]
import { loadConfig, selectWatches, isExpired } from './flight_watch_lib.mjs';
import { runRound } from './run_flight_watch_round.mjs';
import { updateHistory } from './update_flight_watch_history.mjs';
import { renderChart } from './render_flight_watch_overlay_chart.mjs';

const { settings, watches } = await loadConfig();
const argv = process.argv.slice(2);
let selected;
if (argv.includes('--watch')) {
  selected = selectWatches(watches, argv); // 显式指定时不过滤，方便手动补跑
} else {
  selected = watches.filter((w) => w.enabled);
  for (const w of selected.filter(isExpired)) {
    console.error(`[${w.id}] 出发窗口已结束（${w.departure_end}），跳过`);
  }
  selected = selected.filter((w) => !isExpired(w));
}

if (selected.length === 0) {
  console.log('当前没有需要抓取的监控任务（全部停用或已过期），本次空跑结束');
  process.exit(0);
}

const results = [];
for (const watch of selected) {
  console.error(`[${watch.id}] 抓取中: ${watch.label} (${watch.departure_start} ~ ${watch.departure_end}) ...`);
  const round = await runRound(watch, settings);
  console.error(`[${watch.id}] 抓到 ${round.rows_with_price}/${round.rows_total} 个日期的价格${round.min != null ? `，最低 ${round.min} ${watch.currency}` : ''}`);
  const hist = await updateHistory(watch);
  const chart = await renderChart(watch);
  results.push({ round, history: hist, chart });
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
