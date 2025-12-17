import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { TopicsProvider } from './views/topicsProvider';
import { TopicPanel, WaveformConfig } from './views/topicPanel';
import { createRos2StreamDecoder, decodeRos2OutputBuffer, listTopics, runRos2, spawnRos2 } from './ros2/ros2Cli';

type TopicItemArg = { topic?: { name: string; type?: string } } | undefined;

function getTopicFromArg(arg: TopicItemArg): { name: string; type?: string } | null {
	const topic = arg?.topic;
	if (!topic?.name) return null;
	return topic;
}

async function listDockerContainers(): Promise<string[]> {
	return await new Promise<string[]>((resolve, reject) => {
		const child = spawn('docker', ['ps', '--format', '{{.Names}}'], {
			shell: true,
			env: process.env
		});

		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (err: Error) => reject(err));
		child.on('close', (code: number) => {
			if (code !== 0) {
				reject(new Error(stderr.trim() || `docker ps failed (code=${code})`));
				return;
			}
			const names = stdout
				.split(/\r?\n/g)
				.map((s) => s.trim())
				.filter(Boolean);
			resolve(names);
		});
	});
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('ROS2 Topic Viewer');
	// TreeView checkbox: used for terminal/output confirmation.
	const treeEchoChildren = new Map<string, ReturnType<typeof spawnRos2>>();
	// Topic Panel checkbox: used for in-panel log/waveform rendering.
	const panelEchoChildren = new Map<string, ReturnType<typeof spawnRos2>>();
	const panelEchoParseState = new Map<string, { partialLine: string; currentMsgLines: string[] }>();

	const topicsProvider = new TopicsProvider(output);
	const topicsView = vscode.window.createTreeView('ros2TopicViewer.topicsView', {
		treeDataProvider: topicsProvider
	});
	context.subscriptions.push(topicsView);
	let panelHandlersDisposable: vscode.Disposable | undefined;
	let attachedPanel: TopicPanel | undefined;

	function getActivePanel(): TopicPanel | undefined {
		return attachedPanel ?? TopicPanel.getCurrent();
	}

	function getWaveformConfig(): WaveformConfig {
		const cfg = vscode.workspace.getConfiguration('ros2TopicViewer');
		return {
			fieldPath: String(cfg.get<string>('waveform.fieldPath', '')).trim(),
			maxPoints: Math.max(100, Number(cfg.get<number>('waveform.maxPoints', 2000)) || 2000),
			throttleMs: Math.max(0, Number(cfg.get<number>('waveform.throttleMs', 50)) || 0)
		};
	}

	function ensureTopicPanel(): TopicPanel {
		const existing = getActivePanel();
		if (existing) return existing;
		const panel = TopicPanel.createOrShow(context.extensionUri);
		attachPanelHandlers(panel);
		void updatePanelTopics(panel);
		return panel;
	}

	async function runRos2StreamForDuration(args: string[], durationMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
		return await new Promise((resolve) => {
			const child = spawnRos2(args);
			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			child.stdout?.on('data', (chunk: Buffer | string) => {
				stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			child.stderr?.on('data', (chunk: Buffer | string) => {
				stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});

			const finish = (code: number | null) => {
				const stdout = decodeRos2OutputBuffer(Buffer.concat(stdoutChunks));
				const stderr = decodeRos2OutputBuffer(Buffer.concat(stderrChunks));
				resolve({ stdout, stderr, code });
			};
			child.once('close', (code) => finish(code));
			child.once('error', () => finish(null));

			setTimeout(() => {
				try {
					child.kill('SIGINT');
				} catch {
					// ignore
				}
				setTimeout(() => {
					if (child.exitCode === null) {
						try {
							child.kill('SIGKILL');
						} catch {
							// ignore
						}
					}
				}, 1000);
			}, Math.max(200, durationMs));
		});
	}

	function updatePanelWaveformConfig(panel?: TopicPanel): void {
		(panel ?? getActivePanel())?.setWaveformConfig(getWaveformConfig());
	}

	function updatePanelEchoActive(panel?: TopicPanel): void {
		(panel ?? getActivePanel())?.setEchoActive(Array.from(panelEchoChildren.keys()));
	}

	async function updatePanelTopics(panel?: TopicPanel): Promise<void> {
		try {
			const topics = await listTopics();
			(panel ?? getActivePanel())?.setTopics(topics);
			updatePanelEchoActive(panel);
			updatePanelWaveformConfig(panel);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			(panel ?? getActivePanel())?.appendLog(`\n[ros2-topic-viewer] failed to load topics: ${message}\n`);
		}
	}

	function parseRos2EchoMessageLines(lines: string[], fieldPath: string): { v?: number; t?: number } {
		function parseScalarToNumber(raw: string): number | undefined {
			const s = raw.trim().replace(/,$/, '').replace(/^['"]|['"]$/g, '');
			const lower = s.toLowerCase();
			if (lower === 'true') return 1;
			if (lower === 'false') return 0;
			const n = Number.parseFloat(s);
			return Number.isFinite(n) ? n : undefined;
		}

		const values = new Map<string, string>();
		const stack: Array<{ indent: number; key: string }> = [];
		for (const raw of lines) {
			const line = raw.replace(/\r/g, '');
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed.startsWith('#')) continue;
			if (trimmed.startsWith('- ')) continue;
			const m = /^(\s*)([^:\s][^:]*):\s*(.*)$/.exec(line);
			if (!m) continue;
			const indent = m[1].length;
			const key = m[2].trim();
			const rest = m[3];

			while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
				stack.pop();
			}

			if (rest.trim() === '') {
				stack.push({ indent, key });
				continue;
			}

			const pathParts = stack.map((s) => s.key).concat([key]);
			const fullPath = pathParts.join('.');
			values.set(fullPath, rest.trim());
		}

		let vStr: string | undefined;
		if (fieldPath) {
			vStr = values.get(fieldPath);
		} else {
			// Auto mode: prefer common std_msgs numeric field.
			vStr = values.get('data');
			if (!vStr) {
				// Otherwise, pick the first numeric leaf.
				for (const [, v] of values) {
					const n = Number.parseFloat(v);
					if (Number.isFinite(n)) {
						vStr = v;
						break;
					}
				}
			}
		}

		if (!vStr) return {};
		const v = parseScalarToNumber(vStr);
		if (v === undefined) return {};

		const secStr = values.get('header.stamp.sec') ?? values.get('stamp.sec');
		const nsecStr = values.get('header.stamp.nanosec') ?? values.get('stamp.nanosec');
		let t: number | undefined;
		if (secStr) {
			const sec = Number.parseInt(secStr, 10);
			const nsec = nsecStr ? Number.parseInt(nsecStr, 10) : 0;
			if (Number.isFinite(sec) && Number.isFinite(nsec)) {
				t = sec + nsec * 1e-9;
			}
		}

		return { v, t };
	}

	function handleEchoText(topicName: string, text: string): void {
		const panel = getActivePanel();
		if (!panel) return;
		const cfg = getWaveformConfig();

		const state = panelEchoParseState.get(topicName) ?? { partialLine: '', currentMsgLines: [] };
		let combined = state.partialLine + text;
		const parts = combined.split(/\n/);
		state.partialLine = parts.pop() ?? '';

		for (const line of parts) {
			if (line.trim() === '---') {
				const result = parseRos2EchoMessageLines(state.currentMsgLines, cfg.fieldPath);
				state.currentMsgLines = [];
				if (typeof result.v === 'number') {
					panel.appendSample(topicName, result.v, result.t);
				}
				continue;
			}
			state.currentMsgLines.push(line);
		}

		panelEchoParseState.set(topicName, state);
	}

	function attachPanelHandlers(panel: TopicPanel): void {
		if (attachedPanel === panel) return;
		panelHandlersDisposable?.dispose();
		attachedPanel = panel;
		panelHandlersDisposable = vscode.Disposable.from(
			panel.onDidDispose(() => {
				if (attachedPanel === panel) {
					attachedPanel = undefined;
				}
				// Stop panel-only echo when the panel is closed to avoid orphaned processes.
				void (async () => {
					const topics = Array.from(panelEchoChildren.keys());
					for (const name of topics) {
						await stopPanelEchoForTopic(name);
					}
				})();
				panelHandlersDisposable?.dispose();
				panelHandlersDisposable = undefined;
			}),
			panel.onDidToggleEcho(async ({ topic, checked }) => {
				if (checked) {
					await startPanelEchoForTopic(topic);
				} else {
					await stopPanelEchoForTopic(topic);
				}
				updatePanelEchoActive(panel);
			}),
			panel.onDidRequestState(async () => {
				await updatePanelTopics(panel);
				updatePanelEchoActive(panel);
				updatePanelWaveformConfig(panel);
			})
		);
		context.subscriptions.push(panelHandlersDisposable);
	}

	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer('ros2TopicViewer.topicPanel', {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
				const revived = TopicPanel.revive(panel, context.extensionUri);
				attachPanelHandlers(revived);
				await updatePanelTopics(revived);
			}
		})
	);

	async function stopTreeEchoForTopic(topicName: string): Promise<void> {
		const child = treeEchoChildren.get(topicName);
		if (!child || child.killed) {
			treeEchoChildren.delete(topicName);
			return;
		}

		output.show(true);
		output.appendLine(`[ros2-topic-viewer] stop tree echo: ${topicName}`);

		const exited = new Promise<void>((resolve) => {
			child.once('exit', () => resolve());
			child.once('error', () => resolve());
		});

		try {
			child.kill('SIGINT');
		} catch {
			// ignore
		}

		const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
		await Promise.race([exited, timeout]);

		// If the process is still running (common with docker exec + bash -lc), force kill.
		if (child.exitCode === null) {
			try {
				child.kill('SIGKILL');
			} catch {
				// ignore
			}
			await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 1000))]);
		}

		if (child.exitCode !== null) {
			treeEchoChildren.delete(topicName);
			topicsProvider.setTopicChecked(topicName, false);
		} else {
			output.appendLine(`\n[ros2-topic-viewer] WARNING: failed to stop echo process for ${topicName} (pid=${child.pid ?? 'null'})`);
		}
	}

	async function startTreeEchoForTopic(topicName: string): Promise<void> {
		const existing = treeEchoChildren.get(topicName);
		if (existing && !existing.killed) {
			return;
		}

		output.show(true);
		output.appendLine(`[ros2-topic-viewer] topic echo (tree): ${topicName}`);
		topicsProvider.setTopicChecked(topicName, true);

		const child = spawnRos2(['topic', 'echo', topicName]);
		treeEchoChildren.set(topicName, child);
		const stdoutDecoder = createRos2StreamDecoder();
		const stderrDecoder = createRos2StreamDecoder();

		child.stdout?.on('data', (chunk: Buffer | string) => {
			const text = stdoutDecoder.write(chunk);
			if (text) output.append(text);
		});
		child.stderr?.on('data', (chunk: Buffer | string) => {
			const text = stderrDecoder.write(chunk);
			if (text) output.append(text);
		});

		child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
			const tail = stdoutDecoder.end() + stderrDecoder.end();
			if (tail) output.append(tail);
			const current = treeEchoChildren.get(topicName);
			if (current === child) {
				treeEchoChildren.delete(topicName);
				topicsProvider.setTopicChecked(topicName, false);
			}
			output.appendLine(
				`\n[ros2-topic-viewer] echo exited (${topicName}): code=${code ?? 'null'} signal=${signal ?? 'null'}`
			);
		});

		child.on('error', (err: Error) => {
			const tail = stdoutDecoder.end() + stderrDecoder.end();
			if (tail) output.append(tail);
			const current = treeEchoChildren.get(topicName);
			if (current === child) {
				treeEchoChildren.delete(topicName);
				topicsProvider.setTopicChecked(topicName, false);
			}
			output.appendLine(`\n[ros2-topic-viewer] echo error (${topicName}): ${err.message}`);
			void vscode.window.showErrorMessage(`Failed to start echo (${topicName}): ${err.message}`);
		});
	}

	async function stopPanelEchoForTopic(topicName: string): Promise<void> {
		const child = panelEchoChildren.get(topicName);
		if (!child || child.killed) {
			panelEchoChildren.delete(topicName);
			panelEchoParseState.delete(topicName);
			return;
		}

		output.show(true);
		output.appendLine(`[ros2-topic-viewer] stop panel echo: ${topicName}`);
		getActivePanel()?.setStatus(`stop echo: ${topicName}`);

		const exited = new Promise<void>((resolve) => {
			child.once('exit', () => resolve());
			child.once('error', () => resolve());
		});

		try {
			child.kill('SIGINT');
		} catch {
			// ignore
		}

		const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
		await Promise.race([exited, timeout]);

		if (child.exitCode === null) {
			try {
				child.kill('SIGKILL');
			} catch {
				// ignore
			}
			await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 1000))]);
		}

		if (child.exitCode !== null) {
			panelEchoChildren.delete(topicName);
			panelEchoParseState.delete(topicName);
			updatePanelEchoActive();
		} else {
			output.appendLine(
				`\n[ros2-topic-viewer] WARNING: failed to stop echo process for ${topicName} (pid=${child.pid ?? 'null'})`
			);
		}
	}

	async function startPanelEchoForTopic(topicName: string): Promise<void> {
		const existing = panelEchoChildren.get(topicName);
		if (existing && !existing.killed) {
			return;
		}

		output.show(true);
		output.appendLine(`[ros2-topic-viewer] topic echo (panel): ${topicName}`);
		getActivePanel()?.setStatus(`echo: ${topicName}`);
		updatePanelEchoActive();

		const child = spawnRos2(['topic', 'echo', topicName]);
		panelEchoChildren.set(topicName, child);
		panelEchoParseState.set(topicName, { partialLine: '', currentMsgLines: [] });
		const stdoutDecoder = createRos2StreamDecoder();
		const stderrDecoder = createRos2StreamDecoder();

		child.stdout?.on('data', (chunk: Buffer | string) => {
			const text = stdoutDecoder.write(chunk);
			if (!text) return;
			output.append(text);
			getActivePanel()?.appendLog(text);
			handleEchoText(topicName, text);
		});
		child.stderr?.on('data', (chunk: Buffer | string) => {
			const text = stderrDecoder.write(chunk);
			if (!text) return;
			output.append(text);
			getActivePanel()?.appendLog(text);
			handleEchoText(topicName, text);
		});

		child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
			const tail = stdoutDecoder.end() + stderrDecoder.end();
			if (tail) {
				output.append(tail);
				getActivePanel()?.appendLog(tail);
				handleEchoText(topicName, tail);
			}
			const current = panelEchoChildren.get(topicName);
			if (current === child) {
				panelEchoChildren.delete(topicName);
				panelEchoParseState.delete(topicName);
				getActivePanel()?.setStatus('(idle)');
				updatePanelEchoActive();
			}
			output.appendLine(
				`\n[ros2-topic-viewer] echo exited (${topicName}): code=${code ?? 'null'} signal=${signal ?? 'null'}`
			);
		});

		child.on('error', (err: Error) => {
			const tail = stdoutDecoder.end() + stderrDecoder.end();
			if (tail) {
				output.append(tail);
				getActivePanel()?.appendLog(tail);
				handleEchoText(topicName, tail);
			}
			const current = panelEchoChildren.get(topicName);
			if (current === child) {
				panelEchoChildren.delete(topicName);
				panelEchoParseState.delete(topicName);
				getActivePanel()?.setStatus('(idle)');
				updatePanelEchoActive();
			}
			output.appendLine(`\n[ros2-topic-viewer] echo error (${topicName}): ${err.message}`);
			void vscode.window.showErrorMessage(`Failed to start echo (${topicName}): ${err.message}`);
		});
	}

	context.subscriptions.push(
		topicsView.onDidChangeCheckboxState(async (e) => {
			for (const [item, state] of e.items) {
				if (state === vscode.TreeItemCheckboxState.Checked) {
					await startTreeEchoForTopic(item.topic.name);
				} else {
					await stopTreeEchoForTopic(item.topic.name);
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.refreshTopics', async () => {
			await topicsProvider.refresh();
			await updatePanelTopics(getActivePanel());
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.openTopicPanel', async () => {
			const panel = TopicPanel.createOrShow(context.extensionUri);
			attachPanelHandlers(panel);
			panel.setStatus('opened');
			panel.appendLog('\n[ros2-topic-viewer] Open Topic Panel\n');
			panel.setWaveformConfig(getWaveformConfig());
			await updatePanelTopics(panel);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration('ros2TopicViewer.waveform.fieldPath') ||
				e.affectsConfiguration('ros2TopicViewer.waveform.maxPoints') ||
				e.affectsConfiguration('ros2TopicViewer.waveform.throttleMs')
			) {
				updatePanelWaveformConfig();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.copyTopicName', async (arg?: TopicItemArg) => {
			const topic = getTopicFromArg(arg);
			if (!topic) return;
			await vscode.env.clipboard.writeText(topic.name);
			void vscode.window.showInformationMessage(`Copied topic name: ${topic.name}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.copyTopicType', async (arg?: TopicItemArg) => {
			const topic = getTopicFromArg(arg);
			if (!topic) return;
			await vscode.env.clipboard.writeText(topic.type ?? '');
			void vscode.window.showInformationMessage(`Copied topic type: ${topic.type ?? '(empty)'}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.showTopicInfo', async (arg?: TopicItemArg) => {
			const topic = getTopicFromArg(arg);
			if (!topic) return;
			output.show(true);
			output.appendLine(`[ros2-topic-viewer] topic info: ${topic.name}`);
			try {
				const result = await runRos2(['topic', 'info', '-v', topic.name], { timeoutMs: 15000 });
				if (result.stderr.trim()) output.appendLine(result.stderr.trim());
				output.appendLine(result.stdout.trim() || '(no stdout)');
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				output.appendLine(`[ros2-topic-viewer] ERROR: ${message}`);
				void vscode.window.showWarningMessage(`ROS2 topic info failed: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.showTopicHz', async (arg?: TopicItemArg) => {
			const topic = getTopicFromArg(arg);
			if (!topic) return;
			const panel = ensureTopicPanel();
			panel.setStatus(`hz: ${topic.name} (sampling...)`);
			panel.appendLog(`\n[ros2-topic-viewer] topic hz: ${topic.name}\n`);
			try {
				const result = await runRos2StreamForDuration(['topic', 'hz', topic.name], 3000);
				if (result.stderr.trim()) panel.appendLog(result.stderr);
				panel.appendLog(result.stdout.trim() ? result.stdout : '(no stdout)');
				panel.appendLog('\n');
				panel.setStatus(`hz: ${topic.name} (done)`);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				panel.appendLog(`\n[ros2-topic-viewer] ERROR (hz): ${message}\n`);
				panel.setStatus(`hz: ${topic.name} (error)`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.showTopicBw', async (arg?: TopicItemArg) => {
			const topic = getTopicFromArg(arg);
			if (!topic) return;
			const panel = ensureTopicPanel();
			panel.setStatus(`bw: ${topic.name} (sampling...)`);
			panel.appendLog(`\n[ros2-topic-viewer] topic bw: ${topic.name}\n`);
			try {
				const result = await runRos2StreamForDuration(['topic', 'bw', topic.name], 3000);
				if (result.stderr.trim()) panel.appendLog(result.stderr);
				panel.appendLog(result.stdout.trim() ? result.stdout : '(no stdout)');
				panel.appendLog('\n');
				panel.setStatus(`bw: ${topic.name} (done)`);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				panel.appendLog(`\n[ros2-topic-viewer] ERROR (bw): ${message}\n`);
				panel.setStatus(`bw: ${topic.name} (error)`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.echoTopicOnce', async (arg?: TopicItemArg) => {
			const topic = getTopicFromArg(arg);
			if (!topic) return;
			output.show(true);
			output.appendLine(`[ros2-topic-viewer] topic echo (once): ${topic.name}`);
			try {
				const result = await runRos2(['topic', 'echo', '--once', topic.name], { timeoutMs: 20000 });
				if (result.stderr.trim()) output.appendLine(result.stderr.trim());
				output.appendLine(result.stdout.trim() || '(no stdout)');
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				output.appendLine(`[ros2-topic-viewer] ERROR: ${message}`);
				void vscode.window.showWarningMessage(`ROS2 topic echo failed: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.echoTopic', async (arg?: TopicItemArg) => {
			const topic = getTopicFromArg(arg);
			if (!topic) return;
			// Context menu action is a TreeView-driven operation (terminal/output confirmation).
			await startTreeEchoForTopic(topic.name);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.topicActions', async (arg?: TopicItemArg) => {
			const topic = getTopicFromArg(arg);
			if (!topic) return;

			type ActionItem = vscode.QuickPickItem & { cmd: string };
			const items: ActionItem[] = [
				{ label: 'Echo (start)', description: 'Stream to Output/terminal', cmd: 'ros2TopicViewer.echoTopic' },
				{ label: 'Echo (once)', description: 'Single message to Output', cmd: 'ros2TopicViewer.echoTopicOnce' },
				{ label: 'Show Hz', description: 'Sample ~3s and show in panel', cmd: 'ros2TopicViewer.showTopicHz' },
				{ label: 'Show Bw', description: 'Sample ~3s and show in panel', cmd: 'ros2TopicViewer.showTopicBw' },
				{ label: 'Show Info', description: 'ros2 topic info -v', cmd: 'ros2TopicViewer.showTopicInfo' },
				{ label: 'Copy Topic Name', cmd: 'ros2TopicViewer.copyTopicName' },
				{ label: 'Copy Topic Type', cmd: 'ros2TopicViewer.copyTopicType' }
			];

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: `Actions for ${topic.name}`
			});
			if (!picked) return;
			await vscode.commands.executeCommand(picked.cmd, arg);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.stopEcho', async () => {
			if (treeEchoChildren.size === 0 && panelEchoChildren.size === 0) {
				void vscode.window.showInformationMessage('Echo is not running.');
				return;
			}
			const treeTopics = Array.from(treeEchoChildren.keys());
			for (const name of treeTopics) {
				await stopTreeEchoForTopic(name);
			}
			const panelTopics = Array.from(panelEchoChildren.keys());
			for (const name of panelTopics) {
				await stopPanelEchoForTopic(name);
			}
		})
	);

	context.subscriptions.push({
		dispose: () => {
			for (const child of treeEchoChildren.values()) {
				if (!child.killed) {
					try {
						child.kill('SIGINT');
					} catch {
						// ignore
					}
				}
			}
			treeEchoChildren.clear();
			for (const child of panelEchoChildren.values()) {
				if (!child.killed) {
					try {
						child.kill('SIGINT');
					} catch {
						// ignore
					}
				}
			}
			panelEchoChildren.clear();
		}
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.selectDockerContainer', async () => {
			try {
				const containers = await listDockerContainers();
				if (containers.length === 0) {
					void vscode.window.showInformationMessage('No running Docker containers found (docker ps is empty).');
					return;
				}
				const picked = await vscode.window.showQuickPick(containers, {
					placeHolder: 'Select a running Docker container to use for ${container}'
				});
				if (!picked) return;

				const config = vscode.workspace.getConfiguration('ros2TopicViewer');
				await config.update('dockerContainer', picked, vscode.ConfigurationTarget.Global);
				void vscode.window.showInformationMessage(`ROS2 Topic Viewer: dockerContainer set to ${picked} (user settings)`);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				void vscode.window.showWarningMessage(`Docker container selection failed: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ros2TopicViewer.diagnostics', async () => {
			output.show(true);
			output.appendLine('[ros2-topic-viewer] Diagnostics start');
			output.appendLine(`[ros2-topic-viewer] node=${process.version}`);
			output.appendLine(`[ros2-topic-viewer] platform=${process.platform} arch=${process.arch}`);
			const cfg = vscode.workspace.getConfiguration('ros2TopicViewer');
			output.appendLine(
				`[ros2-topic-viewer] settings.ros2Command=${cfg.get<string>('ros2Command', 'ros2')}`
			);
			output.appendLine(
				`[ros2-topic-viewer] settings.commandTemplate=${cfg.get<string>('commandTemplate', '').trim() || '(empty)'}`
			);
			output.appendLine(
				`[ros2-topic-viewer] settings.dockerContainer=${cfg.get<string>('dockerContainer', '').trim() || '(empty)'}`
			);
			output.appendLine(
				`[ros2-topic-viewer] settings.rosDomainId=${String(cfg.get<number | string>('rosDomainId', '')).trim() || '(empty)'}`
			);
			output.appendLine(
				`[ros2-topic-viewer] settings.rmwImplementation=${cfg.get<string>('rmwImplementation', '').trim() || '(empty)'}`
			);
			output.appendLine(
				`[ros2-topic-viewer] settings.outputEncoding=${cfg.get<string>('outputEncoding', 'auto')}`
			);
			const pathValue = process.env.PATH || '';
			const parts = pathValue.split(path.delimiter).filter(Boolean);
			const pathPreview = parts.slice(0, 6).join(path.delimiter);
			output.appendLine(
				`[ros2-topic-viewer] PATH(first6)=${pathPreview}${parts.length > 6 ? `${path.delimiter}...` : ''}`
			);
			try {
				const result = await runRos2(['--help'], { timeoutMs: 5000 });
				output.appendLine(`[ros2-topic-viewer] ros2 --help exit=${result.code ?? 'null'}`);
				if (result.stderr.trim()) output.appendLine(result.stderr.trim());
				output.appendLine(result.stdout.split(/\r?\n/g).slice(0, 20).join('\n'));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				output.appendLine(`[ros2-topic-viewer] ros2 --help ERROR: ${message}`);
			}

			try {
				const result = await runRos2(['topic', 'list', '-t'], { timeoutMs: 15000 });
				output.appendLine(`[ros2-topic-viewer] ros2 topic list -t exit=${result.code ?? 'null'}`);
				if (result.stderr.trim()) output.appendLine(result.stderr.trim());
				output.appendLine(result.stdout.trim() || '(no stdout)');
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				output.appendLine(`[ros2-topic-viewer] ros2 topic list -t ERROR: ${message}`);
			}

			output.appendLine('[ros2-topic-viewer] Diagnostics end');
		})
	);
}

export function deactivate() {
	// no-op
}
