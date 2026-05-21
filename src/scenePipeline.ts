/**
 * 场景 Pipeline 执行引擎 v2
 * 按 ActionConfig.pipeline（skill id 列表）顺序执行，逐 skill 调用 API，传递上下文
 * writeback-output 步骤由代码直接执行，不走 AI
 */

import { ActionConfig, PipelineContext } from './sceneConfig';
import { SkillManager } from './skills';
import { MiniMaxClient, MiniMaxMessage } from './miniMaxClient';
import { ToolManager } from './tools';
import { FuchouzheToolCall } from './fuchouzheService';

export interface PipelineCallbacks {
	onStepStart: (skillId: string, label: string) => void;
	onStepChunk: (skillId: string, chunk: string) => void;
	onStepComplete: (skillId: string, result: string) => void;
	onStepError: (skillId: string, error: string) => void;
	onToolCall?: (tool: FuchouzheToolCall) => void;
	onComplete: (context: PipelineContext) => void;
	onError: (error: string) => void;
	/** 请求用户确认文件移动操作，返回 true 表示确认执行，false 表示取消 */
	onRequestMoveConfirmation?: (moves: Array<{ from: string; to: string }>) => Promise<boolean>;
}

export class ScenePipeline {
	private action: ActionConfig;
	private skillManager: SkillManager;
	private apiClient: MiniMaxClient;
	private toolManager: ToolManager | null;
	private app: any;
	private disabledSkills: Set<string>;
	private conversationStore: any;
	private callbacks: PipelineCallbacks | null = null;
	private aborted = false;

	constructor(options: {
		action: ActionConfig;
		skillManager: SkillManager;
		apiClient: MiniMaxClient;
		toolManager?: ToolManager | null;
		app?: any;
		disabledSkills?: Set<string>;
		conversationStore?: any;
	}) {
		this.action = options.action;
		this.skillManager = options.skillManager;
		this.apiClient = options.apiClient;
		this.toolManager = options.toolManager || null;
		this.app = options.app || null;
		this.disabledSkills = options.disabledSkills || new Set();
		this.conversationStore = options.conversationStore || null;
	}

	async execute(context: PipelineContext, callbacks: PipelineCallbacks): Promise<void> {
		this.aborted = false;
		this.callbacks = callbacks;

		try {
			for (const skillId of this.action.pipeline) {
				if (this.aborted) break;

				// 跳过被用户禁用的可选 skill
				if (this.disabledSkills.has(skillId)) continue;

				const stepLabel = this.action.stepLabels[skillId] || skillId;
				callbacks.onStepStart(skillId, stepLabel);

				try {
					let result: string;

					console.log('[ScenePipeline] skillId:', skillId, 'toolManager:', !!this.toolManager, 'pipeline:', JSON.stringify(this.action.pipeline));

					if (skillId === 'writeback-output') {
						// writeback 由代码直接执行，不走 AI
						result = await this.executeWriteback(context);
					} else if (skillId === 'websearch-news') {
						result = await this.executeWebSearch(context, 'news', skillId, callbacks);
					} else if (skillId === 'websearch-finance') {
						result = await this.executeWebSearch(context, 'finance', skillId, callbacks);
					} else if ((skillId === 'archive-ingest' || skillId.includes('archive-ingest')) && this.toolManager) {
						console.log('[ScenePipeline] MATCHED archive-ingest branch, skillId charCodes:', [...skillId].map(c => c.charCodeAt(0)).join(','));
						result = await this.executeArchiveIngest(skillId, context, callbacks);
					} else if ((skillId === 'archive-classifier' || skillId.includes('archive-classifier')) && this.toolManager) {
						result = await this.executeArchiveClassifier(skillId, context, callbacks);
					} else if ((skillId === 'archive-linker' || skillId.includes('archive-linker')) && this.toolManager) {
						result = await this.executeArchiveLinker(skillId, context, callbacks);
					} else {
						console.log('[ScenePipeline] NO MATCH for skillId:', skillId, 'charCodes:', [...skillId].map(c => c.charCodeAt(0)).join(','), 'going to executeSkill');
						result = await this.executeSkill(skillId, context, callbacks);
					}

					context.skillResults.set(skillId, result);
					callbacks.onStepComplete(skillId, result);
				} catch (err: any) {
					const errMsg = err?.message || String(err);
					callbacks.onStepError(skillId, errMsg);
					context.skillResults.set(skillId, null);
				}
			}

			if (!this.aborted) {
				callbacks.onComplete(context);
			}
		} catch (err: any) {
			callbacks.onError(err?.message || String(err));
		}
	}

	abort(): void {
		this.aborted = true;
		this.apiClient.abort();
	}

	// ============ writeback: 代码直接写文件 ============

	/**
	 * 从 skill 输出中提取简短标题（用于动态文件名）
	 */
	private extractTitle(context: PipelineContext): string {
		for (const [, result] of context.skillResults) {
			if (!result) continue;
			const headingMatch = result.match(/^#+\s+(.+)$/m);
			if (headingMatch) return headingMatch[1].replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30);
			const firstLine = result.split('\n').find(l => l.trim() && !l.startsWith('---'));
			if (firstLine) return firstLine.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30);
		}
		return '';
	}

	private async executeWriteback(context: PipelineContext): Promise<string> {
		console.log('[ScenePipeline] executeWriteback called, app:', !!this.app, 'vault:', !!this.app?.vault, 'toolManager:', !!this.toolManager);

		// 动态文件名：用户没手动改过且路径含 {{title}} 时，从输出提取标题替换
		if (!context.fileNameEdited && context.outputPath.includes('{{title}}')) {
			const title = this.extractTitle(context);
			context.outputPath = context.outputPath.replace(/\{\{title\}\}/g, title || this.action.name);
		}

		// 动态文件名：从 skill 输出的 frontmatter 中读取 filename 字段（通用方案）
		if (!context.fileNameEdited) {
			for (const [, skillOutput] of context.skillResults) {
				if (!skillOutput) continue;
				const filename = this.extractFilenameFromFrontmatter(skillOutput.trim());
				if (filename) {
					// outputPath 格式为 folder/subfolder/文章名.md
					// filename 格式为 subfolder/标题_YYYY-MM-DD（不含.md）
					// 提取 outputPath 中的 folder 部分（即去掉最后文件名，只留路径）
					const lastSlash = context.outputPath.lastIndexOf('/');
					const folder = lastSlash !== -1 ? context.outputPath.substring(0, lastSlash + 1) : '';
					// filename 可能是 subfolder/标题 或 只有标题
					const filenamePart = filename.includes('/')
						? filename.substring(filename.lastIndexOf('/') + 1)
						: filename;
					context.outputPath = folder + filenamePart + '.md';
					console.log('[ScenePipeline] filename from skill frontmatter:', filename, '→ outputPath:', context.outputPath);
					break;
				}
			}
		}

		const content = this.assembleMarkdown(context);
		const outputPath = context.outputPath;
		console.log('[ScenePipeline] writeback content length:', content.length, 'outputPath:', outputPath);
		console.log('[ScenePipeline] content preview (first 500):', content.substring(0, 500));

		if (!content.trim()) {
			return '无内容可写入';
		}

		// 优先用 Obsidian vault API 直接写
		if (this.app?.vault) {
			console.log('[ScenePipeline] Using vault API to write');
			await this.writeViaVaultApi(outputPath, content);
		} else if (this.toolManager) {
			console.log('[ScenePipeline] Using toolManager to write');
			// fallback: 通过 toolManager 调 vault 工具
			const result = await this.toolManager.executeTool({
				name: 'vault',
				arguments: { operation: 'write', path: outputPath, content },
			});
			if (!result.success) {
				throw new Error(result.error || '写入失败');
			}
		} else {
			throw new Error('无可用的写入方式');
		}

		// 执行 vault_move 指令（从 archive-classifier 输出中解析）
		const classifierOutput = context.skillResults.get('archive-classifier') || '';
		console.log('[ScenePipeline] executeVaultMoves classifierOutput length:', classifierOutput.length);
		const moveResults = await this.executeVaultMoves(classifierOutput);
		console.log('[ScenePipeline] executeVaultMoves results:', moveResults);

		// 追加移动结果到返回内容
		if (moveResults.length > 0) {
			return content + '\n\n## 文件移动结果\n' + moveResults.join('\n');
		}
		return content;
	}

	/**
	 * 从文本中解析 vault_move 指令
	 * 格式：vault_move|"源路径"|"目标路径"
	 */
	private parseVaultMoves(text: string): Array<{ from: string; to: string }> {
		const moves: Array<{ from: string; to: string }> = [];
		const regex = /vault_move\|"([^"]+)"\|"([^"]+)"/g;
		let match;
		while ((match = regex.exec(text)) !== null) {
			moves.push({ from: match[1], to: match[2] });
		}
		return moves;
	}

	/**
	 * 执行文件移动操作
	 */
	private async doVaultMove(fromPath: string, toPath: string): Promise<string> {
		try {
			if (this.app?.vault) {
				const file = this.app.vault.getFileByPath(fromPath);
				if (file) {
					// 确保目标父目录存在（自动创建中间目录）
					const normalizedTo = toPath.replace(/\\/g, '/');
					const lastSlash = normalizedTo.lastIndexOf('/');
					if (lastSlash > 0) {
						const parentDir = normalizedTo.substring(0, lastSlash);
						await this.ensureParentFolder(parentDir);
					}
					// 如果目标已存在，先删除再移动
					const destFile = this.app.vault.getFileByPath(toPath);
					if (destFile) {
						await this.app.vault.delete(destFile);
					}
					await this.app.fileManager.renameFile(file, toPath);
					return `✅ ${fromPath} → ${toPath}`;
				} else {
					return `⚠️ 文件不存在: ${fromPath}`;
				}
			} else if (this.toolManager) {
				const result = await this.toolManager.executeTool({
					name: 'vault',
					arguments: { operation: 'move', path: fromPath, destination: toPath },
				});
				if (result.success) {
					return `✅ ${fromPath} → ${toPath}`;
				} else {
					return `❌ 移动失败: ${fromPath} → ${toPath} (${result.error})`;
				}
			}
		} catch (e: any) {
			return `❌ 移动异常: ${fromPath} → ${toPath} (${e.message})`;
		}
		return `❌ 移动失败: ${fromPath} → ${toPath}`;
	}

	/**
	 * 解析并询问用户确认后执行 vault_move 指令
	 * 格式：vault_move|"源路径"|"目标路径"
	 */
	private async executeVaultMoves(text: string): Promise<string[]> {
		const moves = this.parseVaultMoves(text);
		if (moves.length === 0) {
			return [];
		}

		// 通过回调请求用户确认（如果提供了回调）
		if (this.callbacks?.onRequestMoveConfirmation) {
			const confirmed = await this.callbacks.onRequestMoveConfirmation(moves);
			if (!confirmed) {
				return ['⚠️ 用户取消文件移动操作'];
			}
		} else {
			// Fallback: 使用浏览器 confirm 对话框
			const confirmMsg = '即将执行以下文件移动操作：\n' +
				moves.map((m, i) => `${i + 1}. ${m.from} → ${m.to}`).join('\n') +
				'\n\n确认执行？';
			if (!confirm(confirmMsg)) {
				return ['⚠️ 用户取消文件移动操作'];
			}
		}

		const results: string[] = [];
		for (const move of moves) {
			const result = await this.doVaultMove(move.from, move.to);
			results.push(result);
		}
		return results;
	}

	/**
	 * 通过 Obsidian vault API 直接写文件
	 * 自动创建父目录（仅限 outputPath 中已有的层级，不会凭空创建）
	 */
	private async writeViaVaultApi(filePath: string, content: string): Promise<void> {
		console.log('[ScenePipeline] writeViaVaultApi START, filePath:', filePath, 'content length:', content.length);
		const normalizedPath = filePath.replace(/^\/+/, '').replace(/\\/g, '/');
		console.log('[ScenePipeline] normalizedPath:', normalizedPath);

		// 确保父目录存在
		const parentPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
		console.log('[ScenePipeline] parentPath:', parentPath);
		if (parentPath) {
			await this.ensureParentFolder(parentPath);
		}

		const existingFile = this.app.vault.getFileByPath(normalizedPath);
		console.log('[ScenePipeline] existingFile:', !!existingFile, 'content length:', content.length);

		if (existingFile) {
			console.log('[ScenePipeline] Calling vault.modify...');
			await this.app.vault.modify(existingFile, content);
			console.log('[ScenePipeline] vault.modify done');
		} else {
			console.log('[ScenePipeline] Calling vault.create...');
			await this.app.vault.create(normalizedPath, content);
			console.log('[ScenePipeline] vault.create done');
		}
	}

	/**
	 * 确保父目录存在（递归创建）
	 */
	private async ensureParentFolder(folderPath: string): Promise<void> {
		const parts = folderPath.split('/').filter(p => p);
		let currentPath = '';

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				try {
					await this.app.vault.createFolder(currentPath);
				} catch {
					// 文件夹可能在并发中已被创建，忽略
				}
			}
		}
	}

	/**
	 * 从 ljg-writes 输出的 frontmatter 中提取 tags
	 * 直接在正文中查找 tags[...]，处理 frontmatter 和 thinking content 中都有 --- 的情况
	 */
	private extractTagsFromFrontmatter(text: string): string | null {
		// 直接在全文中找所有 tags: [...] 匹配
		// 取最后一个（正文 frontmatter 的 tags 在最后，thinking block 的 tags 在前面）
		const allTags = [...text.matchAll(/tags:\s*\[([^\]]+)\]/g)];
		if (allTags.length === 0) return null;
		// 取最后一个匹配的 tags
		return allTags[allTags.length - 1][1].trim();
	}

	/**
	 * 从 skill 输出的 frontmatter 中提取 filename
	 * 在整个文本中查找 filename: 字段，简单直接
	 */
	private extractFilenameFromFrontmatter(text: string): string | null {
		// 直接在整个文本中找 filename: 字段（可能在任意 frontmatter 块中）
		// 匹配 filename: <value>，value 不包含换行
		const filenameMatch = text.match(/^filename:\s*(.+)$/m);
		if (filenameMatch) {
			return filenameMatch[1].trim();
		}
		return null;
	}

	/**
	 * 从 ljg-writes 输出中提取正文内容（去掉所有 frontmatter 块和 heading）
	 * frontmatter 块可能以 --- 开头（思考块），也可能以 type: 开头（正文块）
	 */
	private stripFrontmatter(text: string): string {
		// 去掉 heading 行（## 开头的行）
		let result = text.replace(/^##.*$/gm, '');

		// 去掉所有 frontmatter 块（以 --- 或 key: value 开头，以 --- 结尾）
		result = result.replace(/(?:\n(?:---|[a-z]+:\s*[^\n]+))+\n---\n*/g, '\n');

		// 去掉可能残留在正文开头的 type: content 等单行
		result = result.replace(/^\s*type:\s*content\s*$/gm, '');

		return result.trim();
	}

	/**
	 * 从 pipeline 上下文组装最终 Markdown 内容
	 */
	private assembleMarkdown(context: PipelineContext): string {
		const parts: string[] = [];
		const now = new Date();
		const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

		// 检查 ljg-writes 输出是否自带 frontmatter
		const ljgWritesOutput = context.skillResults.get('ljg-writes');
		const customTags = ljgWritesOutput ? this.extractTagsFromFrontmatter(ljgWritesOutput.trim()) : null;

		// frontmatter
		parts.push('---');
		parts.push(`type: ${this.action.category}`);
		parts.push(`created: ${dateStr}`);
		parts.push(`action: ${this.action.id}`);
		parts.push(`tags: [${customTags || `${this.action.category}, ${this.action.id}`}]`);
		parts.push('---');
		parts.push('');

		// 标题（ljg-writes 输出纯内容，不加标题 heading）
		if (!customTags) {
			parts.push(`# ${this.action.icon} ${this.action.name}`);
			parts.push('');
		}

		// 按 sectionMap 顺序组装各 section
		let hasContent = false;
		console.log('[ScenePipeline] assembleMarkdown, skillResults entries:', [...context.skillResults.entries()].map(([k,v]) => k + ':' + (v ? v.length : 'null')));
		for (const [skillId, heading] of Object.entries(this.action.sectionMap)) {
			const result = context.skillResults.get(skillId);
			console.log('[ScenePipeline] assembleMarkdown skillId:', skillId, 'result type:', typeof result, 'length:', result ? result.length : 'N/A');
			if (result && result.trim()) {
				let content = this.stripThinkingText(result.trim());

				// ljg-writes：跳过 frontmatter，直接输出正文，且不加 section heading
				if (skillId === 'ljg-writes' && customTags) {
					content = this.stripFrontmatter(content);
					// 直接追加正文，不加 heading
					parts.push(content);
					parts.push('');
					hasContent = true;
					continue;
				}

				// 去掉 AI 输出中重复的 heading（AI 可能自己写了和 sectionMap 相同的标题）
				const firstLines = content.split('\n');
				const firstLine = firstLines[0].trim();
				const headingText = heading.replace(/^#+\s*/, '').trim();
				if (firstLine.replace(/^#+\s*/, '').trim() === headingText) {
					// 跳过第一行（重复的 heading），从第二行开始保留内容
					content = firstLines.slice(1).join('\n').trim();
				}
				parts.push(heading);
				parts.push('');
				parts.push(content);
				parts.push('');
				hasContent = true;
			}
		}


		if (!hasContent) {
			parts.push('> 无处理结果');
			parts.push('');
		}

		return parts.join('\n');
	}

	// 剥离思考文字：去掉 skill 输出中 --- 之前的内容（AI 推理过程）
	private stripThinkingText(text: string): string {
		const dividerIndex = text.indexOf('\n---\n');
		if (dividerIndex !== -1) {
			return text.slice(dividerIndex + 5).trim();
		}
		return text.trim();
	}

	// ============ WebSearch: 通过 AI skill 执行搜索 ============

	private async executeWebSearch(context: PipelineContext, type: 'news' | 'finance', skillId: string, callbacks: PipelineCallbacks): Promise<string> {
		const today = new Date();
		const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
		const userInput = context.input?.trim() || '';

		// 根据是否有用户输入构建不同的搜索策略
		let systemPrompt: string;
		let userMessage: string;

		if (type === 'news') {
			if (userInput) {
				// 有用户输入：围绕用户关注方向搜索
				systemPrompt = `你是富酬者AI引擎的资讯搜索助手。今天是 ${dateStr}。
用户关注的方向是：${userInput}
请围绕这个方向，搜索相关的AI、科技、商业资讯。

执行步骤：
1. 先使用 mcp_web_search 工具搜索「${dateStr} ${userInput} AI 科技 资讯」
2. 如果结果不够，再搜索「${userInput} 最新动态 新闻」
3. 将搜索结果整理为精美的 Markdown 资讯摘要

严格按照以下模板输出每一条资讯：

---

### 📌 资讯标题

> 摘要内容，2-3句话描述核心信息。

🔗 来源：[媒体名称](https://实际URL) · ${dateStr}

---

规则：
- 每条资讯的来源必须是 Markdown 链接 [名称](URL)，绝对不能只写纯文本
- 按相关性和重要性排序，最多10条
- 只输出最终整理好的内容，不要输出思考过程`;
				userMessage = `请搜索关于「${userInput}」的最新AI科技资讯`;
			} else {
				// 空输入：搜索今日综合AI资讯
				systemPrompt = `你是富酬者AI引擎的资讯搜索助手。今天是 ${dateStr}。
请搜索今天最新的AI、科技、商业资讯。

执行步骤：
1. 使用 mcp_web_search 工具搜索「${dateStr} AI 人工智能 科技 最新新闻」
2. 如果结果不够，再搜索「AI technology news today」
3. 将搜索结果整理为精美的 Markdown 资讯摘要

严格按照以下模板输出每一条资讯：

---

### 📌 资讯标题

> 摘要内容，2-3句话描述核心信息。

🔗 来源：[媒体名称](https://实际URL) · ${dateStr}

---

规则：
- 每条资讯的来源必须是 Markdown 链接 [名称](URL)，绝对不能只写纯文本
- 按重要性排序，最多10条
- 只输出最终整理好的内容，不要输出思考过程`;
				userMessage = `请搜索 ${dateStr} 最新的AI科技资讯`;
			}
		} else {
			if (userInput) {
				// 有用户输入：围绕用户关注的财经方向搜索
				systemPrompt = `你是富酬者AI引擎的财经搜索助手。今天是 ${dateStr}。
用户关注的财经方向是：${userInput}
请围绕这个方向，搜索相关的财经新闻和市场动态。

执行步骤：
1. 先使用 mcp_web_search 工具搜索「${dateStr} ${userInput} 财经 市场 新闻」
2. 如果结果不够，再搜索「${userInput} 股票 行情 最新」
3. 将搜索结果整理为精美的 Markdown 财经摘要

按以下结构输出：

## 📊 相关要闻

每条要闻严格按此模板：

---

### 📌 标题

> 摘要内容，2-3句话概述。

🔗 来源：[媒体名称](https://实际URL) · ${dateStr}

---

## 📈 市场动态

同样模板格式。

规则：
- 每条的来源必须是 Markdown 链接 [名称](URL)，绝对不能只写纯文本
- 只输出最终整理好的内容，不要输出思考过程`;
				userMessage = `请搜索关于「${userInput}」的最新财经资讯`;
			} else {
				// 空输入：搜索今日综合财经
				systemPrompt = `你是富酬者AI引擎的财经搜索助手。今天是 ${dateStr}。
请搜索今天的财经要闻与市场行情。

执行步骤：
1. 使用 mcp_web_search 工具搜索「${dateStr} 财经要闻 股市 市场行情」
2. 如果结果不够，再搜索「today financial news market」
3. 将搜索结果整理为精美的 Markdown 财经摘要

按以下结构输出：

## 📊 要闻

每条要闻严格按此模板：

---

### 📌 标题

> 摘要内容，2-3句话概述。

🔗 来源：[媒体名称](https://实际URL) · ${dateStr}

---

## 📈 行情

同样模板格式。

规则：
- 每条的来源必须是 Markdown 链接 [名称](URL)，绝对不能只写纯文本
- 只输出最终整理好的内容，不要输出思考过程`;
				userMessage = `请搜索 ${dateStr} 今日财经要闻与市场行情`;
			}
		}

		const messages: MiniMaxMessage[] = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userMessage },
		];

		let fullOutput = '';
		let lastRoundOutput = '';
		const maxToolRounds = 8;
		let toolRound = 0;

		// 设置工具（WebSearch 需要 MCP 工具如 w_query）
		if (this.toolManager) {
			const tools = (this.toolManager as any).getAvailableTools?.();
			if (tools && tools.length > 0) {
				const miniMaxTools = tools.map((t: any) => ({
					name: t.name,
					description: t.description || '',
					input_schema: t.inputSchema,
				}));
				this.apiClient.setTools(miniMaxTools);
			}
		}

		// 复用与 executeSkill 相同的 tool-loop 逻辑
		while (toolRound < maxToolRounds) {
			if (this.aborted) break;

			let pendingToolCall: { id: string; name: string; arguments: Record<string, any> } | null = null;
			let roundOutput = '';

			for await (const chunk of this.apiClient.chatStream(messages)) {
				if (this.aborted) break;

				if (chunk.type === 'content' && chunk.delta) {
					roundOutput += chunk.delta;
					callbacks.onStepChunk(skillId, chunk.delta);
				} else if (chunk.type === 'tool' && chunk.toolCall) {
					pendingToolCall = chunk.toolCall;
					if (callbacks.onToolCall) {
						callbacks.onToolCall({
							id: chunk.toolCall.id,
							name: chunk.toolCall.name,
							input: chunk.toolCall.arguments,
							status: 'running',
						});
					}
				}
			}

			lastRoundOutput = roundOutput;

			if (pendingToolCall && this.toolManager) {
				try {
					const toolResult = await this.toolManager.executeTool({
						name: pendingToolCall.name,
						arguments: pendingToolCall.arguments,
					});

					messages.push({
						role: 'assistant',
						content: roundOutput || `调用工具: ${pendingToolCall.name}`,
					});
					messages.push({
						role: 'user',
						content: `工具 ${pendingToolCall.name} 执行结果:\n${toolResult.content || toolResult.error || '完成'}`,
					});

					toolRound++;
				} catch {
					break;
				}
			} else {
				break;
			}
		}

		// 只返回最后一轮的输出（最终整理好的内容），不包含中间工具调用过程
		return lastRoundOutput || fullOutput;
	}

	// ============ AI skill 执行 ============

	private async executeSkill(
		skillId: string,
		context: PipelineContext,
		callbacks: PipelineCallbacks,
	): Promise<string> {
		const systemPrompt = this.buildSystemPrompt(skillId, context);

		// start-my-day: 预读取文件内容，绕过AI工具调用循环
		if (skillId === 'start-my-day' && this.toolManager) {
			return this.executeStartMyDay(skillId, systemPrompt, context, callbacks);
		}

		const userMessage = this.buildUserMessage(skillId, context);

		const messages: MiniMaxMessage[] = [
			{ role: 'system', content: systemPrompt },
		];

		// 附加上一条 assistant 消息作为上下文（包含工具调用结果）
		if (this.conversationStore) {
			const conv = this.conversationStore.getCurrentConversation();
			if (conv && conv.messages.length > 0) {
				const lastMsg = conv.messages[conv.messages.length - 1];
				if (lastMsg.role === 'assistant' && lastMsg.content.trim()) {
					messages.push({
						role: 'assistant',
						content: lastMsg.content,
					});
				}
			}
		}

		messages.push({ role: 'user', content: userMessage });

		let fullOutput = '';
		const maxToolRounds = 8;
		let toolRound = 0;

		// 设置工具（让 AI 知道可以调用 vault 等工具）
		// ljg-writes 禁止调用 vault 工具，由 pipeline 统一写文件
		if (this.toolManager && skillId !== 'ljg-writes') {
			const tools = (this.toolManager as any).getAvailableTools?.();
			if (tools && tools.length > 0) {
				const miniMaxTools = tools.map((t: any) => ({
					name: t.name,
					description: t.description || '',
					input_schema: t.inputSchema,
				}));
				this.apiClient.setTools(miniMaxTools);
			}
		}

		while (toolRound < maxToolRounds) {
			if (this.aborted) break;

			let pendingToolCall: { id: string; name: string; arguments: Record<string, any> } | null = null;
			let roundOutput = '';

			for await (const chunk of this.apiClient.chatStream(messages)) {
				if (this.aborted) break;

				if (chunk.type === 'content' && chunk.delta) {
					roundOutput += chunk.delta;
					callbacks.onStepChunk(skillId, chunk.delta);
				} else if (chunk.type === 'tool' && chunk.toolCall) {
					pendingToolCall = chunk.toolCall;
					if (callbacks.onToolCall) {
						callbacks.onToolCall({
							id: chunk.toolCall.id,
							name: chunk.toolCall.name,
							input: chunk.toolCall.arguments,
							status: 'running',
						});
					}
				}
			}

			fullOutput += roundOutput;

			if (pendingToolCall && this.toolManager) {
				try {
					const toolResult = await this.toolManager.executeTool({
						name: pendingToolCall.name,
						arguments: pendingToolCall.arguments,
					});

					if (callbacks.onToolCall) {
						callbacks.onToolCall({
							id: pendingToolCall.id,
							name: pendingToolCall.name,
							input: pendingToolCall.arguments,
							status: toolResult.success ? 'completed' : 'error',
							result: toolResult.content,
							error: toolResult.error,
						});
					}

					messages.push({
						role: 'assistant',
						content: roundOutput || `调用工具: ${pendingToolCall.name}`,
					});
					messages.push({
						role: 'user',
						content: `工具 ${pendingToolCall.name} 执行结果:\n${toolResult.content || toolResult.error || '完成'}`,
					});

					toolRound++;
				} catch (err: any) {
					if (callbacks.onToolCall) {
						callbacks.onToolCall({
							id: pendingToolCall.id,
							name: pendingToolCall.name,
							input: pendingToolCall.arguments,
							status: 'error',
							error: err?.message,
						});
					}
					break;
				}
			} else {
				break;
			}
		}

		return fullOutput;
	}

	private buildSystemPrompt(skillId: string, context: PipelineContext): string {
		const parts: string[] = [];

		parts.push(`你是富酬者AI引擎。当前动作: ${this.action.name}。`);
		parts.push('请直接输出处理结果的 Markdown 内容，不要调用 vault 工具，文件写入由系统自动完成。');
		parts.push('');

		// 加载 skill 的 systemPrompt（并替换模板变量）
		// start-my-day 特殊：文件已预读取，直接生成内容即可
		const skillDef = this.skillManager.getSkillByFolderName(skillId);
		console.log('[ScenePipeline] buildSystemPrompt skillId:', skillId, 'found:', !!skillDef, 'systemPrompt length:', skillDef?.systemPrompt?.length || 0);
		if (!skillDef) {
			console.warn('[ScenePipeline] Skill not found for skillId:', skillId, '- check loadSkills() and folder name');
		} else if (skillId !== 'start-my-day') {
			// start-my-day 使用预读取文件，无需注入 skill 的 vault 工具指令
			const skillContext = {
				userMessage: context.input || '',
				currentFile: '',
				date: new Date().toLocaleDateString('zh-CN'),
				time: new Date().toLocaleTimeString('zh-CN'),
				vaultPath: this.app?.vault?.adapter?.basePath || '',
			};
			const { systemPrompt } = this.skillManager.buildPrompt(skillDef, skillContext);
			parts.push(systemPrompt);
			parts.push('');
		}

		return parts.join('\n');
	}

	private buildUserMessage(skillId: string, context: PipelineContext): string {
		const parts: string[] = [];

		// 第一个 skill：包含原始输入
		const isFirst = this.action.pipeline[0] === skillId;
		if (isFirst) {
			const today = new Date();
			const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
			const userInput = context.input?.trim();
			if (userInput) {
				parts.push(`## 用户输入\n${userInput}`);
			} else {
				// 空输入时提供丰富的上下文，让 skill 能正常执行
				parts.push(`## 任务\n请执行「${this.action.name}」。今天是 ${dateStr}。\n\n请按照你的技能说明直接开始执行，不需要等待额外输入。`);
			}
		}

		// 附件内容（解析后的实际内容，而非仅文件路径）
		if (isFirst && context.attachmentContents && context.attachmentContents.size > 0) {
			for (const [filePath, content] of context.attachmentContents) {
				const fileName = filePath.split('/').pop() || filePath;
				parts.push(`## 附件: ${fileName}\n${content}`);
			}
		} else if (isFirst && context.attachments.length > 0) {
			// fallback: 没有解析内容时仍传递文件路径
			parts.push(`## 附件\n${context.attachments.join('\n')}`);
		}

		// 前序 skill 结果
		for (const [sid, result] of context.skillResults) {
			if (result) {
				parts.push(`## ${sid} 输出\n${result}`);
			}
		}

		return parts.join('\n\n');
	}

	/**
	 * start-my-day 专用执行路径：预读取文件，直接生成内容，无工具循环
	 */
	private async executeStartMyDay(
		skillId: string,
		systemPrompt: string,
		context: PipelineContext,
		callbacks: PipelineCallbacks,
	): Promise<string> {
		const today = new Date();
		const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
		const yesterday = new Date(today);
		yesterday.setDate(today.getDate() - 1);
		const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

		// 读取关键文件
		const filesToRead = [
			'4-计划/私域MVP执行清单.md',
			'4-计划/私域MVP执行计划.md',
			'1-收件箱/拍摄任务.md',
		];

		const inboxItems: string[] = [];
		const planItems: string[] = [];
		let contentMap: Record<string, string> = {};

		for (const filePath of filesToRead) {
			try {
				const result = await this.toolManager!.executeTool({
					name: 'vault',
					arguments: { operation: 'read', path: filePath },
				});
				if (result.success && result.content) {
					contentMap[filePath] = result.content as string;
				}
			} catch (e) {
				console.warn('[ScenePipeline] Failed to read:', filePath, e);
			}
		}

		// 读取收件箱列表
		try {
			const inboxResult = await this.toolManager!.executeTool({
				name: 'vault',
				arguments: { operation: 'list', path: '1-收件箱/' },
			});
			if (inboxResult.success && inboxResult.content) {
				console.log('[ScenePipeline] list raw:', inboxResult.content);
				const lines = (inboxResult.content as string).split('\n');
				for (const line of lines) {
					if (line.trim() && !line.includes('找到')) {
						inboxItems.push(line.trim());
					}
				}
			}
		} catch (e) {}

		// 读取计划列表
		try {
			const planResult = await this.toolManager!.executeTool({
				name: 'vault',
				arguments: { operation: 'list', path: '4-计划/' },
			});
			if (planResult.success && planResult.content) {
				const lines = (planResult.content as string).split('\n');
				for (const line of lines) {
					if (line.trim() && !line.includes('找到')) {
						planItems.push(line.trim());
					}
				}
			}
		} catch (e) {}

		// 构建用户消息，把所有内容都注入进去
		const userMessage = await this.buildStartMyDayUserMessage(dateStr, yesterdayStr, contentMap, inboxItems, planItems);

		const messages: MiniMaxMessage[] = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userMessage },
		];

		// 设置工具（虽然AI不应该调用，但保留以防万一）
		if (this.toolManager) {
			const tools = (this.toolManager as any).getAvailableTools?.();
			if (tools && tools.length > 0) {
				const miniMaxTools = tools.map((t: any) => ({
					name: t.name,
					description: t.description || '',
					input_schema: t.inputSchema,
				}));
				this.apiClient.setTools(miniMaxTools);
			}
		}

		let fullOutput = '';
		let pendingToolCall: { id: string; name: string; arguments: Record<string, any> } | null = null;
		let roundOutput = '';

		for await (const chunk of this.apiClient.chatStream(messages)) {
			if (this.aborted) break;

			if (chunk.type === 'content' && chunk.delta) {
				fullOutput += chunk.delta;
				roundOutput += chunk.delta;
				callbacks.onStepChunk(skillId, chunk.delta);
			} else if (chunk.type === 'tool' && chunk.toolCall) {
				pendingToolCall = chunk.toolCall;
			}
		}

		// 如果AI调用了工具，执行它并继续（最多1轮）
		if (pendingToolCall && this.toolManager) {
			try {
				const toolResult = await this.toolManager.executeTool({
					name: pendingToolCall.name,
					arguments: pendingToolCall.arguments,
				});
				messages.push({ role: 'assistant', content: roundOutput || '调用工具' });
				messages.push({
					role: 'user',
					content: `工具 ${pendingToolCall.name} 执行结果:\n${toolResult.content || toolResult.error || '完成'}`,
				});

				// 第二轮：只生成内容，不允许再调用工具
				this.apiClient.setTools([]);
				roundOutput = '';
				for await (const chunk of this.apiClient.chatStream(messages)) {
					if (this.aborted) break;
					if (chunk.type === 'content' && chunk.delta) {
						fullOutput += chunk.delta;
						roundOutput += chunk.delta;
						callbacks.onStepChunk(skillId, chunk.delta);
					}
				}
			} catch (e) {}
		}

		return fullOutput;
	}

	/**
	 * archive-ingest 专用执行路径：预读取收件箱和根目录文件，直接生成摘要
	 */
	private async executeArchiveIngest(
		skillId: string,
		context: PipelineContext,
		callbacks: PipelineCallbacks,
	): Promise<string> {
		// 强制同步日志
		console.log('[ScenePipeline] >>> executeArchiveIngest CALLED, toolManager:', !!this.toolManager, 'enableVault:', (this.toolManager as any)?.enableVault, 'vaultTool:', !!(this.toolManager as any)?.vaultTool);

		let systemPrompt = '';

		// 收集收件箱文件（声明在 try 外部，确保 catch 后仍可访问）
		const inboxFiles: { path: string; content: string }[] = [];
		try {
			const skillDef = this.skillManager.getSkillByFolderName?.('archive-ingest');
			console.log('[ScenePipeline] skillDef found:', !!skillDef, 'systemPrompt length:', skillDef?.systemPrompt?.length || 0);

			if (skillDef) {
				const skillContext = {
					userMessage: context.input || '',
					currentFile: '',
					date: new Date().toLocaleDateString('zh-CN'),
					time: new Date().toLocaleTimeString('zh-CN'),
					vaultPath: this.app?.vault?.adapter?.basePath || '',
				};
				const built = this.skillManager.buildPrompt(skillDef, skillContext);
				systemPrompt = built.systemPrompt;
				console.log('[ScenePipeline] buildPrompt done, systemPrompt length:', systemPrompt.length);
			}

			console.log('[ScenePipeline] BEFORE vault call, toolManager:', !!this.toolManager, 'vaultTool:', !!(this.toolManager as any)?.vaultTool);
			const inboxResult = await this.toolManager!.executeTool({
				name: 'vault',
				arguments: { operation: 'list', path: '1-收件箱/' },
			});
			console.log('[ScenePipeline] inboxResult success:', inboxResult.success, 'error:', inboxResult.error);
			if (inboxResult.success && inboxResult.content) {
				const lines = String(inboxResult.content).split('\n');
				for (const line of lines) {
					// vault list 返回格式: "📄 1-收件箱/文件名.md" 或 "📁 1-收件箱/子文件夹"
					// 去掉 emoji 前缀后，cleanLine 已经是完整相对路径
					const cleanLine = line.replace(/^[^\w\u4e00-\u9fff]+/, '').trim();
					// 跳过文件夹、非 md 文件、node_modules
					if (!cleanLine || !cleanLine.endsWith('.md') || cleanLine.includes('node_modules')) {
						continue;
					}
					try {
						const readResult = await this.toolManager!.executeTool({
							name: 'vault',
							arguments: { operation: 'read', path: cleanLine },
						});
						if (readResult.success && readResult.content) {
							console.log('[ScenePipeline] inbox file read OK:', cleanLine, 'content length:', (readResult.content as string).length);
							inboxFiles.push({ path: cleanLine, content: readResult.content as string });
						} else {
							console.warn('[ScenePipeline] inbox file read FAILED or empty:', cleanLine, readResult.error);
						}
					} catch (e) { console.warn('[ScenePipeline] vault read error:', e); }
				}
			}
		} catch (e) { console.error('[ScenePipeline] vault list inbox error:', e); }

		// 收集根目录 .md 文件（声明在 try 外部，确保 catch 后仍可访问）
		const rootFiles: { path: string; content: string }[] = [];
		const excludePrefixes = ['1-', '2-', '3-', '4-', '5-', '6-', '7-', '8-', '9-', '.obsidian', '.agent', 'node_modules'];
		try {
			const rootResult = await this.toolManager!.executeTool({
				name: 'vault',
				arguments: { operation: 'list', path: '.' },
			});
			if (rootResult.success && rootResult.content) {
				const lines = (rootResult.content as string).split('\n');
				for (const line of lines) {
					const filePath = line.replace(/^[^\w\u4e00-\u9fff]+/, '').trim();
					if (filePath && filePath.endsWith('.md')) {
						const shouldExclude = excludePrefixes.some(prefix => filePath.startsWith(prefix));
						if (!shouldExclude) {
							try {
								const readResult = await this.toolManager!.executeTool({
									name: 'vault',
									arguments: { operation: 'read', path: filePath },
								});
								if (readResult.success && readResult.content) {
									rootFiles.push({ path: filePath, content: readResult.content as string });
								}
							} catch (e) { console.warn('[ScenePipeline] vault read root file error:', e); }
						}
					}
				}
			}
		} catch (e) { console.error('[ScenePipeline] vault list root error:', e); }

		// 构建包含所有文件内容的 prompt
		const parts: string[] = [];
		parts.push(`## 任务\n归档整理 - 读取待归档内容，提取核心信息。\n`);
		parts.push(`## 用户输入\n${context.input || '帮我把这些笔记归档整理'}\n`);
		console.log('[ScenePipeline] inboxFiles count:', inboxFiles.length, 'rootFiles count:', rootFiles.length);

		if (inboxFiles.length > 0) {
			parts.push(`## 1-收件箱 文件（共 ${inboxFiles.length} 个）`);
			for (const file of inboxFiles) {
				const fileName = file.path.split('/').pop() || file.path;
				parts.push(`\n### ${fileName}\n\`\`\`\n${file.content.slice(0, 2000)}\n\`\`\``);
			}
		} else {
			parts.push(`\n## 1-收件箱\n（收件箱为空）`);
		}

		if (rootFiles.length > 0) {
			parts.push(`\n## 根目录零散文件（共 ${rootFiles.length} 个）`);
			for (const file of rootFiles) {
				const fileName = file.path.split('/').pop() || file.path;
				parts.push(`\n### ${fileName}\n\`\`\`\n${file.content.slice(0, 2000)}\n\`\`\``);
			}
		}

		parts.push(`\n\n## 格式要求
请对每个文件输出：
- 主题：[文件主题]
- 关键词：[关键词1, 关键词2, ...]
- 分类建议：[目标目录，如 3-项目/、6-知识库/、8-归档/ 等]
- 分类理由：[为什么归到这个目录]

然后输出一个汇总表：
| 序号 | 文件名 | 主题 | 分类目标 | 分类理由 |
|------|--------|------|----------|----------|
`);

		const messages: MiniMaxMessage[] = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: parts.join('\n') },
		];

		// 禁用工具（所有文件内容已预读取到 prompt 中，无需再调用工具）
		this.apiClient.setTools([]);

		let fullOutput = '';
		let pendingToolCall: { id: string; name: string; arguments: Record<string, any> } | null = null;
		let roundOutput = '';

		for await (const chunk of this.apiClient.chatStream(messages)) {
			if (this.aborted) break;

			if (chunk.type === 'content' && chunk.delta) {
				fullOutput += chunk.delta;
				roundOutput += chunk.delta;
				callbacks.onStepChunk(skillId, chunk.delta);
			} else if (chunk.type === 'tool' && chunk.toolCall) {
				pendingToolCall = chunk.toolCall;
			}
		}

		// 允许一轮工具调用，然后强制结束
		if (pendingToolCall && this.toolManager) {
			try {
				const toolResult = await this.toolManager.executeTool({
					name: pendingToolCall.name,
					arguments: pendingToolCall.arguments,
				});
				messages.push({ role: 'assistant', content: roundOutput || '调用工具' });
				messages.push({
					role: 'user',
					content: `工具 ${pendingToolCall.name} 执行结果:\n${toolResult.content || toolResult.error || '完成'}`,
				});

				this.apiClient.setTools([]);
				roundOutput = '';
				for await (const chunk of this.apiClient.chatStream(messages)) {
					if (this.aborted) break;
					if (chunk.type === 'content' && chunk.delta) {
						fullOutput += chunk.delta;
						roundOutput += chunk.delta;
						callbacks.onStepChunk(skillId, chunk.delta);
					}
				}
			} catch (e) {}
		}

		return fullOutput;
	}

	/**
	 * archive-classifier 专用执行路径：基于 archive-ingest 的摘要结果进行分类
	 */
	private async executeArchiveClassifier(
		skillId: string,
		context: PipelineContext,
		callbacks: PipelineCallbacks,
	): Promise<string> {
		const archiveIngestOutput = context.skillResults.get('archive-ingest') || '';
		const userInput = context.input || '帮我把这些笔记归档整理';

		const systemPrompt = `你是一个知识库分类专家，负责将内容归类到合适的知识库目录。注意：只能将文件归档到已有的8个目录中，禁止创建新的子目录，禁止使用不存在的目录。

【重要】你必须为每个文件生成移动指令，格式如下（必须严格遵守）：
vault_move|"源路径"|"目标路径"

示例：
vault_move|"1-收件箱/投流视频脚本.md"|"8-归档/投流视频脚本.md"
vault_move|"1-收件箱/直播文档.md"|"3-项目/直播文档.md"

如果没有需要移动的文件，请明确写出"无需移动文件"。`;

		const parts: string[] = [];
		parts.push(`## 任务\n基于以下归档文件的摘要，对每个文件给出分类建议和移动指令。\n`);
		parts.push(`## 归档文件摘要\n${archiveIngestOutput}\n`);

		parts.push(`## 分类体系（只能使用以下目录，禁止创建子目录）\n| 目录 | 适用内容 |\n|------|---------|\n| 1-收件箱 | 未分类的临时内容 |\n| 2-日记 | 日记、日志、每日记录 |\n| 3-项目 | 项目文档、会议记录、项目相关内容 |\n| 4-计划 | 计划、目标、财务、工作指南 |\n| 5-研究 | 学习笔记、研究资料 |\n| 6-知识库 | 知识沉淀、方法论、模板 |\n| 7-资源 | 外部资源、工具、参考资料 |\n| 8-归档 | 已完成/过期的内容 |\n`);
		parts.push(`重要提醒：目标路径只能是如 "3-项目/拍摄任务.md" 或 "6-知识库/xxx.md" 这样的直接子文件，禁止如 "3-项目/子文件夹/xxx.md" 这种带中间目录的路径。\n`);

		parts.push(`## 格式要求\n对每个文件输出：
- 文件名：[文件名]
- 分类目标：[目标目录/]
- 移动指令：vault_move|"1-收件箱/原文件名"|"目标目录/原文件名"（必须包含此行，即使文件不需要移动也要写"无需移动"）
- 分类理由：[为什么归到这个目录]
- 建议标签：[#标签1, #标签2]

最后输出汇总表（必须包含移动指令）：
| 序号 | 文件名 | 分类目标 | 移动指令 |
|------|--------|----------|----------|
`);

		const messages: MiniMaxMessage[] = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: parts.join('\n') },
		];

		// 设置可用工具
		if (this.toolManager) {
			const tools = (this.toolManager as any).getAvailableTools?.();
			if (tools && tools.length > 0) {
				const miniMaxTools = tools.map((t: any) => ({
					name: t.name,
					description: t.description || '',
					input_schema: t.inputSchema,
				}));
				this.apiClient.setTools(miniMaxTools);
			}
		}

		let fullOutput = '';
		let roundOutput = '';
		const maxToolRounds = 4;
		let toolRound = 0;

		while (toolRound < maxToolRounds) {
			if (this.aborted) break;
			roundOutput = '';
			let pendingToolCall: { id: string; name: string; arguments: Record<string, any> } | null = null;

			for await (const chunk of this.apiClient.chatStream(messages)) {
				if (this.aborted) break;
				if (chunk.type === 'content' && chunk.delta) {
					fullOutput += chunk.delta;
					roundOutput += chunk.delta;
					callbacks.onStepChunk(skillId, chunk.delta);
				} else if (chunk.type === 'tool' && chunk.toolCall) {
					pendingToolCall = chunk.toolCall;
					roundOutput += `调用工具: ${chunk.toolCall.name}`;
				}
			}

			// 工具调用在循环外执行
			if (pendingToolCall && this.toolManager) {
				const toolResult = await this.toolManager.executeTool({
					name: pendingToolCall.name,
					arguments: pendingToolCall.arguments,
				});
				messages.push({ role: 'assistant', content: roundOutput || `调用工具: ${pendingToolCall.name}` });
				messages.push({ role: 'user', content: `工具执行结果:\n${toolResult.content || toolResult.error || '完成'}` });
			} else {
				break; // 没有工具调用，正常结束
			}
			toolRound++;
		}

		return fullOutput;
	}

	/**
	 * archive-linker 专用执行路径：基于分类结果建立知识关联
	 */
	private async executeArchiveLinker(
		skillId: string,
		context: PipelineContext,
		callbacks: PipelineCallbacks,
	): Promise<string> {
		const archiveIngestOutput = context.skillResults.get('archive-ingest') || '';
		const archiveClassifierOutput = context.skillResults.get('archive-classifier') || '';

		const systemPrompt = `你是一个知识图谱关联专家，负责将归档内容与已有知识库建立联系。`;

		const parts: string[] = [];
		parts.push(`## 任务\n基于归档文件的摘要和分类结果，为每个文件提供知识关联建议。\n`);
		parts.push(`## 文件摘要\n${archiveIngestOutput}\n`);
		parts.push(`## 分类结果\n${archiveClassifierOutput}\n`);

		parts.push(`## 关联类型说明
| 类型 | 说明 |
|------|------|
| 相关 | 主题相关但不直接关联 |
| 补充 | 对已有内容的补充说明 |
| 延伸 | 在已有内容基础上的深入 |
| 对比 | 与已有内容形成对比 |
| 依赖 | 理解本内容需要先了解的前置知识 |

## 格式要求
对每个文件输出：
- 文件名：[文件名]
- 关联建议：
  1. [[建议关联的笔记名]] - 关联类型：[类型] - 理由：[为什么关联]
  2. [[建议关联的笔记名]] - 关联类型：[类型] - 理由：[为什么关联]

如无明确关联对象，写"暂无明确关联对象，建议归档后通过标签检索"。
`);

		const messages: MiniMaxMessage[] = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: parts.join('\n') },
		];

		// 禁用 vault 工具，AI 直接基于 archive-ingest 的摘要生成知识关联，不调用 vault 工具
		this.apiClient.setTools([]);

		let fullOutput = '';
		let roundOutput = '';
		const maxToolRounds = 1;
		let toolRound = 0;

		while (toolRound < maxToolRounds) {
			if (this.aborted) break;
			roundOutput = '';
			let pendingToolCall: { id: string; name: string; arguments: Record<string, any> } | null = null;

			for await (const chunk of this.apiClient.chatStream(messages)) {
				if (this.aborted) break;
				if (chunk.type === 'content' && chunk.delta) {
					fullOutput += chunk.delta;
					roundOutput += chunk.delta;
					callbacks.onStepChunk(skillId, chunk.delta);
				} else if (chunk.type === 'tool' && chunk.toolCall) {
					pendingToolCall = chunk.toolCall;
					roundOutput += `调用工具: ${chunk.toolCall.name}`;
				}
			}

			// 工具调用在循环外执行
			if (pendingToolCall && this.toolManager) {
				const toolResult = await this.toolManager.executeTool({
					name: pendingToolCall.name,
					arguments: pendingToolCall.arguments,
				});
				messages.push({ role: 'assistant', content: roundOutput || `调用工具: ${pendingToolCall.name}` });
				messages.push({ role: 'user', content: `工具执行结果:\n${toolResult.content || toolResult.error || '完成'}` });
			} else {
				break; // 没有工具调用，正常结束
			}
			toolRound++;
		}

		return fullOutput;
	}

	private async buildStartMyDayUserMessage(
		dateStr: string,
		yesterdayStr: string,
		contentMap: Record<string, string>,
		inboxItems: string[],
		planItems: string[],
	): Promise<string> {
		const parts: string[] = [];
		parts.push(`今天是 ${dateStr}。以下是今日规划所需的信息，请直接生成完整的晨间日记。\n`);

		if (contentMap['4-计划/私域MVP执行清单.md']) {
			parts.push(`## 私域MVP执行清单\n${contentMap['4-计划/私域MVP执行清单.md']}`);
		}
		if (contentMap['4-计划/私域MVP执行计划.md']) {
			parts.push(`## 私域MVP执行计划\n${contentMap['4-计划/私域MVP执行计划.md']}`);
		}
		if (contentMap['1-收件箱/拍摄任务.md']) {
			parts.push(`## 拍摄任务\n${contentMap['1-收件箱/拍摄任务.md']}`);
		}
		if (inboxItems.length > 0) {
			parts.push(`## 收件箱文件列表\n${inboxItems.join('\n')}`);
		}
		if (planItems.length > 0) {
			parts.push(`## 计划文件夹内容\n${planItems.join('\n')}`);
		}

		// 读取昨日日记
		try {
			const yesterdayResult = await this.toolManager!.executeTool({
				name: 'vault',
				arguments: { operation: 'read', path: `2-日记/${yesterdayStr}_晨间.md` },
			});
			if (yesterdayResult.success && yesterdayResult.content) {
				contentMap[`2-日记/${yesterdayStr}_晨间.md`] = yesterdayResult.content as string;
				parts.push(`## 昨日日记\n${yesterdayResult.content}\n`);
			}
		} catch (e) {}
		parts.push(`备注\n[如有阻塞或风险]\n\n`);
		parts.push(`## 格式要求
- 今日待办：必须输出3-5条带编号的待办事项，每条格式为 \`- [ ] #编号 任务描述\`（例：\`- [ ] #1 完成录屏教程前半部分\`）
- 进行中项目状态：输出表格，包含模块、状态、完成度三列
- 收件箱待处理：列出文件名和简要状态
- 本周重点：输出任务表格，包含任务、优先级、产出物三列
- AI摘要：2-3句话总结整体状态，给出今日行动建议
- 备注：标注阻塞风险和行动建议
- 禁止输出"让我..."、"我来帮你..."等描述性语句
- 禁止重复写section标题（标题只输出一次）`);

		return parts.join('\n');
	}
}
