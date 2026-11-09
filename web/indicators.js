// インジケーター計算。chartapp の indicators.py（pandas）と同じ結果になるように書いてある
// （tests/parity.html で Python の結果と突き合わせる）。値が無いところは NaN。

export const MA_PERIODS = [5, 20, 100, 200];
export const ICHIMOKU_SHIFT = 26;

const nanArray = (n) => new Array(n).fill(NaN);

/** 直近 n 本の平均（n 本そろうまで NaN） */
export function sma(a, n) {
  const out = nanArray(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    if (i >= n) sum -= a[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** pandas の ewm(span=n, adjust=False) */
export function ema(a, n) {
  const k = 2 / (n + 1);
  const out = nanArray(a.length);
  let prev = NaN;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i])) continue;
    prev = Number.isNaN(prev) ? a[i] : k * a[i] + (1 - k) * prev;
    out[i] = prev;
  }
  return out;
}

/** pandas の ewm(alpha=α, adjust=False)。最初の NaN は読み飛ばす */
function ewmAlpha(a, alpha) {
  const out = nanArray(a.length);
  let prev = NaN;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i])) {
      out[i] = prev;
      continue;
    }
    prev = Number.isNaN(prev) ? a[i] : alpha * a[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export function macd(close, fast = 12, slow = 26, signal = 9) {
  const ef = ema(close, fast);
  const es = ema(close, slow);
  const line = close.map((_, i) => ef[i] - es[i]);
  const sig = ema(line, signal);
  return { line, sig, hist: line.map((v, i) => v - sig[i]) };
}

/** Wilder 方式の RSI（pandas版と同じく、割る側が 0 のときは 100） */
export function rsi(close, n = 14) {
  const d = close.map((v, i) => (i === 0 ? NaN : v - close[i - 1]));
  const up = ewmAlpha(d.map((v) => (Number.isNaN(v) ? NaN : Math.max(v, 0))), 1 / n);
  const dn = ewmAlpha(d.map((v) => (Number.isNaN(v) ? NaN : Math.max(-v, 0))), 1 / n);
  return close.map((c, i) => {
    if (Number.isNaN(c)) return NaN;
    if (Number.isNaN(up[i]) || Number.isNaN(dn[i]) || dn[i] === 0) return 100;
    const rs = up[i] / dn[i];
    return 100 - 100 / (1 + rs);
  });
}

/** ボリンジャーバンド（標準偏差は母集団: ddof=0） */
export function bollinger(close, n = 20, k = 2) {
  const mid = sma(close, n);
  const up = nanArray(close.length);
  const lo = nanArray(close.length);
  for (let i = n - 1; i < close.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (close[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    up[i] = mid[i] + k * sd;
    lo[i] = mid[i] - k * sd;
  }
  return { mid, up, lo };
}

function rolling(a, n, fn) {
  const out = nanArray(a.length);
  for (let i = n - 1; i < a.length; i++) {
    let v = a[i];
    for (let j = i - n + 1; j < i; j++) v = fn(v, a[j]);
    out[i] = v;
  }
  return out;
}

/** 一目均衡表。先行スパンは「シフト前」の値（使う側で26本ずらす） */
export function ichimoku(high, low, t = 9, k = 26, b = 52) {
  const mid = (n) => {
    const hi = rolling(high, n, Math.max);
    const lo = rolling(low, n, Math.min);
    return hi.map((h, i) => (h + lo[i]) / 2);
  };
  const tenkan = mid(t);
  const kijun = mid(k);
  const spanA = tenkan.map((v, i) => (v + kijun[i]) / 2);
  const spanB = mid(b);
  return { tenkan, kijun, spanA, spanB };
}

/** n 本ずらす（前の値を後ろへ）。はみ出した分は NaN */
export function shift(a, n) {
  return a.map((_, i) => (i - n >= 0 ? a[i - n] : NaN));
}

/** candles: [{time, open, high, low, close, volume}] -> 全指標 */
export function compute(candles) {
  const open = candles.map((c) => c.open);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const volume = candles.map((c) => c.volume);
  const d = { open, high, low, close, volume };
  for (const p of MA_PERIODS) d[`ma${p}`] = sma(close, p);
  const m = macd(close);
  d.macd = m.line;
  d.macdSig = m.sig;
  d.macdHist = m.hist;
  d.rsi = rsi(close);
  const bb = bollinger(close);
  d.bbMid = bb.mid;
  d.bbUp = bb.up;
  d.bbLo = bb.lo;
  const ich = ichimoku(high, low);
  d.spanA = ich.spanA;
  d.spanB = ich.spanB;
  return d;
}
