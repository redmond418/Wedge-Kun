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

### 4.1 Loop Phases

各 trigger について最大 10 iteration まで以下を繰り返す。

1. **Context build**
   - 現在日時
   - trigger message
   - core memory
   - 同一チャンネルの短期ログ
   - registry 最大 10 名
   - nest items
   - reply 元、添付、送信者、チャンネル情報
   - 直前 iteration の tool result
2. **LLM decision**
   - LLM は JSON オブジェクトのみを返す。
   - Markdown、コードフェンス、自然文の前置きは禁止。
3. **Action execution**
   - JSON の `actions` を順に実行する。
   - 実行結果やエラーを `cognition_steps` と短期ログへ保存する。
4. **Re-think**
   - `continue_loop=true` なら tool result を context に追加して再度 LLM に判断させる。
   - `continue_loop=false` なら終了する。

### 4.2 LLM Output Schema

LLM の出力は Zod schema `src/wedge/cognition-schema.ts` で検証する。最低限以下を含む。

```json
{
  "thought_summary": "保存してよい短い判断要約",
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

JSON parse に失敗した場合は 1 回だけ repair prompt を投げる。それでも失敗した場合は、安全な fallback action を返し、プロセスを落とさない。

### 4.3 Action Model

最終 action は Discord 投稿に限定しない。v1 で扱う action は以下。

- `discord_send_message`
- `discord_add_reaction`
- `nest_stash`
- `nest_update`
- `nest_look`
- `update_user_profile`
- `fetch_user_recent_logs`
- `fetch_user_avatar_context`
- `write_core_memory`
- `none`

ファイル操作やターミナル操作は schema と拒否ログから始め、実行時は Windows user directory 配下の path guard を必ず通す。

## 5. Triage, Offering, Boredom

トリアージ、供物満足度、同一話題判定、飽き判定は、原則 LLM の構造化判断に寄せる。ルールベースで固定文を返さない。

- 頼みごとには `request_level` を 0 から 10 で見積もる。
- 雑談、短い説明、短い創作、呼び名をつける程度の軽い依頼は低から中程度に見積もる。実行を避けるために `request_level` を不自然に高くしない。
- 供物は `offering` に構造化する。受け取る場合は `nest_stash` で巣へ保存する。
- 供物が依頼の対価として十分なら、巣に保存したうえで依頼を実行する。
- 供物不足で block する場合も、LLM が `discord_send_message` または `discord_add_reaction` を生成する。
- 同じユーザー、同じ話題で 3 往復相当続く場合のみ bored を検討する。
- 5分経過、別話題、供物提示で bored は解除する。
- 人間との自然会話や別話題では、安易に bored にしない。

## 6. Storage Schema

SQLite は prepared statement のみで操作する。

### users

- `id`
- `guild_id`
- `name`: Discord 表示名
- `call_sign`
- `details`: 自然言語での性格、特徴、呼び名、関係性
- `is_bot`
- `updated_at`

### channels

- `id`
- `guild_id`
- `name`
- `purpose`
- `updated_at`

### short_term_logs

短期ログは、除外対象以外のすべての会話と action を時系列保存する。

- `timestamp`
- `message_id`
- `kind`
- `content`
- `author`: name, id, bot flag
- `channel`: name, id, guild id
- `reply_to_message_id`
- `reply_to_user_id`
- `attachments_json`
- `metadata_json`

### core_memory

コアメモリは生ログの連結ではなく、重要で継続的に覚えるべき情報だけを保存する。

### nest_items

巣のアイテムは以下で管理する。

- `id`
- `name`
- `created_at`
- `updated_at`
- `quantity`
- `notes`

ID と timestamp 以外は LLM が「何であるか」「どの文脈でもらったか」を判断する。

### cognition_runs / cognition_steps

各 cognition loop の prompt、LLM JSON、action、tool result、エラーを保存し、デバッグ可能にする。

## 7. Prompt Files

Prompt はコード直書きにしない。

- `src/wedge/prompts/persona.md`
- `src/wedge/prompts/cognition-system.md`

Prompt builder は以下の構造で組み立てる。

- `[persona]`
- `[rules]`
- `[context_json]`
- `[available_actions]`
- `[output_schema]`

## 8. Memory Batch

AM 4:00 の記憶整理バッチは短期ログを LLM に渡し、重要情報だけを core memory、users.details、channels.purpose、nest item notes へ統合する。成功時のみ古い短期ログを削除する。失敗時はログを残し、次回再試行する。

起動時には未実行分を検出し、recovery batch を走らせる。

## 9. Admin And Debug

Discord 管理コマンドは `config/admin_users.json` の user id のみ許可する。

- `!wedge_sleep <分>`
- `!wedge_reset`

CLI は最低限以下をサポートする。

- `show_core_memory`
- `show_registry <id>`
- `force_memory_batch`
- `dump_nest`
- `local_chat <channel> <user> <text>`

LLM 入出力、JSON decision、action、tool result、最終 Discord 送信内容はデバッグログに出す。`WEDGE_DEBUG_LLM=0` で LLM 詳細ログを抑制できる。
