import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BoardStore } from './boardStore';
import type { BoardFile, Task } from './types';

type WebviewToExtMessage =
  | { type: 'ready' }
  | { type: 'addTask'; task: { title: string; status: string; priority: number; difficulty?: number; branchType?: string; goal?: string; acceptanceCriteria?: string[]; notes?: string } }
  | { type: 'updateTask'; id: string; patch: Partial<Omit<Task, 'id' | 'createdAt'>> }
  | { type: 'deleteTask'; id: string }
  | { type: 'moveTask'; id: string; status: string; index: number }
  | { type: 'reorderWithinColumn'; status: string; orderedIds: string[] }
  | { type: 'copyTaskMarkdown'; id: string; markdown?: string }
  | { type: 'notify'; level?: 'info' | 'warning' | 'error'; message: string }
  | { type: 'openUrl'; url: string }
  | { type: 'editColumns' };

const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Kanbanto');
  output.appendLine('activate');

  const provider = new TaskBoardViewProvider(context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TaskBoardViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  output.appendLine(`registered WebviewViewProvider: ${TaskBoardViewProvider.viewType}`);

  context.subscriptions.push(
    vscode.commands.registerCommand('kanbanto.openBoard', async () => {
      output.appendLine('command: kanbanto.openBoard');
      await vscode.commands.executeCommand('workbench.view.extension.kanbanto');
      await vscode.commands.executeCommand('kanbanto.boardView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kanbanto.openBoardFloating', async () => {
      output.appendLine('command: kanbanto.openBoardFloating');
      provider.openFloatingPanel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kanbanto.setupMcp', async () => {
      output.appendLine('command: kanbanto.setupMcp');
      await setupMcpForWorkspace(context);
    })
  );

  if (vscode.workspace.getConfiguration('kanbanto').get<boolean>('mcpAutoPrompt', true)) {
    void maybePromptMcpSetup(context, output);
  }
}

function getConfiguredWorkspaceRootUri(output?: vscode.OutputChannel): vscode.Uri | undefined {
  const configuredPath = vscode.workspace.getConfiguration('kanbanto').get('workspacePath', '').trim();
  const folder = vscode.workspace.workspaceFolders?.[0];
  const rootUri = configuredPath ? vscode.Uri.file(configuredPath) : folder?.uri;
  if (!rootUri) output?.appendLine('mcp: no workspace folder (and no kanbanto.workspacePath)');
  return rootUri;
}

async function fileExists(fsPath: string): Promise<boolean> {
  try {
    await fs.stat(fsPath);
    return true;
  } catch {
    return false;
  }
}

async function isNodeExecutable(command: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(command, ['-p', 'process.versions.node'], { timeout: 2500 });
    return /^\d+\.\d+\.\d+/.test(String(stdout ?? '').trim());
  } catch {
    return false;
  }
}

async function resolveNvmNode(workspaceRootFsPath: string): Promise<string | undefined> {
  const nvmDir = process.env.NVM_DIR?.trim() || path.join(os.homedir(), '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  if (!(await fileExists(versionsDir))) return undefined;

  let preferredVersion = '';
  try {
    const nvmrc = await fs.readFile(path.join(workspaceRootFsPath, '.nvmrc'), 'utf8');
    preferredVersion = nvmrc.trim().replace(/^v/, '');
  } catch {
    // ignore
  }

  if (preferredVersion) {
    const preferred = path.join(versionsDir, `v${preferredVersion}`, 'bin', 'node');
    if (await fileExists(preferred)) return preferred;
  }

  let entries: string[] = [];
  try {
    entries = await fs.readdir(versionsDir);
  } catch {
    return undefined;
  }
  const versions = entries.filter((e) => /^v?\d+\.\d+\.\d+/.test(e)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = versions[versions.length - 1];
  if (!latest) return undefined;

  const candidate = path.join(versionsDir, latest.startsWith('v') ? latest : `v${latest}`, 'bin', 'node');
  return (await fileExists(candidate)) ? candidate : undefined;
}

async function resolveNodeCommand(workspaceRootFsPath: string): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('kanbanto').get('nodePath', '').trim();
  const candidates: string[] = [];
  if (configured) candidates.push(configured);

  if (process.execPath) candidates.push(process.execPath);
  candidates.push('node');

  if (process.platform === 'win32') {
    const nvmSymlink = process.env.NVM_SYMLINK?.trim();
    if (nvmSymlink) candidates.push(path.join(nvmSymlink, 'node.exe'));
    candidates.push(
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'nodejs', 'node.exe')
    );
  } else {
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
    const nvmNode = await resolveNvmNode(workspaceRootFsPath);
    if (nvmNode) candidates.push(nvmNode);
  }

  const seen = new Set<string>();
  for (const c of candidates.map((s) => s.trim()).filter(Boolean)) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (await isNodeExecutable(c)) return c;
  }

  return undefined;
}

async function readJsonFile(uri: vscode.Uri): Promise<any | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(uri: vscode.Uri, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

async function setupMcpForWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const rootUri = getConfiguredWorkspaceRootUri();
  if (!rootUri) {
    void vscode.window.showErrorMessage('No workspace folder is open (and kanbanto.workspacePath is empty).');
    return;
  }

  const boardFileRelativePathRaw = vscode.workspace
    .getConfiguration('kanbanto')
    .get('boardFileRelativePath', '.kanbanto/tasks.json')
    .trim();
  const boardFileRelativePath = (boardFileRelativePathRaw || '.kanbanto/tasks.json').replace(/\\/g, '/');

  const serverJsPath = context.asAbsolutePath(path.join('mcp', 'kanbanto-mcp', 'dist', 'server.js'));
  if (!(await fileExists(serverJsPath))) {
    void vscode.window.showErrorMessage(
      `Bundled MCP server not found: ${serverJsPath}\n` +
        'If you are developing from source, run `npm run build:mcp` and rebuild the extension.'
    );
    return;
  }

  const nodeCommand = await resolveNodeCommand(rootUri.fsPath);
  if (!nodeCommand) {
    void vscode.window.showErrorMessage(
      'Node.js not found. Install Node.js or set the setting `kanbanto.nodePath` to an absolute Node executable path.'
    );
    return;
  }

  const vscodeDir = vscode.Uri.joinPath(rootUri, '.vscode');
  const mcpJsonUri = vscode.Uri.joinPath(vscodeDir, 'mcp.json');
  await vscode.workspace.fs.createDirectory(vscodeDir);

  const current = (await readJsonFile(mcpJsonUri)) ?? {};
  const servers = (current.servers ?? {}) as Record<string, any>;
  servers.kanbanto = {
    type: 'stdio',
    command: nodeCommand,
    args: [serverJsPath],
    env: {
      KANBANTO_WORKSPACE: rootUri.fsPath,
      KANBANTO_BOARD_PATH: boardFileRelativePath
    }
  };

  await writeJsonFile(mcpJsonUri, { ...current, servers });

  const pick = await vscode.window.showInformationMessage(
    'Kanbanto MCP tools configured in .vscode/mcp.json. Reload VS Code to apply?',
    'Reload Window'
  );
  if (pick === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function maybePromptMcpSetup(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const rootUri = getConfiguredWorkspaceRootUri(output);
  if (!rootUri) return;

  const promptKey = `kanbanto.mcpPrompted:${rootUri.fsPath}`;
  if (context.workspaceState.get<boolean>(promptKey, false)) return;

  const mcpJsonUri = vscode.Uri.joinPath(rootUri, '.vscode', 'mcp.json');
  const current = await readJsonFile(mcpJsonUri);
  const server = current?.servers?.kanbanto as any | undefined;

  const needsSetup = async (): Promise<boolean> => {
    if (!server) return true;
    if (typeof server.command !== 'string' || !server.command.trim()) return true;
    if (!Array.isArray(server.args) || typeof server.args[0] !== 'string' || !server.args[0]) return true;
    if (!(await isNodeExecutable(server.command))) return true;
    if (!(await fileExists(server.args[0]))) return true;
    return false;
  };

  if (!(await needsSetup())) {
    await context.workspaceState.update(promptKey, true);
    return;
  }

  const pick = await vscode.window.showInformationMessage(
    'Enable Kanbanto Copilot MCP tools for this workspace?',
    'Enable',
    'Not now',
    "Don't ask again"
  );

  if (pick === "Don't ask again") {
    await context.workspaceState.update(promptKey, true);
    return;
  }
  if (pick === 'Enable') {
    await context.workspaceState.update(promptKey, true);
    await setupMcpForWorkspace(context);
  }
}

class TaskBoardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'kanbanto.boardView';

  private view?: vscode.WebviewView;
  private readonly webviews = new Set<vscode.Webview>();
  private panel?: vscode.WebviewPanel;
  private store?: BoardStore;
  private board?: BoardFile;
  private watcher?: vscode.FileSystemWatcher;
  private workspaceListener?: vscode.Disposable;
  private reloadDebounceTimer?: NodeJS.Timeout;
  private reloadInProgress = false;
  private reloadPending = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  openFloatingPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'kanbanto.taskBoardPanel',
      'Task board',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist')
        ]
      }
    );

    this.panel = panel;
    panel.webview.html = this.getHtml(panel.webview);
    this.registerWebview(panel.webview, panel.onDidDispose(() => {
      this.webviews.delete(panel.webview);
      this.panel = undefined;
    }));

    void this.ensureStoreAndLoad();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.output.appendLine('resolveWebviewView');

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist')
      ]
    };

    view.webview.html = this.getHtml(view.webview);

    this.registerWebview(view.webview, view.onDidDispose(() => {
      this.webviews.delete(view.webview);
      if (this.view === view) this.view = undefined;
    }));

    // If the extension host starts with an empty window, ensure the view
    // updates when a folder is opened later (avoid staying in no-workspace state).
    this.workspaceListener?.dispose();
    this.workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void this.ensureStoreAndLoad();
    });
    this.context.subscriptions.push(this.workspaceListener);

    void this.ensureStoreAndLoad();
  }

  private registerWebview(webview: vscode.Webview, disposeHook: vscode.Disposable): void {
    this.webviews.add(webview);
    this.context.subscriptions.push(disposeHook);

    const sub = webview.onDidReceiveMessage(async (msg: WebviewToExtMessage) => {
      try {
        await this.onMessage(msg);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(message);
      }
    });
    this.context.subscriptions.push(sub);
  }

  private async ensureStoreAndLoad(): Promise<void> {
    const configuredPath = vscode.workspace.getConfiguration('kanbanto').get('workspacePath', '').trim();
    const boardFileRelativePathRaw = vscode.workspace
      .getConfiguration('kanbanto')
      .get('boardFileRelativePath', '.kanbanto/tasks.json')
      .trim();
    const boardFileRelativePath = (boardFileRelativePathRaw || '.kanbanto/tasks.json').replace(/\\/g, '/');
    const folder = vscode.workspace.workspaceFolders?.[0];

    const rootUri = configuredPath
      ? vscode.Uri.file(configuredPath)
      : folder?.uri;

    if (!rootUri) {
      this.output.appendLine('ensureStoreAndLoad: no workspace folder (and no kanbanto.workspacePath)');
      this.post({ type: 'state', state: { kind: 'no-workspace' } });
      return;
    }

    this.output.appendLine(`ensureStoreAndLoad: root=${rootUri.fsPath}`);

    this.store = new BoardStore(rootUri, boardFileRelativePath);
    this.board = await this.store.loadOrInit();

    this.setupWatcher();
    this.postBoard();
  }

  private setupWatcher(): void {
    this.watcher?.dispose();
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = undefined;
    }
    if (!this.store) return;

    const watcherPattern = new vscode.RelativePattern(this.store.rootUri, this.store.boardFileRelativePath);
    this.watcher = vscode.workspace.createFileSystemWatcher(watcherPattern);
    this.watcher.onDidChange(() => this.scheduleReloadFromDisk());
    this.watcher.onDidCreate(() => this.scheduleReloadFromDisk());
    this.watcher.onDidDelete(() => this.scheduleReloadFromDisk());
    this.context.subscriptions.push(this.watcher);
  }

  private scheduleReloadFromDisk(): void {
    // Windowsでは同一の保存操作で複数イベントが発火しやすいので、短時間にまとめて1回だけ読む。
    if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = undefined;
      void this.reloadFromDiskSerial();
    }, 150);
  }

  private async reloadFromDiskSerial(): Promise<void> {
    if (this.reloadInProgress) {
      this.reloadPending = true;
      return;
    }

    this.reloadInProgress = true;
    try {
      await this.reloadFromDisk();
    } finally {
      this.reloadInProgress = false;
      if (this.reloadPending) {
        this.reloadPending = false;
        this.scheduleReloadFromDisk();
      }
    }
  }

  private async reloadFromDisk(): Promise<void> {
    if (!this.store) return;
    this.output.appendLine('reloadFromDisk');
    this.board = await this.store.loadOrInit();
    this.postBoard();
  }

  private postBoard(): void {
    if (!this.board) return;
    this.post({ type: 'board', board: this.board });
  }

  private post(message: unknown): void {
    for (const webview of this.webviews) {
      void webview.postMessage(message);
    }
  }

  private async onMessage(msg: WebviewToExtMessage): Promise<void> {
    if (!this.store) {
      await this.ensureStoreAndLoad();
      return;
    }

    switch (msg.type) {
      case 'ready': {
        this.postBoard();
        return;
      }

      case 'notify': {
        const message = String(msg.message ?? '').trim();
        if (!message) return;

        const level = msg.level ?? 'info';
        if (level === 'warning') {
          void vscode.window.showWarningMessage(message);
          return;
        }
        if (level === 'error') {
          void vscode.window.showErrorMessage(message);
          return;
        }

        void vscode.window.showInformationMessage(message);
        return;
      }

      case 'addTask': {
        const current = this.board ?? (await this.store.loadOrInit());
        const status = current.columns.includes(msg.task.status) ? msg.task.status : current.columns[0];
        const { board } = this.store.addTask(current, {
          title: msg.task.title,
          status,
          priority: msg.task.priority ?? 0,
          difficulty: msg.task.difficulty,
          branchType: msg.task.branchType,
          goal: msg.task.goal,
          acceptanceCriteria: msg.task.acceptanceCriteria,
          notes: msg.task.notes
        });
        await this.store.save(board);
        this.board = board;
        this.postBoard();
        return;
      }

      case 'updateTask': {
        const current = this.board ?? (await this.store.loadOrInit());
        const { board } = this.store.updateTask(current, msg.id, msg.patch);
        await this.store.save(board);
        this.board = board;
        this.postBoard();
        return;
      }

      case 'deleteTask': {
        const current = this.board ?? (await this.store.loadOrInit());
        const task = current.tasks.find((t) => t.id === msg.id);
        const label = task?.title ? `"${task.title}"` : 'このタスク';
        const pick = await vscode.window.showWarningMessage(`${label} を削除しますか？`, { modal: true }, '削除');
        if (pick !== '削除') return;

        const next = this.store.normalize({ ...current, tasks: current.tasks.filter((t) => t.id !== msg.id) });
        await this.store.save(next);
        this.board = next;
        this.postBoard();
        return;
      }

      case 'moveTask': {
        const current = this.board ?? (await this.store.loadOrInit());
        const next = this.store.moveTask(current, msg.id, msg.status, msg.index);
        await this.store.save(next);
        this.board = next;
        this.postBoard();
        return;
      }

      case 'reorderWithinColumn': {
        const current = this.board ?? (await this.store.loadOrInit());
        const next = this.store.reorderWithinColumn(current, msg.status, msg.orderedIds);
        await this.store.save(next);
        this.board = next;
        this.postBoard();
        return;
      }

      case 'copyTaskMarkdown': {
        let md = typeof msg.markdown === 'string' ? msg.markdown : '';
        if (!md) {
          const current = this.board ?? (await this.store.loadOrInit());
          const task = current.tasks.find((t) => t.id === msg.id);
          if (!task) throw new Error(`Task not found: ${msg.id}`);
          md = taskToMarkdown(task);
        }
        await vscode.env.clipboard.writeText(md);
        void vscode.window.showInformationMessage('Copied task as Markdown');
        return;
      }

      case 'openUrl': {
        const raw = (msg.url ?? '').trim();
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(raw);
        } catch {
          throw new Error('URL が不正です');
        }

        const scheme = uri.scheme?.toLowerCase();
        if (scheme !== 'http' && scheme !== 'https') {
          throw new Error('http/https の URL のみ開けます');
        }

        await vscode.env.openExternal(uri);
        return;
      }

      case 'editColumns': {
        const current = this.board ?? (await this.store.loadOrInit());
        const value = current.columns.join(', ');
        const nextText = await vscode.window.showInputBox({
          title: 'Columns (comma-separated)',
          value,
          prompt: 'Example: Backlog, To Do, In Progress, Review, Done'
        });
        if (!nextText) return;

        const cols = nextText
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (cols.length === 0) return;

        const next = this.store.updateColumns(current, cols);
        await this.store.save(next);
        this.board = next;
        this.postBoard();
        return;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const cacheBust = String(Date.now());
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css'));
    const toolkitUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.js')
    );

    const nonce = cacheBust;

    return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styleUri}?v=${cacheBust}" />
    <script nonce="${nonce}" type="module" src="${toolkitUri}?v=${cacheBust}"></script>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
  </body>
</html>`;
  }
}

function taskToMarkdown(task: Task): string {
  const lines: string[] = [];
  lines.push(`# ${task.title}`);
  lines.push('');
  lines.push(`- status: ${task.status}`);
  lines.push(`- priority: ${task.priority}`);
  if (typeof task.difficulty === 'number') lines.push(`- difficulty: ${task.difficulty}`);
  if (task.branchType) lines.push(`- branchType: ${task.branchType}`);
  lines.push('');

  if (task.goal) {
    lines.push('## Goal');
    lines.push(task.goal);
    lines.push('');
  }

  if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance Criteria');
    for (const c of task.acceptanceCriteria) lines.push(`- ${c}`);
    lines.push('');
  }

  if (task.notes) {
    lines.push('## Notes');
    lines.push(task.notes);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function deactivate() {}
