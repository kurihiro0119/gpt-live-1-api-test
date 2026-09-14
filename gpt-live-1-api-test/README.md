# GPT-Live-1 API lab

公式 WebRTC 経路で `gpt-live-1` を叩くローカル検証環境。

- 音声: `POST /v1/live/sessions` + WebRTC (`oai-events`)
- 委譲: Responses + `gpt-5.6-terra` + `web_search`
- 課金: 音声 $0.05/分（秒単位）。バックエンドは別途。WebRTC 初期化で 15 秒分が先行計上され、開始後に相殺される

## 起動

```bash
cp .env.example .env   # OPENAI_API_KEY を入れる
npm install
npm start
```

http://localhost:3000

Node 22.6+。マイクは localhost / HTTPS のみ。API key はサーバ側。

## 見るもの

| 試すこと | 確認ポイント |
|---|---|
| 割り込み | 発話中に被せる → assistant caption が止まり user が伸びる |
| 依頼変更 | 天気を東京→大阪 | `session.delegation.created` が再発火 |
| 検索委譲 | 「今日のニュースは？」 | 右ペインの nested `response.event` |
| 声の指示 | extra 欄 or 口頭 | 速度・トーン |
| 終了 | 終了ボタン | `session.closed` の `usage.seconds` |

イベント JSON は右上から保存できる。
