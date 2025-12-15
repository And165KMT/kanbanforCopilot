import * as vscode from 'vscode';
import { BoardStore } from './boardStore';
import type { BoardFile, Task } from './types';
import { fetchAssignedToMeWorkItems } from './azureDevops';

type WebviewToExtMessage =
  | { type: 'ready' }
  | { type: 'addTask'; task: { title: string; status: string; priority: number; difficulty?: number; branchType?: string; goal?: string; acceptanceCriteria?: string[]; notes?: string } }
  | { type: 'updateTask'; id: string; patch: Partial<Omit<Task, 'id' | 'createdAt'>> }
  | { type: 'deleteTask'; id: string }
  | { type: 'moveTask'; id: string; status: string; index: number }
  | { type: 'reorderWithinColumn'; status: string; orderedIds: string[] }
  | { type: 'copyTaskMarkdown'; id: string }
  | { type: 'editColumns' }
  | { type: 'importAzure' };

function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

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
}

class TaskBoardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'kanbanto.boardView';

  private view?: vscode.WebviewView;
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

    view.webview.onDidReceiveMessage(async (msg: WebviewToExtMessage) => {
      try {
        await this.onMessage(msg);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(message);
      }
    });

    // If the extension host starts with an empty window, ensure the view
    // updates when a folder is opened later (avoid staying in no-workspace state).
    this.workspaceListener?.dispose();
    this.workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void this.ensureStoreAndLoad();
    });
    this.context.subscriptions.push(this.workspaceListener);

    void this.ensureStoreAndLoad();
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
    void this.view?.webview.postMessage(message);
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
        const current = this.board ?? (await this.store.loadOrInit());
        const task = current.tasks.find((t) => t.id === msg.id);
        if (!task) throw new Error(`Task not found: ${msg.id}`);

        const md = taskToMarkdown(task);
        await vscode.env.clipboard.writeText(md);
        void vscode.window.showInformationMessage('Copied task as Markdown');
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

      case 'importAzure': {
        const store = this.store;
        const current = this.board ?? (await store.loadOrInit());

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Azure DevOps から取り込み中…' },
          async () => {
            const envUri = vscode.Uri.joinPath(store.rootUri, '.env');
            let envText = '';
            try {
              const bytes = await vscode.workspace.fs.readFile(envUri);
              envText = Buffer.from(bytes).toString('utf8');
            } catch {
              throw new Error('ワークスペース直下の .env が見つかりません（AZDO_ORG_URL/AZDO_PROJECT/AZDO_PAT を設定してください）');
            }

            const env = parseDotEnv(envText);

            const orgUrl = (env.AZDO_ORG_URL ?? '').trim();
            const project = (env.AZDO_PROJECT ?? '').trim();
            const pat = (env.AZDO_PAT ?? '').trim();
            if (!orgUrl) throw new Error('AZDO_ORG_URL が .env にありません');
            if (!project) throw new Error('AZDO_PROJECT が .env にありません');
            if (!pat) throw new Error('AZDO_PAT が .env にありません');

            const top = env.AZDO_TOP ? Number(env.AZDO_TOP) : 200;
            const workItemTypes = splitCsv(env.AZDO_WORK_ITEM_TYPES);
            const excludeStates = splitCsv(env.AZDO_EXCLUDE_STATES);

            const items = await fetchAssignedToMeWorkItems({
              orgUrl,
              project,
              pat,
              top: Number.isFinite(top) ? top : 200,
              workItemTypes: workItemTypes.length > 0 ? workItemTypes : ['Task', 'Issue'],
              excludeStates: excludeStates.length > 0 ? excludeStates : ['Done', 'Closed']
            });

            const targetStatus = current.columns.includes('Backlog') ? 'Backlog' : current.columns[0];

            let next = current;
            let imported = 0;
            let skippedExisting = 0;

            for (const wi of items) {
              const marker = `ADO#${wi.id}`;
              const already = next.tasks.some((t) => (t.notes ?? '').includes(marker));
              if (already) {
                skippedExisting++;
                continue;
              }

              const title = `[ADO#${wi.id}] ${wi.title}`;
              const notesLines = [
                marker,
                `URL: ${wi.url}`,
                wi.type ? `Type: ${wi.type}` : undefined,
                wi.state ? `State: ${wi.state}` : undefined
              ].filter((s): s is string => typeof s === 'string' && s.length > 0);

              const { board } = store.addTask(next, {
                title,
                status: targetStatus,
                priority: 0,
                goal: wi.description,
                acceptanceCriteria: wi.acceptanceCriteria,
                notes: notesLines.join('\n')
              });
              next = board;
              imported++;
            }

            await store.save(next);
            this.board = next;
            this.postBoard();

            void vscode.window.showInformationMessage(
              `Azure DevOps から取り込み完了: ${imported}件（既存スキップ: ${skippedExisting}件）`
            );
          }
        );

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
