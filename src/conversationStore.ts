/**
 * 对话历史存储管理
 * 使用 localStorage 持久化对话历史
 */

import { ContextManager, type ContextUsage } from './contextManager';

export interface ConversationMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: number;
	attachedFiles?: Array<{name: string; icon: string}>;
}

export interface Conversation {
	id: string;
	title: string;
	messages: ConversationMessage[];
	createdAt: number;
	updatedAt: number;
}

export class ConversationStore {
	private conversations: Map<string, Conversation> = new Map();
	private currentConversationId: string | null = null;
	private storageKey: string;
	private listeners: Set<() => void> = new Set();
	private contextManager: ContextManager;
	private usageListeners: Set<(usage: ContextUsage) => void> = new Set();
	// P2-10: 脏检查 + debounced 保存，避免每次变更都全量序列化
	private dirtyConversations = new Set<string>();
	private saveScheduled = false;

	constructor(vaultPath: string, contextWindow: number = 200000) {
		// 基于 vault path 创建唯一的 storage key
		const hash = this.hashString(vaultPath);
		this.storageKey = `fuchouzhe-conversations-${hash}`;
		this.contextManager = new ContextManager(contextWindow);
		this.contextManager.setUsageUpdateCallback((usage) => {
			this.usageListeners.forEach(listener => listener(usage));
		});
		this.load();
	}

	private hashString(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash;
		}
		return Math.abs(hash).toString(36);
	}

	/**
	 * 加载存储的对话
	 */
	private load(): void {
		console.log('[ConversationStore] load() called, storageKey:', this.storageKey);
		try {
			const stored = localStorage.getItem(this.storageKey);
			console.log('[ConversationStore] Stored data exists:', !!stored);
			if (stored) {
				const data = JSON.parse(stored);
				console.log('[ConversationStore] Parsed data:', Object.keys(data));
				if (data.conversations) {
					console.log('[ConversationStore] data.conversations type:', typeof data.conversations);
					console.log('[ConversationStore] data.conversations isArray?:', Array.isArray(data.conversations));

					// 兼容处理：可能是数组或对象
					if (Array.isArray(data.conversations)) {
						// 旧格式：数组，用 id 字段作为 key
						for (const conv of data.conversations) {
							if (conv.id) {
								this.conversations.set(conv.id, conv);
							}
						}
					} else {
						// 新格式：对象
						for (const [id, conv] of Object.entries(data.conversations)) {
							this.conversations.set(id, conv as Conversation);
						}
					}

					// 注意：存储的 key 可能是 currentConversationId 或 currentId
					this.currentConversationId = data.currentConversationId || data.currentId || null;
					console.log('[ConversationStore] Loaded conversations count:', this.conversations.size);
					console.log('[ConversationStore] currentConversationId:', this.currentConversationId);
					console.log('[ConversationStore] Map has this id?:', this.conversations.has(this.currentConversationId));
				}
			} else {
				console.log('[ConversationStore] No stored data, will create new conversation');
			}
		} catch (e) {
			console.error('[ConversationStore] Load error:', e);
		}

		// 如果没有对话，创建一个新的
		if (this.conversations.size === 0) {
			console.log('[ConversationStore] Creating new conversation');
			this.createConversation();
		}
		console.log('[ConversationStore] load() complete, currentConversationId:', this.currentConversationId);
	}

	/**
	 * 保存对话到 localStorage（增量 + debounced，避免主线程阻塞）
	 * P2-10: 只序列化标记为脏的对话，用 requestIdleCallback 分散主线程压力
	 */
	private scheduleSave(convId?: string): void {
		if (convId) {
			this.dirtyConversations.add(convId);
		}
		if (this.saveScheduled) return;
		this.saveScheduled = true;

		if (typeof requestIdleCallback !== 'undefined') {
			requestIdleCallback(() => this.flushSave(), { timeout: 2000 });
		} else {
			setTimeout(() => this.flushSave(), 100);
		}
	}

	private flushSave(): void {
		this.saveScheduled = false;
		if (this.dirtyConversations.size === 0) return;

		try {
			// 增量：只序列化脏对话，合并到现有存储
			const existing = localStorage.getItem(this.storageKey);
			const base = existing ? JSON.parse(existing) : { conversations: {}, currentId: null };

			for (const id of this.dirtyConversations) {
				const conv = this.conversations.get(id);
				if (conv) {
					(base.conversations as Record<string, Conversation>)[id] = conv;
				} else {
					delete (base.conversations as Record<string, Conversation>)[id];
				}
			}
			base.currentId = this.currentConversationId;

			localStorage.setItem(this.storageKey, JSON.stringify(base));
			this.dirtyConversations.clear();
		} catch (e) {
			console.error('[ConversationStore] Save error:', e);
		}
	}

	/**
	 * 订阅变化
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach(listener => listener());
	}

	/**
	 * 创建新对话
	 */
	createConversation(): string {
		const id = `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		console.log('[ConversationStore] createConversation, id:', id);
		const conversation: Conversation = {
			id,
			title: '新对话',
			messages: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.conversations.set(id, conversation);
		this.currentConversationId = id;
		console.log('[ConversationStore] After set, conversations size:', this.conversations.size);
		console.log('[ConversationStore] currentConversationId:', this.currentConversationId);
		this.scheduleSave(this.currentConversationId!);
		this.notify();
		return id;
	}

	/**
	 * 获取当前对话
	 */
	getCurrentConversation(): Conversation | null {
		console.log('[ConversationStore] getCurrentConversation, currentConversationId:', this.currentConversationId, 'conversations size:', this.conversations.size);
		if (!this.currentConversationId) {
			console.log('[ConversationStore] getCurrentConversation returning null - no currentConversationId');
			return null;
		}
		const conv = this.conversations.get(this.currentConversationId);
		console.log('[ConversationStore] getCurrentConversation, found:', conv ? 'yes' : 'no');
		return conv || null;
	}

	/**
	 * 获取当前对话 ID
	 */
	getCurrentConversationId(): string | null {
		return this.currentConversationId;
	}

	/**
	 * 切换对话
	 */
	switchConversation(id: string): void {
		if (this.conversations.has(id)) {
			this.currentConversationId = id;
			this.scheduleSave(this.currentConversationId!);
			this.notify();
		}
	}

	/**
	 * 删除对话
	 */
	deleteConversation(id: string): void {
		if (this.conversations.has(id)) {
			this.conversations.delete(id);
			if (this.currentConversationId === id) {
				// 如果删除的是当前对话，切换到第一个可用对话
				const firstId = this.conversations.keys().next().value;
				this.currentConversationId = firstId || null;
			}
			this.scheduleSave(this.currentConversationId!);
			this.notify();
		}
	}

	/**
	 * 获取所有对话
	 */
	getAllConversations(): Conversation[] {
		return Array.from(this.conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/**
	 * 添加用户消息
	 */
	addUserMessage(content: string, attachedFiles?: Array<{name: string; icon: string}>): ConversationMessage | null {
		const conv = this.getCurrentConversation();
		console.log('[ConversationStore] addUserMessage, conv:', conv ? 'exists' : 'null', conv?.messages?.length);
		if (!conv) return null;

		const message: ConversationMessage = {
			id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			role: 'user',
			content,
			timestamp: Date.now(),
			attachedFiles: attachedFiles && attachedFiles.length > 0 ? attachedFiles : undefined,
		};
		conv.messages.push(message);
		conv.updatedAt = Date.now();
		console.log('[ConversationStore] After add, messages count:', conv.messages.length);
		this.scheduleSave(this.currentConversationId!);
		this.notify();
		return message;
	}

	/**
	 * 添加助手消息
	 */
	addAssistantMessage(content: string): ConversationMessage | null {
		const conv = this.getCurrentConversation();
		if (!conv) return null;

		const message: ConversationMessage = {
			id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			role: 'assistant',
			content,
			timestamp: Date.now(),
		};
		conv.messages.push(message);
		conv.updatedAt = Date.now();

		// 更新对话标题（取用户第一条消息的前 30 个字符）
		if (conv.messages.length === 2) {
			const firstUserMsg = conv.messages[0]?.content || '';
			conv.title = firstUserMsg.substring(0, 30) + (firstUserMsg.length > 30 ? '...' : '');
		}

		this.scheduleSave(this.currentConversationId!);
		this.notify();
		return message;
	}

	/**
	 * 更新助手消息（用于流式输出时的更新）
	 */
	updateAssistantMessage(msgId: string, content: string): void {
		const conv = this.getCurrentConversation();
		if (!conv) return;

		const msg = conv.messages.find(m => m.id === msgId && m.role === 'assistant');
		if (msg) {
			msg.content = content;
			conv.updatedAt = Date.now();
			this.scheduleSave(this.currentConversationId!);
			this.notify();
		}
	}

	/**
	 * 订阅上下文使用量变化
	 */
	subscribeUsage(listener: (usage: ContextUsage) => void): () => void {
		this.usageListeners.add(listener);
		return () => this.usageListeners.delete(listener);
	}

	/**
	 * 获取当前上下文使用量
	 */
	getContextUsage(): ContextUsage | null {
		return this.contextManager.getUsage();
	}

	/**
	 * 获取当前对话的消息历史（用于 API 调用）
	 */
	getMessages(): { role: 'user' | 'assistant'; content: string }[] {
		const conv = this.getCurrentConversation();
		console.log('[ConversationStore] getMessages, conv:', conv ? 'exists' : 'null', 'messages:', conv?.messages?.length);
		if (!conv) return [];

		return conv.messages.map(m => ({
			role: m.role,
			content: m.content,
		}));
	}

	/**
	 * 获取消息（带上下文压缩支持）
	 * 如果上下文超过限制，会返回压缩后的消息和摘要
	 */
	getMessagesWithCondensation(
		systemPrompt: string
	): { messages: { role: 'user' | 'assistant' | 'system'; content: string }[]; condensed: boolean; summary?: string } {
		const conv = this.getCurrentConversation();
		if (!conv || conv.messages.length === 0) {
			return { messages: [], condensed: false };
		}

		const messages = conv.messages.map(m => ({
			role: m.role as 'user' | 'assistant',
			content: m.content,
		}));

		// 检查是否需要压缩
		if (this.contextManager.needsCondensation(messages)) {
			const { condensed, summary } = this.contextManager.condenseMessages(messages, systemPrompt);
			// 更新上下文使用量
			const tokens = messages.reduce((sum, m) => sum + m.content.length, 0);
			this.contextManager.updateUsage(tokens);
			return {
				messages: condensed.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
				condensed: true,
				summary,
			};
		}

		// 更新上下文使用量
		const tokens = messages.reduce((sum, m) => sum + m.content.length, 0);
		this.contextManager.updateUsage(tokens);

		return { messages, condensed: false };
	}

	/**
	 * 清空当前对话
	 */
	clearCurrentConversation(): void {
		const conv = this.getCurrentConversation();
		if (!conv) return;

		conv.messages = [];
		conv.title = '新对话';
		conv.updatedAt = Date.now();

		// 重置 ContextManager 状态
		this.contextManager.reset();

		this.scheduleSave(this.currentConversationId!);
		this.notify();
	}

	/**
	 * 导出对话为 JSON
	 */
	exportToJSON(): string {
		return JSON.stringify({
			conversations: Object.fromEntries(this.conversations),
			currentId: this.currentConversationId,
			exportedAt: Date.now(),
		}, null, 2);
	}

	/**
	 * 从 JSON 导入对话
	 */
	importFromJSON(json: string): { success: boolean; message: string } {
		try {
			const data = JSON.parse(json);
			if (data.conversations) {
				for (const [id, conv] of Object.entries(data.conversations)) {
					this.conversations.set(id, conv as Conversation);
				}
			}
			if (data.currentId && this.conversations.has(data.currentId)) {
				this.currentConversationId = data.currentId;
			}
			this.scheduleSave(this.currentConversationId!);
			this.notify();
			return { success: true, message: '导入成功' };
		} catch (e) {
			return { success: false, message: '导入失败：无效的 JSON 格式' };
		}
	}
}