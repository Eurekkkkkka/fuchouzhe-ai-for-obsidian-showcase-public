/**
 * MiniMax MCP 客户端
 * 通过子进程管理 minimax-coding-plan-mcp 服务器
 */

import { spawn, ChildProcess } from 'child_process';
import { ToolResult, MCPRequest, MCPResponse, MCPNotification, MCPTool } from './types';

export interface MiniMaxMcpClientOptions {
	apiKey: string;
	apiHost?: string;
	basePath?: string;
	resourceMode?: 'url' | 'local';
	onNotification?: (notification: MCPNotification) => void;
	onError?: (error: string) => void;
}

export class MiniMaxMcpClient {
	private process: ChildProcess | null = null;
	private messageId = 0;
	private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
	private tools: MCPTool[] = [];
	private initialized = false;
	private apiKey: string;
	private apiHost: string;
	private basePath?: string;
	private resourceMode?: 'url' | 'local';
	private onNotification?: (notification: MCPNotification) => void;
	private onError?: (error: string) => void;

	constructor(options: MiniMaxMcpClientOptions) {
		this.apiKey = options.apiKey;
		this.apiHost = options.apiHost || 'https://api.minimaxi.com';
		this.basePath = options.basePath;
		this.resourceMode = options.resourceMode;
		this.onNotification = options.onNotification;
		this.onError = options.onError;
	}

	/**
	 * 启动 MCP 服务器
	 */
	async start(): Promise<void> {
		if (this.process) {
			console.log('[MiniMax MCP] Already running');
			return;
		}

		return new Promise((resolve, reject) => {
			console.log('[MiniMax MCP] Starting MCP server...');
			console.log('[MiniMax MCP] API Key length:', this.apiKey?.length || 0);
			console.log('[MiniMax MCP] API Key prefix:', this.apiKey?.substring(0, 8) || 'EMPTY', '...');

			// 构建环境变量
			const env: Record<string, string> = {
				...process.env,
				MINIMAX_API_KEY: this.apiKey,
				MINIMAX_API_HOST: this.apiHost,
			};

			if (this.basePath) {
				env.MINIMAX_MCP_BASE_PATH = this.basePath;
			}
			if (this.resourceMode) {
				env.MINIMAX_API_RESOURCE_MODE = this.resourceMode;
			}

			// 启动 uvx 进程
			this.process = spawn('uvx', ['minimax-coding-plan-mcp', '-y'], {
				env,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			// 收集 stdout 数据
			let stdoutBuffer = '';

			this.process.stdout?.on('data', (data: Buffer) => {
				stdoutBuffer += data.toString();
				this.processStdout(stdoutBuffer);
			});

			this.process.stderr?.on('data', (data: Buffer) => {
				console.log('[MiniMax MCP stderr]', data.toString());
			});

			this.process.on('error', (error) => {
				console.error('[MiniMax MCP] Process error:', error);
				this.onError?.(`MCP 服务器启动失败: ${error.message}`);
				reject(error);
			});

			this.process.on('exit', (code) => {
				console.log('[MiniMax MCP] Process exited with code:', code);
				this.process = null;
				this.initialized = false;
				if (code !== 0) {
					this.onError?.(`MCP 服务器异常退出，代码: ${code}`);
				}
			});

			// 初始化 MCP
			this.initialize()
				.then(() => {
					console.log('[MiniMax MCP] Initialized successfully');
					resolve();
				})
				.catch(reject);
		});
	}

	/**
	 * 处理 stdout 数据
	 */
	private processStdout(buffer: string) {
		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			try {
				const data = JSON.parse(trimmed);

				// 响应
				if (data.id !== undefined) {
					const pending = this.pendingRequests.get(data.id);
					if (pending) {
						this.pendingRequests.delete(data.id);
						if (data.error) {
							pending.reject(new Error(data.error.message));
						} else {
							pending.resolve(data.result);
						}
					}
				}
				// 通知
				else if (data.method) {
					this.onNotification?.(data as MCPNotification);
				}
			} catch (e) {
				// 非 JSON 数据，可能是调试输出
				console.log('[MiniMax MCP]', trimmed);
			}
		}
	}

	/**
	 * 初始化 MCP 连接
	 */
	private async initialize(): Promise<void> {
		const result = await this.sendRequest('initialize', {
			protocolVersion: '1.0',
			clientInfo: {
				name: 'fuchouzhe-ai-plugin',
				version: '1.0.0',
			},
			capabilities: {},
		});

		// 获取可用工具（调用 tools/list，因为某些 MCP 服务器不在 initialize 中返回 tools）
		try {
			const toolsResult = await this.sendRequest('tools/list', {});
			if (toolsResult && toolsResult.tools) {
				this.tools = toolsResult.tools;
			} else if (Array.isArray(toolsResult)) {
				this.tools = toolsResult;
			}
			console.log('[MiniMax MCP] Available tools:', this.tools.map((t) => t.name).join(', '));
		} catch (e) {
			console.warn('[MiniMax MCP] Failed to get tools list:', e);
		}

		this.initialized = true;
	}

	/**
	 * 发送 JSON-RPC 请求
	 */
	private sendRequest(method: string, params?: any): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.process || !this.process.stdin) {
				reject(new Error('MCP process not running'));
				return;
			}

			const id = ++this.messageId;
			const request: MCPRequest = {
				jsonrpc: '2.0',
				id,
				method,
				params,
			};

			this.pendingRequests.set(id, { resolve, reject });
			this.process.stdin.write(JSON.stringify(request) + '\n');

			// 超时处理
			setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error(`Request ${method} timed out`));
				}
			}, 60000);
		});
	}

	/**
	 * 停止 MCP 服务器
	 */
	stop(): void {
		if (this.process) {
			console.log('[MiniMax MCP] Stopping...');
			this.process.kill();
			this.process = null;
			this.initialized = false;
			this.pendingRequests.clear();
		}
	}

	/**
	 * 调用工具
	 */
	async callTool(name: string, arguments_: Record<string, any>): Promise<ToolResult> {
		if (!this.initialized) {
			return { success: false, error: 'MCP not initialized' };
		}

		try {
			console.log('[MiniMax MCP] Calling tool:', name, arguments_);

			const result = await this.sendRequest('tools/call', {
				name,
				arguments: arguments_,
			});

			// 解析结果
			if (result.content && result.content.length > 0) {
				const text = result.content[0]?.text;
				return { success: true, content: text, data: result };
			}

			return { success: true, content: '', data: result };
		} catch (error: any) {
			console.error('[MiniMax MCP] Tool call error:', error);
			return { success: false, error: error.message };
		}
	}

	/**
	 * 获取可用工具列表
	 */
	getTools(): MCPTool[] {
		return this.tools;
	}

	/**
	 * 检查是否已初始化
	 */
	isReady(): boolean {
		return this.initialized && this.process !== null;
	}

	/**
	 * 检查 uvx 是否可用
	 */
	static async checkUvxAvailable(): Promise<boolean> {
		return new Promise((resolve) => {
			const child = spawn('uvx', ['--version']);
			child.on('error', () => resolve(false));
			child.on('exit', (code) => resolve(code === 0));
		});
	}
}
