# Kanban for Copilot

A lightweight Kanban board for VS Code with JSON persistence, plus one-click “Copy as Markdown” so you can paste a task into Copilot/Chat.

## License / 利用条件
Non-commercial use only. Commercial use is prohibited. See [LICENSE](LICENSE).
（商用利用は禁止です）

## Disclaimer
This is an unofficial project and is not affiliated with Microsoft.

## Features
- Drag & drop tasks across columns and within a column
- Store board data in a JSON file inside your workspace
- Edit columns (add / rename / reorder)
- Task fields: title, goal, acceptance criteria, notes, status, priority, difficulty, branch type
- One-click “Copy Markdown” per task (clipboard)
- Search (press Enter to apply; Esc to clear)
- External edits win: if the JSON file changes, the webview reloads from disk

## Usage
- Open from the Activity Bar: **Task board**
- Or run commands from the Command Palette:
  - `Kanban: Open Task board`
  - `Kanban: Open Task board (Floating)`
- Copy a task as Markdown: click **Copy Markdown** on the task

Note: Settings and data files use the internal id `kanbanto` (e.g. `.kanbanto/tasks.json`, `kanbanto.*`).

## Data file
By default the board is stored at `.kanbanto/tasks.json` under your workspace folder.

The file format looks like:

```json
{
  "version": 1,
  "columns": ["Backlog", "To Do", "In Progress", "Review", "Done"],
  "tasks": [
    {
      "id": "81c8c67c",
      "title": "Export JSON",
      "goal": "Write the JSON file",
      "acceptanceCriteria": ["The file is created successfully"],
      "notes": "",
      "status": "Review",
      "priority": 5,
      "difficulty": 3,
      "branchType": "feature",
      "order": 0,
      "updatedAt": "2025-12-15T00:00:00.000Z"
    }
  ]
}
```

Notes:
- `order` is persisted as a single 0..n sequence across the whole board.
- If a task has an unknown `status`, it is normalized to the first column.

## Settings
- `kanbanto.workspacePath`: Absolute folder path to read/write. If empty, uses the currently opened workspace folder.
- `kanbanto.boardFileRelativePath`: Relative path to the board JSON under `workspacePath`. Default: `.kanbanto/tasks.json`.

## MCP server (optional)
This repo includes an MCP (Model Context Protocol) server so tools can directly read/write the same board file.

- Project: [mcp/kanbanto-mcp](mcp/kanbanto-mcp)
- Tools: `board_get`, `tasks_list`, `task_add`, `task_update`, `task_move`, `task_delete`, `column_reorder`, `columns_update`, `board_normalize`

### Configure MCP (so Copilot can manage tasks)

Prereqs: VS Code + Copilot Chat with MCP support (uses `.vscode/mcp.json`).

Important: the MCP server runs as a separate process. This extension can generate the needed `.vscode/mcp.json` for you, or you can register a server manually.

#### Option A (recommended): one-command setup from the extension
1) Install the extension (VSIX / Marketplace).
2) Open the workspace you want Copilot to operate on.
3) Run the command: `Kanban: Enable Copilot MCP Tools`

This will create/update `.vscode/mcp.json` for the current workspace. The MCP server executable is bundled with the extension; you do not need to copy the `mcp/` folder into your workspace. If Node.js cannot be found, install Node.js or set `kanbanto.nodePath`.
Note: the generated config uses absolute paths; if you move the workspace to another machine, run the command again.

#### Option B: manual setup (advanced / custom location)
1) Get the MCP server code
- Either clone this repo, or copy the folder [mcp/kanbanto-mcp](mcp/kanbanto-mcp) into the workspace where you want to use the board.

2) Build the MCP server
```bash
cd mcp/kanbanto-mcp
npm install
npm run build
```

3) Register the server in your workspace
Create/edit [.vscode/mcp.json](.vscode/mcp.json) in the workspace you want Copilot to operate on.

Example:
```jsonc
{
  "servers": {
    "kanbanto": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/mcp/kanbanto-mcp/dist/server.js"],
      "env": {
        "KANBANTO_WORKSPACE": "${workspaceFolder}",
        "KANBANTO_BOARD_PATH": ".kanbanto/tasks.json"
      }
    }
  }
}
```

Notes:
- If you placed the MCP server somewhere else, change `args` to the correct `dist/server.js` path.
- If `command: "node"` fails with `spawn node ENOENT`, use an absolute Node path (or run `Kanban: Enable Copilot MCP Tools` to generate a working config automatically).
- Set `KANBANTO_BOARD_PATH` to match the extension setting `kanbanto.boardFileRelativePath`.

## Development
```bash
npm install
npm run build
```

## Let others try it

### Option A: Run from source (recommended for quick testing)
1. Clone this repo.
2. Open the repo folder in VS Code.
3. Run `npm install` and `npm run build`.
4. Press `F5` to start an Extension Development Host.
5. In the new VS Code window, open the Command Palette and run:
  - `Kanban: Open Task board`

### Option B: Share a VSIX (recommended for non-dev users)
Create a VSIX package:

```bash
npm install
npm run build
npx @vscode/vsce package
```

This produces a `.vsix` file in the project root. Share that file.

Install the VSIX on another machine:
1. Open VS Code.
2. Go to Extensions.
3. Click `...` (More Actions) → `Install from VSIX...`.
4. Select the `.vsix`.

After installation, run `Kanban: Open Task board` from the Command Palette.

MCP:
```bash
cd mcp/kanbanto-mcp
npm install
npm run build
```
