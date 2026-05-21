import { Notice } from 'obsidian';
import { MiniMaxClient, type MiniMaxMessage, type MiniMaxStreamChunk } from './miniMaxClient';
import { ToolManager } from './tools';
import { SkillManager, type SkillDefinition } from './skills';
import * as fs from 'fs';
import * as path from 'path';

export interface FuchouzheMessage {
	type: 'stream' | 'thinking' | 'tool' | 'question' | 'plan' | 'error' | 'end';
	content?: string;
	data?: any;
}

export interface FuchouzheToolCall {
	id: string;
	name: string;
	input: any;
	status?: 'running' | 'completed' | 'error';
	result?: any;
	error?: string;
}

export interface SendMessageOptions {
	content: string;
	promptOverride?: string;
	filePath?: string;
	fileContent?: string;
	selection?: string;
	model?: string;
	mode?: string;
	thinkingEnabled?: boolean;
	images?: Array<{
		mediaType: string;
		data: string;  // base64
	}>;
	history?: Array<{ role: 'user' | 'assistant'; content: string }>;
	memoryContext?: string;  // 记忆上下文（已截断到预算内）
	onChunk?: (chunk: string) => void;
	onThinking?: (chunk: string) => void;
	onTool?: (tool: FuchouzheToolCall) => void;
	onEnd?: () => void;
	onError?: (error: string) => void;
}

export interface FuchouzheServiceConfig {
	apiProvider?: 'minimax' | 'deepseek' | 'zhipin';
	apiKey?: string;
	baseUrl?: string;
	model?: string;
	timeout?: number;
	enableSkills?: boolean;
	autoAttachFile?: boolean;
}

export class FuchouzheService {
	private apiClient: MiniMaxClient;
	private apiKey: string = '';
	private emit(type: string, data?: any): void {
		// P0-2: 直接从 handlerMap 发射，消除双存储导致的通知错乱
		const handlers = this.handlerMap.get(type);
		if (handlers) {
			handlers.forEach(handler => {
				try { handler(data); } catch (e) { console.error('[iFlow] Handler error:', e); }
			});
		}
	}
	private app: any;
	private toolManager: ToolManager | null = null;
	private skillManager: SkillManager;
	private settings: Partial<FuchouzheServiceConfig> = {};
	// P1-8: 系统 prompt 缓存，避免每次发送消息都重建
	private systemPromptCache: { prompt: string; toolsHash: string; skillsHash: string } | null = null;

	constructor(app?: any, toolManager?: ToolManager) {
		this.app = app;
		this.toolManager = toolManager || null;
		this.apiKey = '';
		this.skillManager = new SkillManager(app);
		this.apiClient = new MiniMaxClient({
			apiKey: '',
		});
	}

	updateConfig(settings: FuchouzheServiceConfig): void {
		this.settings = { ...this.settings, ...settings };

		if (settings.apiKey) {
			this.apiKey = settings.apiKey;
			this.apiClient.setApiKey(settings.apiKey);
		}

		if (settings.model) {
			this.apiClient.setModel(settings.model);
		}

		// P1-4: 只在 baseUrl 真正改变时才重建 MiniMaxClient，避免丢失内部状态
		if (settings.baseUrl && settings.baseUrl !== this.apiClient.getBaseUrl()) {
			this.apiClient = new MiniMaxClient({
				apiKey: this.apiKey,
				baseUrl: settings.baseUrl,
				model: settings.model || 'MiniMax-Text-01',
				timeout: settings.timeout || 300000, // 5 分钟超时
			});
		}
	}

	async checkConnection(): Promise<boolean> {
		if (!this.apiKey) {
			return false;
		}

		try {
			return await this.apiClient.validateApiKey();
		} catch {
			return false;
		}
	}

	async connect(): Promise<void> {
		if (!this.apiKey) {
			throw new Error('API Key not configured');
		}
	}

	/**
	 * 重新扫描 Skills 文件夹
	 */
	rescanSkills(): SkillDefinition[] {
		this.skillManager.reloadSkills();
		return this.skillManager.getAllSkills();
	}

	/**
	 * 检测是否触发了 Skill
	 */
	detectSkill(userMessage: string): { skill: any; prompt: string } | null {
		if (!this.settings.enableSkills) {
			return null;
		}

		// 懒加载 Skills
		this.skillManager.loadSkills();

		const skill = this.skillManager.detectSkill(userMessage);
		if (!skill) {
			return null;
		}

		const context = {
			userMessage,
			currentFile: '',
			date: new Date().toLocaleDateString('zh-CN'),
			time: new Date().toLocaleTimeString('zh-CN'),
			vaultPath: this.app?.vault?.adapter?.basePath || '',
		};

		const { systemPrompt, userPrompt } = this.skillManager.buildPrompt(skill, context);
		return { skill, prompt: userPrompt };
	}

	async sendMessage(options: SendMessageOptions): Promise<void> {
		console.log('[iFlow] sendMessage called, apiKey:', this.apiKey ? 'set' : 'empty');

		if (!this.apiKey) {
			new Notice('请先配置 API Key');
			options.onError?.('API Key not configured');
			return;
		}

		// 检测 Skill
		const skillMatch = this.detectSkill(options.content);
		const effectiveContent = skillMatch?.prompt || options.content;

		// 构建初始消息历史
		const messages: MiniMaxMessage[] = [];

		// 添加系统提示词
		let systemPrompt = await this.buildSystemPrompt();

		// 如果匹配了 Skill，将 Skill 的 systemPrompt 注入系统提示词
		if (skillMatch?.skill?.systemPrompt) {
			systemPrompt += '\n\n# 当前激活技能指令\n\n' + skillMatch.skill.systemPrompt;
			console.log('[iFlow] Skill system prompt injected:', skillMatch.skill.name);
		}

		messages.push({
			role: 'system',
			content: systemPrompt,
		});

		// 注入记忆上下文（在系统提示词之后、历史消息之前）
		if (options.memoryContext) {
			const memoryBlock = `# 长期记忆\n\n${options.memoryContext}`;
			messages.push({
				role: 'system',
				content: memoryBlock,
			});
			console.log('[iFlow] Memory context injected, tokens:', this.estimateTokens(memoryBlock));
		}

		// 添加历史对话（如果有）
		if (options.history && options.history.length > 0) {
			for (const msg of options.history) {
				messages.push({
					role: msg.role,
					content: msg.content,
				});
			}

			// 检查上下文是否超出限制，如果超出则截断旧消息
			this.truncateHistoryIfNeeded(messages);
		}

		// 添加文件内容（如果有）
		if (options.fileContent && this.settings.autoAttachFile !== false) {
			messages.push({
				role: 'user',
				content: `当前文件内容 (${options.filePath}):\n\`\`\`\n${options.fileContent}\n\`\`\``,
			});
		}

		// 添加选中文本（如果有）
		if (options.selection) {
			messages.push({
				role: 'user',
				content: `用户选中的内容:\n\`\`\`\n${options.selection}\n\`\`\``,
			});
		}

		// 添加用户消息
		const userContent = options.promptOverride || options.content;

		// 如果匹配了 Skill，将 Skill 指令作为用户消息的前缀（而非埋在 system prompt 底部）
		// 这样模型会把 skill 指令当成主要任务来执行
		if (skillMatch?.skill?.systemPrompt) {
			const skillInstruction = '【技能指令】\n' + skillMatch.skill.systemPrompt + '\n\n【用户请求】\n' + userContent;
			messages.push({
				role: 'user',
				content: skillInstruction,
			});
		} else {
			messages.push({
				role: 'user',
				content: userContent,
			});
		}

		try {
			// 清空之前的处理器
			this.clearHandlers();

			// 注册处理器
			if (options.onChunk) {
				this.on('stream', options.onChunk);
			}
			if (options.onThinking) {
				this.on('thinking', options.onThinking);
			}
			if (options.onTool) {
				this.on('tool', options.onTool);
			}
			if (options.onEnd) {
				this.on('end', options.onEnd);
			}
			if (options.onError) {
				this.on('error', options.onError);
			}

			// 发送请求并处理工具调用
			await this.sendMessageWithTools(messages, options);

		} catch (error: any) {
			// Ignore abort errors (user clicked stop)
			if (error.name === 'AbortError' || error.message?.includes('abort')) {
				console.log('[iFlow] Request aborted by user');
				return;
			}
			console.error('[iFlow] Send message error:', error);
			new Notice(`发送消息失败: ${error.message}`);
			options.onError?.(error.message);
		}
	}

	/**
	 * 发送消息并处理工具调用
	 */
	private async sendMessageWithTools(messages: MiniMaxMessage[], options: SendMessageOptions): Promise<void> {
		const maxIterations = 10; // 防止无限循环
		let iteration = 0;

		while (iteration < maxIterations) {
			iteration++;
			console.log('[iFlow] Message iteration:', iteration);

			// 设置工具（每次发消息时获取最新工具列表）
			if (this.toolManager) {
				const tools = this.toolManager.getAvailableTools();
				const miniMaxTools = tools.map(t => ({
					name: t.name,
					description: t.description,
					input_schema: t.inputSchema
				}));
				this.apiClient.setTools(miniMaxTools);
				console.log('[iFlow] Tools configured:', miniMaxTools.map(t => t.name).join(', '));
			}

			let accumulatedText = '';
			let lastOutputLength = 0; // 追踪上次输出到哪里
			let hasToolCall = false;
			const toolCalls: Array<{ name: string; args: Record<string, string> }> = [];
			const processedToolBlocks = new Set<string>(); // 避免重复处理
			const notifiedToolFingerprints = new Set<string>(); // 避免重复通知 UI（P0-1）

			// 发送请求并收集响应
			for await (const chunk of this.apiClient.chatStream(messages)) {
				if (chunk.type === 'thinking' && chunk.delta) {
					// Forward thinking chunks to UI
					this.emit('thinking', chunk.delta);
					continue;
				} else if (chunk.type === 'content' && chunk.delta) {
					accumulatedText += chunk.delta;

					// 检测并提取工具调用
					const toolBlocks = this.extractToolBlocks(accumulatedText);
					for (const toolBlock of toolBlocks) {
						if (!processedToolBlocks.has(toolBlock.block)) {
							processedToolBlocks.add(toolBlock.block);
							const parsed = this.parseToolCallBlock(toolBlock.block);
							if (parsed) {
								toolCalls.push(parsed);
								hasToolCall = true;
								console.log('[iFlow] Detected tool call:', parsed.name, parsed.args);

								// P0-1: 避免重复通知 UI（同一次迭代中同一工具只通知一次）
								const fingerprint = `${parsed.name}::${JSON.stringify(parsed.args)}`;
								if (!notifiedToolFingerprints.has(fingerprint)) {
									notifiedToolFingerprints.add(fingerprint);
									options.onTool?.({
										id: `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
										name: parsed.name,
										input: parsed.args,
										status: 'running',
									});
								}
							}
						}
					}

					// 检查是否有未完成的工具块（只有开标签没有闭标签）
					const hasOpenTag = accumulatedText.includes('[TOOL_CALL]') || accumulatedText.includes('<invoke');
					const hasCloseTag = accumulatedText.includes('[/TOOL_CALL]') || accumulatedText.includes('</invoke>');

					// 检查是否有不完整的开标签（如 [TOOL 而非 [TOOL_CALL]）
					const hasPartialOpenTag = (accumulatedText.includes('[TOOL') && !hasOpenTag) ||
						(accumulatedText.includes('<invoke') && !accumulatedText.includes('</invoke>') && !hasOpenTag);

					// 判断是否有未完成的工具块
					let hasIncompleteBlock = false;
					if ((hasOpenTag || hasPartialOpenTag) && !hasCloseTag) {
						hasIncompleteBlock = true;
					} else if (hasOpenTag && hasCloseTag) {
						// 有开标签和闭标签，检查最后一个块是否完整
						const lastClosePos = Math.max(
							accumulatedText.lastIndexOf('[/TOOL_CALL]'),
							accumulatedText.lastIndexOf('</invoke>')
						);
						const lastOpenPos = Math.max(
							accumulatedText.lastIndexOf('[TOOL_CALL]'),
							accumulatedText.lastIndexOf('<invoke')
						);
						if (lastOpenPos > lastClosePos) {
							hasIncompleteBlock = true;
						}
					}

					if (hasIncompleteBlock) {
						// 有未完成的工具块，不输出任何内容，等待完整
						// 但先输出开标签之前的内容（如果还没输出）
						const firstOpenPos = accumulatedText.indexOf('[TOOL_CALL]') >= 0
							? accumulatedText.indexOf('[TOOL_CALL]')
							: accumulatedText.indexOf('<invoke') >= 0
								? accumulatedText.indexOf('<invoke')
								: accumulatedText.indexOf('[TOOL');

						if (firstOpenPos > lastOutputLength) {
							const textToProcess = accumulatedText.substring(lastOutputLength, firstOpenPos);
							if (textToProcess && options.onChunk) {
								this.emit('stream', textToProcess);
							}
							lastOutputLength = firstOpenPos;
						}
				} else if (toolBlocks.length > 0) {
					// 所有工具块都完整，输出每个块之前的内容（块本身被跳过）
					for (const tb of toolBlocks) {
						if (tb.start > lastOutputLength) {
							// 输出这个块之前的内容
							const textToProcess = accumulatedText.substring(lastOutputLength, tb.start);
							if (textToProcess && options.onChunk) {
								this.emit('stream', textToProcess);
							}
						}
						// 跳过整个工具块
						lastOutputLength = tb.end;
					}
					// 输出最后一个块之后的内容
					const lastBlock = toolBlocks[toolBlocks.length - 1];
					if (lastBlock.end < accumulatedText.length) {
						const textToProcess = accumulatedText.substring(lastBlock.end);
						if (textToProcess && options.onChunk) {
							this.emit('stream', textToProcess);
						}
						lastOutputLength = accumulatedText.length;
					}
				} else if (!hasOpenTag && accumulatedText.length > lastOutputLength) {
					// 没有工具块，也没有未完成的工具块，输出所有新内容
					const textToProcess = accumulatedText.substring(lastOutputLength);
					if (textToProcess && options.onChunk) {
						this.emit('stream', textToProcess);
					}
					lastOutputLength = accumulatedText.length;
				} else if (hasOpenTag && toolBlocks.length === 0) {
					// P1-5: 有未完成的工具块（<tool_call> 未关闭），只输出 tag 之前的文本；
					// tag 之后的内容可能是工具名/参数，应等块完成后再输出，避免内容泄漏进正常输出
					const firstOpenPos = accumulatedText.indexOf('<tool_call>') !== -1
						? accumulatedText.indexOf('<tool_call>')
						: accumulatedText.indexOf('[TOOL_CALL]');
					if (firstOpenPos > lastOutputLength) {
						const textToProcess = accumulatedText.substring(lastOutputLength, firstOpenPos);
						if (textToProcess && options.onChunk) {
							this.emit('stream', textToProcess);
						}
						lastOutputLength = firstOpenPos;
					}
				}
			} else if (chunk.type === 'done') {
					console.log('[iFlow] Message done');
				} else if (chunk.type === 'tool' && chunk.toolCall) {
					// 直接处理 API 返回的结构化工具调用（而非从文本解析）
					const toolCall = chunk.toolCall;
					const fingerprint = `${toolCall.name}::${JSON.stringify(toolCall.arguments)}`;

					// P0-1: 去重 + 避免重复通知 UI
					if (!notifiedToolFingerprints.has(fingerprint)) {
						toolCalls.push({ name: toolCall.name, args: toolCall.arguments });
						hasToolCall = true;
						notifiedToolFingerprints.add(fingerprint);
						console.log('[iFlow] Detected tool call from stream:', toolCall.name, toolCall.arguments);

						// 通知 UI
						options.onTool?.({
							id: toolCall.id || `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
							name: toolCall.name,
							input: toolCall.arguments,
							status: 'running',
						});
					}
				} else if (chunk.type === 'error') {
					options.onError?.(chunk.error || 'Unknown error');
					return;
				}
			}

			// 如果没有工具调用，结束
			if (!hasToolCall || toolCalls.length === 0) {
				console.log('[iFlow] No more tool calls, ending');
				this.emit('end');
				return;
			}

			// 执行工具调用
			console.log('[iFlow] Executing', toolCalls.length, 'tool calls');
			const toolResults: string[] = [];

			for (const tool of toolCalls) {
				let result: string;
				try {
					const toolResult = await this.toolManager?.executeTool({
						name: tool.name,
						arguments: tool.args,
					});

					if (toolResult?.success) {
						result = typeof toolResult.content === 'string'
							? toolResult.content
							: JSON.stringify(toolResult.content);
						console.log('[iFlow] Tool result:', result.substring(0, 100));
					} else {
						result = `Error: ${toolResult?.error || 'Unknown error'}`;
						console.error('[iFlow] Tool error:', result);
					}
				} catch (error: any) {
					result = `Exception: ${error.message}`;
					console.error('[iFlow] Tool exception:', error);
				}

				toolResults.push(`[TOOL_RESULT]${tool.name}: ${result}[/TOOL_RESULT]`);
			}

			// 将工具结果添加为 assistant 消息
			messages.push({
				role: 'assistant',
				content: accumulatedText,
			});

			// 将工具结果作为用户消息发送
			messages.push({
				role: 'user',
				content: `工具执行结果:\n${toolResults.join('\n')}\n\n请根据结果继续回答。`,
			});

			console.log('[iFlow] Sending tool results back to AI, messages count:', messages.length);
		}

		console.log('[iFlow] Max iterations reached, ending');
		this.emit('end');
	}

	/**
	 * 从文本中提取工具调用块
	 */
	private extractToolBlocks(text: string): Array<{ block: string; start: number; end: number }> {
		const blocks: Array<{ block: string; start: number; end: number }> = [];

		// 检测 [TOOL_CALL]...[/TOOL_CALL] 格式 - 最优先检测
		let start = 0;
		while (true) {
			const openTag = '[TOOL_CALL]';
			const closeTag = '[/TOOL_CALL]';
			const openPos = text.indexOf(openTag, start);
			if (openPos === -1) break;

			const closePos = text.indexOf(closeTag, openPos);
			if (closePos === -1) break;

			const block = text.substring(openPos, closePos + closeTag.length);
			blocks.push({ block, start: openPos, end: closePos + closeTag.length });
			start = closePos + closeTag.length;
		}

		// 检测 <tool_call>...</tool_call> 格式
		start = 0;
		while (true) {
			const openTag = '<tool_call>';
			const closeTag = '</tool_call>';
			const openPos = text.indexOf(openTag, start);
			if (openPos === -1) break;

			const closePos = text.indexOf(closeTag, openPos);
			if (closePos === -1) break;

			const block = text.substring(openPos, closePos + closeTag.length);
			blocks.push({ block, start: openPos, end: closePos + closeTag.length });
			start = closePos + closeTag.length;
		}

		// 检测 <invoke name="...">...</invoke> 格式
		start = 0;
		while (true) {
			const openTag = '<invoke';
			const closeTag = '</invoke>';
			const openPos = text.indexOf(openTag, start);
			if (openPos === -1) break;

			const closePos = text.indexOf(closeTag, openPos);
			if (closePos === -1) break;

			const block = text.substring(openPos, closePos + closeTag.length);
			blocks.push({ block, start: openPos, end: closePos + closeTag.length });
			start = closePos + closeTag.length;
		}

		// 按起始位置排序
		blocks.sort((a, b) => a.start - b.start);
		return blocks;
	}

	/**
	 * 解析工具调用块
	 * P1-5: 支持 JSON 原生解析 + 三种 tag 格式
	 */
	private parseToolCallBlock(block: string): { name: string; args: Record<string, string> } | null {
		try {
			let name: string | undefined;
			const args: Record<string, string> = {};

			// 格式0（最优先）: 纯 JSON 对象 {"tool": "...", "args": {...}}
			// 匹配 <tool_call>{"tool": "...", ...}</tool_call> 中的内层 JSON
			const jsonOnlyMatch = block.match(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/);
			if (jsonOnlyMatch) {
				try {
					const parsed = JSON.parse(jsonOnlyMatch[1]);
					if (parsed.tool && typeof parsed.tool === 'string') {
						name = parsed.tool;
						// args 可能是嵌套对象，需要序列化
						if (parsed.args) {
							if (typeof parsed.args === 'object') {
								for (const [k, v] of Object.entries(parsed.args)) {
									args[k] = typeof v === 'string' ? v : JSON.stringify(v);
								}
							} else {
								args._raw = String(parsed.args);
							}
						}
						return { name, args };
					}
				} catch {
					// JSON 解析失败，回退到正则方式
				}
			}

			// 格式1: <tool_call>{"tool": "vault", "args": {...}}</tool_call>
			const toolCallMatch = block.match(/<tool_call>\s*\{[\s\S]*?"tool"\s*:\s*"([^"]+)"[\s\S]*?<\/tool_call>/);
			if (toolCallMatch) {
				name = toolCallMatch[1];

				// 提取 --key value 格式的参数
				const argMatches = block.matchAll(/--(\w+)\s+"([^"]+)"/g);
				for (const match of argMatches) {
					args[match[1]] = match[2];
				}
			}

			// 格式2: <invoke name="...">...</invoke>
			if (!name) {
				const invokeMatch = block.match(/<invoke\s+name="([^"]+)"/);
				name = invokeMatch?.[1];

				// 提取参数
				const xmlParamMatches = block.matchAll(/<parameter\s+name="([^"]+)">([^<]*)<\/parameter>/g);
				for (const match of xmlParamMatches) {
					args[match[1]] = match[2].trim();
				}
			}

			// 格式3: [TOOL_CALL]{tool => "..."}[/TOOL_CALL]
			if (!name) {
				const jsonStart = block.indexOf('{tool');
				if (jsonStart >= 0) {
					const toolNameMatch = block.substring(jsonStart).match(/tool\s*=>\s*"([^"]+)"/);
					name = toolNameMatch?.[1];

					// 提取 --key "value" 格式的参数
					const argMatches = block.matchAll(/--(\w+)\s+"([^"]+)"/g);
					for (const match of argMatches) {
						args[match[1]] = match[2];
					}
				}
			}

			if (!name) {
				console.warn('[iFlow] Could not parse tool name from:', block.substring(0, 100));
				return null;
			}

			console.log('[iFlow] Parsed tool:', name, args);
			return { name, args };
		} catch (error) {
			console.error('[iFlow] Error parsing tool block:', error);
			return null;
		}
	}

	/**
	 * 构建系统提示词
	 * P1-8: 带缓存，5分钟有效，避免每次发送消息都重建整个 prompt
	 */
	private async buildSystemPrompt(): Promise<string> {
		// 生成当前 tools 和 skills 的哈希，用于判断缓存是否过期
		const toolsStr = this.toolManager ? JSON.stringify(this.toolManager.getAvailableTools().map(t => ({ n: t.name, d: t.description }))) : '';
		const skillsStr = this.settings.enableSkills ? JSON.stringify(this.skillManager.getAllSkills().map(s => ({ n: s.name, d: s.description }))) : '';
		const toolsHash = this.hashString(toolsStr);
		const skillsHash = this.hashString(skillsStr);

		const now = Date.now();
		const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟缓存
		if (
			this.systemPromptCache &&
			this.systemPromptCache.toolsHash === toolsHash &&
			this.systemPromptCache.skillsHash === skillsHash &&
			(now - (this.systemPromptCache as any)._builtAt || 0) < CACHE_TTL_MS
		) {
			// 缓存命中：只更新时间部分
			return this.systemPromptCache.prompt;
		}

		// 获取当前时间
		const dateStr = new Date().toLocaleDateString('zh-CN', {
			year: 'numeric', month: 'long', day: 'numeric',
			weekday: 'long', hour: '2-digit', minute: '2-digit',
			timeZone: 'Asia/Shanghai'
		});

		// 从 .agent/persona.md 读取 persona
		let personaPrompt = `你是一个高效的 AI 助手，帮助用户处理 Obsidian 笔记库中的各种任务。`;
		try {
			// 使用 Node.js fs 读取隐藏文件夹中的文件（绕过 Obsidian vault API 对隐藏文件夹的限制）
			const vaultPath = this.app?.vault?.adapter?.basePath;
			if (vaultPath) {
				const personaPath = path.join(vaultPath, '.agent', 'persona.md');
				console.log('[iFlow] Trying to load persona from:', personaPath);
				if (fs.existsSync(personaPath)) {
					personaPrompt = fs.readFileSync(personaPath, 'utf-8');
					console.log('[iFlow] Persona loaded successfully, length:', personaPrompt.length);
				} else {
					console.warn('[iFlow] Persona file not found at path:', personaPath);
				}
			} else {
				console.warn('[iFlow] Cannot get vault path for persona loading');
			}
		} catch (e) {
			console.warn('[iFlow] Failed to load persona.md:', e);
		}

		// 添加时间信息
		const timePrompt = `\n\n# 当前时间（重要！）
当前时间是：${dateStr}（北京时间）
当你搜索"今日新闻"或"今天的新闻"时，必须使用以上当前时间，不要使用任何其他日期。`;

		// 添加可用工具说明
		let toolsPrompt = '';
		if (this.toolManager) {
			const tools = this.toolManager.getAvailableTools();
			if (tools.length > 0) {
				toolsPrompt += '\n\n# 可用工具\n\n';
				for (const tool of tools) {
					toolsPrompt += `## ${tool.name}\n${tool.description}\n`;
					if (tool.inputSchema?.properties) {
						toolsPrompt += '参数:\n';
						for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
							toolsPrompt += `- ${key}: ${(prop as any).description || (prop as any).type}\n`;
						}
					}
				}
			}
		}

		// 添加 Skills 说明
		let skillsPrompt = '';
		if (this.settings.enableSkills) {
			const skills = this.skillManager.getAllSkills();
			if (skills.length > 0) {
				skillsPrompt += '\n\n# 可用技能\n\n';
				for (const skill of skills) {
					skillsPrompt += `- **${skill.name}**：${skill.description}（触发词: ${skill.triggers.join(', ')})\n`;
				}
				skillsPrompt += '\n当用户使用触发词时，自动应用对应技能。';
			}
		}

		const finalPrompt = personaPrompt + timePrompt + toolsPrompt + skillsPrompt;
		this.saveSystemPromptCache(finalPrompt, toolsHash, skillsHash);
		return finalPrompt;
	}

	// P1-8: 在 buildSystemPrompt 最后调用，保存缓存
	private saveSystemPromptCache(prompt: string, toolsHash: string, skillsHash: string): void {
		this.systemPromptCache = { prompt, toolsHash, skillsHash, _builtAt: Date.now() } as any;
	}

	/**
	 * 如果历史对话超出上下文限制，截断旧消息
	 */
	private truncateHistoryIfNeeded(messages: MiniMaxMessage[]): void {
		const CONTEXT_LIMIT = 150000; // P1-7: 150K tokens 软限制（原 180K 偏高，易超限）
		const MIN_MESSAGES_TO_KEEP = 2; // 至少保留最近 2 条消息

		// 计算当前 tokens
		let totalTokens = 0;
		for (const msg of messages) {
			// 粗略估算：中文约 2 chars/token，英文约 4 chars/token
			totalTokens += this.estimateTokens(msg.content);
			// 加上 role 和 overhead
			totalTokens += 20;
		}

		console.log('[iFlow] Context tokens:', totalTokens, '/', CONTEXT_LIMIT);

		if (totalTokens <= CONTEXT_LIMIT) {
			return; // 不需要截断
		}

		// 需要截断：保留系统消息，截断历史对话
		const systemMsg = messages[0]; // 系统消息
		const historyMsgs = messages.slice(1); // 历史消息（不含系统消息）

		// 从最新的消息开始保留
		const keptMsgs: MiniMaxMessage[] = [];
		let keptTokens = this.estimateTokens(systemMsg.content) + 20;

		for (let i = historyMsgs.length - 1; i >= 0; i--) {
			const msg = historyMsgs[i];
			const msgTokens = this.estimateTokens(msg.content) + 20;

			if (keptTokens + msgTokens <= CONTEXT_LIMIT * 0.9) {
				keptMsgs.unshift(msg);
				keptTokens += msgTokens;
			} else if (keptMsgs.length >= MIN_MESSAGES_TO_KEEP) {
				break;
			}
		}

		// 如果保留的消息太少（少于 MIN_MESSAGES_TO_KEEP），强制保留更多
		if (keptMsgs.length < MIN_MESSAGES_TO_KEEP && historyMsgs.length >= MIN_MESSAGES_TO_KEEP) {
			keptMsgs.length = 0;
			keptTokens = this.estimateTokens(systemMsg.content) + 20;
			for (let i = historyMsgs.length - 1; i >= 0 && keptMsgs.length < MIN_MESSAGES_TO_KEEP; i--) {
				const msg = historyMsgs[i];
				keptMsgs.unshift(msg);
				keptTokens += this.estimateTokens(msg.content) + 20;
			}
		}

		// 生成摘要说明
		const summary = `【早期对话已截断】保留了最近 ${keptMsgs.length} 条消息，约 ${Math.round(keptTokens / 1000)}k tokens。`;

		// 重建消息数组
		messages.length = 0;
		messages.push(systemMsg);
		if (keptMsgs.length > 0) {
			messages.push({
				role: 'system',
				content: summary,
			});
			messages.push(...keptMsgs);
		}

		console.log('[iFlow] Context truncated. Kept', keptMsgs.length, 'messages');
	}

	/**
	 * 估算文本 token 数
	 * P1-7: 改进精度，采用 GPT 系 tokenizer 的字节级估算
	 * 规则：中/日/韩字符=2 tokens，字母/数字/常见符号≈1 token，空格=0
	 */
	private estimateTokens(text: string): number {
		if (!text) return 0;
		let tokenCount = 0;
		let i = 0;

		while (i < text.length) {
			const charCode = text.charCodeAt(i);
			// 中日韩统一表意文字 (CJK Unified Ideographs)
			if (charCode >= 0x4E00 && charCode <= 0x9FFF) {
				tokenCount += 2;
				i += 1;
			// 韩文字母音节
			} else if (charCode >= 0xAC00 && charCode <= 0xD7AF) {
				tokenCount += 2;
				i += 1;
			// 日文平假名/片假名
			} else if ((charCode >= 0x3040 && charCode <= 0x309F) || (charCode >= 0x30A0 && charCode <= 0x30FF)) {
				tokenCount += 2;
				i += 1;
			// 常见 ASCII 标点/字母/数字：每个字符约 0.25~1 token，这里保守取 0.5
			} else if (charCode <= 127) {
				tokenCount += 0.5;
				i += 1;
			} else {
				// 其他多字节字符（拉丁字母等）：保守取 1
				tokenCount += 1;
				i += 1;
			}
		}

		return Math.ceil(tokenCount);
	}

	private handlerMap = new Map<string, Set<(data: any) => void>>();

	on(type: string, handler: (data: any) => void): void {
		// P0-2: 只用 handlerMap 单存储，消除重复注册
		if (!this.handlerMap.has(type)) {
			this.handlerMap.set(type, new Set());
		}
		this.handlerMap.get(type)!.add(handler);
	}

	off(type: string, handler: (data: any) => void): void {
		const handlers = this.handlerMap.get(type);
		if (handlers) {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this.handlerMap.delete(type);
			}
		}
	}

	clearHandlers(): void {
		// P0-2: 只清理 handlerMap
		this.handlerMap.clear();
	}

	dispose(): void {
		this.clearHandlers();
	}

	getSkillManager(): SkillManager {
		// 确保 skills 已加载（首次调用时触发懒加载）
		this.skillManager.loadSkills();
		return this.skillManager;
	}

	getMiniMaxClient(): MiniMaxClient {
		return this.apiClient;
	}

	getToolManager(): ToolManager | null {
		return this.toolManager;
	}

	abort(): void {
		this.apiClient.abort();
		this.emit('end');
	}

	// 简单的字符串哈希（用于缓存失效检测）
	private hashString(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash;
		}
		return Math.abs(hash).toString(36);
	}
}
