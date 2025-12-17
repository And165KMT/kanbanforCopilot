import { spawn, type ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import * as iconv from 'iconv-lite';
import { TextDecoder } from 'util';

export type Ros2Result = {
	stdout: string;
	stderr: string;
	code: number | null;
};

export type Ros2Topic = {
	name: string;
	type?: string;
};

export type OutputEncoding = 'auto' | 'utf8' | 'cp932';

function normalizeNodeFullName(nodeName: string, nodeNamespace?: string): string {
	const name = String(nodeName ?? '').trim();
	if (!name) return '';
	if (name.startsWith('/')) return name;
	const ns = String(nodeNamespace ?? '').trim();
	if (!ns || ns === '/') {
		return '/' + name.replace(/^\/+/, '');
	}
	return ns.replace(/\/+$/, '') + '/' + name.replace(/^\/+/, '');
}

function parseTopicInfoVerbose(text: string): { publishers: string[]; subscribers: string[] } {
	const publishers: string[] = [];
	const subscribers: string[] = [];
	let section: 'publishers' | 'subscribers' | 'none' = 'none';
	let pendingName: string | undefined;
	let pendingNamespace: string | undefined;

	const pushNode = (nameRaw?: string, nsRaw?: string) => {
		const full = normalizeNodeFullName(String(nameRaw ?? ''), nsRaw);
		if (!full) return;
		if (section === 'publishers') {
			if (!publishers.includes(full)) publishers.push(full);
		} else if (section === 'subscribers') {
			if (!subscribers.includes(full)) subscribers.push(full);
		}
	};

	for (const rawLine of String(text ?? '').split(/\r?\n/g)) {
		const line = rawLine.trim();
		if (!line) continue;

		if (/^Publisher count\s*:/i.test(line)) {
			section = 'publishers';
			pendingName = undefined;
			pendingNamespace = undefined;
			continue;
		}
		if (/^(Subscription|Subscriber) count\s*:/i.test(line)) {
			section = 'subscribers';
			pendingName = undefined;
			pendingNamespace = undefined;
			continue;
		}
		if (/^(Service|Action) (server|client) count\s*:/i.test(line)) {
			section = 'none';
			pendingName = undefined;
			pendingNamespace = undefined;
			continue;
		}
		if (section === 'none') continue;

		const mName = line.match(/^Node name\s*:\s*(.+)$/i);
		if (mName) {
			pendingName = mName[1].trim();
			pendingNamespace = undefined;
			if (pendingName.startsWith('/')) {
				pushNode(pendingName, undefined);
				pendingName = undefined;
			}
			continue;
		}

		const mNs = line.match(/^Node namespace\s*:\s*(.+)$/i);
		if (mNs) {
			pendingNamespace = mNs[1].trim();
			if (pendingName) {
				pushNode(pendingName, pendingNamespace);
				pendingName = undefined;
				pendingNamespace = undefined;
			}
			continue;
		}
	}

	if (pendingName) {
		pushNode(pendingName, pendingNamespace);
	}

	return { publishers, subscribers };
}

function isCommandNotFound(result: Ros2Result): boolean {
	// Typical shells return 127 when a command is not found.
	if (result.code === 127) return true;
	const stderr = (result.stderr || '').toLowerCase();
	return stderr.includes('not found') || stderr.includes('is not recognized');
}

function isSpawnEnoent(err: unknown): boolean {
	const e = err as NodeJS.ErrnoException;
	return e?.code === 'ENOENT';
}

type SpawnSpec = {
	command: string;
	args: string[];
	shell: boolean;
	env: NodeJS.ProcessEnv;
};

function buildRos2SpawnSpec(args: string[]): SpawnSpec {
	const {
		ros2Command,
		commandTemplate,
		dockerContainer,
		envFromSettings,
		rosDomainId,
		rmwImplementation
	} = getConfig();

	const argsString = args.map(quoteArg).join(' ');
	const resolvedTemplate = commandTemplate
		? commandTemplate.replaceAll('${args}', argsString).replaceAll('${container}', dockerContainer)
		: '';

	const extraEnv: Record<string, string> = {};
	if (rosDomainId && envFromSettings.ROS_DOMAIN_ID === undefined) {
		extraEnv.ROS_DOMAIN_ID = rosDomainId;
	}
	if (rmwImplementation && envFromSettings.RMW_IMPLEMENTATION === undefined) {
		extraEnv.RMW_IMPLEMENTATION = rmwImplementation;
	}
	const mergedEnv = { ...process.env, ...extraEnv, ...envFromSettings };

	if (resolvedTemplate) {
		return {
			command: resolvedTemplate,
			args: [],
			shell: true,
			env: mergedEnv
		};
	}

	if (dockerContainer) {
		const setupScript =
			'source "/opt/ros/${ROS_DISTRO:-humble}/setup.bash" >/dev/null 2>&1 || source "/opt/ros/humble/setup.bash" >/dev/null 2>&1';
		const ros2Script = `${setupScript} && ros2 ${argsString}`;

		const dockerEnvArgs: string[] = [];
		for (const [key, value] of Object.entries({ ...extraEnv, ...envFromSettings })) {
			dockerEnvArgs.push('-e', `${key}=${value}`);
		}

		return {
			command: 'docker',
			args: ['exec', '-i', ...dockerEnvArgs, dockerContainer, 'bash', '-lc', ros2Script],
			shell: false,
			env: mergedEnv
		};
	}

	return {
		command: ros2Command,
		args,
		shell: false,
		env: mergedEnv
	};
}

export function spawnRos2(args: string[]): ChildProcess {
	const spec = buildRos2SpawnSpec(args);
	return spawn(spec.command, spec.args, {
		shell: spec.shell,
		env: spec.env
	});
}

function getConfig() {
	const config = vscode.workspace.getConfiguration('ros2TopicViewer');
	const ros2Command = config.get<string>('ros2Command', 'ros2');
	const commandTemplate = config.get<string>('commandTemplate', '').trim();
	const dockerContainer = config.get<string>('dockerContainer', '').trim();
	const envFromSettings = config.get<Record<string, string>>('env', {});
	const outputEncoding = config.get<OutputEncoding>('outputEncoding', 'auto');
	const rosDomainIdRaw = config.get<number | string>('rosDomainId', '');
	const rosDomainId = String(rosDomainIdRaw ?? '').trim();
	const rmwImplementation = config.get<string>('rmwImplementation', '').trim();
	return {
		ros2Command,
		commandTemplate,
		dockerContainer,
		envFromSettings,
		outputEncoding,
		rosDomainId,
		rmwImplementation
	};
}

function quoteArg(arg: string): string {
	if (arg.length === 0) {
		return '""';
	}
	if (!/[\s"]/g.test(arg)) {
		return arg;
	}
	return '"' + arg.replaceAll('"', '\\"') + '"';
}

function quoteCommand(command: string): string {
	if (command.length === 0) return '""';
	if (!/[\s"]/g.test(command)) return command;
	return '"' + command.replaceAll('"', '\\"') + '"';
}


function decodeOutput(buffer: Buffer, outputEncoding: OutputEncoding): string {
	if (outputEncoding === 'cp932') {
		return iconv.decode(buffer, 'cp932');
	}
	if (outputEncoding === 'utf8') {
		return buffer.toString('utf8');
	}

	// auto
	const utf8 = buffer.toString('utf8');
	if (process.platform === 'win32') {
		// If UTF-8 decoding produced replacement characters, it's likely CP932 output.
		if (utf8.includes('\uFFFD')) {
			return iconv.decode(buffer, 'cp932');
		}
	}
	return utf8;
}

export function decodeRos2OutputBuffer(buffer: Buffer): string {
	const { outputEncoding } = getConfig();
	return decodeOutput(buffer, outputEncoding);
}

export type Ros2StreamDecoder = {
	write: (chunk: Buffer | string) => string;
	end: () => string;
};

function createUtf8StreamDecoder(): Ros2StreamDecoder {
	const decoder = new TextDecoder('utf-8');
	return {
		write: (chunk) => {
			if (typeof chunk === 'string') return chunk;
			return decoder.decode(chunk, { stream: true });
		},
		end: () => decoder.decode()
	};
}

function createCp932StreamDecoder(): Ros2StreamDecoder {
	const decoder = iconv.getDecoder('cp932');
	return {
		write: (chunk) => {
			if (typeof chunk === 'string') return chunk;
			const out = decoder.write(chunk);
			return typeof out === 'string' ? out : '';
		},
		end: () => {
			const out = decoder.end();
			return typeof out === 'string' ? out : '';
		}
	};
}

export function createRos2StreamDecoder(): Ros2StreamDecoder {
	const { outputEncoding } = getConfig();
	if (outputEncoding === 'cp932') return createCp932StreamDecoder();
	if (outputEncoding === 'utf8') return createUtf8StreamDecoder();

	// auto
	if (process.platform !== 'win32') {
		return createUtf8StreamDecoder();
	}

	let decided: 'utf8' | 'cp932' | undefined;
	let delegate: Ros2StreamDecoder | undefined;
	const pending: Buffer[] = [];
	let pendingBytes = 0;

	const flushPendingIfDecided = (): string => {
		if (!decided || !delegate || pending.length === 0) return '';
		const all = Buffer.concat(pending);
		pending.length = 0;
		pendingBytes = 0;
		return delegate.write(all);
	};

	const decide = (): void => {
		if (decided) return;
		const all = pending.length > 0 ? Buffer.concat(pending) : Buffer.alloc(0);
		const utf8 = all.toString('utf8');
		decided = utf8.includes('\uFFFD') ? 'cp932' : 'utf8';
		delegate = decided === 'cp932' ? createCp932StreamDecoder() : createUtf8StreamDecoder();
	};

	return {
		write: (chunk) => {
			if (typeof chunk === 'string') return chunk;

			if (delegate) {
				return delegate.write(chunk);
			}

			pending.push(chunk);
			pendingBytes += chunk.length;
			if (pendingBytes >= 1024) {
				decide();
				return flushPendingIfDecided();
			}
			return '';
		},
		end: () => {
			if (delegate) {
				const flushed = flushPendingIfDecided();
				return flushed + delegate.end();
			}
			if (pending.length === 0) return '';

			const all = Buffer.concat(pending);
			pending.length = 0;
			pendingBytes = 0;

			const utf8 = all.toString('utf8');
			const chosen: 'utf8' | 'cp932' = utf8.includes('\uFFFD') ? 'cp932' : 'utf8';
			decided = chosen;
			delegate = chosen === 'cp932' ? createCp932StreamDecoder() : createUtf8StreamDecoder();
			return delegate.write(all) + delegate.end();
		}
	};
}

function buildShellCommand(base: string, args: string[]): string {
	const baseCommand = quoteCommand(base);
	const argString = args.map(quoteArg).join(' ');
	return argString.length > 0 ? `${baseCommand} ${argString}` : baseCommand;
}

export async function runRos2(args: string[], options?: { timeoutMs?: number }): Promise<Ros2Result> {
	const { outputEncoding } = getConfig();
	const spec = buildRos2SpawnSpec(args);

	return await new Promise<Ros2Result>((resolve, reject) => {
		const child = spawn(spec.command, spec.args, {
			shell: spec.shell,
			env: spec.env
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout?.on('data', (chunk: Buffer) => {
			stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});

		let timeout: NodeJS.Timeout | undefined;
		if (options?.timeoutMs && options.timeoutMs > 0) {
			timeout = setTimeout(() => {
				try {
					child.kill();
				} catch {
					// ignore
				}
				reject(new Error(`ros2 command timed out after ${options.timeoutMs}ms`));
			}, options.timeoutMs);
		}

		child.on('error', (err) => {
			if (timeout) clearTimeout(timeout);
			if (isSpawnEnoent(err)) {
				const baseHint = spec.command === 'docker'
					? 'docker not found. Install Docker CLI in this environment, or configure ros2TopicViewer.commandTemplate to use a remote/alternate execution method.'
					: 'ros2 not found. Configure ros2TopicViewer.ros2Command or ros2TopicViewer.commandTemplate.';
				reject(new Error(baseHint));
				return;
			}
			reject(err);
		});

		child.on('close', (code) => {
			if (timeout) clearTimeout(timeout);
			const stdout = decodeOutput(Buffer.concat(stdoutChunks), outputEncoding);
			const stderr = decodeOutput(Buffer.concat(stderrChunks), outputEncoding);
			const result: Ros2Result = { stdout, stderr, code };
			if (isCommandNotFound(result)) {
				const { commandTemplate, dockerContainer } = getConfig();
				const hintLines: string[] = [];
				hintLines.push('ros2 command not found.');
				hintLines.push('Check settings:');
				hintLines.push('- ros2TopicViewer.ros2Command (default: ros2)');
				hintLines.push('- ros2TopicViewer.commandTemplate (e.g. docker exec / source ROS setup)');
				if (!commandTemplate && !dockerContainer) {
					hintLines.push('- If you use Docker, set ros2TopicViewer.dockerContainer or commandTemplate with ${container}.');
				}
				const details = stderr.trim() ? `\n${stderr.trim()}` : '';
				reject(new Error(`${hintLines.join(' ')}${details}`));
				return;
			}
			resolve(result);
		});
	});
}

export async function listTopics(): Promise<Ros2Topic[]> {
	const result = await runRos2(['topic', 'list', '-t'], { timeoutMs: 5000 });
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `ros2 topic list failed (code=${result.code ?? 'null'})`);
	}

	const topics: Ros2Topic[] = [];
	for (const rawLine of result.stdout.split(/\r?\n/g)) {
		const line = rawLine.trim();
		if (!line) continue;

		const match = line.match(/^(\S+)\s+\[(.+)\]$/);
		if (match) {
			topics.push({ name: match[1], type: match[2] });
			continue;
		}
		topics.push({ name: line });
	}

	topics.sort((a, b) => a.name.localeCompare(b.name));
	return topics;
}

export async function getTopicParticipants(topicName: string): Promise<{ publishers: string[]; subscribers: string[] }> {
	const topic = String(topicName ?? '').trim();
	if (!topic) return { publishers: [], subscribers: [] };
	const cfg = vscode.workspace.getConfiguration('ros2TopicViewer');
	const timeoutMs = Math.max(500, Number(cfg.get<number>('topicParticipants.timeoutMs', 4000)) || 4000);
	const result = await runRos2(['topic', 'info', '-v', topic], { timeoutMs });
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `ros2 topic info failed (code=${result.code ?? 'null'})`);
	}
	return parseTopicInfoVerbose(result.stdout);
}
