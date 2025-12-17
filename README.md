# ROS 2 Topic Viewer (VS Code Extension)

ROS 2 の `ros2 topic` を VS Code 内で使いやすくするための拡張（開発中）です。

## いま動いている機能（現状）
- Explorer に「ROS 2 Topics」ビューを追加
- `ROS2: Refresh Topics` で `ros2 topic list -t` を実行
- `ROS2: Diagnostics (Check CLI)` で実行環境の確認

## 開発（ビルド・実行）
- 依存導入: `npm install`
- ビルド: `npm run compile`
- 実行: VS Code の「Run Extension」(Extension Development Host)

## 重要: `ros2` が見つからない場合
Extension Host から `ros2` が見えないと、Topics 一覧は出ません。
その場合は、以下どちらかの方式にしてください。

---

## 方式A（推奨・開発向け）: Dev Containers で拡張をコンテナ内で動かす
VS Code の Dev Containers（Remote - Containers）でこのリポジトリを開き、Extension Development Host もコンテナ側で起動します。
- メリット: `ros2` がそのまま動く（PATH/環境の問題が激減）
- デメリット: ユーザー配布時の利用形態とは別物になりうる

この方式なら設定は基本不要で、`ros2` が PATH に入っていれば動きます。

---

## 方式B: ホスト（Windows）から `docker exec` で ROS2 コンテナを叩く
拡張は Windows 側で動かし、`ros2` をコンテナ内で実行します。

### 設定例
VS Code の設定（ユーザー設定 or ワークスペース設定）で `ros2TopicViewer.commandTemplate` を設定します。

この拡張は `commandTemplate` 内で `${container}`（選択中のコンテナ名）を使えます。
コンテナ名は `ROS2: Select Docker Container` コマンドで「起動中のコンテナ」から選べます。

例（Humble、コンテナ名: `ros2_humble`）:

```json
{
  "ros2TopicViewer.commandTemplate": "docker exec -i ${container} bash -lc 'source /opt/ros/humble/setup.bash && ros2 ${args}'"
}
```

Docker/WSL 経由の出力は通常 UTF-8 なので、必要なら以下も設定します（既定 auto でも大抵OK）:

```json
{
  "ros2TopicViewer.outputEncoding": "utf8"
}
```

ワークスペース overlay を source したい場合の例:

```json
{
  "ros2TopicViewer.commandTemplate": "docker exec -i ros2_humble bash -lc 'source /opt/ros/humble/setup.bash && source /workspaces/ws/install/setup.bash && ros2 ${args}'"
}
```

### docker-compose の場合（別コンテナ構成）
`ros2` を叩く先は「ROS グラフに参加しているサービス（コンテナ）」にしてください。
`docker compose exec` を使う例（service名: `ros_tools`）:

```json
{
  "ros2TopicViewer.commandTemplate": "docker compose exec -T ros_tools bash -lc 'source /opt/ros/humble/setup.bash && ros2 ${args}'",
  "ros2TopicViewer.outputEncoding": "utf8"
}
```

別コンテナでノードを動かす場合は、compose の同一ネットワーク上で discovery できる必要があります。
そのうえで、必要なら RMW や Domain を揃えます（拡張が `ros2` を実行する際に注入されます）:

```json
{
  "ros2TopicViewer.rosDomainId": 0,
  "ros2TopicViewer.rmwImplementation": "rmw_cyclonedds_cpp"
}
```

### 注意
- Windows の Docker ではネットワーク制約により、ホスト↔コンテナ間で DDS が期待通りに見えないことがあります。
  - ただし「ノードも全部コンテナ内」で完結していれば、拡張は `docker exec` で問題なく topics を取得できます。

---

## トラブルシューティング
1) まず `ROS2: Diagnostics (Check CLI)` を実行
- Output の `ros2 --help exit=0` になれば OK

2) `ros2` が見つからない（exit=1 / "'ros2' は認識されていません"）
- 方式A or 方式B を選んで設定

3) 文字化け
- 日本語 Windows の場合は cp932 を考慮してデコードするよう対応済み（Diagnostics が読めるはず）
