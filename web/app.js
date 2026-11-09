// ChartWeb 本体: 画面の組み立て・チャート描画・定期更新
import { compute, MA_PERIODS } from "./indicators.js";
import { RULES, defaultParams, paramsFrom, activeRules, evaluate, explain, verdict, lastSignal } from "./signals.js";
import { TIMEFRAMES, TF_SEC, HISTORY_N, fetchHistory, fetchLatest, fetchTickers, merge, changedFrom, fmtPrice } from "./datafeed.js";

const JST = 9 * 3600; // チャートの時間軸はUTC表示なので、9時間足して日本時間に見せる
const POLL_MS = 15000;
const SHOW_BARS = 120;
const STORE_KEY = "chartweb.v1";
const FIRST_PAIRS = ["btc_jpy", "eth_jpy", "xrp_jpy", "sol_jpy", "astr_jpy", "bnb_jpy", "sui_jpy", "ada_jpy"];
const MA_COLORS = { 5: "#ffd54f", 20: "#42a5f5", 100: "#ab47bc", 200: "#ff7043" };
const SUBS = [["rsi", "RSI"], ["macd", "MACD"], ["score", "スコア"]];

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") e.textContent = v;
    else if (k === "style") for (const [name, val] of Object.entries(v)) e.style.setProperty(name, val); // "--c" のような変数もここで入る
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids) e.append(c);
  return e;
}

// ---------------------------------------------------------------- 保存
function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ pair: S.pair, tf: S.tf, sub: S.sub, overlays: S.overlays, params: S.params }));
  } catch {
    /* 保存できなくても動く（プライベートブラウズなど） */
  }
}

const saved = loadStore();
const S = {
  pair: typeof saved.pair === "string" ? saved.pair : "btc_jpy",
  tf: TF_SEC[saved.tf] ? saved.tf : "1h",
  sub: SUBS.some(([k]) => k === saved.sub) ? saved.sub : "rsi",
  overlays: { ma5: false, ma20: true, ma100: false, ma200: true, bb: false, ...(saved.overlays || {}) }, // 細かい足でローソクが線に隠れないよう、初期はMA20とMA200だけ
  params: paramsFrom(saved.params),
  candles: [],
  d: null, // 指標
  ev: null, // 判定
  nClosed: 0,
  sel: null, // 見ている足の番号（null=最新の確定足）
  tickers: [],
  token: 0, // 銘柄・時間足を切り替えたら古い通信の結果を捨てるための番号
};

// ---------------------------------------------------------------- チャート
const LC = window.LightweightCharts;
let main, sub, candleSeries, volSeries, lineSeries, subSeries, syncing = false;

const baseOptions = () => ({
  autoSize: true,
  layout: { background: { color: "#131722" }, textColor: "#d1d4dc", fontSize: 11 },
  grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
  rightPriceScale: { borderColor: "#2a2e39", minimumWidth: 72 },
  timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, rightOffset: 4 },
  crosshair: { mode: LC.CrosshairMode.Normal },
});

function buildCharts() {
  main = LC.createChart($("main"), baseOptions());
  sub = LC.createChart($("sub"), { ...baseOptions(), timeScale: { ...baseOptions().timeScale, visible: false } });
  candleSeries = main.addCandlestickSeries({
    upColor: "#26a69a", downColor: "#ef5350", borderVisible: false, wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    priceFormat: { type: "custom", formatter: fmtPrice, minMove: 0.0001 },
  });
  volSeries = main.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
  volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  lineSeries = {};
  for (const p of MA_PERIODS) lineSeries[`ma${p}`] = main.addLineSeries({ color: MA_COLORS[p], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  for (const k of ["bbUp", "bbLo"]) lineSeries[k] = main.addLineSeries({ color: "#7e57c2", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

  // 上下のチャートの横方向（表示範囲）をそろえる
  const link = (from, to) =>
    from.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r) return;
      syncing = true;
      to.timeScale().setVisibleLogicalRange(r);
      syncing = false;
    });
  link(main, sub);
  link(sub, main);
  main.subscribeClick((p) => {
    if (!p.time || !S.candles.length) return;
    const i = S.candles.findIndex((c) => c.time + JST === p.time);
    if (i >= 0) {
      S.sel = i;
      renderJudge();
    }
  });
}

const pt = (arr, c, i) => (Number.isFinite(arr[i]) ? { time: c[i].time + JST, value: arr[i] } : { time: c[i].time + JST });

function mainPoints(i) {
  const c = S.candles;
  const { d } = S;
  const t = c[i].time + JST;
  const up = c[i].close >= c[i].open;
  const out = {
    candle: { time: t, open: c[i].open, high: c[i].high, low: c[i].low, close: c[i].close },
    vol: { time: t, value: c[i].volume, color: up ? "rgba(38,166,154,0.45)" : "rgba(239,83,80,0.45)" },
  };
  for (const p of MA_PERIODS) out[`ma${p}`] = S.overlays[`ma${p}`] ? pt(d[`ma${p}`], c, i) : { time: t };
  out.bbUp = S.overlays.bb ? pt(d.bbUp, c, i) : { time: t };
  out.bbLo = S.overlays.bb ? pt(d.bbLo, c, i) : { time: t };
  return out;
}

// from: 0 なら全部入れ直す。それ以外は from 番目以降だけ update する
// （チャートの update は「いちばん新しい足」か「その次の足」にしか使えない。古い足を渡すとエラーになる）
function applyMain(from = 0) {
  const n = S.candles.length;
  const buf = { candle: [], vol: [] };
  for (const k of Object.keys(lineSeries)) buf[k] = [];
  for (let i = from; i < n; i++) {
    const p = mainPoints(i);
    for (const k of Object.keys(buf)) buf[k].push(p[k]);
  }
  const seriesOf = (k) => (k === "candle" ? candleSeries : k === "vol" ? volSeries : lineSeries[k]);
  for (const [k, pts] of Object.entries(buf)) {
    if (from === 0) seriesOf(k).setData(pts);
    else for (const p of pts) seriesOf(k).update(p);
  }
  // 売買シグナルの印（確定した足だけ）
  const marks = [];
  for (let i = 0; i < S.nClosed; i++) {
    const s = S.ev.signal[i];
    if (s) marks.push({ time: S.candles[i].time + JST, position: s > 0 ? "belowBar" : "aboveBar", shape: s > 0 ? "arrowUp" : "arrowDown", color: s > 0 ? "#26a69a" : "#ef5350" });
  }
  candleSeries.setMarkers(marks);
}

// 下のチャート（RSI / MACD / スコア）。切り替えるたびに作り直す
function buildSub() {
  if (subSeries) for (const s of Object.values(subSeries)) sub.removeSeries(s);
  const o = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, lineWidth: 1 };
  if (S.sub === "rsi") {
    subSeries = { rsi: sub.addLineSeries({ ...o, color: "#b39ddb", lastValueVisible: true }) };
    for (const [price, color] of [[S.params.rsiHi, "#ef5350"], [S.params.rsiLo, "#26a69a"]]) subSeries.rsi.createPriceLine({ price, color, lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "" });
  } else if (S.sub === "macd") {
    subSeries = {
      hist: sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }),
      line: sub.addLineSeries({ ...o, color: "#42a5f5" }),
      sig: sub.addLineSeries({ ...o, color: "#ff7043" }),
    };
  } else {
    subSeries = { score: sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: true }) };
    for (const [price, color] of [[S.params.buyTh, "#26a69a"], [S.params.sellTh, "#ef5350"]]) subSeries.score.createPriceLine({ price, color, lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "" });
  }
}

function subPoints(i) {
  const c = S.candles;
  const { d } = S;
  const t = c[i].time + JST;
  if (S.sub === "rsi") return { rsi: pt(d.rsi, c, i) };
  if (S.sub === "macd") {
    const h = d.macdHist[i];
    return {
      hist: Number.isFinite(h) ? { time: t, value: h, color: h >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)" } : { time: t },
      line: pt(d.macd, c, i),
      sig: pt(d.macdSig, c, i),
    };
  }
  const v = S.ev.score[i];
  return { score: { time: t, value: v, color: v > 0 ? "rgba(38,166,154,0.7)" : v < 0 ? "rgba(239,83,80,0.7)" : "#8b93a7" } };
}

function applySub(from = 0) {
  const n = S.candles.length;
  const buf = Object.fromEntries(Object.keys(subSeries).map((k) => [k, []]));
  for (let i = from; i < n; i++) {
    const p = subPoints(i);
    for (const k of Object.keys(buf)) buf[k].push(p[k]);
  }
  for (const [k, pts] of Object.entries(buf)) {
    if (from === 0) subSeries[k].setData(pts);
    else for (const p of pts) subSeries[k].update(p);
  }
}

function showRecent() {
  const apply = () => {
    const n = S.candles.length;
    if (n) main.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - SHOW_BARS), to: n + 4 });
  };
  apply();
  // データを入れた直後のチャート側の自動調整が後から来て範囲を上書きすることがあるので、描画が落ち着いてからもう一度
  requestAnimationFrame(() => requestAnimationFrame(apply));
}

// ---------------------------------------------------------------- 計算と表示
function recompute() {
  S.d = compute(S.candles);
  S.ev = evaluate(S.d, S.params);
  const last = S.candles[S.candles.length - 1];
  const forming = last && last.time + TF_SEC[S.tf] > Date.now() / 1000;
  S.nClosed = S.candles.length - (forming ? 1 : 0);
}

const jstText = (sec) =>
  new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(sec * 1000));

/** 切り替え中に前の銘柄のチャートが残らないよう、いったん空にする */
function clearCharts() {
  S.candles = [];
  S.sel = null;
  candleSeries.setData([]);
  candleSeries.setMarkers([]);
  volSeries.setData([]);
  for (const s of Object.values(lineSeries)) s.setData([]);
  for (const s of Object.values(subSeries)) s.setData([]);
  $("price").textContent = "-";
  $("chg").textContent = "";
  $("pill").textContent = "…";
  $("pill").style.background = "";
  $("scoreText").textContent = "";
  $("lastSig").textContent = "";
  $("rules").replaceChildren();
}

function renderHeader() {
  const c = S.candles;
  if (!c.length) return;
  $("price").textContent = `¥${fmtPrice(c[c.length - 1].close)}`;
  const t = S.tickers.find((x) => x.pair === S.pair);
  const chg = $("chg");
  if (t) {
    chg.textContent = `24h ${t.change >= 0 ? "+" : ""}${t.change.toFixed(2)}%`;
    chg.className = t.change >= 0 ? "up" : "down";
  } else {
    chg.textContent = "";
    chg.className = "";
  }
}

function renderJudge() {
  const i = S.sel ?? S.nClosed - 1;
  const pill = $("pill");
  const list = $("rules");
  list.replaceChildren();
  if (i < 0 || !S.ev) {
    pill.textContent = "…";
    pill.style.background = "";
    $("scoreText").textContent = "";
    $("lastSig").textContent = "";
    return;
  }
  const score = S.ev.score[i];
  const v = verdict(score, S.params);
  const max = Math.max(1, activeRules(S.params).length);
  pill.textContent = v.label;
  pill.style.background = v.color;
  $("scoreText").textContent = `スコア ${score > 0 ? "+" : ""}${score}（−${max}〜+${max}）`;
  const ls = lastSignal(S.ev, S.nClosed);
  $("lastSig").textContent = ls ? `直近のシグナル: ${ls.dir > 0 ? "買い" : "売り"} ${jstText(S.candles[ls.index].time)}（${S.nClosed - 1 - ls.index}本前）` : "直近のシグナル: なし";
  $("detailTitle").textContent = `判定の内訳（${jstText(S.candles[i].time)} の足${S.sel === null ? "・最新の確定足" : ""}）`;
  $("latestBtn").hidden = S.sel === null;

  const rows = explain(S.d, S.ev, i, S.params);
  if (!rows.length) list.append(el("li", {}, el("span", { className: "empty", text: "使うルールが選ばれていません（⚙で選べます）" })));
  for (const r of rows) {
    list.append(
      el("li", {},
        el("span", { className: `v ${r.vote > 0 ? "up" : r.vote < 0 ? "down" : "zero"}`, text: r.vote > 0 ? "+1" : r.vote < 0 ? "−1" : "0" }),
        el("span", { className: "name", text: r.label }),
        el("span", { className: "why", text: r.text }),
      ),
    );
  }
}

function render(from = 0) {
  recompute();
  if (!S.candles.length) return;
  if (S.sel !== null && S.sel >= S.candles.length) S.sel = null;
  applyMain(from);
  applySub(from);
  renderHeader();
  renderJudge();
}

// ---------------------------------------------------------------- 通信
function setStatus(msg, isErr = false) {
  $("status").textContent = msg;
  $("status").className = isErr ? "err" : "";
}

async function load() {
  const token = ++S.token;
  setStatus("読み込み中…");
  try {
    const candles = await fetchHistory(S.pair, S.tf, HISTORY_N);
    if (token !== S.token) return;
    S.candles = candles;
    S.sel = null;
    buildSub();
    render(0);
    showRecent();
    setStatus(`更新 ${new Date().toLocaleTimeString("ja-JP")}（${candles.length}本）`);
  } catch (e) {
    if (token !== S.token) return;
    setStatus(`読み込めませんでした: ${e.message}`, true);
  }
}

let polling = false;
async function poll() {
  if (polling || document.hidden || !S.candles.length) return;
  polling = true;
  const token = S.token;
  try {
    const [latest, tickers] = await Promise.all([fetchLatest(S.pair, S.tf), fetchTickers().catch(() => null)]);
    if (token !== S.token) return;
    if (tickers) {
      S.tickers = tickers;
      refreshPairLabels();
    }
    const next = merge(S.candles, latest);
    const from = changedFrom(S.candles, next);
    S.candles = next;
    render(from);
    setStatus(`更新 ${new Date().toLocaleTimeString("ja-JP")}（${S.candles.length}本）`);
  } catch (e) {
    if (token === S.token) setStatus(`更新できませんでした（次回再試行）: ${e.message}`, true);
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------- 画面の部品
const pairName = (p) => p.replace("_", "/").toUpperCase();

function refreshPairLabels() {
  const sel = $("pair");
  const have = new Map([...sel.options].map((o) => [o.value, o]));
  const list = S.tickers.length ? S.tickers.map((t) => t.pair) : FIRST_PAIRS;
  if (list.length !== have.size || list.some((p) => !have.has(p))) {
    const order = [...FIRST_PAIRS.filter((p) => list.includes(p)), ...list.filter((p) => !FIRST_PAIRS.includes(p)).sort()];
    sel.replaceChildren(...order.map((p) => el("option", { value: p, text: pairName(p) })));
    if (!order.includes(S.pair)) S.pair = order[0];
  }
  for (const o of sel.options) {
    const t = S.tickers.find((x) => x.pair === o.value);
    o.textContent = t ? `${pairName(o.value)}  ${t.change >= 0 ? "+" : ""}${t.change.toFixed(1)}%` : pairName(o.value);
  }
  sel.value = S.pair;
}

function buildTfs() {
  const nav = $("tfs");
  nav.replaceChildren(...TIMEFRAMES.map(([k]) => el("button", { type: "button", text: k, "aria-pressed": String(k === S.tf), onclick: () => switchTf(k) })));
}
function switchTf(tf) {
  if (tf === S.tf) return;
  S.tf = tf;
  saveStore();
  buildTfs();
  clearCharts();
  load();
}

function buildChips() {
  const chips = $("chips");
  const items = [...MA_PERIODS.map((p) => [`ma${p}`, `MA${p}`, MA_COLORS[p]]), ["bb", "BB", "#7e57c2"]];
  chips.replaceChildren(
    ...items.map(([k, label, color]) =>
      el("button", {
        type: "button", text: label, "data-c": "1", style: { "--c": color }, "aria-pressed": String(!!S.overlays[k]),
        onclick: (e) => {
          S.overlays[k] = !S.overlays[k];
          e.currentTarget.setAttribute("aria-pressed", String(S.overlays[k]));
          saveStore();
          if (S.candles.length) applyMain(0);
        },
      }),
    ),
  );
  $("subtabs").replaceChildren(
    ...SUBS.map(([k, label]) =>
      el("button", {
        type: "button", text: label, "aria-pressed": String(k === S.sub),
        onclick: () => {
          S.sub = k;
          saveStore();
          for (const b of $("subtabs").children) b.setAttribute("aria-pressed", String(b.textContent === label));
          buildSub();
          if (S.candles.length) {
            applySub(0);
            const r = main.timeScale().getVisibleLogicalRange();
            if (r) sub.timeScale().setVisibleLogicalRange(r);
          }
        },
      }),
    ),
  );
}

// ---------------------------------------------------------------- 設定ダイアログ
function openSettings() {
  const f = $("form");
  const box = $("ruleBoxes");
  box.replaceChildren(
    ...RULES.map(([k, label]) => {
      const cb = el("input", { type: "checkbox", name: `rule_${k}`, checked: !!S.params.enabled[k] });
      return el("label", {}, cb, document.createTextNode(label));
    }),
  );
  for (const k of ["buyTh", "sellTh", "rsiLo", "rsiHi", "volMult", "volLen"]) f.elements[k].value = S.params[k];
  $("dlg").showModal();
}

function applySettings(next) {
  S.params = next;
  saveStore();
  buildSub(); // 基準線の位置が変わるので作り直す
  if (S.candles.length) {
    render(0);
    const r = main.timeScale().getVisibleLogicalRange();
    if (r) sub.timeScale().setVisibleLogicalRange(r);
  }
}

function readSettings() {
  const f = $("form");
  const o = { enabled: {} };
  for (const [k] of RULES) o.enabled[k] = f.elements[`rule_${k}`].checked;
  for (const k of ["buyTh", "sellTh", "rsiLo", "rsiHi", "volMult", "volLen"]) o[k] = f.elements[k].value;
  return paramsFrom(o);
}

// ---------------------------------------------------------------- 起動
function start() {
  if (!LC) {
    setStatus("チャートの部品を読み込めませんでした。通信を確認して、再読み込みしてください", true);
    return;
  }
  refreshPairLabels();
  buildTfs();
  buildChips();
  buildCharts();
  buildSub();

  $("pair").addEventListener("change", (e) => {
    S.pair = e.target.value;
    saveStore();
    clearCharts();
    load();
  });
  $("settingsBtn").addEventListener("click", openSettings);
  $("cancelBtn").addEventListener("click", () => $("dlg").close());
  $("resetBtn").addEventListener("click", () => {
    const d = defaultParams();
    for (const [k] of RULES) $("form").elements[`rule_${k}`].checked = d.enabled[k];
    for (const k of ["buyTh", "sellTh", "rsiLo", "rsiHi", "volMult", "volLen"]) $("form").elements[k].value = d[k];
  });
  $("form").addEventListener("submit", () => applySettings(readSettings()));
  $("latestBtn").addEventListener("click", () => {
    S.sel = null;
    renderJudge();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll();
  });
  setInterval(poll, POLL_MS);

  fetchTickers()
    .then((t) => {
      S.tickers = t;
      refreshPairLabels();
    })
    .catch(() => {})
    .finally(load);

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

start();
window.__chartweb = { S, poll, get main() { return main; }, get sub() { return sub; } }; // 動作確認(tests/)用
