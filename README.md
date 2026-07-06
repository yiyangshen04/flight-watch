# 机票价格监控（Flight Watch）

配置驱动的 Google Flights 价格监控：在 `flight_watch_config.json` 里定义任意条监控任务
（航线、日期窗口、行程长度、货币、舱位等），自动抓取每个出发日期的最低价并累积成历史走势图。

**网站**: https://yiyangshen04.github.io/flight-watch/

## 全自动模式（GitHub Actions）

- **定时抓价**：`.github/workflows/watch.yml` 每天早晚各跑一轮（芝加哥时间约 10:17 / 22:17），
  抓完把数据提交回仓库，网站自动更新。没有活跃监控时几秒内空跑结束，公开仓库不产生任何费用。
- **网页添加监控**：网站右上角「＋ 添加监控」→ 填 Issue 表单提交 →
  `.github/workflows/add-watch.yml` 自动解析、写入配置、抓第一轮、回帖并关闭 Issue。
  只有仓库主人提交的表单会被处理，其他人提交会被忽略。
- **过期自动停**：出发窗口过去后该任务自动跳过，不再抓取（网站上标记「已结束」）。
  手动停用某任务：把配置里它的 `enabled` 改为 `false`。

## 本地手动跑

```bash
cd ~/Desktop/flight_watch
node flight_watch_once.mjs        # 一键：抓取 -> 入库历史 -> 生成走势图
node flight_watch_stats.mjs       # 终端统计报告：哪天便宜、每轮价格变化
git push                          # 推上去网站才会更新
```

跑完后打开 `data/<任务id>/overlay_chart.html` 查看价格走势。

也可以分步执行（三个脚本都支持 `--watch <id>` 只跑某一个任务）：

```bash
node run_flight_watch_round.mjs              # 只抓取一轮
node update_flight_watch_history.mjs         # 只把最新一轮追加进历史
node render_flight_watch_overlay_chart.mjs   # 只重新生成走势图
node flight_watch_once.mjs --watch chi-rom-sep-2026
```

脚本按自身所在目录定位文件，在任何目录下执行都可以。

## 配置说明（flight_watch_config.json）

顶层设置：

| 字段 | 默认 | 说明 |
|---|---|---|
| `concurrency` | 3 | 同时抓取几个日期 |
| `retry_count` | 2 | 每个日期失败后的重试次数 |
| `request_delay_ms` | 400 | 每次请求前的间隔（另加随机抖动），避免被限流 |

每条监控任务（`watches` 数组的元素）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 任务标识，也是 `data/` 下的文件夹名（字母数字-_） |
| `enabled` | | 默认 true；false 则默认不跑（`--watch` 指定时仍可跑） |
| `trip_type` | | `round_trip`（默认）或 `one_way` |
| `outbound.from/to` | ✅ | 去程机场/城市代码（如 CHI、ROM、PAR、PEK、SHA） |
| `return.from/to` | | 回程航段，默认按去程反向；填不同机场即为开口行程（如去程到罗马、从巴黎回） |
| `departure_start/end` | ✅ | 扫描的出发日期窗口（每一天都会查一次价） |
| `trip_length_days` | 往返必填 | 回程日期 = 出发日期 + 该天数 |
| `currency` | | 默认 USD，支持 EUR/CNY/JPY 等 |
| `seat` | | economy（默认）/ premium_economy / business / first |
| `adults` | | 成人数，默认 1 |
| `max_stops` | | 最多中转次数，0 = 只看直飞；不填则不限 |
| `target_departure_date` | | 重点关注的出发日期，会单独出现在 summary 里 |
| `price_floor/price_ceiling` | | 价格合理区间（默认 30~100000），区间外的解析结果丢弃 |

新增监控 = 在 `watches` 里加一个对象；数据自动存到 `data/<id>/`，互不干扰。

## 数据文件（每个任务一个文件夹 data/<id>/）

- `latest_round.json` / `.csv` — 最新一轮抓取结果（debug.url 可在浏览器打开人工核价）
- `previous_round.json` — 上一轮结果（算环比变化用）
- `baseline_snapshot.json` — 每个日期第一次抓到的价格（算累计涨跌用）
- `price_history.json` — 所有轮次的完整历史
- `overlay_chart.html` — 走势图（最新轮 / 上一轮 / 基准价三条线，悬停看每个日期的完整历史）

## 工作原理与注意事项

- 抓取用的是 Google Flights 的 `?tfs=`（protobuf 编码）URL，服务端会直接渲染航班结果，
  无需浏览器。价格从结果卡片的 aria-label（"From 710 US dollars round trip total..."）中提取，
  取每个日期的最低价。
- 旧版脚本用的 `#flt=` 锚点 URL 不会把查询发给服务器，所以从未抓到过价格；
  那次尝试的数据归档在 `archive_2026-04_first_attempt/`（全部为空值）。
- 多城市（3 段以上）行程 Google 不做服务端渲染，暂不支持；两段的开口行程按往返模式编码，已验证可用。
- 偶尔个别日期会 `no_prices_found`（限流或渲染缺失），重跑一轮通常会补上。
- 定期监控可配合 cron/launchd 每天跑一次 `node flight_watch_once.mjs`。

## HTTP 服务（launchd，可选）

`~/Library/LaunchAgents/com.hanson.flightwatch.http.plist` 会用 Python 在
`http://127.0.0.1:8787` 上对 `flight_watch_bundle/` 提供本地静态服务。
目前因 macOS 权限限制（launchd 的 python3 无「桌面」访问权限）无法启动，
如需修复：系统设置 → 隐私与安全性 → 完全磁盘访问权限（或文件和文件夹）中授权 python3。
