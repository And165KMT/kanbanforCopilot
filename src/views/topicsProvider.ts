import * as vscode from 'vscode';
import { getTopicParticipants, listTopics, type Ros2Topic } from '../ros2/ros2Cli';

type TopicParticipants = { publishers: string[]; subscribers: string[] };

class TopicItem extends vscode.TreeItem {
	constructor(public readonly topic: Ros2Topic, checked: boolean, participants?: TopicParticipants) {
		super(topic.name, vscode.TreeItemCollapsibleState.None);
		const type = topic.type ? String(topic.type) : '?';
		const pubs = (participants?.publishers ?? []).filter(Boolean);
		const subs = (participants?.subscribers ?? []).filter(Boolean);
		const parts: string[] = [];
		if (pubs.length > 0) parts.push(`pub: ${pubs.map((n) => `${n}/${type}`).join(', ')}`);
		if (subs.length > 0) parts.push(`sub: ${subs.map((n) => `${n}/${type}`).join(', ')}`);
		this.description = parts.length > 0 ? parts.join(' | ') : type;
		this.contextValue = 'ros2TopicViewer.topic';
		if (parts.length > 0) {
			this.tooltip = `${topic.name}\n${type}\n${pubs.length > 0 ? `pub: ${pubs.join(', ')}` : 'pub: (none)'}\n${subs.length > 0 ? `sub: ${subs.join(', ')}` : 'sub: (none)'}`;
		} else {
			this.tooltip = topic.type ? `${topic.name}\n${type}` : topic.name;
		}
		this.checkboxState = checked
			? vscode.TreeItemCheckboxState.Checked
			: vscode.TreeItemCheckboxState.Unchecked;
	}
}

export class TopicsProvider implements vscode.TreeDataProvider<TopicItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TopicItem | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private cached: Ros2Topic[] | null = null;
	private checkedTopicNames = new Set<string>();
	private participantsByTopicName = new Map<string, TopicParticipants>();
	private loadSeq = 0;
	private pendingRefreshTimer: NodeJS.Timeout | undefined;

	constructor(private readonly output: vscode.OutputChannel) {}

	getTreeItem(element: TopicItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: TopicItem): Promise<TopicItem[]> {
		if (element) {
			return [];
		}

		if (!this.cached) {
			await this.load();
		}

		return (this.cached ?? []).map(
			(t) =>
				new TopicItem(t, this.checkedTopicNames.has(t.name), this.participantsByTopicName.get(t.name))
		);
	}

	setCheckedTopics(names: Iterable<string>): void {
		this.checkedTopicNames = new Set(names);
		this._onDidChangeTreeData.fire();
	}

	setTopicChecked(name: string, checked: boolean): void {
		if (checked) {
			this.checkedTopicNames.add(name);
		} else {
			this.checkedTopicNames.delete(name);
		}
		this._onDidChangeTreeData.fire();
	}

	getCheckedTopics(): ReadonlyArray<string> {
		return Array.from(this.checkedTopicNames);
	}

	async refresh(): Promise<void> {
		this.cached = null;
		await this.load();
		this._onDidChangeTreeData.fire();
	}

	private scheduleRefresh(): void {
		if (this.pendingRefreshTimer) return;
		this.pendingRefreshTimer = setTimeout(() => {
			this.pendingRefreshTimer = undefined;
			this._onDidChangeTreeData.fire();
		}, 200);
	}

	private async loadParticipants(seq: number, topics: Ros2Topic[]): Promise<void> {
		// Limit concurrency to keep refresh responsive.
		const concurrency = 4;
		let nextIndex = 0;

		const worker = async () => {
			while (true) {
				if (seq !== this.loadSeq) return;
				const idx = nextIndex++;
				if (idx >= topics.length) return;
				const t = topics[idx];
				try {
					const participants = await getTopicParticipants(t.name);
					if (seq !== this.loadSeq) return;
					this.participantsByTopicName.set(t.name, participants);
					this.scheduleRefresh();
				} catch (err) {
					// Ignore per-topic failures; keep type-only display.
					if (seq !== this.loadSeq) return;
				}
			}
		};

		await Promise.all(Array.from({ length: Math.min(concurrency, topics.length) }, () => worker()));
	}

	private async load(): Promise<void> {
		try {
			this.output.appendLine('[ros2-topic-viewer] Refreshing topics...');
			const topics = await listTopics();
			this.cached = topics;
			this.participantsByTopicName.clear();
			const seq = ++this.loadSeq;
			const cfg = vscode.workspace.getConfiguration('ros2TopicViewer');
			const participantsEnabled = cfg.get<boolean>('topicParticipants.enabled', true);
			const maxTopics = Math.max(0, Number(cfg.get<number>('topicParticipants.maxTopics', 50)) || 50);
			if (participantsEnabled) {
				const target = maxTopics > 0 ? topics.slice(0, Math.min(maxTopics, topics.length)) : topics;
				if (maxTopics > 0 && topics.length > maxTopics) {
					this.output.appendLine(
						`[ros2-topic-viewer] topicParticipants: resolving first ${maxTopics}/${topics.length} topics (type-only for the rest)`
					);
				}
				void this.loadParticipants(seq, target);
			} else {
				this.output.appendLine('[ros2-topic-viewer] topicParticipants: disabled (type-only display)');
			}
			this.output.appendLine(`[ros2-topic-viewer] ${topics.length} topics`);
		} catch (err) {
			this.cached = [];
			this.participantsByTopicName.clear();
			const message = err instanceof Error ? err.message : String(err);
			this.output.appendLine(`[ros2-topic-viewer] ERROR: ${message}`);
			this.output.show(true);
			void vscode.window.showWarningMessage(`ROS2 topics refresh failed: ${message}`);
		}
	}
}
