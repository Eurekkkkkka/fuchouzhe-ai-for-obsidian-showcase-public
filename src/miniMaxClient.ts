/**
 * MiniMax API Client
 * 直接调用 MiniMax API 实现流式对话
 */

export interface MiniMaxMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

export interface MiniMaxStreamChunk {
	type: 'content' | 'thinking' | 'done' | 'error' | 'tool';
	delta?: string;
	stopReason?: string;
	error?: string;
	toolCall?: {
		id: string;
		name: string;
		arguments: Record<string, any>;
	};
}

export interface MiniMaxTool {
	name: string;
	description: string;
	input_schema: {
		type: 'object';
		properties: Record<string, any>;
		required?: string[];
	};
}

export interface MiniMaxClientOptions {
	apiKey: string;
	baseUrl?: string;
	model?: string;
	timeout?: number;
	tools?: MiniMaxTool[];
}

export class MiniMaxClient {
	private apiKey: string;
	private baseUrl: string;
	private model: string;
	private timeout: number;
	private tools: MiniMaxTool[];
	private abortController: AbortController | null = null;

	// 断路器状态
	private circuitState: 'closed' | 'open' | 'half-open' = 'closed';
	private consecutiveFailures = 0;
	private circuitOpenUntil = 0;
	private readonly circuitThreshold = 3;       // 连续失败 3 次触发断路
	private readonly circuitCooldown = 30000;     // 断路冷却 30 秒
	private readonly skillInterval = 800;         // skill 间隔 800ms

	constructor(options: MiniMaxClientOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = options.baseUrl || 'https://api.minimaxi.chat';
		this.model = options.model || 'MiniMax-Text-01';
		this.timeout = options.timeout || 300000;
		this.tools = options.tools || [];
	}

	setApiKey(apiKey: string): void {
		this.apiKey = apiKey;
	}

	setModel(model: string): void {
		this.model = model;
	}

	setBaseUrl(baseUrl: string): void {
		// P1-4: 支持动态更新 baseUrl，避免不必要的客户端重建
		this.baseUrl = baseUrl;
	}

	getBaseUrl(): string {
		return this.baseUrl;
	}

	abort(): void {
		this.abortController?.abort();
		this.abortController = null;
	}

	setTools(tools: MiniMaxTool[]): void {
		this.tools = tools;
		console.log('[MiniMax] Tools set:', tools.map(t => t.name).join(', '));
	}

	/**
	 * 发送消息并获取流式响应
	 * 断路器 + 指数退避重试（最多 5 次）+ skill 间隔节流
	 */
	async *chatStream(
		messages: MiniMaxMessage[],
		onChunk?: (chunk: MiniMaxStreamChunk) => void
	): AsyncGenerator<MiniMaxStreamChunk> {
		// 断路器检查
		if (this.circuitState === 'open') {
			const now = Date.now();
			if (now < this.circuitOpenUntil) {
				const waitSec = Math.ceil((this.circuitOpenUntil - now) / 1000);
				throw new Error(`服务暂时不可用，断路保护中（${waitSec}秒后自动恢复）`);
			}
			// 冷却结束，进入半开状态试探
			this.circuitState = 'half-open';
			console.log('[MiniMax] Circuit half-open, probing...');
		}

		// skill 间隔节流
		await this.sleep(this.skillInterval);

		const url = `${this.baseUrl}/v1/messages`;
		const maxRetries = 5;

		console.log('[MiniMax] Sending request to:', url);

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			this.abortController = new AbortController();

			const systemMessages = messages.filter(m => m.role === 'system');
			const chatMessages = messages.filter(m => m.role !== 'system');
			const systemPrompt = systemMessages.map(m => m.content).join('\n');

			const requestBody: Record<string, any> = {
			model: this.model,
			system: systemPrompt,
			messages: chatMessages.map(m => ({
				role: m.role,
				content: [
					{
						type: 'text',
						text: m.content
					}
				]
			})),
			stream: true,
		};

		// thinking 是 MiniMax 专用参数，其他模型不支持
		if (this.model.startsWith('MiniMax')) {
			requestBody.thinking = { type: 'enabled', budget_tokens: 8192 };
		}

		if (this.tools.length > 0) {
			requestBody.tools = this.tools;
			console.log('[MiniMax] Including tools in request:', this.tools.map(t => t.name).join(', '));
		}

			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(requestBody),
				signal: this.abortController.signal,
			});

			console.log('[MiniMax] Response status:', response.status);

			// 429/529: 服务端过载或限流，自动重试
			if ((response.status === 429 || response.status === 529) && attempt < maxRetries) {
				this.onRequestFailure();
				const waitMs = Math.min(3000 * Math.pow(2, attempt), 30000);
				console.warn(`[MiniMax] ${response.status} overloaded, retry ${attempt + 1}/${maxRetries} after ${waitMs}ms`);
				await this.sleep(waitMs);
				continue;
			}

			if (!response.ok) {
				const errorText = await response.text();
				console.error('[MiniMax] Error response:', errorText);
				this.onRequestFailure();
				throw new Error(`MiniMax API error: ${response.status} - ${errorText}`);
			}

			if (!response.body) {
				console.error('[MiniMax] No response body!');
				throw new Error('No response body');
			}

			// SSE 流式解析
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let accumulatedText = '';

			// 工具调用状态
			let currentToolCall: { id: string; name: string; inputJson: string } | null = null;

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						console.log('[MiniMax] Stream done, accumulated:', accumulatedText.length, 'chars');
						break;
					}

					const text = decoder.decode(value, { stream: true });
					buffer += text;

					// 处理完整行
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;

						// event 行 - 打印事件类型
						if (trimmed.startsWith('event:')) {
							console.log('[MiniMax] Event:', trimmed);
							continue;
						}

						// data 行
						if (trimmed.startsWith('data: ')) {
							const jsonStr = trimmed.slice(6);
							try {
								const data = JSON.parse(jsonStr);
								// 保留关键日志用于调试
								if (data?.type === 'content_block_start' || data?.type === 'content_block_stop') {
									console.log('[MiniMax] Block:', data?.type, data?.content_block?.type || '', data?.content_block?.name || '');
								}

								// content_block_start - 可能是 text、thinking 或 tool_use
								if (data?.type === 'content_block_start') {
									const blockType = data?.content_block?.type;
									if (blockType === 'tool_use') {
										currentToolCall = {
											id: data?.content_block?.id || '',
											name: data?.content_block?.name || '',
											inputJson: ''
										};
										console.log('[MiniMax] Tool call started:', currentToolCall.name);
									}
									continue;
								}

								// content_block_delta - 根据 delta type 处理不同内容
								if (data?.type === 'content_block_delta') {
									const deltaType = data?.delta?.type;

									if (deltaType === 'text_delta') {
										const content = data?.delta?.text;
										if (content) {
											accumulatedText += content;
											yield { type: 'content', delta: content } as MiniMaxStreamChunk;
										}
									} else if (deltaType === 'thinking_delta') {
										const content = data?.delta?.thinking;
										if (content) {
											yield { type: 'thinking', delta: content } as MiniMaxStreamChunk;
										}
									} else if (deltaType === 'input_json_delta') {
										// 工具参数 JSON 增量
										if (currentToolCall) {
											currentToolCall.inputJson += data?.delta?.partial_json || '';
										}
									}
									continue;
								}

								// content_block_stop - 内容块结束
								if (data?.type === 'content_block_stop') {
									// 如果是工具调用块，发送工具调用
									if (currentToolCall) {
										try {
											const args = JSON.parse(currentToolCall.inputJson || '{}');
											console.log('[MiniMax] Yielding tool call:', currentToolCall.name, 'args:', JSON.stringify(args).substring(0, 100));
											yield {
												type: 'tool',
												toolCall: {
													id: currentToolCall.id,
													name: currentToolCall.name,
													arguments: args
												}
											} as MiniMaxStreamChunk;
										} catch (e) {
											console.warn('[MiniMax] Failed to parse tool args:', e, 'input:', currentToolCall.inputJson);
											// 即使解析失败，也尝试提取有用信息
											console.warn('[MiniMax] Raw inputJson:', currentToolCall.inputJson);
										}
										currentToolCall = null;
									}
									continue;
								}

								// message_delta - 消息结束信息
								if (data?.type === 'message_delta') {
									console.log('[MiniMax] Message delta:', JSON.stringify(data?.delta).substring(0, 100));
								}

								// message_stop - 整个消息结束
								if (data?.type === 'message_stop') {
									console.log('[MiniMax] Message stop');
									yield { type: 'done', stopReason: 'stop' } as MiniMaxStreamChunk;
								}
							} catch (e) {
								console.warn('[MiniMax] Parse error:', e);
							}
						}
					}
				}
			} finally {
				reader.releaseLock();
			}

			// 成功完成，重置断路器
			this.onRequestSuccess();
			return;

		} catch (e) {
			// Ignore abort errors
			if (e instanceof DOMException && e.name === 'AbortError') {
				console.log('[MiniMax] Request aborted by user');
				return;
			}
			// 网络错误也可重试
			this.onRequestFailure();
			if (attempt < maxRetries) {
				const waitMs = Math.min(3000 * Math.pow(2, attempt), 30000);
				console.warn(`[MiniMax] Request error, retry ${attempt + 1}/${maxRetries} after ${waitMs}ms`, e);
				await this.sleep(waitMs);
				continue;
			}
			console.error('[MiniMax] Request error:', e);
			throw e;
		}
		} // end for retry loop
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	private onRequestSuccess(): void {
		this.consecutiveFailures = 0;
		if (this.circuitState !== 'closed') {
			console.log('[MiniMax] Circuit closed (recovered)');
			this.circuitState = 'closed';
		}
	}

	private onRequestFailure(): void {
		this.consecutiveFailures++;
		if (this.consecutiveFailures >= this.circuitThreshold && this.circuitState !== 'open') {
			this.circuitState = 'open';
			this.circuitOpenUntil = Date.now() + this.circuitCooldown;
			console.warn(`[MiniMax] Circuit OPEN — ${this.consecutiveFailures} consecutive failures, cooling down ${this.circuitCooldown / 1000}s`);
		}
	}

	/**
	 * 发送消息并获取完整响应（非流式）
	 */
	async chat(
		messages: MiniMaxMessage[],
		onChunk?: (chunk: MiniMaxStreamChunk) => void
	): Promise<string> {
		let fullContent = '';

		for await (const chunk of this.chatStream(messages, onChunk)) {
			if (chunk.type === 'content' && chunk.delta) {
				fullContent += chunk.delta;
			} else if (chunk.type === 'error') {
				throw new Error(chunk.error);
			}
		}

		return fullContent;
	}

	/**
	 * 检查 API Key 是否有效
	 */
	async validateApiKey(): Promise<boolean> {
		try {
			// 用正确的端点验证
			const response = await fetch(`${this.baseUrl}/v1/messages`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: this.model,
					max_tokens: 10,
					messages: [{ role: 'user', content: 'hi' }],
				}),
				signal: AbortSignal.timeout(10000),
			});
			// 检查响应内容
			const text = await response.text();
			return text.includes('content') || response.ok;
		} catch {
			return false;
		}
	}
}
