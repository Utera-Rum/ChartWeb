# Changelog (ChartWeb)

## 0.2.0
- サポート／抵抗ライン（S/R）を追加: 見ている銘柄の日足1500本から、chartapp の毎朝の自動更新と同じ計算で線を選び、どの時間足のチャートにも引く（赤=重要なサポート／青=サポート／オレンジ=重要な抵抗／紫=抵抗）。「S/R」ボタンで切り替え、凡例は画面の下。銘柄ごとに6時間キャッシュ
- chartapp の `sr_lines.py` との一致テストを追加（tests/sr_fixture.json、実際の日足4銘柄を含む11ケース）

## 0.1.0
- 初版: bitbank のチャート（ローソク足・出来高・MA・ボリンジャー）、売買判定（chartapp と同じルール）、RSI/MACD/スコア、設定、15秒ごとの更新
- JS版の計算を chartapp(Python) と突き合わせるテスト（tests/parity.html）
- PWA（ホーム画面に追加できる）、GitHub Pages 公開用のワークフロー
