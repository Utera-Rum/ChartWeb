# ChartWeb（chartapp のスマホ向けWeb版）

bitbank のチャートと売買判定を見る静的サイト（ビルドなし・サーバーなし）。ユーザー(Rum)には日本語で答える。
PC用の chartapp（`Z:\UlteraProjects\chartapp`）の判定ロジックを JavaScript に移したもの。

## 構成
- `web/` … 公開する静的ファイルだけ。`app.js`(画面) / `indicators.js` / `signals.js` / `srlines.js` / `datafeed.js` / `sw.js`
- `web/srlines.js` … **サポート／抵抗ライン**（チャートの「S/R」ボタン。初期はオン）。chartapp の `sr_lines.py` と同じ計算で、**見ている時間足に関係なく日足1500本**（`fetchHistory(pair, "1d", 1500)`）から価格帯を選び、`createPriceLine` で引く（サポート=重要は赤・その他は青、抵抗=重要はオレンジ・その他は紫。重要は太線）。銘柄ごとに6時間キャッシュ（`srCache`）、取得に失敗したら5分は取り直さない（`srFailedAt`）。足が60本未満は引かない。chartapp の「毎朝の自動更新」（`tools/update_sr_lines.py`）とは別に、ブラウザが毎回計算する（PCが止まっていても動く。手で引いた線は反映されない）
- `tests/parity.html` … ブラウザで開く。`PARITY OK` がタイトルに出れば合格。JS版の計算が chartapp(Python)版と一致するか＋datafeed の部品
- `tests/make_fixture.py` … chartapp の indicators.py / signals.py で正解データ `fixture.json` を作る（chartapp の `.venv` の python で実行）
- `tests/make_sr_fixture.py` … chartapp の `sr_lines.py` で正解データ `sr_fixture.json` を作る（実際の日足4銘柄＋刻みの粗いデータなど11ケース。足のデータごと入れるので、テストは通信しない）

## 動かす・試す
- `cd web && python -m http.server 8765` → http://localhost:8765/
- テスト: リポジトリ直下で `python -m http.server 8766` → http://localhost:8766/tests/parity.html
- Nodeは入っていない。確認はブラウザ（Claudeのブラウザペイン）で行う。スマホ幅は `resize_window` の mobile。ペインが隠れていると `document.hidden` になり定期更新が止まる

## 注意
- `indicators.js` / `signals.js` は chartapp の `indicators.py` / `signals.py` と同じ結果にする。**どちらかを変えたら、もう片方と `make_fixture.py` → `parity.html` で一致を確かめる**
- `srlines.js` も同じ: chartapp の `sr_lines.py`（定数・点数・選び方）を変えたら、JS側を直して `make_sr_fixture.py` → `parity.html`。Pythonの `round` はちょうど半分を偶数へ丸めるので、`nice()` / `roundFixed()` でそろえている（`toFixed` は大きい方へ丸める）。Lightweight Charts の価格線は、近い線だけが目盛りの範囲に入る（遠い線は目盛りを広げない）
- Lightweight Charts の `series.update()` は「最新の足」以降にしか使えない（古い足を渡すと "Cannot update oldest data"）。取り直しは `changedFrom()` で、最新の足の変化・追加だけなら update、それ以外は setData
- チャートの時間軸はUTC表示。日本時間に見せるため時刻に +9時間している（`app.js` の JST）。データ側の時刻はUTC秒のまま
- bitbank のローソク足APIの日付キーは1時間足以下=YYYYMMDD、4時間足以上=YYYY。古い日付・上場前の年は空かエラーになるので「データなし」扱い
- APIキーを使う機能（保有資産・取引履歴）は入れない方針。公開サイトにキーを置かない
- `sw.js` は通信できるときは常に最新を使う（ネットワーク優先）。ファイルを増やしたら `SHELL` の一覧に足す（無いファイルがあると install が失敗する）
- Lightweight Charts のバージョンを変えるときは `index.html` の `integrity` と `sw.js` の `LIB` も変える
- ブラウザペインでは Service Worker が登録できない（"An unknown error occurred when fetching the script"）。sw.js の動作は実際のブラウザで確認すること
