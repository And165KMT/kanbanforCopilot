(function () {
	const logEl = document.getElementById('log');
	const statusEl = document.getElementById('status-line');
	const topicsListEl = document.getElementById('topics-list');
	const canvas = document.getElementById('waveform-canvas');
	const ctx = canvas ? canvas.getContext('2d') : null;

	function appendLog(text) {
		if (!text) return;
		logEl.textContent += text;
		logEl.scrollTop = logEl.scrollHeight;
	}

	try {
		statusEl.textContent = 'Status: (script started)';
		topicsListEl.textContent = '(loading topics...)';

		let vscode;
		try {
			vscode = acquireVsCodeApi();
			statusEl.textContent = 'Status: (vscode api ok)';
		} catch (e) {
			statusEl.textContent = 'Status: (vscode api unavailable)';
			appendLog('\n[panel] acquireVsCodeApi failed: ' + String(e) + '\n');
			return;
		}

		let topics = [];
		let active = new Set();
		let isApplyingState = false;
		let waveformConfig = { fieldPath: '', maxPoints: 2000, throttleMs: 50 };
		/** @type {Map<string, {t:number, v:number}[]>} */
		let samplesByTopic = new Map();
		let lastDrawAt = 0;
		let drawScheduled = false;

		const colorVarNames = [
			'--vscode-charts-blue',
			'--vscode-charts-green',
			'--vscode-charts-orange',
			'--vscode-charts-purple',
			'--vscode-charts-red',
			'--vscode-charts-yellow'
		];

		function getSeriesColor(topic) {
			const topicList = Array.from(active.values()).sort();
			const idx = Math.max(0, topicList.indexOf(topic));
			const cssVar = colorVarNames[idx % colorVarNames.length];
			const v = getComputedStyle(document.body).getPropertyValue(cssVar).trim();
			return v || '#4FC3F7';
		}

		function ensureCanvasSize() {
			if (!canvas || !ctx) return;
			const dpr = window.devicePixelRatio || 1;
			const parent = canvas.parentElement;
			if (!parent) return;
			const w = Math.max(1, parent.clientWidth);
			const h = Math.max(1, parent.clientHeight);
			const cw = Math.floor(w * dpr);
			const ch = Math.floor(h * dpr);
			if (canvas.width !== cw || canvas.height !== ch) {
				canvas.width = cw;
				canvas.height = ch;
				canvas.style.width = w + 'px';
				canvas.style.height = h + 'px';
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.scale(dpr, dpr);
			}
		}

		function pruneSamplesToActive() {
			// Keep last-known data even after a topic is unchecked.
			for (const t of active.values()) {
				if (!samplesByTopic.has(t)) samplesByTopic.set(t, []);
			}
		}

		function scheduleDraw() {
			if (!ctx || !canvas) return;
			if (drawScheduled) return;
			drawScheduled = true;
			requestAnimationFrame(() => {
				drawScheduled = false;
				drawWaveform();
			});
		}

		function drawWaveform() {
			if (!ctx || !canvas) return;
			const now = Date.now();
			const throttleMs = Math.max(0, Number(waveformConfig.throttleMs) || 0);
			if (throttleMs > 0 && now - lastDrawAt < throttleMs) {
				scheduleDraw();
				return;
			}
			lastDrawAt = now;

			ensureCanvasSize();
			const parent = canvas.parentElement;
			const w = parent ? parent.clientWidth : canvas.clientWidth;
			const h = parent ? parent.clientHeight : canvas.clientHeight;
			ctx.clearRect(0, 0, w, h);
			ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
			ctx.fillRect(0, 0, w, h);

			ctx.lineWidth = 1;

			const activeTopics = Array.from(active.values());
			const allTopics = Array.from(new Set([...samplesByTopic.keys(), ...activeTopics]));
			let hasAny = false;
			for (const t of allTopics) {
				const s = samplesByTopic.get(t);
				if (s && s.length >= 2) {
					hasAny = true;
					break;
				}
			}

			if (!allTopics.length || !hasAny) {
				ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') || '#888';
				ctx.font = '12px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
				const msg = !allTopics.length ? 'Waveform: select (echo) a topic' : 'Waveform: waiting for samples';
				ctx.fillText(msg, 10, 18);
				return;
			}

			let minV = Infinity;
			let maxV = -Infinity;
			let minT = Infinity;
			let maxT = -Infinity;
			for (const t of allTopics) {
				const arr = samplesByTopic.get(t) || [];
				for (const s of arr) {
					if (typeof s.t === 'number' && Number.isFinite(s.t)) {
						minT = Math.min(minT, s.t);
						maxT = Math.max(maxT, s.t);
					}
					if (typeof s.v !== 'number' || Number.isNaN(s.v)) continue;
					minV = Math.min(minV, s.v);
					maxV = Math.max(maxV, s.v);
				}
			}
			if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
				return;
			}
			if (minV === maxV) {
				minV -= 1;
				maxV += 1;
			}

			const hasTimeRange = Number.isFinite(minT) && Number.isFinite(maxT) && maxT > minT;
			const timeRange = hasTimeRange ? maxT - minT : 1;

			const pad = 8;
			const plotW = Math.max(1, w - pad * 2);
			const plotH = Math.max(1, h - pad * 2);

			for (const t of allTopics) {
				const arr = samplesByTopic.get(t) || [];
				if (arr.length < 2) continue;
				ctx.globalAlpha = active.has(t) ? 1.0 : 0.35;
				ctx.strokeStyle = getSeriesColor(t);
				ctx.beginPath();
				const n = arr.length;
				for (let i = 0; i < n; i++) {
					const s = arr[i];
					const x = hasTimeRange
						? pad + ((s.t - minT) / timeRange) * plotW
						: pad + (i / (n - 1)) * plotW;
					const y = pad + (1 - (s.v - minV) / (maxV - minV)) * plotH;
					if (i === 0) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				}
				ctx.stroke();
			}
			ctx.globalAlpha = 1.0;

			ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') || '#888';
			ctx.font = '12px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
			const labelPath = waveformConfig.fieldPath ? waveformConfig.fieldPath : '(auto)';
			const labelTopics = allTopics.join(', ');
			const tLabel = hasTimeRange ? `dt=${(maxT - minT).toFixed(3)}s` : 'dt=(n/a)';
			ctx.fillText(
				`${labelTopics}  ${labelPath}  ${tLabel}  min=${minV.toFixed(3)} max=${maxV.toFixed(3)}`,
				10,
				18
			);
		}

		function renderTopics() {
			isApplyingState = true;
			topicsListEl.textContent = '';
			for (const t of topics) {
				const row = document.createElement('div');
				row.className = 'topic-row';

				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.checked = active.has(t.name);
				checkbox.addEventListener('change', () => {
					if (isApplyingState) return;
					vscode.postMessage({ type: 'setEcho', topic: t.name, checked: checkbox.checked });
				});

				const meta = document.createElement('div');
				meta.className = 'topic-meta';
				const nameEl = document.createElement('div');
				nameEl.textContent = t.name;
				const typeEl = document.createElement('div');
				typeEl.className = 'topic-type';
				typeEl.textContent = t.type ? t.type : '';
				meta.appendChild(nameEl);
				meta.appendChild(typeEl);

				row.appendChild(checkbox);
				row.appendChild(meta);
				topicsListEl.appendChild(row);
			}
			isApplyingState = false;
		}

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (!msg || typeof msg.type !== 'string') return;

			if (msg.type === 'appendLog') {
				appendLog(String(msg.text ?? ''));
				return;
			}
			if (msg.type === 'setStatus') {
				statusEl.textContent = 'Status: ' + String(msg.text ?? '');
				return;
			}
			if (msg.type === 'hello') {
				appendLog('\n[panel] ' + String(msg.text ?? '') + '\n');
				return;
			}
			if (msg.type === 'setTopics') {
				topics = Array.isArray(msg.topics) ? msg.topics : [];
				renderTopics();
				return;
			}
			if (msg.type === 'setEchoActive') {
				const arr = Array.isArray(msg.topics) ? msg.topics : [];
				active = new Set(arr);
				pruneSamplesToActive();
				renderTopics();
				scheduleDraw();
				return;
			}
			if (msg.type === 'setWaveformConfig') {
				const cfg = msg.config || {};
				waveformConfig = {
					fieldPath: String(cfg.fieldPath ?? ''),
					maxPoints: Math.max(100, Number(cfg.maxPoints ?? 2000) || 2000),
					throttleMs: Math.max(0, Number(cfg.throttleMs ?? 50) || 0)
				};
				for (const [k, arr] of samplesByTopic.entries()) {
					if (arr.length > waveformConfig.maxPoints) {
						arr.splice(0, arr.length - waveformConfig.maxPoints);
					}
					samplesByTopic.set(k, arr);
				}
				scheduleDraw();
				return;
			}
			if (msg.type === 'appendSample') {
				const topic = String(msg.topic ?? '');
				const v = Number(msg.v);
				if (!topic) return;
				// Accept late samples even after uncheck so the last waveform is preserved.
				if (!active.has(topic) && !samplesByTopic.has(topic)) return;
				if (!Number.isFinite(v)) return;
				const t = typeof msg.t === 'number' && Number.isFinite(msg.t) ? msg.t : Date.now() / 1000;
				const arr = samplesByTopic.get(topic) || [];
				arr.push({ t, v });
				if (arr.length > waveformConfig.maxPoints) {
					arr.splice(0, arr.length - waveformConfig.maxPoints);
				}
				samplesByTopic.set(topic, arr);
				scheduleDraw();
				return;
			}
		});

		window.addEventListener('resize', () => scheduleDraw());
		setTimeout(() => scheduleDraw(), 0);

		vscode.postMessage({ type: 'ready' });
		setTimeout(() => vscode.postMessage({ type: 'requestState' }), 0);
	} catch (e) {
		try {
			statusEl.textContent = 'Status: (panel js error)';
			appendLog('\n[panel] error: ' + String(e) + '\n');
		} catch {
			// ignore
		}
	}
})();
