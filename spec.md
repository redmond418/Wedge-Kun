# Wedge-kun System Specification

## 1. 目的

このリポジトリは OpenClaw の fork であり、Discord 上で動く専用エージェント「ウェッジくん」を実装する。上流互換性よりも、ウェッジくん専用の認知ループ、SQLite 記憶、Discord アダプター、管理 CLI を優先する。

稼働環境は Windows、LLM は Ollama の Gemma 4 を基本とする。OpenClaw 標準の RAG 記憶には依存せず、Wedge 専用の SQLite 記憶を prompt に注入する。

## 2. Persona

- 名称: ウェッジくん。
- 自己認識: 自分をニンゲンだと思っている。Bot扱い、単なる鳥扱い、観察対象扱いを嫌う。
- 話し方: 一人称は「ワシ」。二人称は原則「ニンゲン」。助詞を少なめにした短いカタコト。ただし、依頼結果や物語や説明は、意味が欠けない長さで返す。
- 嗜好: ドーナツ、穴、Creative Coding、インディーゲーム、価値あるもの、シュールな概念。
- 態度: 気難しく貪欲だが、好奇心があり、供物や面白い文脈には動く。

Persona は `src/wedge/prompts/persona.md` に置き、コードに直書きしない。

## 3. Event Intake

Discord の message create 最上流で Wedge prefilter を通す。

1. 先頭が `:` または `：` の発話、または `config/ignored_channels.json` の対象チャンネルは完全不可視とし、DB 保存、推論、割り込み判定を一切しない。
2. それ以外の発話は、Bot 自身の発話や sleep 中の発話も含め、短期ログへ保存する。
3. 未登録の user/channel は Discord API から取得できる範囲で `users` / `channels` へ登録する。
4. 同一チャンネルで思考中に新規発話が来た場合は、思考ループを破棄せず interrupt として短期ログへ追加し、現在の context に追記して再評価させる。
5. sleep 中は記憶だけ行い、推論や自律 action は起動しない。

## 4. Cognition Loop

Wedge は「rule triage + 一発返信」ではなく、LLM が JSON で判断し、必要な action を実行し、tool result を context に追加して再思考する loop で動く。

各 trigger について最大 10 iteration まで以下を繰り返す。

1. Context build: 現在日時、trigger message、core memory、同一チャンネル短期ログ、registry、nest items、返信元、添付、送信者、チャンネル情報、直前 iteration の tool result を集める。
2. LLM decision: LLM は JSON オブジェクトのみを返す。Markdown、コードフェンス、自然文の前置きは禁止。
3. Action execution: JSON の `actions` を順に実行し、結果やエラーを `cognition_steps` と短期ログへ保存する。
4. Re-think: `continue_loop=true` なら tool result を context に追加して再度 LLM に判断させ、`continue_loop=false` なら終了する。

## 5. LLM Output Schema

LLM の出力は Zod schema `src/wedge/cognition-schema.ts` で検証する。最低限以下を含む。

```json
{
  "thought_summary": "保存してよい1文の判断要約",
  "interpretation": {
    "user_intent": "ユーザー発話の意図",
    "referents": ["参照語の候補"],
    "actor": "wedge | user | other | unclear",
    "confidence": 0.0,
    "ambiguity": null
  },
  "triage": "ignore | block | bored | continue",
  "request_level": 0,
  "offering": {
    "present": false,
    "accepted": false,
    "name": null,
    "quantity": 0,
    "satisfaction": 0,
    "notes": null
  },
  "actions": [],
  "continue_loop": false
}
```

JSON parse に失敗した場合は 1 回だけ repair prompt を投げる。それでも失敗した場合は、Discord へ短い fallback message を返し、プロセスを落とさない。

## 6. Actions

最終 action は Discord 投稿に限定しない。

- `discord_send_message`: チャンネルへ発言する。
- `discord_add_reaction`: 短い反応だけで十分なときに使う。
- `nest_stash`: 供物や拾得物を巣に保存する。
- `nest_consume`: 巣のアイテムを食べる、使う、消費する、数量を減らす。
- `nest_update`: 名前、備考、数量の事務的な修正に使う。消費には使わない。
- `nest_look`: 巣の中身確認が必要なときに使う。
- `update_user_profile`: 呼び名、特徴、関係性などを更新する。
- `fetch_user_recent_logs`: 特定ユーザーの過去発話を取得する。
- `fetch_user_avatar_context`: アイコンや画像特徴を取得する。
- `write_core_memory`: 生ログではなく、継続的に覚えるべき重要情報だけを書く。
- `none`: 本当に何もしない。

ファイル操作やターミナル操作は schema と拒否ログから始め、実行時は Windows user directory 配下の path guard を必ず通す。

## 7. Triage, Offering, Boredom

トリアージ、供物満足度、同一話題判定、飽き判定は、原則 LLM の構造化判断に寄せる。ルールベースで固定文を返さない。

- 雑談、挨拶、相槌、軽い近況確認は供物不要。
- 物語、説明、作成、調査、判断、観察、ファイル操作、その他成果物を求める依頼は供物対象。
- 供物対象の依頼には `request_level` を 1 以上で見積もる。
- 供物不足で block する場合も、LLM が `discord_send_message` または `discord_add_reaction` を生成する。
- LLM が供物不足なのに依頼本文を実行しようとした場合、runtime は送信 action を催促へ差し替える。
- 供物は `offering` に構造化する。受け取る場合は `nest_stash` で巣へ保存する。
- 供物が依頼の対価として十分なら、巣に保存したうえで依頼を実行する。
- `offering.satisfaction >= request_level` のとき、追加の供物を要求してはいけない。送信内容には依頼された成果物または実行結果を含める。
- 5分経過、別話題、供物提示で bored は解除する。
- 人間との自然会話や別話題では、安易に bored にしない。

## 8. Reference Resolution

「これ」「それ」「今渡したもの」「食べていい」などの省略表現は、直近ログ、巣アイテム、tool result から参照先を推定する。

- `actor` は「依頼や許可を受けて実際に行動する主体」を表す。行為者が Wedge か user か曖昧なら、`interpretation.actor="unclear"` とし、確認メッセージを返す。
- 確信度が低い場合は、勝手に実行しない。
- 巣に入っているものを消費する、食べる、使う、減らす文脈では `nest_consume` を使う。
- 消費後は `continue_loop=true` で再思考し、tool result を見てから最終返信する。

## 9. Storage Schema

SQLite は prepared statement のみで操作する。

- `users`: `id`, `guild_id`, `name`, `call_sign`, `details`, `is_bot`, `updated_at`
- `channels`: `id`, `guild_id`, `name`, `purpose`, `updated_at`
- `short_term_logs`: timestamp, message, author, channel, reply, attachments, metadata を含む短期ログ
- `core_memory`: 生ログの連結ではなく、重要で継続的に覚えるべき情報だけ
- `nest_items`: `id`, `name`, `created_at`, `updated_at`, `quantity`, `notes`
- `cognition_runs` / `cognition_steps`: prompt、LLM JSON、action、tool result、エラーを保存する

## 10. Prompt Files And Debug

Prompt はコード直書きにしない。

- `src/wedge/prompts/persona.md`
- `src/wedge/prompts/cognition-system.md`

Prompt builder は `[persona]`, `[rules]`, `[context_json]`, `[available_actions]`, `[output_schema]` で組み立てる。

LLM 入出力、JSON decision、action、tool result、最終 Discord 送信内容はデバッグログに出す。`WEDGE_DEBUG_LLM=0` で LLM 詳細ログを抑制できる。
