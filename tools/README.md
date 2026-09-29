# 这几个脚本是干什么的

- `build_valuation.py` —— 把 `data/valuation/*.csv` 的季度锚点 + 当日价格合成
  `valuation_data.js`（页面直接读的那个文件）。**每天由 GitHub Actions 自动跑**。
- `fetch_valuation.py` —— 去 macrotrends 与 stockanalysis 抓季度锚点，
  写 `data/valuation/*.csv`。**不在 CI 里跑**（会被限流），季报出来后在本地跑一次再推送。
- `valuation_lib.py` —— 插值、外推、两种百分位的公共函数。

## 每天自动更新的是什么

市盈率 = 当日收盘价 ÷ 每股收益。**分子天天变，分母要等下一份季报**。
所以每日任务只重抓价格（yfinance）再重算，不碰季度锚点。

## 什么时候需要手动更新

| 情况 | 做什么 |
|---|---|
| 季报出了，想让每股收益跟上 | 本地 `python3 scripts/fetch_valuation.py` 后把 `data/valuation/*.csv` 推上来 |
| QQQ / VOO 的指数估值要更新 | 本地跑 `scripts/build_dataset.py`，再把精简后的 `data.json` 推上来（它依赖 FactSet 周报 PDF，CI 里做不了） |
| 想改页面设计或代码 | 直接改 `index.html` / `valuation.js` / `plot.js` 推上来。自动任务只动 `valuation_data.js`，不会覆盖你的改动 |

## 估值提醒与邮件

`check_alerts.py` 在每天更新完数据后跑一遍，对照仓库根目录的 `alerts.json`：
分位越过阈值、且**上一次还没越过**时，才通过 Resend 发一封邮件。
状态记在 `alerts_state.json` 里，所以一只股票便宜着不动不会天天发信。

要让它真的发信，在仓库的 Settings → Secrets and variables → Actions 里加两个：

| Secret | 填什么 |
|---|---|
| `RESEND_API_KEY` | resend.com 后台生成的 API key |
| `ALERT_TO` | 收件邮箱 |
| `ALERT_FROM` | 可选。默认 `onboarding@resend.dev`；在 Resend 验证自己的域名后可换成自己的地址 |

没配这两个的话脚本会自己跳过发信，任务照样跑完，不会红。

**邮箱地址和密钥都不要写进仓库文件**——这个仓库是公开的。
`alerts.json` 里只有规则（哪只股票、什么阈值），不含任何联系方式。
