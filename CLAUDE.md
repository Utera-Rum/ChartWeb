# ChartWeb（chartapp のスマホ向けWeb版）

bitbank のチャートと売買判定を見る静的サイト（ビルドなし・サーバーなし）。ユーザー(Rum)には日本語で答える。
PC用の chartapp（`Z:\UlteraProjects\chartapp`）の判定ロジックを JavaScript に移したもの。

## 構成
- `web/` … 公開する静的ファイルだけ。`app.js`(画面) / `indicators.js` / `signals.js` / `datafeed.js` / `sw.js`
- `tests/parity.html` … ブラウザで開く。`PARITY OK` がタイトルに出れば合格。JS版の計算が chartapp(Python)版と一致するか＋datafeed の部品
- `tests/make_fixture.py` … chartapp の indicators.py / signals.py で正解データ `fixture.json` を作る（chartapp の `.venv` の python で実行）

## 動かす・試す
- `cd web && python -m http.server 8765` → http://localhost:8765/
- テスト: リポジトリ直下で `python -m http.server 8766` → http://localhost:8766/tests/parity.html
- Nodeは入っていない。確認はブラウザ（Claudeのブラウザペイン）で行う。スマホ幅は `resize_window` の mobile。ペインが隠れていると `document.hidden` になり定期更新が止まる

## 注意
- `indicators.js` / `signals.js` は chartapp の `indicators.py` / `signals.py` と同じ結果にする。**どちらかを変えたら、もう片方と `make_fixture.py` → `parity.html` で一致を確かめる**
- Lightweight Charts の `series.update()` は「最新の足」以降にしか使えない（古い足を渡すと "Cannot update oldest data"）。取り直しは `changedFrom()` で、最新の足の変化・追加だけなら update、それ以外は setData
- チャートの時間軸はUTC表示。日本時間に見せるため時刻に +9時間している（`app.js` の JST）。データ側の時刻はUTC秒のまま
- bitbank のローソク足APIの日付キーは1時間足以下=YYYYMMDD、4時間足以上=YYYY。古い日付・上場前の年は空かエラーになるので「データなし」扱い
- APIキーを使う機能（保有資産・取引履歴）は入れない方針。公開サイトにキーを置かない
- `sw.js` は通信できるときは常に最新を使う（ネットワーク優先）。ファイルを増やしたら `SHELL` の一覧に足す（無いファイルがあると install が失敗する）
- Lightweight Charts のバージョンを変えるときは `index.html` の `integrity` と `sw.js` の `LIB` も変える
- ブラウザペインでは Service Worker が登録できない（"An unknown error occurred when fetching the script"）。sw.js の動作は実際のブラウザで確認すること
