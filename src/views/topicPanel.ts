import * as vscode from 'vscode';

export type PanelTopic = { name: string; type?: string };

export type WaveformConfig = {
	fieldPath: string;
	maxPoints: number;
	throttleMs: number;
};

type PanelMessage =
	| { type: 'appendLog'; text: string }
	| { type: 'setStatus'; text: string }
	| { type: 'hello'; text: string }
	| { type: 'setTopics'; topics: PanelTopic[] }
	| { type: 'setEchoActive'; topics: string[] }
	| { type: 'setWaveformConfig'; config: WaveformConfig }
	| { type: 'appendSample'; topic: string; t?: number; v: number };

type IncomingMessage =
	| { type: 'ready' }
	| { type: 'requestState' }
	| { type: 'setEcho'; topic: string; checked: boolean };

function getNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export class TopicPanel {
	private static current: TopicPanel | undefined;
	private readonly buildId: string;
	private isReady = false;
	private pendingMessages: PanelMessage[] = [];
	private lastStatus: string | undefined;
	private readonly _onDidToggleEcho = new vscode.EventEmitter<{ topic: string; checked: boolean }>();
	readonly onDidToggleEcho = this._onDidToggleEcho.event;
	private readonly _onDidRequestState = new vscode.EventEmitter<void>();
	readonly onDidRequestState = this._onDidRequestState.event;
	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	readonly onDidDispose = this._onDidDispose.event;

	static createOrShow(extensionUri: vscode.Uri): TopicPanel {
		const column = vscode.ViewColumn.Beside;

		// Webviews created in older versions (or restored) may have scripts disabled and
		// will never run the panel JS. Recreate the panel to ensure correct options.
		if (TopicPanel.current) {
			try {
				TopicPanel.current.panel.dispose();
			} catch {
				// ignore
			}
			TopicPanel.current = undefined;
		}

		const panel = vscode.window.createWebviewPanel(
			'ros2TopicViewer.topicPanel',
			'ROS 2 Topic Panel',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);

		TopicPanel.current = new TopicPanel(panel, extensionUri);
		return TopicPanel.current;
	}

	static getCurrent(): TopicPanel | undefined {
		return TopicPanel.current;
	}

	static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): TopicPanel {
		TopicPanel.current = new TopicPanel(panel, extensionUri);
		return TopicPanel.current;
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly extensionUri: vscode.Uri
	) {
		this.buildId = new Date().toISOString();
		this.panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		this.panel.onDidDispose(() => this.dispose());
		this.panel.webview.onDidReceiveMessage((msg: IncomingMessage) => {
			if (msg?.type === 'ready') {
				this.isReady = true;
				this.flushPending();
				if (this.lastStatus !== undefined) {
					this.postMessage({ type: 'setStatus', text: this.lastStatus });
				}
				this.postMessage({ type: 'hello', text: 'Topic Panel ready' });
				this._onDidRequestState.fire();
				return;
			}
			if (msg?.type === 'requestState') {
				this._onDidRequestState.fire();
				return;
			}
			if (msg?.type === 'setEcho') {
				const topic = String((msg as any).topic ?? '').trim();
				const checked = Boolean((msg as any).checked);
				if (!topic) return;
				this._onDidToggleEcho.fire({ topic, checked });
				return;
			}
		});
		this.panel.webview.html = this.getHtml();
	}

	private reloadWebview(): void {
		// If the extension is reloaded while the panel is kept alive,
		// the webview may still show old HTML. Force-refresh to the latest UI.
		this.isReady = false;
		this.pendingMessages = [];
		this.panel.webview.html = this.getHtml();
	}

	dispose(): void {
		if (TopicPanel.current === this) {
			TopicPanel.current = undefined;
		}
		this._onDidDispose.fire();
	}

	appendLog(text: string): void {
		this.postMessage({ type: 'appendLog', text });
	}

	setStatus(text: string): void {
		this.lastStatus = text;
		this.postMessage({ type: 'setStatus', text });
	}

	setTopics(topics: PanelTopic[]): void {
		this.postMessage({ type: 'setTopics', topics });
	}

	setEchoActive(topicNames: string[]): void {
		this.postMessage({ type: 'setEchoActive', topics: topicNames });
	}

	setWaveformConfig(config: WaveformConfig): void {
		this.postMessage({ type: 'setWaveformConfig', config });
	}

	appendSample(topic: string, v: number, t?: number): void {
		this.postMessage({ type: 'appendSample', topic, v, t });
	}

	private postMessage(message: PanelMessage): void {
		if (!this.isReady) {
			this.pendingMessages.push(message);
			return;
		}
		void this.panel.webview.postMessage(message);
	}

	private flushPending(): void {
		if (!this.isReady) return;
		if (this.pendingMessages.length === 0) return;
		const messages = this.pendingMessages;
		this.pendingMessages = [];
		for (const msg of messages) {
			void this.panel.webview.postMessage(msg);
		}
	}

	private getHtml(): string {
		const nonce = getNonce();
		const scriptUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'topicPanel.js')
		);
		const csp = [
			"default-src 'none'",
			`style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
			`img-src ${this.panel.webview.cspSource} data: https:`,
			`script-src ${this.panel.webview.cspSource}`
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>ROS 2 Topic Panel</title>
	<style>
		:root {
			color-scheme: light dark;
		}
		body {
			margin: 0;
			padding: 0;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			height: 100vh;
			display: grid;
			grid-template-rows: auto 1fr minmax(120px, 0.6fr) auto;
		}
		.section {
			border-top: 1px solid var(--vscode-panel-border);
			padding: 8px;
			box-sizing: border-box;
		}
		#waveform {
			border-top: none;
			display: flex;
			align-items: center;
			justify-content: center;
			background: var(--vscode-editor-background);
		}
		#waveform-inner {
			width: 100%;
			height: 100%;
			border: 1px dashed var(--vscode-panel-border);
			box-sizing: border-box;
			display: flex;
			align-items: center;
			justify-content: center;
		}
		#log {
			overflow: auto;
			white-space: pre-wrap;
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
		}
		#status {
			display: grid;
			grid-template-columns: 1fr;
			gap: 6px;
		}
		.status-line {
			color: var(--vscode-descriptionForeground);
		}
		#topics {
			overflow: auto;
		}
		#topics-list {
			display: grid;
			gap: 6px;
		}
		.topic-row {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 8px;
			align-items: center;
		}
		.topic-meta {
			display: grid;
			gap: 2px;
		}
		.topic-type {
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
	</style>
</head>
<body>
	<div id="topics" class="section">
		<div class="status-line">Echo topics (check to start/stop)</div>
		<div id="topics-list" aria-label="Topics list"></div>
	</div>
	<div id="waveform" class="section">
		<div id="waveform-inner">
			<canvas id="waveform-canvas" aria-label="Waveform canvas"></canvas>
		</div>
	</div>
	<div id="log" class="section" aria-label="Text log"></div>
	<div id="status" class="section" aria-label="Status">
		<div id="status-line" class="status-line">Status: (html ${this.buildId})</div>
	</div>

	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
