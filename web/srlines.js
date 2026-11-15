// サポート／抵抗ラインの自動計算。chartapp の sr_lines.py と同じ結果にする（tests/parity.html で突き合わせ）。
//
// 日足の高値・安値のスイングを価格帯（±2.5%）ごとにまとめ、反発の回数・直近性・滞在日数で点数をつけ、
// いまの価格より下（サポート）と上（抵抗）から、間隔をあけて4本ずつ選ぶ。点数の高い2本が「重要」。
//   サポート  重要=赤 #f23645 ／ その他=青 #2962ff
//   抵抗      重要=オレンジ #ff9800 ／ その他=紫 #7e57c2

export const W = 6; // 前後W本より高い／安い足＝スイング
export const BAND = 0.025; // 同じ価格帯とみなす幅
export const HALF_DAYS = 365; // 点数の半減期（日）
export const MIN_GAP = 0.03; // 選ぶ線どうしの最小の間隔（価格の割合）
export const PER_SIDE = 4; // 片側に引く本数
export const IMPORTANT = 2; // そのうち「重要」にする本数
export const NEAR_PCT = 0.005; // いまの価格にこれだけ近い帯は、どちらの側にも入れない
export const DIST_SCALE = 0.25; // 遠い帯の点数を割り引く（1 + 距離/0.25 で割る）
export const RECENT = 60; // 直近の安値・高値として拾うときに見る本数
export const MAX_DOWN = 0.5; // サポートは、いまの価格の50%下まで
export const MAX_UP = 1.0; // 抵抗は、いまの価格の2倍まで
export const SINGLE = 0.6; // 1回だけの安値・高値の点数の掛け率
export const MIN_SCORE = 0.3; // これ未満の点数の帯は引かない
export const HISTORY_DAYS = 1500; // 計算に使う日足の本数（chartapp と同じ）
export const MIN_BARS = 60; // これより短い日足では計算しない

export const COLORS = { supportImportant: "#f23645", support: "#2962ff", resistanceImportant: "#ff9800", resistance: "#7e57c2" };

/** [価格, 位置, "H"/"L", 直近の極値か]。Python の _pivots と同じ */
function pivots(high, low) {
  const n = high.length;
  const out = [];
  let gmin = Infinity;
  let gmax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (low[i] < gmin) gmin = low[i];
    if (high[i] > gmax) gmax = high[i];
  }
  for (let i = W; i < n - W; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i - W; j <= i + W; j++) {
      if (low[j] < lo) lo = low[j];
      if (high[j] > hi) hi = high[j];
    }
    if (low[i] === lo) out.push([low[i], i, "L", low[i] === gmin]); // 期間の最安値・最高値は、1回だけでも重要な線にする
    if (high[i] === hi) out.push([high[i], i, "H", high[i] === gmax]);
  }
  // 確定していない直近の足でも、直近 RECENT 本の最安値・最高値を更新していれば候補にする
  if (n > W + RECENT) {
    let ti = n - W;
    for (let j = n - W; j < n; j++) if (low[j] < low[ti]) ti = j;
    let m = Infinity;
    for (let j = n - RECENT; j < n - W; j++) if (low[j] < m) m = low[j];
    if (low[ti] < m) out.push([low[ti], ti, "L", true]);
    ti = n - W;
    for (let j = n - W; j < n; j++) if (high[j] > high[ti]) ti = j;
    m = -Infinity;
    for (let j = n - RECENT; j < n - W; j++) if (high[j] > m) m = high[j];
    if (high[ti] > m) out.push([high[ti], ti, "H", true]);
  }
  return out;
}

const median = (sorted) => {
  const k = sorted.length;
  return k % 2 ? sorted[(k - 1) / 2] : (sorted[k / 2 - 1] + sorted[k / 2]) / 2;
};

/** 価格帯ごとの {price, n, kinds, recent, stay, decay} */
export function clusters(high, low, close) {
  const n = close.length;
  const pts = pivots(high, low).sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0) || Number(a[3]) - Number(b[3]));
  const groups = [];
  for (const p of pts) {
    const g = groups[groups.length - 1];
    if (g && p[0] <= g[0][0] * (1 + BAND)) g.push(p);
    else groups.push([p]);
  }
  const k = Math.LN2 / HALF_DAYS;
  return groups.map((g) => {
    const price = median(g.map((x) => x[0]).sort((a, b) => a - b));
    const lo = price * (1 - BAND / 2);
    const hi = price * (1 + BAND / 2);
    let stay = 0;
    for (let i = 0; i < n; i++) if (close[i] >= lo && close[i] <= hi) stay++;
    return { price, n: g.length, kinds: g.map((x) => x[2]), recent: g.some((x) => x[3]), stay, decay: g.map((x) => Math.exp(-(n - 1 - x[1]) * k)) };
  });
}

/** side="support": 安値のスイングを重く／"resistance": 高値のスイングを重く */
export function score(c, side) {
  const main = side === "support" ? "L" : "H";
  let s = 0;
  for (let i = 0; i < c.kinds.length; i++) s += c.decay[i] * (c.kinds[i] === main ? 1.0 : 0.6);
  return s + 0.01 * c.stay;
}

/** 小数 d 桁（d>0）への丸め。Python の round と同じく、ちょうど半分のときだけ偶数へ（toFixed は大きい方へ丸めるので、そこだけ直す） */
function roundFixed(p, d) {
  const s = p.toFixed(Math.min(100, d + 60)); // 2進数の値の、厳密な10進展開
  const dot = s.indexOf(".");
  if (/^50*$/.test(s.slice(dot + 1 + d))) {
    const down = s.slice(0, dot + 1 + d); // 切り捨てた値
    const even = Number(down.slice(-1)) % 2 === 0;
    return even ? Number(down) : Number((Number(down) + 10 ** -d).toFixed(d));
  }
  return Number(p.toFixed(d));
}

/** 見やすい価格にする（有効数字3桁）。Python の round（偶数丸め）にそろえる */
export function nice(p) {
  if (!(p > 0)) return p;
  const d = 2 - Math.floor(Math.log10(p));
  if (d > 0) return roundFixed(p, d);
  const s = 10 ** -d;
  const y = p / s;
  let r = Math.round(y);
  if (y - Math.floor(y) === 0.5 && r % 2 !== 0) r -= 1;
  return r * s;
}

/** 選んだ線 [{price, score, important}]（点数の高い順） */
export function pick(high, low, close, side, last = close[close.length - 1]) {
  const cands = [];
  for (const c of clusters(high, low, close)) {
    if (side === "support" && c.price >= last * (1 - NEAR_PCT)) continue;
    if (side === "resistance" && c.price <= last * (1 + NEAR_PCT)) continue;
    if (side === "support" && c.price < last * (1 - MAX_DOWN)) continue;
    if (side === "resistance" && c.price > last * (1 + MAX_UP)) continue;
    const dist = Math.abs(c.price / last - 1);
    let sc = score(c, side) / (1 + dist / DIST_SCALE);
    if (c.n < 2 && !c.recent) sc *= SINGLE; // 1回だけの安値・高値（直近・期間の極値は除く）は割り引く
    if (sc >= MIN_SCORE) cands.push([sc, c]);
  }
  cands.sort((a, b) => b[0] - a[0]);
  const chosen = [];
  for (const [sc, c] of cands) {
    if (chosen.every((o) => Math.abs(Math.log(c.price / o.price)) >= MIN_GAP)) chosen.push({ price: nice(c.price), score: sc, important: false });
    if (chosen.length >= PER_SIDE) break;
  }
  for (const o of chosen.slice(0, IMPORTANT)) o.important = true;
  return chosen;
}

/** 日足の配列（{high, low, close}）から {support:[…], resistance:[…]}。足が少ないときは null */
export function levels(candles) {
  if (!candles || candles.length < MIN_BARS) return null;
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  return { support: pick(high, low, close, "support"), resistance: pick(high, low, close, "resistance") };
}

/** 画面に引く線の指定（Lightweight Charts の createPriceLine 用）。価格の高い順 */
export function lineSpecs(lv) {
  if (!lv) return [];
  const out = [];
  for (const [side, imp, oth] of [["support", COLORS.supportImportant, COLORS.support], ["resistance", COLORS.resistanceImportant, COLORS.resistance]]) {
    for (const o of lv[side]) out.push({ price: o.price, color: o.important ? imp : oth, lineWidth: o.important ? 2 : 1, important: o.important, side });
  }
  return out.sort((a, b) => b.price - a.price);
}
