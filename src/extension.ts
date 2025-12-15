import * as vscode from 'vscode';
import * as path from 'node:path';
import { BoardStore } from './boardStore';
import type { BoardFile, Task } from './types';
import { addWorkItemHistoryComment, attachFileToWorkItem, fetchAssignedToMeWorkItems, fetchWorkItemTypeStates, updateWorkItemDescription, updateWorkItemState } from './azureDevops';

type WebviewToExtMessage =
  | { type: 'ready' }
  | { type: 'addTask'; task: { title: string; status: string; priority: number; difficulty?: number; branchType?: string; goal?: string; acceptanceCriteria?: string[]; notes?: string } }
  | { type: 'updateTask'; id: string; patch: Partial<Omit<Task, 'id' | 'createdAt'>> }
  | { type: 'deleteTask'; id: string }
  | { type: 'moveTask'; id: string; status: string; index: number }
  | { type: 'reorderWithinColumn'; status: string; orderedIds: string[] }
  | { type: 'copyTaskMarkdown'; id: string }
  | { type: 'openUrl'; url: string }
  | { type: 'addAdoComment'; workItemId: number; comment: string }
  | { type: 'addAdoCommentWithAttachment'; workItemId: number; comment: string }
  | { type: 'addAdoAttachment'; workItemId: number; fileName: string; mime: string; dataBase64: string; comment?: string }
  | { type: 'syncAdoDescription'; workItemId: number; goal: string; acceptanceCriteria: string[] }
  | { type: 'openEnvSettings' }
  | { type: 'editColumns' }
  | { type: 'importAzure' };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toDescriptionHtml(goal: string, acceptanceCriteria: string[]): string {
  const parts: string[] = [];
  const g = String(goal ?? '').trim();
  const ac = Array.isArray(acceptanceCriteria)
    ? acceptanceCriteria.map((s) => String(s ?? '').trim()).filter((s) => s.length > 0)
    : [];

  if (g) {
    const lines = g.split(/\r?\n/).map((l) => escapeHtml(l));
    parts.push('<h2>Goal</h2>');
    parts.push(`<p>${lines.join('<br/>')}</p>`);
  }

  if (ac.length > 0) {
    parts.push('<h2>Acceptance Criteria</h2>');
    parts.push('<ul>');
    for (const item of ac) parts.push(`<li>${escapeHtml(item)}</li>`);
    parts.push('</ul>');
  }

  return parts.join('\n').trim();
}

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

function serializeDotEnv(env: Record<string, string>): string {
  const lines: string[] = [];
  lines.push('# Kanbanto Azure DevOps settings');
  lines.push('# Required: AZDO_ORG_URL, AZDO_PROJECT, AZDO_PAT');
  lines.push('# Optional: AZDO_COLUMN_TO_STATE, AZDO_TOP, AZDO_WORK_ITEM_TYPES, AZDO_EXCLUDE_STATES');
  lines.push('');

  const orderedKeys = [
    'AZDO_ORG_URL',
    'AZDO_PROJECT',
    'AZDO_PAT',
    'AZDO_COLUMN_TO_STATE',
    'AZDO_TOP',
    'AZDO_WORK_ITEM_TYPES',
    'AZDO_EXCLUDE_STATES'
  ];

  const extraKeys = Object.keys(env)
    .filter((k) => !orderedKeys.includes(k))
    .sort((a, b) => a.localeCompare(b));

  for (const key of [...orderedKeys, ...extraKeys]) {
    const value = env[key];
    if (value === undefined) continue;
    lines.push(`${key}=${value}`);
  }

  return lines.join('\n') + '\n';
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function parseColumnToStateMap(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of splitCsv(value)) {
    const m = item.match(/^(.+?)\s*(=|->|:)\s*(.+)$/);
    if (!m) continue;
    const col = m[1].trim();
    const state = m[3].trim();
    if (!col || !state) continue;
    result[col] = state;
  }
  return result;
}

function lookupMapInsensitive(map: Record<string, string>, key: string): string | undefined {
  const nk = normalizeKey(key);
  for (const [k, v] of Object.entries(map)) {
    if (normalizeKey(k) === nk) return v;
  }
  return undefined;
}

function buildStateToColumnMap(board: BoardFile, columnToState: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  // Explicit mappings take precedence.
  for (const [col, state] of Object.entries(columnToState)) {
    if (!col || !state) continue;
    result[state] = col;
  }
  // Fallback: if a column name equals a state name, allow identity mapping.
  for (const col of board.columns) {
    result[col] ??= col;
  }
  return result;
}

function extractAdoWorkItemId(task: Task | undefined): number | undefined {
  if (!task) return undefined;
  const text = [task.title ?? '', task.notes ?? ''].join('\n');
  const m = text.match(/\bADO#(\d+)\b/);
  if (!m) return undefined;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

function composeAdoNotes(existingNotes: string | undefined, wi: { id: number; url: string; type?: string; state?: string }): string {
  const baseLines = [
    `ADO#${wi.id}`,
    `URL: ${wi.url}`,
    wi.type ? `Type: ${wi.type}` : undefined,
    wi.state ? `State: ${wi.state}` : undefined
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);

  const rest = String(existingNotes ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .filter((l) => !/^ADO#\d+\b/.test(l))
    .filter((l) => !/^URL:\s*/i.test(l))
    .filter((l) => !/^Type:\s*/i.test(l))
    .filter((l) => !/^State:\s*/i.test(l));

  return rest.length > 0
    ? [...baseLines, '', ...rest].join('\n')
    : baseLines.join('\n');
}

function parseAdoTypeFromNotes(task: Task): string | undefined {
  const lines = String(task.notes ?? '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^Type:\s*(.+)$/i);
    if (m) {
      const t = m[1].trim();
      return t.length > 0 ? t : undefined;
    }
  }
  return undefined;
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

  private static readonly preferredEnvRelativePath = '.kanbanto/.env';
  private static readonly fallbackEnvRelativePath = '.env';

  private view?: vscode.WebviewView;
  private store?: BoardStore;
  private board?: BoardFile;
  private watcher?: vscode.FileSystemWatcher;
  private workspaceListener?: vscode.Disposable;
  private reloadDebounceTimer?: NodeJS.Timeout;
  private reloadInProgress = false;
  private reloadPending = false;

  private azdoCache?: {
    orgUrl: string;
    project: string;
    pat: string;
    columnToState: Record<string, string>;
  };

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
        const before = current.tasks.find((t) => t.id === msg.id);
        const { board } = this.store.updateTask(current, msg.id, msg.patch);
        await this.store.save(board);
        this.board = board;
        this.postBoard();

        const after = board.tasks.find((t) => t.id === msg.id);
        if (before && after && before.status !== after.status) {
          void this.syncTaskStateToAzure(after, after.status);
        }
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

        const moved = next.tasks.find((t) => t.id === msg.id);
        if (moved) void this.syncTaskStateToAzure(moved, moved.status);
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

      case 'addAdoComment': {
        const workItemId = Number(msg.workItemId);
        const comment = String(msg.comment ?? '').trim();
        if (!Number.isFinite(workItemId) || workItemId <= 0) throw new Error('ADO Work Item ID が不正です');
        if (!comment) throw new Error('コメントが空です');

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `ADO#${workItemId} にコメント投稿中…` },
          async () => {
            const { orgUrl, project, pat } = await this.loadAzdoConfig();

            await addWorkItemHistoryComment({ orgUrl, project, pat, id: workItemId, comment });
            void vscode.window.showInformationMessage(`ADO#${workItemId} にコメントを投稿しました`);
          }
        );

        return;
      }

      case 'addAdoCommentWithAttachment': {
        const store = this.store;
        const workItemId = Number(msg.workItemId);
        const comment = String(msg.comment ?? '').trim();
        if (!Number.isFinite(workItemId) || workItemId <= 0) throw new Error('ADO Work Item ID が不正です');

        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: '添付する',
          filters: {
            Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
            Files: ['*']
          }
        });

        if (!picked || picked.length === 0) {
          if (comment) {
            const { orgUrl, project, pat } = await this.loadAzdoConfig();
            await addWorkItemHistoryComment({ orgUrl, project, pat, id: workItemId, comment });
            void vscode.window.showInformationMessage(`ADO#${workItemId} にコメントを投稿しました（添付なし）`);
          }
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `ADO#${workItemId} に添付中…` },
          async () => {
            const { orgUrl, project, pat } = await this.loadAzdoConfig();
            const maxFiles = 5;
            const targets = picked.slice(0, maxFiles);

            for (const uri of targets) {
              const bytes = await vscode.workspace.fs.readFile(uri);
              const maxBytes = 10 * 1024 * 1024; // 10MB
              if (bytes.length > maxBytes) {
                throw new Error(`添付ファイルが大きすぎます（10MBまで）: ${uri.fsPath}`);
              }
              const fileName = path.basename(uri.fsPath);
              await attachFileToWorkItem({
                orgUrl,
                project,
                pat,
                id: workItemId,
                fileName,
                content: Buffer.from(bytes),
                comment: comment || undefined
              });
            }

            if (comment) {
              await addWorkItemHistoryComment({ orgUrl, project, pat, id: workItemId, comment });
            }

            void vscode.window.showInformationMessage(
              `ADO#${workItemId} に添付しました（${targets.length}件）${comment ? ' + コメント' : ''}`
            );
          }
        );

        return;
      }

      case 'addAdoAttachment': {
        const workItemId = Number(msg.workItemId);
        if (!Number.isFinite(workItemId) || workItemId <= 0) throw new Error('ADO Work Item ID が不正です');

        const fileName = String(msg.fileName ?? '').trim() || `pasted-${Date.now()}.png`;
        const comment = String(msg.comment ?? '').trim();
        const b64 = String(msg.dataBase64 ?? '').trim();
        if (!b64) throw new Error('添付データが空です');

        // Base64 payload guard
        const maxBytes = 2 * 1024 * 1024; // 2MB
        const approxBytes = Math.floor((b64.length * 3) / 4);
        if (approxBytes > maxBytes) throw new Error('貼り付け画像が大きすぎます（2MBまで）。ファイル添付を使ってください');

        const content = Buffer.from(b64, 'base64');
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `ADO#${workItemId} に貼り付け画像を添付中…` },
          async () => {
            const { orgUrl, project, pat } = await this.loadAzdoConfig();
            await attachFileToWorkItem({
              orgUrl,
              project,
              pat,
              id: workItemId,
              fileName,
              content,
              comment: comment || undefined
            });
            if (comment) {
              await addWorkItemHistoryComment({ orgUrl, project, pat, id: workItemId, comment });
            }
            void vscode.window.showInformationMessage(`ADO#${workItemId} に画像を添付しました${comment ? ' + コメント' : ''}`);
          }
        );

        return;
      }

      case 'syncAdoDescription': {
        const workItemId = Number(msg.workItemId);
        if (!Number.isFinite(workItemId) || workItemId <= 0) throw new Error('ADO Work Item ID が不正です');

        const html = toDescriptionHtml(String(msg.goal ?? ''), Array.isArray(msg.acceptanceCriteria) ? msg.acceptanceCriteria : []);
        if (!html) {
          void vscode.window.showWarningMessage('Goal / Acceptance criteria が空のため、更新しません');
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `ADO#${workItemId} の Description を更新中…` },
          async () => {
            const { orgUrl, project, pat } = await this.loadAzdoConfig();
            await updateWorkItemDescription({ orgUrl, project, pat, id: workItemId, descriptionHtml: html });
          }
        );

        void vscode.window.showInformationMessage(`ADO#${workItemId} の Description を更新しました`);
        return;
      }

      case 'openEnvSettings': {
        const store = this.store;
        if (!store) {
          await this.ensureStoreAndLoad();
          return;
        }

        const envUriForWrite = this.getEnvUriForWrite(store);
        const envText = await this.tryReadEnvText(store);
        const existing = envText ? parseDotEnv(envText) : {};

        const orgUrl = await vscode.window.showInputBox({
          title: 'Azure DevOps: Org URL',
          prompt: '例: https://dev.azure.com/YourOrg',
          value: existing.AZDO_ORG_URL ?? ''
        });
        if (orgUrl === undefined) return;

        const project = await vscode.window.showInputBox({
          title: 'Azure DevOps: Project',
          prompt: 'ADOのプロジェクト名',
          value: existing.AZDO_PROJECT ?? ''
        });
        if (project === undefined) return;

        const pat = await vscode.window.showInputBox({
          title: 'Azure DevOps: PAT',
          prompt: 'Work Items (read & write) が必要です',
          password: true,
          value: existing.AZDO_PAT ?? ''
        });
        if (pat === undefined) return;

        const columnToState = await vscode.window.showInputBox({
          title: 'Optional: Column -> State mapping',
          prompt: '例: Backlog=New,To Do=To Do,In Progress=Doing,Review=Review,Done=Done',
          value: existing.AZDO_COLUMN_TO_STATE ?? ''
        });
        if (columnToState === undefined) return;

        const top = await vscode.window.showInputBox({
          title: 'Optional: Import top N',
          prompt: '取り込み件数（例: 200）',
          value: existing.AZDO_TOP ?? ''
        });
        if (top === undefined) return;

        const workItemTypes = await vscode.window.showInputBox({
          title: 'Optional: Work item types',
          prompt: '例: Task,Issue',
          value: existing.AZDO_WORK_ITEM_TYPES ?? ''
        });
        if (workItemTypes === undefined) return;

        const excludeStates = await vscode.window.showInputBox({
          title: 'Optional: Exclude states (import)',
          prompt: '例: Done,Closed',
          value: existing.AZDO_EXCLUDE_STATES ?? ''
        });
        if (excludeStates === undefined) return;

        const nextEnv: Record<string, string> = {
          ...existing,
          AZDO_ORG_URL: orgUrl.trim(),
          AZDO_PROJECT: project.trim(),
          AZDO_PAT: pat.trim(),
          AZDO_COLUMN_TO_STATE: columnToState.trim(),
          AZDO_TOP: top.trim(),
          AZDO_WORK_ITEM_TYPES: workItemTypes.trim(),
          AZDO_EXCLUDE_STATES: excludeStates.trim()
        };

        const text = serializeDotEnv(nextEnv);
        const dirUri = vscode.Uri.joinPath(store.rootUri, ...this.splitRelPath(TaskBoardViewProvider.preferredEnvRelativePath).slice(0, -1));
        await vscode.workspace.fs.createDirectory(dirUri);
        await vscode.workspace.fs.writeFile(envUriForWrite, Buffer.from(text, 'utf8'));
        this.azdoCache = undefined;
        void vscode.window.showInformationMessage(`${TaskBoardViewProvider.preferredEnvRelativePath} を更新しました`);
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
            const envText = await this.readEnvText(store);

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
            const columnToState = parseColumnToStateMap(env.AZDO_COLUMN_TO_STATE);
            this.azdoCache = { orgUrl, project, pat, columnToState };

            const items = await fetchAssignedToMeWorkItems({
              orgUrl,
              project,
              pat,
              top: Number.isFinite(top) ? top : 200,
              workItemTypes: workItemTypes.length > 0 ? workItemTypes : ['Task', 'Issue'],
              excludeStates: excludeStates.length > 0 ? excludeStates : ['Done', 'Closed']
            });

            const stateToColumn = buildStateToColumnMap(current, columnToState);

            let next = current;
            let added = 0;
            let updated = 0;

            for (const wi of items) {
              const desiredStatus = (() => {
                const state = (wi.state ?? '').trim();
                if (state) {
                  const mapped = lookupMapInsensitive(stateToColumn, state);
                  if (mapped && current.columns.some((c) => normalizeKey(c) === normalizeKey(mapped))) return mapped;
                  const exact = current.columns.find((c) => c === state);
                  if (exact) return exact;
                }
                return current.columns.includes('Backlog') ? 'Backlog' : current.columns[0];
              })();

              const existing = next.tasks.find((t) => extractAdoWorkItemId(t) === wi.id);
              const title = `[ADO#${wi.id}] ${wi.title}`;
              const notes = composeAdoNotes(existing?.notes, { id: wi.id, url: wi.url, type: wi.type, state: wi.state });

              if (existing) {
                const { board } = store.updateTask(next, existing.id, {
                  title,
                  status: desiredStatus,
                  goal: wi.description,
                  acceptanceCriteria: wi.acceptanceCriteria,
                  notes
                });
                next = board;
                updated++;
              } else {
                const { board } = store.addTask(next, {
                  title,
                  status: desiredStatus,
                  priority: 0,
                  goal: wi.description,
                  acceptanceCriteria: wi.acceptanceCriteria,
                  notes
                });
                next = board;
                added++;
              }
            }

            await store.save(next);
            this.board = next;
            this.postBoard();

            void vscode.window.showInformationMessage(
              `Azure DevOps と同期完了: 追加 ${added}件 / 更新 ${updated}件`
            );
          }
        );

        return;
      }
    }
  }

  private splitRelPath(relPath: string): string[] {
    return relPath
      .replace(/\\/g, '/')
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private getEnvUriForWrite(store: BoardStore): vscode.Uri {
    return vscode.Uri.joinPath(store.rootUri, ...this.splitRelPath(TaskBoardViewProvider.preferredEnvRelativePath));
  }

  private async tryReadEnvText(store: BoardStore): Promise<string | undefined> {
    const preferred = vscode.Uri.joinPath(store.rootUri, ...this.splitRelPath(TaskBoardViewProvider.preferredEnvRelativePath));
    try {
      const bytes = await vscode.workspace.fs.readFile(preferred);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      // fall through
    }

    const fallback = vscode.Uri.joinPath(store.rootUri, ...this.splitRelPath(TaskBoardViewProvider.fallbackEnvRelativePath));
    try {
      const bytes = await vscode.workspace.fs.readFile(fallback);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private async readEnvText(store: BoardStore): Promise<string> {
    const text = await this.tryReadEnvText(store);
    if (text !== undefined) return text;
    throw new Error(
      `${TaskBoardViewProvider.preferredEnvRelativePath} または ${TaskBoardViewProvider.fallbackEnvRelativePath} が見つかりません（AZDO_ORG_URL/AZDO_PROJECT/AZDO_PAT を設定してください）`
    );
  }

  private async loadAzdoConfig(): Promise<{ orgUrl: string; project: string; pat: string; columnToState: Record<string, string> }> {
    if (this.azdoCache) return this.azdoCache;
    const store = this.store;
    if (!store) throw new Error('Store is not ready');

    const envText = await this.readEnvText(store);

    const env = parseDotEnv(envText);
    const orgUrl = (env.AZDO_ORG_URL ?? '').trim();
    const project = (env.AZDO_PROJECT ?? '').trim();
    const pat = (env.AZDO_PAT ?? '').trim();
    if (!orgUrl) throw new Error('AZDO_ORG_URL が .env にありません');
    if (!project) throw new Error('AZDO_PROJECT が .env にありません');
    if (!pat) throw new Error('AZDO_PAT が .env にありません');

    const columnToState = parseColumnToStateMap(env.AZDO_COLUMN_TO_STATE);
    this.azdoCache = { orgUrl, project, pat, columnToState };
    return this.azdoCache;
  }

  private async syncTaskStateToAzure(task: Task, status: string): Promise<void> {
    const workItemId = extractAdoWorkItemId(task);
    if (!workItemId) return;

    try {
      const { orgUrl, project, pat, columnToState } = await this.loadAzdoConfig();

      const mapped = lookupMapInsensitive(columnToState, status);
      const desiredState = mapped ?? status;

      // If no explicit mapping exists, validate against allowed states to avoid 400 spam.
      if (!mapped) {
        const wiType = parseAdoTypeFromNotes(task);
        if (wiType) {
          const allowed = await fetchWorkItemTypeStates({ orgUrl, project, pat, type: wiType });
          const ok = allowed.some((s) => s.toLowerCase() === desiredState.toLowerCase());
          if (!ok && allowed.length > 0) {
            const hint = `AZDO_COLUMN_TO_STATE にマッピングを追加してください。例: In Progress=Doing`;
            this.output.appendLine(
              `syncTaskStateToAzure skipped: unsupported state "${desiredState}" for type "${wiType}"; allowed=${allowed.join(', ')}`
            );
            void vscode.window.showWarningMessage(
              `Azure DevOps 側で State "${desiredState}" は無効です（Type: ${wiType}）。${hint}`
            );
            return;
          }
        }
      }

      await updateWorkItemState({ orgUrl, project, pat, id: workItemId, state: desiredState });
      this.output.appendLine(`syncTaskStateToAzure: ADO#${workItemId} <= ${desiredState}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.output.appendLine(`syncTaskStateToAzure failed: ${message}`);
      void vscode.window.showErrorMessage(`Azure DevOps 同期に失敗しました: ${message}`);
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
