# kanbanto-mcp

An MCP (Model Context Protocol) server (stdio) for Kanban to Copilot.

## Tools
- Get board: `board_get`
- List tasks: `tasks_list`
- Add task: `task_add`
- Update task: `task_update`
- Move task: `task_move`
- Delete task: `task_delete`
- Apply in-column reorder: `column_reorder`
- Update columns: `columns_update`
- Normalize board: `board_normalize`

## Target file
By default, this server reads/writes `.kanbanto/tasks.json` under the workspace folder.

Configure the workspace folder:
- `--workspace=...` or env `KANBANTO_WORKSPACE`

Configure the board file path (relative to the workspace folder):
- `--board=...` or env `KANBANTO_BOARD_PATH`

Defaults:
- Workspace: `process.cwd()`
- Board file: `.kanbanto/tasks.json`

## Development
```bash
cd mcp/kanbanto-mcp
npm install
npm run build
```

## Manual run (debug)
Because MCP uses stdio, running it directly is not very human-friendly. Prefer verifying build output.

```bash
npm run build
node dist/server.js --workspace="C:\\path\\to\\workspace" --board=".kanbanto\\tasks.json"
```
