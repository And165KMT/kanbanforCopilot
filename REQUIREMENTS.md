# ROS2 Topic Viewer (VS Code Extension) — 要件定義（ドラフト）

## 1. 目的 / ゴール
- VS Code 上で ROS 2 のトピック一覧を確認し、選択したトピックの情報参照とメッセージ購読（表示）をできるようにする。
- ターミナルで `ros2 topic ...` を叩く手間を減らし、開発中のデバッグ確認を素早くする。

## 2. 想定ユーザー
- ROS 2 アプリ開発者（ノード/launch/メッセージ定義を VS Code で編集している人）

## 3. 対象環境
- VS Code: Stable（Windows）
- ROS 2: Windowsネイティブ環境にインストール済み（PowerShell で `ros2` が動作）
- 実装方針（最小）: `ros2` CLI を子プロセス実行して情報取得
  - 例: `ros2 topic list -t`, `ros2 topic info -v`, `ros2 topic echo`

> 注: DDS へ直接接続する方式（rcl/rmw バインディング）は初期MVPでは行わない。

## 4. スコープ（MVP）
### 4.1 できること（機能要件）
1) トピック一覧の表示
- コマンド: `ros2 topic list -t` 相当
- 表示項目: トピック名、型（type）
- 更新: 手動（Refresh コマンド）

2) トピック詳細の表示
- コマンド: `ros2 topic info -v <topic>` 相当
- 表示内容: publisher/subscriber 数、QoS（可能な範囲）、ノード名（取得できる範囲）

3) トピック購読（メッセージ表示）
- コマンド: `ros2 topic echo <topic>`
- 表示: 専用パネル（Webview）で表示（必須）
- 停止: Stop コマンドで子プロセスを終了

4) トピック統計の表示（必須）
- コマンド: `ros2 topic hz <topic>` / `ros2 topic bw <topic>` 相当
- 表示: 専用パネル内に要約（テキスト）として表示

5) 専用パネルでの「時系列波形」表示（必須）
- パネル: Webview（例: "ROS 2 Topic Panel"）
- 入力: `ros2 topic echo` の出力をストリームとして取り込み
- 波形: 受信時刻をX軸、数値系列をY軸にして折れ線表示
- 最小仕様:
  - メッセージから数値スカラー（int/float/bool など）を1つ選んで1系列として描画
  - 選択方法は「設定でフィールドパス指定」または「自動選択（最初に見つかった数値）」
  - 描画点数は上限を設け、リングバッファで保持（例: 500〜5000点）
  - 波形が作れない場合（数値が取れない等）は、同パネル内にテキスト表示へフォールバック

4) 接続・実行環境の選択（最小）
- 既定: ローカル環境の `ros2` を実行
- 設定: `ros2` 実行コマンドをユーザー設定で上書き可能（将来の拡張余地として残すが、MVPはWindowsネイティブを前提）

### 4.2 非目標（MVPではやらない）
- トピック publish（`ros2 topic pub`）
- bag 再生/録画
- メッセージを完全に構造化してツリー表示（MVPは波形+テキスト中心）
- 高度な可視化（複数系列の同時表示、統計の詳細グラフ、ズーム/パンなどの高機能）
- 自動更新（一定間隔ポーリング）
- launch / node 一覧ビュー

## 4.3 将来的な方向性（参考・非MVP）
- RViz のような統合可視化（3D/2D、TF、Marker 等）
- メッセージ型ごとの専用可視化（Image/LaserScan/PointCloud2 など）

## 5. UI/UX 要件（最小）
- Activity Bar / Explorer にビューを1つ追加: 「ROS 2 Topics」
  - ツリー: Topic ノード（`/foo/bar`）
  - 右クリックメニュー: `Echo`, `Info`, `Copy Topic Name`
- Command Palette:
  - `ROS2: Refresh Topics`
  - `ROS2: Show Topic Info`
  - `ROS2: Echo Topic`
  - `ROS2: Open Topic Panel`
  - `ROS2: Stop Echo`
  - `ROS2: Show Topic Hz`
  - `ROS2: Show Topic Bw`
- メッセージ表示先:
  - MVP: 専用パネル（Webview）

## 6. 設定（Settings）
- `ros2TopicViewer.ros2Command` (string)
  - 既定: `ros2`
  - 将来例: `wsl ros2`, `docker exec -i <container> ros2`
- `ros2TopicViewer.env` (object<string,string>)
  - `ROS_DOMAIN_ID` などを必要に応じて注入できる

- `ros2TopicViewer.waveform.fieldPath` (string)
  - 既定: 空（自動選択）
  - 例: `data` / `twist.linear.x` など
- `ros2TopicViewer.waveform.maxPoints` (number)
  - 既定: 2000（案）
- `ros2TopicViewer.waveform.throttleMs` (number)
  - 既定: 100（案）
  - 目的: 高レート時にUI描画が詰まらないよう間引く

## 7. エラーハンドリング要件
- `ros2` が見つからない/実行失敗時:
  - 通知（Warning）で「設定 `ros2Command` を確認」案内
  - Output に stderr を残す
- `ros2 daemon` 未起動などで情報が取れない場合:
  - 失敗を表示し、`ros2 daemon start` 相当の案内（実行はMVP外）
- Echo 実行中にビュー更新しても落ちない（プロセス管理を分離）

## 8. 非機能要件
- パフォーマンス: トピック一覧更新は 2秒以内を目標（環境依存は許容）
- 安定性: Echo 中断・再開でプロセスが残留しない
- セキュリティ: 取得したメッセージはローカル表示のみ（外部送信しない）

## 9. 受け入れ条件（Acceptance Criteria）
- `ROS2: Refresh Topics` でトピック一覧が表示される
- トピック選択→ `Show Topic Info` で詳細が表示される
- `Open Topic Panel` で専用パネルが開く
- `Echo Topic` で専用パネルにメッセージが流れ、数値フィールドが取れる場合は波形が更新される
- `Stop Echo` で購読が停止し、子プロセスが残留しない
- `Show Topic Hz` / `Show Topic Bw` で結果がパネル内に表示される

## 10. 未確定事項（要確認）
1) 波形にする「値」の決め方
- ✅ 決定: A. 設定 `waveform.fieldPath` でユーザーが明示指定（MVP必須）

2) 波形のX軸時刻
- ✅ 決定: B. メッセージのヘッダ時刻（`std_msgs/Header` 等）がある場合はそれを使用（無い場合は受信時刻にフォールバック）

3) hz/bw の表示スタイル
- ✅ 決定: A. コマンドの出力をそのまま表示（最小）

