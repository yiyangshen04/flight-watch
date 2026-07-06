// 解析「添加机票监控」Issue 表单，把新监控写进 flight_watch_config.json
// 输入: 环境变量 ISSUE_BODY（GitHub issue form 的 markdown 正文）
// 输出: 成功时向 $GITHUB_OUTPUT 写 id=<新监控id>；失败时写 parse_error.txt 并以非零码退出
import fs from 'node:fs/promises';
import { CONFIG_PATH, normalizeWatch, parseIsoDate } from '../flight_watch_lib.mjs';

function parseIssueForm(body) {
  const map = {};
  for (const part of body.split(/^### /m).slice(1)) {
    const nl = part.indexOf('\n');
    if (nl < 0) continue;
    const heading = part.slice(0, nl).trim();
    let value = part.slice(nl).trim();
    if (value === '_No response_') value = '';
    map[heading] = value;
  }
  return map;
}

const code = (s) => (s ?? '').trim().toUpperCase();

async function main() {
  const body = process.env.ISSUE_BODY;
  if (!body) throw new Error('缺少 ISSUE_BODY 环境变量');
  const f = parseIssueForm(body);

  const from = code(f['出发地代码']);
  const to = code(f['目的地代码']);
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    throw new Error(`出发地/目的地需要是 3 位机场或城市代码，收到: "${from}" / "${to}"`);
  }
  const tripType = (f['行程类型'] ?? '往返').includes('单') ? 'one_way' : 'round_trip';
  const depStart = (f['出发窗口开始日期'] ?? '').trim();
  const depEnd = (f['出发窗口结束日期'] ?? '').trim();
  parseIsoDate(depStart);
  parseIsoDate(depEnd);
  if (depStart > depEnd) throw new Error(`出发窗口开始日期晚于结束日期: ${depStart} > ${depEnd}`);
  const today = new Date().toISOString().slice(0, 10);
  if (depEnd < today) throw new Error(`出发窗口 ${depStart} ~ ${depEnd} 已经过去了`);

  const watch = {
    id: '',
    enabled: true,
    trip_type: tripType,
    outbound: { from, to },
    departure_start: depStart,
    departure_end: depEnd,
    currency: code(f['货币']) || 'USD',
  };

  if (tripType === 'round_trip') {
    const len = Number((f['行程天数（往返必填）'] ?? '').trim());
    if (!Number.isInteger(len) || len <= 0) throw new Error('往返行程需要填写正整数的行程天数');
    watch.trip_length_days = len;
    const rr = code(f['回程航段（可选，开口行程用）']);
    if (rr) {
      const m = rr.match(/^([A-Z]{3})[-–—>→ ]+([A-Z]{3})$/);
      if (!m) throw new Error(`回程航段格式应为 PAR-CHI，收到: "${rr}"`);
      watch.return = { from: m[1], to: m[2] };
    }
  }

  if ((f['中转限制'] ?? '').includes('直飞')) watch.max_stops = 0;
  const target = (f['目标出发日期（可选）'] ?? '').trim();
  if (target) {
    parseIsoDate(target);
    if (target < depStart || target > depEnd) throw new Error(`目标日期 ${target} 不在出发窗口内`);
    watch.target_departure_date = target;
  }
  const label = (f['显示名称（可选）'] ?? '').trim();
  if (label) watch.label = label;

  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  const ids = new Set(config.watches.map((w) => w.id));
  let id = `${from}-${to}-${depStart.replaceAll('-', '')}`.toLowerCase();
  for (let n = 2; ids.has(id); n += 1) id = `${from}-${to}-${depStart.replaceAll('-', '')}`.toLowerCase() + '-' + n;
  watch.id = id;

  normalizeWatch(watch, config.watches.length); // 校验，不合法会抛错
  config.watches.push(watch);
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `id=${id}\n`);
  }
  console.log(JSON.stringify({ ok: true, id, watch }, null, 2));
}

try {
  await main();
} catch (err) {
  const msg = String(err?.message || err);
  await fs.writeFile('parse_error.txt', msg);
  console.error('解析失败:', msg);
  process.exit(1);
}
