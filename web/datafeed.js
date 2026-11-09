// bitbank の公開API（ローソク足・ティッカー）。ブラウザから直接読める（CORS可）。APIキーは使わない。
// chartapp の datafeed.py（CcxtFeed の bitbank 専用部分）と同じ考え方。

const BASE = "https://public.bitbank.cc";

// 秒数。bitbank のAPI名は API_NAME
export const TIMEFRAMES = [
  ["1m", 60, "1min"],
  ["5m", 300, "5min"],
  ["15m", 900, "15min"],
  ["30m", 1800, "30min"],
  ["1h", 3600, "1hour"],
  ["4h", 14400, "4hour"],
  ["1d", 86400, "1day"],
  ["1w", 604800, "1week"],
];
export const TF_SEC = Object.fromEntries(TIMEFRAMES.map(([k, s]) => [k, s]));
const API_NAME = Object.fromEntries(TIMEFRAMES.map(([k, , a]) => [k, a]));

export const HISTORY_N = 600; // 最初に取得する本数（200MAが十分に出る数）
export const KEEP_N = 3000;

async function getJson(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.success !== 1) throw new Error(`bitbankのエラー (code ${j.data && j.data.code})`);
    return j.data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("通信がタイムアウトしました");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** bitbank の1行 [o,h,l,c,v,ms] -> {time(秒), open, high, low, close, volume} */
export function toCandle(row) {
  return {
    time: Math.floor(row[5] / 1000),
    open: Number(row[0]),
    high: Number(row[1]),
    low: Number(row[2]),
    close: Number(row[3]),
    volume: Number(row[4]),
  };
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
const dayKey = (ms) => {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`;
};
const yearKey = (ms) => String(new Date(ms).getUTCFullYear());

/** 時間足ごとの日付キー。〜1時間足=YYYYMMDD(その日1日分) / 4時間足以上=YYYY(その年1年分)。新しい順 */
export function candleKeys(tf, startMs, endMs) {
  const keys = [];
  if (TF_SEC[tf] >= 14400) {
    for (let y = new Date(endMs).getUTCFullYear(); y >= new Date(startMs).getUTCFullYear(); y--) keys.push(String(y));
  } else {
    const DAY = 86400000;
    const first = Math.floor(startMs / DAY) * DAY;
    for (let t = Math.floor(endMs / DAY) * DAY; t >= first; t -= DAY) keys.push(dayKey(t));
  }
  return keys;
}

async function fetchKey(pair, tf, key) {
  const d = await getJson(`${BASE}/${pair}/candlestick/${API_NAME[tf]}/${key}`);
  const rows = d.candlestick && d.candlestick[0] ? d.candlestick[0].ohlcv : [];
  return rows.map(toCandle);
}

/** 同じ時刻の足は新しい方で置き換え、時刻順に並べる */
export function merge(old, add) {
  const m = new Map();
  for (const c of old) m.set(c.time, c);
  for (const c of add) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time).slice(-KEEP_N);
}

const sameBar = (a, b) => a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

/** 取り直した結果(next)で、チャートをどこから描き直せばよいか（prev=今チャートにある足）。
 *  - 最新の足が動いた／新しい足が増えただけ → 今の最新の足の番号（>0）。そこから update する
 *  - それより前の足が変わった／本数が減った（古い足が上限で消えた）／1本以下 → 0（全部入れ直す）
 *  チャートの update は「いちばん新しい足」以降にしか使えないので、古い足を渡さないための判定 */
export function changedFrom(prev, next) {
  if (next.length < prev.length) return 0;
  let i = 0;
  while (i < prev.length && sameBar(prev[i], next[i])) i++;
  const last = prev.length - 1;
  return last > 0 && i >= last ? last : 0;
}

/** 同時に走らせる数を絞って全部実行（公開APIに負荷をかけすぎない） */
async function settleLimited(tasks, limit = 6) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

/** 過去の足をまとめて取る（日・年ごとの取得を数本ずつ並列で） */
export async function fetchHistory(pair, tf, n = HISTORY_N, nowMs = Date.now()) {
  const startMs = nowMs - n * TF_SEC[tf] * 1000;
  const keys = candleKeys(tf, startMs, nowMs);
  const results = await settleLimited(keys.map((k) => () => fetchKey(pair, tf, k)));
  // 最新側(先頭2つ)の失敗は本当の問題。古い側の失敗は「データなし」とみなす
  const bad = results.slice(0, 2).findIndex((r) => r.status === "rejected");
  if (bad >= 0 && !results.some((r) => r.status === "fulfilled" && r.value.length)) {
    throw results[bad].reason;
  }
  let all = [];
  for (const r of results) if (r.status === "fulfilled") all = all.concat(r.value);
  all = merge([], all);
  if (!all.length) throw new Error(`${pair} ${tf}: データが見つかりません（銘柄または時間足が未対応の可能性）`);
  return all.slice(-n);
}

/** 直近の数本だけ取り直す（日付が変わる付近・年始は前の日付も取る） */
export async function fetchLatest(pair, tf, nowMs = Date.now()) {
  const dur = TF_SEC[tf] * 1000;
  const keys = candleKeys(tf, nowMs - 3 * dur, nowMs).reverse();
  const parts = await Promise.all(keys.map((k) => fetchKey(pair, tf, k)));
  const since = Math.floor((nowMs - 3 * dur) / 1000);
  return merge([], parts.flat()).filter((c) => c.time >= since);
}

/** 全銘柄のティッカー -> [{pair, last, open, change(%)}] */
export async function fetchTickers() {
  const d = await getJson(`${BASE}/tickers_jpy`);
  return d
    .map((t) => {
      const last = Number(t.last);
      const open = Number(t.open);
      return { pair: t.pair, last, open, change: open ? ((last - open) / open) * 100 : 0 };
    })
    .filter((t) => Number.isFinite(t.last));
}

/** 表示用の価格（桁数に応じて小数点以下を調整） */
export function fmtPrice(v) {
  if (!Number.isFinite(v)) return "-";
  if (v >= 100) return v.toLocaleString("ja-JP", { maximumFractionDigits: 0 });
  if (v >= 1) return v.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toLocaleString("ja-JP", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}
