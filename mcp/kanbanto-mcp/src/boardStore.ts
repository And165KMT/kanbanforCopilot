import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { BoardFileSchema } from './schema.js';
import type { BoardFile, Task } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function toFiniteInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toOptionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function defaultBoard(): BoardFile {
  return {
    version: 1,
    columns: ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'],
    tasks: []
  };
}

export class BoardStore {
  private readonly boardPath: string;

  constructor(boardPath: string) {
    this.boardPath = boardPath;
  }

  static fromWorkspace(workspacePath: string, relativeBoardPath = '.kanbanto/tasks.json'): BoardStore {
    return new BoardStore(resolve(workspacePath, relativeBoardPath));
  }

  async load(): Promise<BoardFile> {
    try {
      const text = await readFile(this.boardPath, 'utf-8');
      const json = JSON.parse(text) as unknown;
      return BoardFileSchema.parse(json);
    } catch (error) {
      const board = defaultBoard();
      await this.save(board);
      return board;
    }
  }

  async save(board: BoardFile): Promise<void> {
    const safeBoard = BoardFileSchema.parse(board);
    const dir = dirname(this.boardPath);
    await mkdir(dir, { recursive: true });
    await writeFile(`${this.boardPath}.tmp`, JSON.stringify(safeBoard, null, 2), 'utf-8');
    await rename(`${this.boardPath}.tmp`, this.boardPath);
  }

  normalize(board: BoardFile): BoardFile {
    const columns = board.columns.length > 0 ? board.columns : defaultBoard().columns;
    const columnSet = new Set(columns);

    const tasks: Task[] = board.tasks
      .filter((t) => typeof t.id === 'string' && t.id.length > 0)
      .map((t) => ({
        ...t,
        status: columnSet.has(t.status) ? t.status : columns[0],
        priority: toFiniteInt(t.priority, 0),
        difficulty: t.difficulty !== undefined ? Math.min(Math.max(toFiniteInt(t.difficulty, 0), 0), 5) : undefined,
        branchType: toOptionalNonEmptyString((t as any).branchType),
        order: toFiniteInt(t.order, 0),
        updatedAt: t.updatedAt || nowIso()
      }));

    const byStatus = new Map<string, Task[]>();
    for (const col of columns) byStatus.set(col, []);
    for (const t of tasks) byStatus.get(t.status)!.push(t);

    // order is treated as a single 0..n sequence across the whole board
    const normalizedTasks: Task[] = [];
    let nextOrder = 0;
    for (const col of columns) {
      const inCol = byStatus.get(col)!;
      inCol.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
      for (const t of inCol) {
        normalizedTasks.push({ ...t, order: nextOrder++ });
      }
    }

    return { version: 1, columns, tasks: normalizedTasks };
  }

  private orderedByColumn(board: BoardFile): Map<string, Task[]> {
    const byStatus = new Map<string, Task[]>();
    for (const col of board.columns) byStatus.set(col, []);
    for (const t of board.tasks) {
      const list = byStatus.get(t.status);
      if (list) list.push(t);
    }
    for (const col of board.columns) {
      byStatus.get(col)!.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
    }
    return byStatus;
  }

  private flattenAndRenumber(columns: string[], byStatus: Map<string, Task[]>): Task[] {
    const result: Task[] = [];
    let nextOrder = 0;
    for (const col of columns) {
      const inCol = byStatus.get(col) ?? [];
      for (const t of inCol) {
        result.push({ ...t, order: nextOrder++ });
      }
    }
    return result;
  }

  private nextId(): string {
    return Math.random().toString(16).slice(2, 10);
  }

  addTask(
    board: BoardFile,
    input: Omit<Task, 'id' | 'updatedAt' | 'order'> & { order?: number }
  ): { board: BoardFile; task: Task } {
    const status = input.status;
    const now = nowIso();

    const task: Task = {
      id: this.nextId(),
      title: input.title,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      notes: input.notes,
      status,
      priority: input.priority,
      difficulty: input.difficulty,
      branchType: input.branchType,
      order: input.order ?? Number.MAX_SAFE_INTEGER,
      createdAt: now,
      updatedAt: now
    };

    const next: BoardFile = {
      ...board,
      tasks: [...board.tasks, task]
    };

    return { board: this.normalize(next), task };
  }

  updateTask(board: BoardFile, id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): { board: BoardFile; task: Task } {
    const idx = board.tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`Task not found: ${id}`);

    const prev = board.tasks[idx];
    const movingToAnotherStatus = typeof patch.status === 'string' && patch.status.length > 0 && patch.status !== prev.status;
    const nextTask: Task = {
      ...prev,
      ...patch,
      id: prev.id,
      createdAt: prev.createdAt,
      ...(movingToAnotherStatus && patch.order === undefined ? { order: Number.MAX_SAFE_INTEGER } : {}),
      updatedAt: nowIso()
    };

    const next: BoardFile = {
      ...board,
      tasks: board.tasks.map((t) => (t.id === id ? nextTask : t))
    };

    return { board: this.normalize(next), task: nextTask };
  }

  deleteTask(board: BoardFile, id: string): BoardFile {
    const next: BoardFile = { ...board, tasks: board.tasks.filter((t) => t.id !== id) };
    return this.normalize(next);
  }

  moveTask(board: BoardFile, id: string, status: string, index?: number): BoardFile {
    const normalized = this.normalize(board);
    const task = normalized.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);

    const byStatus = this.orderedByColumn(normalized);
    const fromList = byStatus.get(task.status);
    const toList = byStatus.get(status);
    if (!fromList || !toList) throw new Error(`Unknown status: ${status}`);

    const fromIdx = fromList.findIndex((t) => t.id === id);
    if (fromIdx >= 0) fromList.splice(fromIdx, 1);

    const insertAt = index ?? toList.length;
    const clamped = Math.min(Math.max(insertAt, 0), toList.length);
    toList.splice(clamped, 0, { ...task, status, updatedAt: nowIso() });

    const nextTasks = this.flattenAndRenumber(normalized.columns, byStatus);
    return { ...normalized, tasks: nextTasks };
  }

  reorderWithinColumn(board: BoardFile, status: string, orderedIds: string[]): BoardFile {
    const normalized = this.normalize(board);
    const byStatus = this.orderedByColumn(normalized);
    const inCol = byStatus.get(status);
    if (!inCol) throw new Error(`Unknown status: ${status}`);

    const idSet = new Set(orderedIds);
    const map = new Map(inCol.map((t) => [t.id, t] as const));
    const reordered: Task[] = [];

    for (const id of orderedIds) {
      const t = map.get(id);
      if (t) reordered.push(t);
    }
    for (const t of inCol) {
      if (!idSet.has(t.id)) reordered.push(t);
    }

    byStatus.set(status, reordered);
    const nextTasks = this.flattenAndRenumber(normalized.columns, byStatus);
    return { ...normalized, tasks: nextTasks };
  }

  updateColumns(board: BoardFile, columns: string[]): BoardFile {
    const next: BoardFile = { ...board, columns };
    return this.normalize(next);
  }
}
