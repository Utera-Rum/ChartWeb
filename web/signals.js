// 売買タイミングの判定ロジック。chartapp の signals.py と同じ考え方・同じ結果になるように書いてある。
//
// 各ルールが  +1 = 買い寄り / 0 = 中立 / -1 = 売り寄り  のどれかを出し、その合計が「スコア」。
// スコアが買い基準以上なら【買い】、売り基準以下なら【売り】。

import { ICHIMOKU_SHIFT, shift } from "./indicators.js";

// [キー, 表示名, 初期ON]
export const RULES = [
  ["trend200", "長期トレンド（200MA）", true],
  ["maorder", "MAの並び（5・20・100）", true],
  ["macd", "MACD", true],
  ["rsi", "RSI", true],
  ["volume", "出来高", true],
  ["bb", "ボリンジャーバンド", false],
  ["ichi", "一目均衡表（雲）", false],
];
export const LABELS = Object.fromEntries(RULES.map(([k, l]) => [k, l]));

export function defaultParams() {
  return {
    enabled: Object.fromEntries(RULES.map(([k, , on]) => [k, on])),
    rsiLo: 30, // これ以下=売られすぎ(+1)
    rsiHi: 70, // これ以上=買われすぎ(-1)
    volMult: 1.5, // 出来高が平均の何倍以上で「急増」とみなすか
    volLen: 20,
    buyTh: 3, // スコア >= buyTh で【買い】
    sellTh: -2, // スコア <= sellTh で【売り】
  };
}

/** 保存された設定を、足りない項目を補いながら読む（壊れた値は無視） */
export function paramsFrom(obj) {
  const p = defaultParams();
  if (!obj || typeof obj !== "object") return p;
  for (const k of Object.keys(p.enabled)) {
    if (obj.enabled && typeof obj.enabled[k] === "boolean") p.enabled[k] = obj.enabled[k];
  }
  for (const k of ["rsiLo", "rsiHi", "volMult", "volLen", "buyTh", "sellTh"]) {
    const v = Number(obj[k]);
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "" && Number.isFinite(v)) p[k] = v;
  }
  p.volLen = Math.max(1, Math.round(p.volLen));
  return p;
}

export const activeRules = (p) => RULES.map(([k]) => k).filter((k) => p.enabled[k]);

/** 直近 n 本の平均を1本ずらしたもの（その足自身は含めない） */
function volAvg(volume, n) {
  const out = new Array(volume.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < volume.length; i++) {
    sum += volume[i];
    if (i >= n) sum -= volume[i - n];
    if (i >= n - 1 && i + 1 < volume.length) out[i + 1] = sum / n;
  }
  return out;
}

function vote(key, d, p) {
  const n = d.close.length;
  const c = d.close;
  const v = new Array(n).fill(0);
  if (key === "trend200") {
    for (let i = 0; i < n; i++) v[i] = c[i] > d.ma200[i] ? 1 : c[i] < d.ma200[i] ? -1 : 0;
  } else if (key === "maorder") {
    for (let i = 0; i < n; i++) {
      const up = d.ma5[i] > d.ma20[i] && d.ma20[i] > d.ma100[i];
      const dn = d.ma5[i] < d.ma20[i] && d.ma20[i] < d.ma100[i];
      v[i] = up ? 1 : dn ? -1 : 0;
    }
  } else if (key === "macd") {
    for (let i = 1; i < n; i++) {
      const h = d.macdHist[i];
      const hp = d.macdHist[i - 1];
      const up = d.macd[i] > d.macdSig[i] && h > hp;
      const dn = d.macd[i] < d.macdSig[i] && h < hp;
      v[i] = up ? 1 : dn ? -1 : 0;
    }
  } else if (key === "rsi") {
    for (let i = 0; i < n; i++) v[i] = d.rsi[i] <= p.rsiLo ? 1 : d.rsi[i] >= p.rsiHi ? -1 : 0;
  } else if (key === "volume") {
    const avg = volAvg(d.volume, p.volLen);
    for (let i = 0; i < n; i++) {
      const big = d.volume[i] > p.volMult * avg[i];
      v[i] = big && c[i] > d.open[i] ? 1 : big && c[i] < d.open[i] ? -1 : 0;
    }
  } else if (key === "bb") {
    for (let i = 0; i < n; i++) v[i] = c[i] < d.bbLo[i] ? 1 : c[i] > d.bbUp[i] ? -1 : 0;
  } else if (key === "ichi") {
    const a = shift(d.spanA, ICHIMOKU_SHIFT);
    const b = shift(d.spanB, ICHIMOKU_SHIFT);
    for (let i = 0; i < n; i++) {
      const top = Math.max(a[i], b[i]);
      const bot = Math.min(a[i], b[i]);
      v[i] = c[i] > top ? 1 : c[i] < bot ? -1 : 0;
    }
  }
  return v;
}

/** 各ルールの票・スコア・シグナル（+1=買い発生 / -1=売り発生）を返す */
export function evaluate(d, p) {
  const keys = activeRules(p);
  const n = d.close.length;
  const votes = {};
  for (const k of keys) votes[k] = vote(k, d, p);
  const score = new Array(n).fill(0);
  for (const k of keys) for (let i = 0; i < n; i++) score[i] += votes[k][i];

  const raw = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (score[i] >= p.buyTh && score[i - 1] < p.buyTh) raw[i] = 1;
    else if (score[i] <= p.sellTh && score[i - 1] > p.sellTh) raw[i] = -1;
  }
  // 画面用：買い→売り→買い…と交互になるものだけ残す
  const signal = new Array(n).fill(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    if (raw[i] && raw[i] !== last) {
      signal[i] = raw[i];
      last = raw[i];
    }
  }
  return { votes, score, signal, signalRaw: raw };
}

/** i本目の足について [{label, vote, text}] を返す（判定パネル用） */
export function explain(d, ev, i, p) {
  return activeRules(p).map((k) => ({ key: k, label: LABELS[k], vote: ev.votes[k][i], text: reason(k, ev.votes[k][i], d, i, p) }));
}

function reason(k, v, d, i, p) {
  const fmt = (x, f = 1) => x.toFixed(f);
  if (k === "trend200") {
    if (Number.isNaN(d.ma200[i])) return "200MAのデータが足りません";
    return ["価格が200MAより下", "価格が200MAとほぼ同じ", "価格が200MAより上"][v + 1];
  }
  if (k === "maorder") return ["5＜20＜100 の下降並び", "並びが混在（方向感なし）", "5＞20＞100 の上昇並び"][v + 1];
  if (k === "macd") {
    if (v === 1) return "MACDがシグナルより上で、勢いが拡大";
    if (v === -1) return "MACDがシグナルより下で、勢いが拡大";
    if (Number.isNaN(d.macd[i])) return "データ不足";
    return d.macd[i] > d.macdSig[i] ? "上向きだが勢いは鈍化" : "下向きだが勢いは鈍化";
  }
  if (k === "rsi") return `RSI ${fmt(d.rsi[i], 0)}（${{ 1: "売られすぎ", 0: "中立", "-1": "買われすぎ" }[v]}）`;
  if (k === "volume") {
    const avg = volAvg(d.volume, p.volLen)[i];
    const ratio = avg ? d.volume[i] / avg : NaN;
    if (v === 1) return `出来高が平均の${fmt(ratio)}倍の陽線`;
    if (v === -1) return `出来高が平均の${fmt(ratio)}倍の陰線`;
    return Number.isFinite(ratio) ? `出来高は平常（平均の${fmt(ratio)}倍）` : "データ不足";
  }
  if (k === "bb") return { 1: "下のバンド(−2σ)の外＝行き過ぎ", 0: "バンドの内側", "-1": "上のバンド(+2σ)の外＝行き過ぎ" }[v];
  if (k === "ichi") return { 1: "価格が雲の上", 0: "雲の中（方向感なし）", "-1": "価格が雲の下" }[v];
  return "";
}

/** スコア -> {label, color} */
export function verdict(score, p) {
  if (score >= p.buyTh) return { label: "買い", color: "#26a69a" };
  if (score <= p.sellTh) return { label: "売り", color: "#ef5350" };
  if (score > 0) return { label: "買い寄り", color: "#5fb8ad" };
  if (score < 0) return { label: "売り寄り", color: "#e58b84" };
  return { label: "様子見", color: "#8b93a7" };
}

/** 確定足(先頭から nClosed 本)の中で最後に出たシグナル -> {index, dir} | null */
export function lastSignal(ev, nClosed) {
  for (let i = Math.min(nClosed, ev.signal.length) - 1; i >= 0; i--) {
    if (ev.signal[i]) return { index: i, dir: ev.signal[i] };
  }
  return null;
}
