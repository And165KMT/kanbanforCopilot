export type BoardFile = {
  version: 1;
  columns: string[];
  tasks: Task[];
};

export type Task = {
  id: string;
  title: string;
  goal?: string;
  acceptanceCriteria?: string[];
  notes?: string;
  status: string;
  priority: number;
  difficulty?: number;
  branchType?: string;
  order: number; // A single 0..n sequence across the whole board
  createdAt?: string;
  updatedAt: string;
};
