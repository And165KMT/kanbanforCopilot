import * as vscode from 'vscode';
import { BoardFile, Task } from './types';

function nowIso(): string {
  return new Date().toISOString();
}

function defaultBoard(): BoardFile {
  return {
    version: 1,
    columns: ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'],
    tasks: []
  };
}

function toFiniteInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export class BoardStore {
  constructor(
    public readonly rootUri: vscode.Uri,
    public readonly boardFileRelativePath: string = '.kanbanto/tasks.json'
  ) {}

  private pathSegments(): string[] {
    return this.boardFileRelativePath
      .split(/[\\/]+/g)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  get boardUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.rootUri, ...this.pathSegments());
  }

  async loadOrInit(): Promise<BoardFile> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.boardUri);
      const text = Buffer.from(bytes).toString('utf8');
      return this.normalize(JSON.parse(text) as unknown);
    } catch {
      const board = defaultBoard();
      await this.save(board);
      return board;
    }
  }

  async save(board: BoardFile): Promise<void> {
    const normalized = this.normalize(board);
    const segments = this.pathSegments();
    const fileName = segments[segments.length - 1] ?? 'tasks.json';
    const dir = vscode.Uri.joinPath(this.rootUri, ...segments.slice(0, -1));
    await vscode.workspace.fs.createDirectory(dir);

    const tmp = vscode.Uri.joinPath(dir, `${fileName}.tmp`);
    const target = this.boardUri;

    await vscode.workspace.fs.writeFile(tmp, Buffer.from(JSON.stringify(normalized, null, 2), 'utf8'));
    await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
  }

  normalize(raw: unknown): BoardFile {
    const board = (raw ?? {}) as Partial<BoardFile>;
    const columns = Array.isArray(board.columns) && board.columns.length > 0 ? board.columns.filter(Boolean) : defaultBoard().columns;
    const columnSet = new Set(columns);

    const tasks: Task[] = Array.isArray(board.tasks)
      ? board.tasks
          .filter((t): t is Task => !!t && typeof (t as any).id === 'string' && (t as any).id.length > 0)
          .map((t) => ({
            ...t,
            status: columnSet.has(t.status) ? t.status : columns[0],
            priority: toFiniteInt(t.priority, 0),
            difficulty: t.difficulty !== undefined ? toFiniteInt(t.difficulty, 0) : undefined,
            order: toFiniteInt(t.order, 0),
            updatedAt: t.updatedAt || nowIso()
          }))
      : [];

    const byStatus = new Map<string, Task[]>();
    for (const col of columns) byStatus.set(col, []);
    for (const t of tasks) byStatus.get(t.status)!.push(t);
    for (const col of columns) {
      byStatus.get(col)!.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
    }

    const normalizedTasks: Task[] = [];
    let nextOrder = 0;
    for (const col of columns) {
      for (const t of byStatus.get(col)!) {
        normalizedTasks.push({ ...t, order: nextOrder++ });
      }
    }

    return { version: 1, columns, tasks: normalizedTasks };
  }

  addTask(board: BoardFile, input: Omit<Task, 'id' | 'updatedAt' | 'order'> & { order?: number }): { board: BoardFile; task: Task } {
    const now = nowIso();
    const task: Task = {
      id: Math.random().toString(16).slice(2, 10),
      title: input.title,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      notes: input.notes,
      status: input.status,
      priority: input.priority,
      difficulty: input.difficulty,
      branchType: input.branchType,
      order: input.order ?? Number.MAX_SAFE_INTEGER,
      createdAt: now,
      updatedAt: now
    };

    const next = this.normalize({ ...board, tasks: [...board.tasks, task] });
    return { board: next, task };
  }

  updateTask(board: BoardFile, id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): { board: BoardFile; task: Task } {
    const idx = board.tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`Task not found: ${id}`);

    const prev = board.tasks[idx];
    const moving = typeof patch.status === 'string' && patch.status.length > 0 && patch.status !== prev.status;
    const nextTask: Task = {
      ...prev,
      ...patch,
      id: prev.id,
      createdAt: prev.createdAt,
      ...(moving && patch.order === undefined ? { order: Number.MAX_SAFE_INTEGER } : {}),
      updatedAt: nowIso()
    };

    const next = this.normalize({ ...board, tasks: board.tasks.map((t) => (t.id === id ? nextTask : t)) });
    return { board: next, task: nextTask };
  }

  reorderWithinColumn(board: BoardFile, status: string, orderedIds: string[]): BoardFile {
    const normalized = this.normalize(board);

    const columns = normalized.columns;
    const byStatus = new Map<string, Task[]>();
    for (const col of columns) byStatus.set(col, []);
    for (const t of normalized.tasks) byStatus.get(t.status)!.push(t);

    const list = byStatus.get(status);
    if (!list) throw new Error(`Unknown status: ${status}`);

    const map = new Map(list.map((t) => [t.id, t] as const));
    const idSet = new Set(orderedIds);
    const reordered: Task[] = [];

    for (const id of orderedIds) {
      const t = map.get(id);
      if (t) reordered.push(t);
    }
    for (const t of list) {
      if (!idSet.has(t.id)) reordered.push(t);
    }
    byStatus.set(status, reordered);

    const tasks: Task[] = [];
    let nextOrder = 0;
    for (const col of columns) {
      for (const t of byStatus.get(col)!) {
        tasks.push({ ...t, order: nextOrder++ });
      }
    }

    return { ...normalized, tasks };
  }

  moveTask(board: BoardFile, id: string, status: string, index: number): BoardFile {
    const normalized = this.normalize(board);
    const columns = normalized.columns;

    const byStatus = new Map<string, Task[]>();
    for (const col of columns) byStatus.set(col, []);
    for (const t of normalized.tasks) byStatus.get(t.status)!.push(t);

    let found: Task | undefined;
    for (const col of columns) {
      const list = byStatus.get(col)!;
      const idx = list.findIndex((t) => t.id === id);
      if (idx >= 0) {
        found = list[idx];
        list.splice(idx, 1);
        break;
      }
    }
    if (!found) throw new Error(`Task not found: ${id}`);

    const target = byStatus.get(status);
    if (!target) throw new Error(`Unknown status: ${status}`);

    const clamped = Math.min(Math.max(index, 0), target.length);
    target.splice(clamped, 0, { ...found, status, updatedAt: nowIso() });

    const tasks: Task[] = [];
    let nextOrder = 0;
    for (const col of columns) {
      for (const t of byStatus.get(col)!) {
        tasks.push({ ...t, order: nextOrder++ });
      }
    }

    return { ...normalized, tasks };
  }

  updateColumns(board: BoardFile, columns: string[]): BoardFile {
    return this.normalize({ ...board, columns });
  }
}
