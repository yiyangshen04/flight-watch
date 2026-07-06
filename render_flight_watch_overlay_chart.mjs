import { pathToFileURL } from 'node:url';
import {
  fs, readJsonIfExists, watchPaths, loadConfig, selectWatches,
  currencySymbol, median,
} from './flight_watch_lib.mjs';

function escHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function renderChart(watch) {
  const paths = watchPaths(watch.id);
  const latest = await readJsonIfExists(paths.latestJson, null);
  const history = await readJsonIfExists(paths.historyJson, null);
  if (!latest?.rows || !history?.series_by_departure_date) {
    throw new Error(`watch "${watch.id}" 缺少 latest 或 history 数据，请先运行抓取和入库脚本`);
  }

  const rows = latest.rows;
  const priced = rows.filter((r) => Number.isFinite(r.price_min));
  const vals = priced.map((r) => r.price_min);
  const statMin = vals.length ? Math.min(...vals) : null;
  const statMedian = median(vals);
  const statMean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const statMax = vals.length ? Math.max(...vals) : null;

  const runTimes = (history.runs || []).map((r) => r.run_started_at);
  const series = Object.values(history.series_by_departure_date)
    .sort((a, b) => a.departure_date.localeCompare(b.departure_date));

  const xLabels = series.map((s) => s.departure_date);
  const latestLine = series.map((s) => {
    const p = s.points[s.points.length - 1];
    return Number.isFinite(p?.price_min) ? p.price_min : null;
  });
  const baselineLine = series.map((s) => {
    const p = s.points.find((pt) => Number.isFinite(pt?.price_min));
    return Number.isFinite(p?.price_min) ? p.price_min : null;
  });
  const previousLine = series.map((s) => {
    const p = s.points.length >= 2 ? s.points[s.points.length - 2] : null;
    return Number.isFinite(p?.price_min) ? p.price_min : null;
  });

  const payload = {
    generated_at: new Date().toISOString(),
    run_started_at: latest.run_started_at,
    run_count: runTimes.length,
    label: watch.label,
    route: watch.route_text,
    currency: watch.currency,
    currency_symbol: currencySymbol(watch.currency),
    xLabels,
    latestLine,
    previousLine,
    baselineLine,
    series,
    summary: {
      min: statMin,
      median: statMedian,
      mean: statMean,
      max: statMax,
      rows_total: rows.length,
      rows_with_price: priced.length,
    },
  };

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Flight Watch: ${escHtml(watch.label)}</title>
  <style>
    :root {
      --card: #ffffff;
      --ink: #1c2430;
      --muted: #66758a;
      --line-latest: #1f7a8c;
      --line-prev: #9b6b9e;
      --line-base: #a6761d;
    }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background: linear-gradient(160deg, #eef3f8, #f9fbfd 45%, #edf6f3); color: var(--ink); }
    .wrap { max-width: 1220px; margin: 24px auto; padding: 0 14px 28px; }
    .card { background: var(--card); border-radius: 16px; box-shadow: 0 12px 28px rgba(19,35,58,.08); border: 1px solid #e7edf4; }
    .head { padding: 18px 18px 8px; }
    h1 { margin: 0; font-size: 21px; }
    .sub { margin-top: 6px; color: var(--muted); font-size: 13px; }
    .stats { display: grid; grid-template-columns: repeat(6, minmax(0,1fr)); gap: 10px; padding: 8px 18px 18px; }
    .stat { background: #f8fbff; border: 1px solid #e3ebf6; border-radius: 10px; padding: 9px 10px; }
    .stat .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
    .stat .v { margin-top: 4px; font-weight: 700; }
    .chart { padding: 0 10px 16px; position: relative; }
    canvas { width: 100%; height: 420px; display: block; }
    .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); padding: 0 18px 14px; }
    .dot { width: 10px; height: 10px; border-radius: 99px; display: inline-block; margin-right: 6px; }
    .tooltip { position: fixed; pointer-events: none; z-index: 99; max-width: 360px; background: #101827; color: #edf4ff; border: 1px solid rgba(255,255,255,.15); border-radius: 10px; box-shadow: 0 12px 26px rgba(0,0,0,.35); padding: 10px 12px; font-size: 12px; line-height: 1.4; opacity: 0; transform: translateY(4px); transition: opacity .12s ease, transform .12s ease; }
    .tooltip.visible { opacity: 1; transform: translateY(0); }
    .tooltip .t { font-weight: 700; margin-bottom: 4px; }
    .tooltip .muted { color: #b8c7dd; }
    @media (max-width: 900px) {
      .stats { grid-template-columns: repeat(2, minmax(0,1fr)); }
      canvas { height: 360px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <h1>Flight Price Watch: ${escHtml(watch.label)}</h1>
        <div class="sub">${escHtml(payload.route)} | ${escHtml(payload.currency)} | Generated ${escHtml(payload.generated_at)} | Run start ${escHtml(payload.run_started_at || 'n/a')} | Total saved runs ${payload.run_count}</div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Rows</div><div class="v">${payload.summary.rows_total}</div></div>
        <div class="stat"><div class="k">Rows With Price</div><div class="v">${payload.summary.rows_with_price}</div></div>
        <div class="stat"><div class="k">Min</div><div class="v">${payload.summary.min ?? 'n/a'}</div></div>
        <div class="stat"><div class="k">Median</div><div class="v">${payload.summary.median ?? 'n/a'}</div></div>
        <div class="stat"><div class="k">Mean</div><div class="v">${payload.summary.mean == null ? 'n/a' : payload.summary.mean.toFixed(2)}</div></div>
        <div class="stat"><div class="k">Max</div><div class="v">${payload.summary.max ?? 'n/a'}</div></div>
      </div>
      <div class="chart"><canvas id="c"></canvas></div>
      <div class="legend">
        <span><span class="dot" style="background:var(--line-latest)"></span>Latest round</span>
        <span><span class="dot" style="background:var(--line-prev)"></span>Previous round</span>
        <span><span class="dot" style="background:var(--line-base)"></span>Baseline (first captured)</span>
      </div>
    </div>
  </div>
  <div id="tip" class="tooltip"></div>

  <script>
    const DATA = ${JSON.stringify(payload)};
    const CUR = DATA.currency_symbol;
    const c = document.getElementById('c');
    const tip = document.getElementById('tip');
    const ctx = c.getContext('2d');

    function fit() {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rect = c.getBoundingClientRect();
      c.width = Math.floor(rect.width * dpr);
      c.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    function extent(lines) {
      const vals = lines.flat().filter((v) => Number.isFinite(v));
      if (!vals.length) return [0, 1];
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = Math.max(20, (hi - lo) * 0.1);
      return [lo - pad, hi + pad];
    }

    function drawLine(points, color, xPos, yPos) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < points.length; i += 1) {
        const yv = points[i];
        if (!Number.isFinite(yv)) { started = false; continue; }
        const x = xPos(i);
        const y = yPos(yv);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
      for (let i = 0; i < points.length; i += 1) {
        const yv = points[i];
        if (!Number.isFinite(yv)) continue;
        const x = xPos(i);
        const y = yPos(yv);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    let hover = null;

    function draw() {
      const w = c.clientWidth;
      const h = c.clientHeight;
      ctx.clearRect(0, 0, w, h);

      const m = { top: 20, right: 20, bottom: 76, left: 62 };
      const plot = { x: m.left, y: m.top, w: w - m.left - m.right, h: h - m.top - m.bottom };

      const labels = DATA.xLabels;
      const lines = [DATA.latestLine, DATA.previousLine, DATA.baselineLine];
      const yy = extent(lines);
      const yMin = yy[0];
      const yMax = yy[1];

      const xPos = (i) => plot.x + (labels.length <= 1 ? plot.w / 2 : (i / (labels.length - 1)) * plot.w);
      const yPos = (v) => plot.y + (1 - (v - yMin) / (yMax - yMin)) * plot.h;

      ctx.strokeStyle = '#e3e8ef';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i += 1) {
        const y = plot.y + (i / 5) * plot.h;
        ctx.beginPath();
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.w, y);
        ctx.stroke();

        const val = yMax - ((yMax - yMin) * i) / 5;
        ctx.fillStyle = '#6a7789';
        ctx.font = '11px ui-sans-serif, system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(CUR + Math.round(val), plot.x - 8, y + 4);
      }

      ctx.strokeStyle = '#d6deea';
      ctx.beginPath();
      ctx.moveTo(plot.x, plot.y + plot.h);
      ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
      ctx.stroke();

      drawLine(DATA.baselineLine, getComputedStyle(document.documentElement).getPropertyValue('--line-base').trim(), xPos, yPos);
      drawLine(DATA.previousLine, getComputedStyle(document.documentElement).getPropertyValue('--line-prev').trim(), xPos, yPos);
      drawLine(DATA.latestLine, getComputedStyle(document.documentElement).getPropertyValue('--line-latest').trim(), xPos, yPos);

      ctx.fillStyle = '#6a7789';
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      const step = Math.max(1, Math.ceil(labels.length / 10));
      for (let i = 0; i < labels.length; i += step) {
        const x = xPos(i);
        const lbl = labels[i].slice(5);
        ctx.fillText(lbl, x, plot.y + plot.h + 16);
      }

      if (hover != null) {
        const x = xPos(hover);
        ctx.strokeStyle = '#9fb2c7';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, plot.y);
        ctx.lineTo(x, plot.y + plot.h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    function seriesPopupHtml(s) {
      const latest = s.points[s.points.length - 1] || {};
      const rows = s.points
        .map((p) => p.run_started_at + ': ' + (Number.isFinite(p.price_min) ? (CUR + p.price_min) : 'n/a') + ' (' + p.status + ')')
        .join('<br/>');
      const latestVal = Number.isFinite(latest.price_min) ? (CUR + latest.price_min) : 'n/a';
      return '<div class="t">' + s.departure_date + (s.return_date ? (' -> ' + s.return_date) : '') + '</div>' +
        '<div>Latest: <b>' + latestVal + '</b> | Status: <span class="muted">' + (latest.status || 'n/a') + '</span></div>' +
        '<div class="muted" style="margin-top:6px; max-height:180px; overflow:auto">' + (rows || 'No history') + '</div>';
    }

    c.addEventListener('mousemove', (ev) => {
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const labels = DATA.xLabels;
      const m = { left: 62, right: 20 };
      const plotW = rect.width - m.left - m.right;
      if (labels.length < 1 || x < m.left - 10 || x > rect.width - m.right + 10) {
        hover = null;
        tip.classList.remove('visible');
        draw();
        return;
      }
      const t = (x - m.left) / Math.max(1, plotW);
      const i = Math.min(labels.length - 1, Math.max(0, Math.round(t * (labels.length - 1))));
      hover = i;
      draw();

      const s = DATA.series[i];
      if (!s) return;
      tip.innerHTML = seriesPopupHtml(s);
      tip.style.left = Math.min(window.innerWidth - 380, ev.clientX + 14) + 'px';
      tip.style.top = Math.min(window.innerHeight - 260, ev.clientY + 14) + 'px';
      tip.classList.add('visible');
    });

    c.addEventListener('mouseleave', () => {
      hover = null;
      tip.classList.remove('visible');
      draw();
    });

    window.addEventListener('resize', fit);
    fit();
  </script>
</body>
</html>`;

  await fs.writeFile(paths.chartHtml, html);
  return { watch_id: watch.id, out_html: paths.chartHtml };
}

async function main() {
  const { watches } = await loadConfig();
  const selected = selectWatches(watches);
  const results = [];
  for (const watch of selected) {
    results.push(await renderChart(watch));
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
