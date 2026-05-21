/**
 * 上下文管理器
 * 处理 200K token 限制，当接近限制时自动压缩旧对话
 */

import type { MiniMaxMessage } from './miniMaxClient';

export interface ContextUsage {
	inputTokens: number;
	contextWindow: number;
	percentage: number;
}

export interface CondensedMessage {
	role: 'user' | 'assistant';
	content: string;
	isSummary?: boolean;
}

const CONTEXT_WINDOW_STANDARD = 200_000; // 200K tokens
const WARNING_THRESHOLD = 0.80; // 80% 开始警告
const SUMMARIZE_THRESHOLD = 0.85; // 85% 开始压缩
const SYSTEM_PROMPT_RESERVE = 5000; // 保留 5000 tokens 给系统提示

/**
 * 估算文本的 token 数量
 * 中文约 2 chars/token，英文约 4 chars/token
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;

	let tokenCount = 0;
	let i = 0;

	while (i < text.length) {
		// 检测是否中文字符
		const charCode = text.charCodeAt(i);
		if (charCode >= 0x4E00 && charCode <= 0x9FFF) {
			// 中文字符，约 2 chars per token
			tokenCount += 0.5;
			i += 1;
		} else if (charCode >= 0xAC00 && charCode <= 0xD7AF) {
			// 韩文字符
			tokenCount += 0.5;
			i += 1;
		} else if (charCode >= 0x3040 && charCode <= 0x30FF) {
			// 日文字符
			tokenCount += 0.5;
			i += 1;
		} else if (text.charAt(i) === '\n') {
			// 换行符
			tokenCount += 0.5;
			i += 1;
		} else {
			// 英文/其他字符，4 chars per token
			tokenCount += 0.25;
			i += 1;
		}
	}

	return Math.ceil(tokenCount);
}

/**
 * 计算消息数组的总 token 数
 */
export function calculateMessagesTokens(messages: MiniMaxMessage[]): number {
	let total = 0;

	for (const msg of messages) {
		// role 和 content overhead
		total += estimateTokens(msg.role) + 4; // "role": xxxx
		total += estimateTokens(msg.content);
		// content 字段 overhead
		total += 10;
		// 消息之间 overhead
		total += 5;
	}

	return total;
}

export class ContextManager {
	private contextWindow: number;
	private currentUsage: ContextUsage | null = null;
	private onUsageUpdate: ((usage: ContextUsage) => void) | null = null;

	constructor(contextWindow: number = CONTEXT_WINDOW_STANDARD) {
		this.contextWindow = contextWindow;
	}

	/**
	 * 设置使用量更新回调
	 */
	setUsageUpdateCallback(callback: (usage: ContextUsage) => void): void {
		this.onUsageUpdate = callback;
	}

	/**
	 * 更新使用量
	 */
	updateUsage(inputTokens: number): ContextUsage {
		this.currentUsage = {
			inputTokens,
			contextWindow: this.contextWindow,
			percentage: Math.min(100, Math.round((inputTokens / this.contextWindow) * 100)),
		};

		if (this.onUsageUpdate) {
			this.onUsageUpdate(this.currentUsage);
		}

		return this.currentUsage;
	}

	/**
	 * 获取当前使用量
	 */
	getUsage(): ContextUsage | null {
		return this.currentUsage;
	}

	/**
	 * 重置使用量（清空上下文时调用）
	 */
	reset(): void {
		this.currentUsage = null;
	}

	/**
	 * 获取警告状态（是否超过 80%）
	 */
	isWarning(): boolean {
		if (!this.currentUsage) return false;
		return this.currentUsage.percentage > (WARNING_THRESHOLD * 100);
	}

	/**
	 * 检测是否需要压缩
	 */
	needsCondensation(messages: MiniMaxMessage[]): boolean {
		const totalTokens = calculateMessagesTokens(messages);
		return totalTokens > (this.contextWindow * SUMMARIZE_THRESHOLD);
	}

	/**
	 * 压缩对话（保留最近的消息，压缩旧消息）
	 */
	condenseMessages(
		messages: MiniMaxMessage[],
		systemPrompt: string
	): { condensed: MiniMaxMessage[]; summary: string } {
		// 计算可用空间
		const systemTokens = estimateTokens(systemPrompt);
		const availableTokens = this.contextWindow - systemTokens - SYSTEM_PROMPT_RESERVE;

		// 收集所有非系统消息
		const userAssistantMessages = messages.filter(m => m.role !== 'system');

		// 从最新的消息开始，保留能放入的内容
		const keptMessages: MiniMaxMessage[] = [];
		let keptTokens = 0;

		// 先放最新的用户消息（通常是最新问题）
		for (let i = userAssistantMessages.length - 1; i >= 0; i--) {
			const msg = userAssistantMessages[i];
			const msgTokens = estimateTokens(msg.content) + 50; // 加上 overhead

			if (keptTokens + msgTokens <= availableTokens * 0.3) {
				// 放在最前面（逆序遍历）
				keptMessages.unshift(msg);
				keptTokens += msgTokens;
			} else {
				break;
			}
		}

		// 如果保留的消息太少，说明对话太长，需要更激进的压缩
		if (keptMessages.length < 2) {
			// 保留最后一条用户消息（当前问题）
			const lastUserMsg = userAssistantMessages.filter(m => m.role === 'user').pop();
			if (lastUserMsg) {
				keptMessages.push(lastUserMsg);
			}
		}

		// 生成压缩摘要
		const summary = this.generateSummary(userAssistantMessages, keptMessages);

		// 构建压缩后的消息
		const condensed: MiniMaxMessage[] = [];

		if (summary) {
			condensed.push({
				role: 'system',
				content: `【对话历史摘要】\n${summary}\n\n---\n以上是之前对话的摘要。`,
			});
		}

		condensed.push(...keptMessages);

		return { condensed, summary };
	}

	/**
	 * 生成对话摘要
	 */
	private generateSummary(
		allMessages: MiniMaxMessage[],
		keptMessages: MiniMaxMessage[]
	): string {
		if (allMessages.length <= keptMessages.length) {
			return '';
		}

		// 收集被丢弃的消息内容
		const droppedContent: string[] = [];
		const keptIds = new Set(keptMessages.map((m, i) => i));

		let idx = 0;
		for (const msg of allMessages) {
			if (!keptIds.has(idx)) {
				droppedContent.push(`[${msg.role}]: ${msg.content.substring(0, 500)}`);
			}
			idx++;
		}

		if (droppedContent.length === 0) {
			return '';
		}

		// 生成摘要
		const summaryLines = [
			`压缩了 ${droppedContent.length} 条早期消息`,
			`对话主题：${this.extractTopic(allMessages)}`,
		];

		return summaryLines.join('\n');
	}

	/**
	 * 提取对话主题
	 */
	private extractTopic(messages: MiniMaxMessage[]): string {
		// 简单策略：取前几条用户消息的首个问题
		const userMessages = messages.filter(m => m.role === 'user').slice(0, 3);
		if (userMessages.length === 0) return '未知';

		const firstQuestion = userMessages[0].content.substring(0, 50);
		return firstQuestion + (userMessages[0].content.length > 50 ? '...' : '');
	}

	/**
	 * 获取可用 token 数
	 */
	getAvailableTokens(messages: MiniMaxMessage[], systemPrompt: string): number {
		const usedTokens = calculateMessagesTokens(messages) + estimateTokens(systemPrompt);
		return Math.max(0, this.contextWindow - usedTokens - SYSTEM_PROMPT_RESERVE);
	}

	/**
	 * 检查消息是否超出限制
	 */
	isOverLimit(messages: MiniMaxMessage[], systemPrompt: string): boolean {
		const usedTokens = calculateMessagesTokens(messages) + estimateTokens(systemPrompt);
		return usedTokens > this.contextWindow;
	}
}