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
