# Kanban to Copilot

A lightweight Kanban board for VS Code with JSON persistence, plus one-click “Copy as Markdown” so you can paste a task into Copilot/Chat.

## Features
- Drag & drop tasks across columns and within a column
- Store board data in a JSON file inside your workspace
- Edit columns (add / rename / reorder)
- Task fields: title, goal, acceptance criteria, notes, status, priority, difficulty, branch type
- Search (press Enter to apply; Esc to clear)
- External edits win: if the JSON file changes, the webview reloads from disk

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
- Tools: `board_get`, `tasks_list`, `task_add`, `task_update`, `task_move`, `task_delete`, `column_reorder`, `columns_update`, `board_normalize`, `azure_devops_import_assigned_to_me`

### Azure DevOps import (PAT)

The MCP server can import Azure DevOps work items assigned to the PAT owner (`@Me`) and add them as Kanbanto tasks.

1) Create a `.env` file in the workspace folder (this repo ignores it via `.gitignore`)
Use the template [.env.example](.env.example).

Required variables:
- `AZDO_ORG_URL` e.g. `https://dev.azure.com/YourOrg`
- `AZDO_PROJECT` e.g. `YourProject`
- `AZDO_PAT` a PAT with at least **Work Items (read)**

2) Call the MCP tool
- Tool: `azure_devops_import_assigned_to_me`
- Defaults read from `.env`.
- Imported tasks include an `ADO#12345` marker in `notes` so re-import can skip duplicates.

### Configure MCP (so Copilot can manage tasks)

Important: installing the VSIX only installs the VS Code extension. The MCP server is a separate Node.js process, so you must provide it and register it.

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
