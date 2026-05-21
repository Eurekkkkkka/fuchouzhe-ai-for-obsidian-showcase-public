import { ItemView, WorkspaceLeaf, TFile, MarkdownView, MarkdownRenderer, Notice } from 'obsidian';
import FuchouzhePlugin from './main';
import { FuchouzheService, FuchouzheToolCall } from './fuchouzheService';
import type { FuchouzheSettings } from './main';
import { initI18n, t } from './i18n';
import { AuthUI } from './authUI';
import { ConversationStore } from './conversationStore';
import { isBinaryDocument, parseDocument, getFileIcon } from './documentReader';
import { ActionOverlay, ActionSelection, recordRecentAction } from './scenePanel';
import { ScenePipeline, PipelineCallbacks } from './scenePipeline';
import { ActionConfig, PipelineContext, getActionConfig, createPipelineContext, detectAction, resolveTemplatePath, composeOutputPath } from './sceneConfig';
import { getFuchouzheLockupSvg, getFuchouzheMarkSvg } from './brandLogo';

export const VIEW_TYPE_FUCHOUZHE_CHAT = 'fuchouzhe-chat-view';

export class FuchouzheChatView extends ItemView {
	plugin: FuchouzhePlugin;
	fuchouzheService: FuchouzheService;
	conversationStore: ConversationStore;
	private currentMessage = '';
	private currentAssistantMsgId: string | null = null;
	private isStreaming = false;
	private thinkingContent = '';

	// Text buffering for smooth streaming
	private textBuffer: string = '';
	private flushTimer: number | null = null;
	private renderRafId: number | null = null;
	private pendingRender = false;

	// Thinking buffering for smooth streaming
	private thinkingBuffer: string = '';
	private thinkingFlushTimer: number | null = null;
	private pendingThinkingRender = false;

	// Tool call tracking
	private activeToolCalls = new Map<string, FuchouzheToolCall>();
	private toolCallElements = new Map<string, HTMLElement>();

	// UI Components
	private messagesContainer!: HTMLElement;
	private textarea!: HTMLTextAreaElement;
	private sendButton!: HTMLElement;
	private welcomeMessage!: HTMLElement;
	private contextIndicator!: HTMLElement;

	// Conversation panel
	private showConversationPanel = false;
	private conversationPanel!: HTMLElement;
	private conversationTrigger!: HTMLElement;

	// Streaming state
	private firstChunkReceived = false;

	// Auth UI
	private authUI: AuthUI | null = null;
	private authContainer: HTMLElement | null = null;
	private chatContainer: HTMLElement | null = null;
	private isAuthenticated = false;

	// Action panel
	private actionOverlay: ActionOverlay | null = null;
	private activePipeline: ScenePipeline | null = null;
	private isSceneMode = false;
	private pendingAction: ActionConfig | null = null;
	private pendingDisabledSkills: Set<string> = new Set();
	private pendingOutputPath: string = '';
	private pendingOutputFolder: string = '';
	private pendingFileName: string = '';
	private pendingFileNameEdited = false;
	private pendingAutoFilename = false;

	constructor(leaf: WorkspaceLeaf, plugin: FuchouzhePlugin, fuchouzheService: FuchouzheService) {
		super(leaf);
		this.plugin = plugin;
		this.fuchouzheService = fuchouzheService;
		this.conversationStore = new ConversationStore(plugin.getVaultPath());
	}

	getViewType(): string {
		return VIEW_TYPE_FUCHOUZHE_CHAT;
	}

	getDisplayText(): string {
		return '富酬者AI Chat';
	}

	getIcon(): string {
		return 'message-square';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('fuchouzhe-container');

		// 创建 Auth UI 容器（用于登录验证）
		this.authContainer = container.createDiv({ cls: 'fuchouzhe-auth-container' });

		// 创建聊天 UI 容器
		this.chatContainer = container.createDiv({ cls: 'fuchouzhe-chat' });
		this.chatContainer.style.display = 'none';

		// 初始化 Auth UI
		this.authUI = new AuthUI({
			container: this.authContainer,
			onSuccess: () => {
				this.isAuthenticated = true;
				this.showChatView();
			},
			onLogout: () => {
				this.isAuthenticated = false;
				this.showAuthView();
			}
		});

		// 初始化 Auth UI（会检查登录状态）
		await this.authUI.init();

		// 如果已经登录，直接显示聊天界面
		if (this.authUI.isLoggedIn()) {
			this.isAuthenticated = true;
			this.showChatView();
		}
	}

	/**
	 * 显示聊天界面
	 */
	private showChatView(): void {
		if (!this.chatContainer || !this.authContainer) return;

		this.authContainer.style.display = 'none';
		this.chatContainer.style.display = 'flex';

		// 如果已经有聊天 UI 子元素，不再重新创建
		if (this.chatContainer.children.length > 0) {
			// 仍尝试加载历史（如果需要）
			this.loadConversationHistory();
			return;
		}

		// 创建聊天 UI
		// Header — layout: [logo] [spacer] [title ▾] [spacer] [actions]
		const header = this.chatContainer.createDiv({ cls: 'fuchouzhe-header' });

		// Left: brand logo (clickable → scene panel)
		const headerLogo = header.createDiv({ cls: 'fuchouzhe-header-logo fuchouzhe-header-logo-clickable' });
		headerLogo.setAttribute('aria-label', '场景面板');
		headerLogo.addEventListener('click', () => {
			if (this.isStreaming) return;
			this.showScenePage();
		});
		headerLogo.innerHTML = getFuchouzheMarkSvg(24);

		// Center: conversation selector (absolute centered)
		const selector = header.createDiv({ cls: 'fuchouzhe-conversation-selector' });
		this.conversationTrigger = selector.createEl('button', {
			cls: 'fuchouzhe-conversation-trigger',
		});
		const conv = this.conversationStore.getCurrentConversation();
		const triggerText = this.conversationTrigger.createSpan({ cls: 'fuchouzhe-conversation-trigger-text' });
		triggerText.textContent = conv?.title || '新对话';
		this.conversationTrigger.createSpan({ cls: 'fuchouzhe-conversation-arrow', text: '▾' });
		this.conversationTrigger.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleConversationPanel();
		});

		// 对话面板
		this.conversationPanel = selector.createDiv({ cls: 'fuchouzhe-conversation-panel hidden' });
		this.buildConversationPanel();

		// 点击外部关闭面板
		this.registerDomEvent(document, 'click', (e: MouseEvent) => {
			if (this.showConversationPanel && !selector.contains(e.target as Node)) {
				this.closeConversationPanel();
			}
		});

		// Right: Header actions
		const actions = header.createDiv({ cls: 'fuchouzhe-header-actions' });

		// Export conversation button
		const exportBtn = actions.createEl('button', {
			cls: 'fuchouzhe-header-btn',
			attr: { 'aria-label': '导出对话' }
		});
		exportBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
		exportBtn.addEventListener('click', () => this.exportConversation());

		// P1-4: Clear context button with confirmation
		const clearBtn = actions.createEl('button', {
			cls: 'fuchouzhe-header-btn',
			attr: { 'aria-label': '清空上下文', 'data-tooltip': '清空上下文（开始新话题）' }
		});
		clearBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
		clearBtn.addEventListener('click', async () => {
			const currentConv = this.conversationStore.getCurrentConversation();
			if (!currentConv || currentConv.messages.length === 0) {
				new Notice('当前没有对话内容');
				return;
			}
			this.clearContext();
		});

		// Messages wrapper
		const messagesWrapper = this.chatContainer.createDiv({ cls: 'fuchouzhe-messages-wrapper' });

		// Messages container
		this.messagesContainer = messagesWrapper.createDiv({ cls: 'fuchouzhe-messages' });

		// Scroll-to-bottom floating button
		const scrollBottomBtn = messagesWrapper.createDiv({ cls: 'fuchouzhe-scroll-bottom-btn fuchouzhe-hidden' });
		scrollBottomBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
		scrollBottomBtn.addEventListener('click', () => {
			this.scrollToBottom();
		});
		this.messagesContainer.addEventListener('scroll', () => {
			const { scrollTop, scrollHeight, clientHeight } = this.messagesContainer;
			const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
			if (isNearBottom) {
				scrollBottomBtn.addClass('fuchouzhe-hidden');
			} else {
				scrollBottomBtn.removeClass('fuchouzhe-hidden');
			}
		});

		// Welcome message
		this.addWelcomeMessage();

		// Input container
		const inputContainer = this.chatContainer.createDiv({ cls: 'fuchouzhe-input-container' });

		// Multi-file context indicator
		this.contextIndicator = inputContainer.createDiv({ cls: 'fuchouzhe-context-bar fuchouzhe-hidden' });
		this.plugin.app.workspace.on('file-open', (file) => {
			// 场景模式下不自动附加文件
			if (this.isSceneMode) return;

			if (file && this.plugin.settings.autoAttachFile) {
				// 替换旧的自动附加文件，但不删除用户手动添加的
				if (this.autoAttachedPath && this.autoAttachedPath !== file.path) {
					if (!this.manuallyAttachedPaths.has(this.autoAttachedPath)) {
						this.attachedFiles.delete(this.autoAttachedPath);
					}
				}
				this.autoAttachedPath = file.path;
				this.attachedFiles.set(file.path, file);
				this.renderAttachedFiles();
			}
		});
		// 初始化当前文件
		const currentFile = this.plugin.getActiveFile();
		if (currentFile && this.plugin.settings.autoAttachFile) {
			this.autoAttachedPath = currentFile.path;
			this.attachedFiles.set(currentFile.path, currentFile);
			this.renderAttachedFiles();
		}

		// Input wrapper
		const inputWrapper = inputContainer.createDiv({ cls: 'fuchouzhe-input-wrapper' });

		this.textarea = inputWrapper.createEl('textarea', {
			cls: 'fuchouzhe-input',
			attr: { placeholder: '输入你的问题... (Shift+Enter 换行)' }
		}) as HTMLTextAreaElement;

		// P1-2: 输入框自动调高
		this.textarea.addEventListener('input', () => {
			this.textarea.style.height = 'auto';
			this.textarea.style.height = Math.min(this.textarea.scrollHeight, 200) + 'px';
			// @ mention file picker
			this.handleAtMention();
			// / prompt template picker
			this.handleSlashCommand();
		});

		// Drag and drop file support
		inputWrapper.addEventListener('dragover', (e) => {
			e.preventDefault();
			inputWrapper.classList.add('fuchouzhe-input-dragover');
		});
		inputWrapper.addEventListener('dragleave', () => {
			inputWrapper.classList.remove('fuchouzhe-input-dragover');
		});
		inputWrapper.addEventListener('drop', async (e) => {
			e.preventDefault();
			inputWrapper.classList.remove('fuchouzhe-input-dragover');
			const files = e.dataTransfer?.files;
			if (files && files.length > 0) {
				// Try to find the file in vault
				const droppedFile = files[0];
				const vaultFiles = this.plugin.app.vault.getFiles();
				const match = vaultFiles.find(f => f.name === droppedFile.name);
				if (match) {
					this.addAttachedFile(match);
					this.textarea.dispatchEvent(new Event('input'));
				} else {
					new Notice('只能拖拽 vault 中的文件');
				}
			}
		});

		// Input toolbar
		const toolbar = inputWrapper.createDiv({ cls: 'fuchouzhe-input-toolbar' });

		this.sendButton = toolbar.createEl('button', {
			cls: 'fuchouzhe-send-button',
			attr: { 'aria-label': '发送' }
		});
		this.sendButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

		// P0-2: 发送/停止按钮
		this.sendButton.addEventListener('click', () => {
			if (this.isStreaming) {
				this.fuchouzheService.abort();
				if (this.activePipeline) this.activePipeline.abort();
				this.isStreaming = false;
				this.resetSendButton();
			} else if (this.isSceneMode) {
				this.executeActionFromInput();
			} else {
				this.sendMessage();
			}
		});

		// Event listeners
		this.textarea.addEventListener('keydown', (e) => {
			// @ mention 键盘导航
			if (this.atMentionDropdown) {
				if (this.handleAtMentionKeydown(e)) return;
			}
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				if (this.isStreaming) return;
				if (this.isSceneMode) {
					this.executeActionFromInput();
				} else {
					this.sendMessage();
				}
			}
		});

		// 加载历史消息
		this.loadConversationHistory();
	}

	/**
	 * 加载历史对话
	 */
	private loadConversationHistory(): void {
		const conv = this.conversationStore.getCurrentConversation();
		console.log('[ChatView] loadConversationHistory, conv:', conv ? 'exists' : 'null', 'messages:', conv?.messages?.length);

		if (!conv || conv.messages.length === 0) {
			console.log('[ChatView] No history to load or empty conversation');
			return;
		}

		// 隐藏欢迎消息
		if (this.welcomeMessage) {
			this.welcomeMessage.addClass('fuchouzhe-hidden');
		}

		// 加载所有消息到 UI
		for (const msg of conv.messages) {
			console.log('[ChatView] Loading message:', msg.role, msg.content.substring(0, 50));
			this.addMessage(msg.role, msg.content, msg.attachedFiles);
		}
	}

	/**
	 * 显示认证界面
	 */
	private showAuthView(): void {
		if (!this.chatContainer || !this.authContainer) return;

		this.chatContainer.style.display = 'none';
		this.authContainer.style.display = 'flex';

		// 清空聊天容器，重新初始化
		this.chatContainer.empty();
	}

	/**
	 * 检查是否已登录
	 */
	private isLoggedIn(): boolean {
		return this.authUI?.isLoggedIn() || false;
	}

	private async ensureAuthenticated(): Promise<boolean> {
		if (!this.authUI) return false;

		const valid = await this.authUI.ensureSession();
		if (!valid) {
			this.isAuthenticated = false;
			this.showAuthView();
			return false;
		}

		this.isAuthenticated = true;
		return true;
	}

	private addWelcomeMessage() {
		const greeting = this.getTimeBasedGreeting();
		const welcomeEl = this.messagesContainer.createDiv({
			cls: 'fuchouzhe-message fuchouzhe-message-assistant fuchouzhe-welcome-message'
		});
		const contentEl = welcomeEl.createDiv({ cls: 'fuchouzhe-message-content' });

		// Brand logo
		const logoEl = contentEl.createDiv({ cls: 'fuchouzhe-welcome-logo' });
		logoEl.innerHTML = getFuchouzheLockupSvg(160, 140);

		// Greeting
		const greetingEl = contentEl.createEl('p', { cls: 'fuchouzhe-welcome-greeting-text' });
		greetingEl.setText(greeting);

		// Subtitle
		contentEl.createEl('p', {
			cls: 'fuchouzhe-welcome-subtitle',
			text: '我可以帮你整理笔记、写作、搜索、生成思维导图...'
		});

		// Quick prompts (restored)
		const quickPrompts = contentEl.createDiv({ cls: 'fuchouzhe-quick-prompts' });
		const prompts = [
			{ icon: '📝', text: '总结当前文件' },
			{ icon: '💡', text: '帮我写大纲' },
			{ icon: '🔍', text: '搜索相关笔记' },
		];
		for (const p of prompts) {
			const btn = quickPrompts.createEl('button', {
				cls: 'fuchouzhe-quick-prompt-btn',
				text: `${p.icon} ${p.text}`
			});
			btn.addEventListener('click', () => {
				this.textarea.value = p.text;
				this.sendMessage();
			});
		}

		this.welcomeMessage = welcomeEl;
	}

	// ============ 动作面板集成 ============

	/**
	 * 显示动作建议横幅：用户输入匹配了某个动作，提供"执行动作"或"普通发送"两个选项
	 */
	private showActionSuggestion(action: ActionConfig, userInput: string): void {
		// 移除已有的建议横幅
		this.messagesContainer.querySelector('.fuchouzhe-action-suggestion')?.remove();

		const banner = this.messagesContainer.createDiv({ cls: 'fuchouzhe-action-suggestion' });

		// 动作信息行
		const infoRow = banner.createDiv({ cls: 'fuchouzhe-action-suggestion-info' });
		infoRow.createSpan({ cls: 'fuchouzhe-action-suggestion-icon', text: action.icon });
		const infoText = infoRow.createDiv({ cls: 'fuchouzhe-action-suggestion-text-wrap' });
		infoText.createDiv({ cls: 'fuchouzhe-action-suggestion-title', text: `检测到「${action.name}」` });
		infoText.createDiv({ cls: 'fuchouzhe-action-suggestion-desc', text: action.description });

		const buttons = banner.createDiv({ cls: 'fuchouzhe-action-suggestion-buttons' });

		const runBtn = buttons.createEl('button', { cls: 'fuchouzhe-action-suggestion-run' });
		runBtn.textContent = `${action.icon} 使用此场景`;
		runBtn.addEventListener('click', () => {
			banner.remove();
			// 进入场景模式，显示简报卡片，让用户确认后执行
			this.pendingAction = action;
			this.pendingDisabledSkills = new Set();
			this.pendingOutputFolder = action.defaultOutputFolder;
			this.pendingFileName = resolveTemplatePath(action.defaultFileName);
			this.pendingFileNameEdited = false;
			this.pendingAutoFilename = true;
			this.pendingOutputPath = composeOutputPath(this.pendingOutputFolder, this.pendingFileName);
			this.enterSceneMode(action);
			this.showBriefingCard({
				action,
				disabledSkills: new Set(),
				outputFolder: action.defaultOutputFolder,
				fileName: this.pendingFileName,
				outputPath: this.pendingOutputPath,
				fileNameEdited: false,
				autoFilename: true,
			});
		});

		const skipBtn = buttons.createEl('button', { cls: 'fuchouzhe-action-suggestion-skip' });
		skipBtn.textContent = '普通发送';
		skipBtn.addEventListener('click', () => {
			banner.remove();
			this.sendMessageDirect();
		});

		this.scrollToBottom();
	}

	/**
	 * 直接发送消息（跳过动作检测，用于"普通发送"按钮）
	 */
	private sendMessageDirect(): void {
		this.sendMessage(true);
	}

	private showScenePage(): void {
		// 如果已经打开，关闭它
		if (this.actionOverlay?.isVisible()) {
			this.actionOverlay.close();
			return;
		}

		if (!this.chatContainer) return;

		this.actionOverlay = new ActionOverlay(
			this.chatContainer,
			(selection) => this.onActionSelected(selection),
			() => { this.actionOverlay = null; },
			this.app,
		);
		this.actionOverlay.show();
	}

	private onActionSelected(selection: ActionSelection): void {
		this.actionOverlay = null;

		const action = selection.action;

		// 如果动作配置了 autoExecutePrompt，跳过简报卡片，直接执行
		if (action.autoExecutePrompt) {
			const context = createPipelineContext(action, action.autoExecutePrompt, [], {
				outputFolder: selection.outputFolder,
				fileName: selection.fileName,
				fileNameEdited: selection.fileNameEdited,
				autoFilename: selection.autoFilename,
			});
			recordRecentAction(action.id);
			this.executePipeline(action, context, selection.disabledSkills);
			return;
		}

		this.pendingAction = action;
		this.pendingDisabledSkills = selection.disabledSkills;
		this.pendingOutputFolder = selection.outputFolder;
		this.pendingFileName = selection.fileName;
		this.pendingFileNameEdited = selection.fileNameEdited;
		this.pendingAutoFilename = selection.autoFilename;
		this.pendingOutputPath = selection.outputPath;
		this.enterSceneMode(action);

		// 显示任务简报卡片
		this.showBriefingCard(selection);

		// 聚焦输入框
		this.textarea?.focus();
	}

	/**
	 * 在聊天区显示任务简报卡片（待执行状态）
	 */
	private showBriefingCard(selection: ActionSelection): void {
		// 移除已有的简报卡片
		this.messagesContainer.querySelector('.fuchouzhe-briefing-card')?.remove();

		// 隐藏所有已有子元素（消息、欢迎消息等），让 briefing card 独占页面
		Array.from(this.messagesContainer.children).forEach(child => {
			(child as HTMLElement).classList.add('fuchouzhe-scene-hidden');
		});

		const action = selection.action;
		const card = this.messagesContainer.createDiv({ cls: 'fuchouzhe-briefing-card' });

		// 头部：图标 + 名称 + 描述
		const hero = card.createDiv({ cls: 'fuchouzhe-briefing-hero' });
		hero.createDiv({ cls: 'fuchouzhe-briefing-icon', text: action.icon });
		const heroInfo = hero.createDiv({ cls: 'fuchouzhe-briefing-info' });
		heroInfo.createDiv({ cls: 'fuchouzhe-briefing-name', text: action.name });
		heroInfo.createDiv({ cls: 'fuchouzhe-briefing-desc', text: action.description });

		// 将执行的步骤
		const activeSkills = action.pipeline.filter(
			s => s !== 'writeback-output' && !selection.disabledSkills.has(s)
		);
		if (activeSkills.length > 0) {
			const stepsSection = card.createDiv({ cls: 'fuchouzhe-briefing-section' });
			stepsSection.createDiv({ cls: 'fuchouzhe-briefing-section-label', text: '📋 将执行' });
			const stepsFlow = stepsSection.createDiv({ cls: 'fuchouzhe-briefing-steps' });
			activeSkills.forEach((skillId, i) => {
				const label = action.skillLabels?.[skillId]
					|| action.stepLabels[skillId]?.replace(/^正在/, '').replace(/\.{3}$/, '')
					|| skillId;
				stepsFlow.createSpan({ cls: 'fuchouzhe-briefing-step-chip', text: label });
				if (i < activeSkills.length - 1) {
					stepsFlow.createSpan({ cls: 'fuchouzhe-briefing-step-arrow', text: '→' });
				}
			});
		}

		// 示例输入
		if (action.examples && action.examples.length > 0) {
			const exSection = card.createDiv({ cls: 'fuchouzhe-briefing-section' });
			exSection.createDiv({ cls: 'fuchouzhe-briefing-section-label', text: '💡 试试这样输入' });
			const exList = exSection.createDiv({ cls: 'fuchouzhe-briefing-examples' });
			for (const example of action.examples) {
				const exItem = exList.createDiv({ cls: 'fuchouzhe-briefing-example' });
				exItem.textContent = example;
				exItem.addEventListener('click', () => {
					if (this.textarea) {
						this.textarea.value = example;
						this.textarea.focus();
						// 触发 input 事件以调整高度
						this.textarea.dispatchEvent(new Event('input'));
					}
				});
			}
		}

		// 输出路径
		const pathSection = card.createDiv({ cls: 'fuchouzhe-briefing-path' });
		if (selection.autoFilename) {
			// 自动文件名：只显示文件夹，不显示具体文件名
			const lastSlash = selection.outputPath.lastIndexOf('/');
			const folder = lastSlash !== -1 ? selection.outputPath.substring(0, lastSlash + 1) : selection.outputPath;
			pathSection.textContent = `📂 ${folder}`;
		} else {
			pathSection.textContent = `📂 ${selection.outputPath}`;
		}

		// 取消按钮
		const cancelBtn = card.createEl('button', { cls: 'fuchouzhe-briefing-cancel', text: '取消' });
		cancelBtn.addEventListener('click', () => {
			card.remove();
			this.exitSceneMode();
		});

		this.scrollToBottom();
	}

	private enterSceneMode(action: ActionConfig): void {
		this.isSceneMode = true;

		// 清除自动附加的文件，只保留手动添加的
		if (this.autoAttachedPath && !this.manuallyAttachedPaths.has(this.autoAttachedPath)) {
			this.attachedFiles.delete(this.autoAttachedPath);
		}
		this.autoAttachedPath = null;
		this.renderAttachedFiles();

		// 改变发送按钮为执行按钮
		if (this.sendButton) {
			this.sendButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
			this.sendButton.setAttribute('aria-label', '开始执行');
			this.sendButton.classList.add('fuchouzhe-send-button-execute');
		}

		// 根据 requiredInput 设置 placeholder
		if (this.textarea) {
			const hint = action.requiredInput === 'file'
				? '请附加文件后按 Enter 执行'
				: action.requiredInput === 'text'
				? '请输入内容后按 Enter 执行'
				: '输入内容或附加文件后按 Enter 执行';
			this.textarea.setAttribute('placeholder', `${action.icon} ${action.name} — ${hint}`);
		}
	}

	private exitSceneMode(): void {
		this.isSceneMode = false;
		this.pendingAction = null;
		this.pendingDisabledSkills.clear();
		this.pendingOutputPath = '';
		this.pendingOutputFolder = '';
		this.pendingFileName = '';
		this.pendingFileNameEdited = false;
		this.pendingAutoFilename = false;

		// 清理简报卡片
		this.messagesContainer.querySelector('.fuchouzhe-briefing-card')?.remove();

		// 恢复所有被隐藏的子元素
		Array.from(this.messagesContainer.children).forEach(child => {
			(child as HTMLElement).classList.remove('fuchouzhe-scene-hidden');
		});

		// 恢复发送按钮
		if (this.sendButton) {
			this.sendButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
			this.sendButton.setAttribute('aria-label', '发送');
			this.sendButton.classList.remove('fuchouzhe-send-button-execute');
		}

		// 恢复输入框 placeholder
		if (this.textarea) {
			this.textarea.setAttribute('placeholder', '输入你的问题... (Shift+Enter 换行)');
		}

		// 恢复自动附加当前文件
		const currentFile = this.plugin.getActiveFile();
		if (currentFile && this.plugin.settings.autoAttachFile) {
			this.autoAttachedPath = currentFile.path;
			this.attachedFiles.set(currentFile.path, currentFile);
		}
		this.renderAttachedFiles();
	}

	private async executeActionFromInput(): Promise<void> {
		const action = this.pendingAction;
		if (!action) return;
		if (!(await this.ensureAuthenticated())) return;

		// 移除简报卡片
		this.messagesContainer.querySelector('.fuchouzhe-briefing-card')?.remove();

		let inputText = this.textarea?.value?.trim() || '';

		// 空输入时使用动作的默认提示词
		if (!inputText && action.defaultPrompt) {
			inputText = action.defaultPrompt;
		}

		// 场景模式下：只取用户手动附加的文件，排除自动附加的当前笔记
		const manualFiles = Array.from(this.attachedFiles.entries())
			.filter(([path]) => path !== this.autoAttachedPath)
			.map(([, file]) => file);
		const fileNames = manualFiles.map(f => f.path);
		const hasText = inputText.length > 0;
		const hasFiles = fileNames.length > 0;

		// 根据 requiredInput 校验（仅 file 类型强制要求附件，text 和 text_or_file 允许空输入）
		if (action.requiredInput === 'file' && !hasFiles) {
			new Notice('这个操作需要附加文件（使用 @ 或拖拽文件）');
			return;
		}

		// 构建输入（文件内容通过 attachmentContents 传递，不拼入 input 文本）
		const fullInput = inputText;

		const context = createPipelineContext(action, fullInput, fileNames, {
			outputFolder: this.pendingOutputFolder || undefined,
			fileName: this.pendingFileName || undefined,
			fileNameEdited: this.pendingFileNameEdited,
			autoFilename: this.pendingAutoFilename,
		});

		// 读取附件文件内容（Excel/Word/普通文本等）
		if (hasFiles) {
			for (const file of manualFiles) {
				try {
					const ext = file.extension?.toLowerCase() || '';
					let content: string;
					if (isBinaryDocument(ext)) {
						const buffer = await this.app.vault.readBinary(file);
						const result = await parseDocument(buffer, file.name, ext);
						content = result.content;
					} else {
						content = await this.app.vault.read(file);
					}
					context.attachmentContents.set(file.path, content);
				} catch (e: any) {
					console.error('[ChatView] Failed to read attachment for pipeline:', file.path, e);
					context.attachmentContents.set(file.path, `[无法读取文件: ${file.name} - ${e.message}]`);
				}
			}
		}

		// 清理输入框
		if (this.textarea) this.textarea.value = '';
		this.attachedFiles.clear();
		this.manuallyAttachedPaths.clear();
		this.renderAttachedFiles();

		// 收集附件文件信息（用于消息气泡显示）
		const attachedFileNames: Array<{name: string; icon: string}> = [];
		for (const file of manualFiles) {
			const ext = file.extension?.toLowerCase() || '';
			attachedFileNames.push({ name: file.basename, icon: getFileIcon(ext) });
		}

		// 保存 disabledSkills 用于 pipeline 过滤
		const disabledSkills = new Set(this.pendingDisabledSkills);

		// 退出场景模式
		this.exitSceneMode();

		// 记录最近使用
		recordRecentAction(action.id);

		// 执行 pipeline（传入 disabledSkills 和附件信息）
		this.executePipeline(action, context, disabledSkills, attachedFileNames);
	}

	private async executePipeline(action: ActionConfig, context: PipelineContext, disabledSkills?: Set<string>, attachedFileNames?: Array<{name: string; icon: string}>): Promise<void> {
		// 显示用户输入（带附件 chip）
		const inputDisplay = context.input?.trim();
		const userContent = inputDisplay
			? `${action.icon} ${action.name}\n${inputDisplay}`
			: `${action.icon} ${action.name}`;
		this.addMessage('user', userContent,
			attachedFileNames && attachedFileNames.length > 0 ? attachedFileNames : undefined);

		// 保存用户输入到 conversationStore
		this.conversationStore.addUserMessage(userContent,
			attachedFileNames && attachedFileNames.length > 0 ? attachedFileNames : undefined);

		// 创建执行卡片消息
		const progressMsgId = this.addMessage('assistant', '');
		const progressEl = this.messagesContainer.querySelector(`[data-id="${progressMsgId}"]`);
		const contentEl = progressEl?.querySelector('.fuchouzhe-message-content') as HTMLElement;
		if (!contentEl) return;

		contentEl.empty();

		// ---- 构建执行卡片 ----
		const card = contentEl.createDiv({ cls: 'fuchouzhe-exec-card' });

		// 卡片头部：图标 + 名称 + 状态
		const cardHeader = card.createDiv({ cls: 'fuchouzhe-exec-header' });
		cardHeader.createSpan({ cls: 'fuchouzhe-exec-icon', text: action.icon });
		const headerInfo = cardHeader.createDiv({ cls: 'fuchouzhe-exec-header-info' });
		headerInfo.createDiv({ cls: 'fuchouzhe-exec-title', text: action.name });
		const statusBadge = headerInfo.createSpan({ cls: 'fuchouzhe-exec-badge fuchouzhe-exec-badge-running' });
		statusBadge.textContent = '执行中';

		// 进度条
		const progressBar = card.createDiv({ cls: 'fuchouzhe-exec-bar' });
		const progressFill = progressBar.createDiv({ cls: 'fuchouzhe-exec-bar-fill' });

		// 步骤列表（每个 skill 一行，实时更新状态）
		const activeSkills = (disabledSkills && disabledSkills.size > 0)
			? action.pipeline.filter(s => !disabledSkills.has(s))
			: action.pipeline;
		const totalSteps = activeSkills.length;
		let currentStep = 0;

		// ---- 缓动进度动画引擎 ----
		let animatedProgress = 0;       // 当前动画值
		let targetProgress = 0;         // 目标值（步骤节点）
		let ceilingProgress = 0;        // 当前允许的爬行上限（下一个节点值）
		let progressRAF: number | null = null;

		const tickProgress = () => {
			if (animatedProgress < targetProgress) {
				// 快速追赶到已确认的节点目标
				const delta = Math.max(0.12, (targetProgress - animatedProgress) * 0.08);
				animatedProgress = Math.min(animatedProgress + delta, targetProgress);
			} else if (animatedProgress < ceilingProgress) {
				// 到达节点后，缓慢爬行逼近下一个节点上限（永远不到达）
				const remaining = ceilingProgress - animatedProgress;
				// 越接近上限爬得越慢：每帧只走剩余距离的 0.3%
				const creep = Math.max(0.01, remaining * 0.003);
				animatedProgress = Math.min(animatedProgress + creep, ceilingProgress - 0.5);
			}
			progressFill.style.width = `${animatedProgress}%`;
			progressRAF = requestAnimationFrame(tickProgress);
		};
		// 启动动画循环
		progressRAF = requestAnimationFrame(tickProgress);

		const setTargetProgress = (pct: number, ceiling: number) => {
			targetProgress = pct;
			ceilingProgress = ceiling;
		};
		const stopProgressAnimation = () => {
			if (progressRAF !== null) { cancelAnimationFrame(progressRAF); progressRAF = null; }
		};

		const stepsContainer = card.createDiv({ cls: 'fuchouzhe-exec-steps' });
		const stepElements = new Map<string, { row: HTMLElement; statusEl: HTMLElement; labelEl: HTMLElement; summaryEl: HTMLElement; previewEl: HTMLElement }>();

		for (const skillId of activeSkills) {
			const label = action.skillLabels?.[skillId]
				|| action.stepLabels[skillId]?.replace(/^正在/, '').replace(/\.{3}$/, '')
				|| skillId;

			const row = stepsContainer.createDiv({ cls: 'fuchouzhe-exec-step' });
			const mainLine = row.createDiv({ cls: 'fuchouzhe-exec-step-main' });
			const statusEl = mainLine.createSpan({ cls: 'fuchouzhe-exec-step-status fuchouzhe-exec-step-pending' });
			statusEl.textContent = '○';
			const labelEl = mainLine.createSpan({ cls: 'fuchouzhe-exec-step-label', text: label });

			const summaryEl = row.createDiv({ cls: 'fuchouzhe-exec-step-summary fuchouzhe-hidden' });
			const previewEl = row.createDiv({ cls: 'fuchouzhe-exec-step-preview fuchouzhe-hidden' });

			stepElements.set(skillId, { row, statusEl, labelEl, summaryEl, previewEl });
		}

		this.scrollToBottom();
		this.isStreaming = true;

		const skillManager = this.fuchouzheService.getSkillManager();
		const apiClient = this.fuchouzheService.getMiniMaxClient();
		const toolManager = this.fuchouzheService.getToolManager();

		const pipeline = new ScenePipeline({
			action,
			skillManager,
			apiClient,
			toolManager,
			app: this.app,
			disabledSkills,
			conversationStore: this.conversationStore,
		});
		this.activePipeline = pipeline;

		let finalOutput = '';

		const callbacks: PipelineCallbacks = {
			onStepStart: (skillId, _label) => {
				const el = stepElements.get(skillId);
				if (el) {
					currentStep++;
					const nodePct = Math.min(Math.round(((currentStep - 0.5) / totalSteps) * 100), 95);
					const ceilingPct = Math.min(Math.round((currentStep / totalSteps) * 100), 97);
					setTargetProgress(nodePct, ceilingPct);

					el.row.addClass('fuchouzhe-exec-step-active');
					el.statusEl.textContent = '◉';
					el.statusEl.className = 'fuchouzhe-exec-step-status fuchouzhe-exec-step-running';
				}
				this.scrollToBottom();
			},
			onStepChunk: (skillId: string, chunk: string) => {
				const el = stepElements.get(skillId);
				if (!el?.previewEl) return;

				const rawKey = `__raw_${skillId}`;
				(el as any)[rawKey] = ((el as any)[rawKey] || '') + chunk;
				const rawText: string = (el as any)[rawKey];

				const lines = rawText.split('\n')
					.map(l => l.trim())
					.filter(l => l && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('```'));

				const displayLines = lines.slice(-3);
				if (displayLines.length > 0) {
					el.previewEl.empty();
					for (const line of displayLines) {
						const lineEl = el.previewEl.createDiv({ cls: 'fuchouzhe-exec-preview-line' });
						lineEl.textContent = line.length > 60 ? line.slice(0, 60) + '...' : line;
					}
					el.previewEl.removeClass('fuchouzhe-hidden');
				}
				this.scrollToBottom();
			},
			onStepComplete: (skillId, result) => {
				const el = stepElements.get(skillId);
				if (el) {
					const nodePct = Math.min(Math.round((currentStep / totalSteps) * 100), 95);
					const nextCeiling = Math.min(Math.round(((currentStep + 0.5) / totalSteps) * 100), 97);
					setTargetProgress(nodePct, nextCeiling);

					el.row.removeClass('fuchouzhe-exec-step-active');
					el.row.addClass('fuchouzhe-exec-step-done');
					el.statusEl.textContent = '✓';
					el.statusEl.className = 'fuchouzhe-exec-step-status fuchouzhe-exec-step-success';

					// 隐藏实时预览
					el.previewEl.addClass('fuchouzhe-hidden');

					// 显示完成摘要
					if (result && skillId !== 'writeback-output') {
						const summary = this.extractStepSummary(result);
						if (summary) {
							el.summaryEl.textContent = summary;
							el.summaryEl.removeClass('fuchouzhe-hidden');
						}
					}
				}

				if (skillId === 'writeback-output') {
					finalOutput = result;
				}
				this.scrollToBottom();
			},
			onStepError: (skillId, error) => {
				const el = stepElements.get(skillId);
				if (el) {
					el.row.removeClass('fuchouzhe-exec-step-active');
					el.row.addClass('fuchouzhe-exec-step-failed');
					el.statusEl.textContent = '✗';
					el.statusEl.className = 'fuchouzhe-exec-step-status fuchouzhe-exec-step-error';
					el.labelEl.textContent += ` — ${error}`;
				}
			},
			onToolCall: (tool) => {
				this.handleToolCall(progressMsgId, tool);
			},
			onRequestMoveConfirmation: async (moves) => {
				return new Promise<boolean>((resolve) => {
					// 创建确认消息
					const confirmMsg = card.createDiv({ cls: 'fuchouzhe-move-confirm' });
					confirmMsg.createDiv({ cls: 'fuchouzhe-move-confirm-title' }).textContent = '📦 即将执行以下文件移动操作：';
					const listEl = confirmMsg.createDiv({ cls: 'fuchouzhe-move-confirm-list' });
					for (const move of moves) {
						const item = listEl.createDiv({ cls: 'fuchouzhe-move-confirm-item' });
						item.textContent = `${move.from} → ${move.to}`;
					}

					// 按钮区域
					const btnRow = confirmMsg.createDiv({ cls: 'fuchouzhe-move-confirm-buttons' });

					const confirmBtn = btnRow.createEl('button', { cls: 'fuchouzhe-btn fuchouzhe-btn-primary' });
					confirmBtn.textContent = '✅ 确认执行';
					confirmBtn.addEventListener('click', () => {
						confirmMsg.remove();
						resolve(true);
					});

					const cancelBtn = btnRow.createEl('button', { cls: 'fuchouzhe-btn fuchouzhe-btn-secondary' });
					cancelBtn.textContent = '❌ 取消';
					cancelBtn.addEventListener('click', () => {
						confirmMsg.remove();
						resolve(false);
					});

					this.scrollToBottom();
				});
			},
			onComplete: (ctx) => {
				// 停止缓动动画，直接完成
				stopProgressAnimation();
				progressFill.style.width = '100%';

				// 更新卡片状态为完成
				statusBadge.textContent = '完成';
				statusBadge.className = 'fuchouzhe-exec-badge fuchouzhe-exec-badge-done';
				progressBar.addClass('fuchouzhe-exec-bar-done');

				// 输出路径
				if (ctx.outputPath) {
					const pathLine = card.createDiv({ cls: 'fuchouzhe-exec-output-path' });
					pathLine.textContent = `📝 已保存到 ${ctx.outputPath}`;
				}

				// 最终内容（渲染 markdown）
				if (finalOutput) {
					const resultSection = card.createDiv({ cls: 'fuchouzhe-exec-result' });
					const resultToggle = resultSection.createEl('details', { cls: 'fuchouzhe-exec-result-details' });
					resultToggle.setAttribute('open', '');
					const resultSummary = resultToggle.createEl('summary');
					resultSummary.textContent = '查看结果';
					const resultBody = resultToggle.createDiv({ cls: 'fuchouzhe-exec-result-body' });
					MarkdownRenderer.render(
						this.app,
						finalOutput,
						resultBody,
						'',
						this,
					);
					this.enableExternalLinks(resultBody);
				}

				// 保存执行结果到 conversationStore
				this.conversationStore.addAssistantMessage(finalOutput || `${action.name} 执行完成`);
				this.updateConversationTriggerTitle();

				this.isStreaming = false;
				this.activePipeline = null;
				this.resetSendButton();
				this.scrollToBottom();
			},
			onError: (error) => {
				stopProgressAnimation();
				progressFill.style.width = '100%';

				statusBadge.textContent = '失败';
				statusBadge.className = 'fuchouzhe-exec-badge fuchouzhe-exec-badge-error';
				progressBar.addClass('fuchouzhe-exec-bar-error');

				const errorLine = card.createDiv({ cls: 'fuchouzhe-exec-error' });
				errorLine.textContent = `❌ ${error}`;

				this.isStreaming = false;
				this.activePipeline = null;
				this.resetSendButton();
			},
		};

		await pipeline.execute(context, callbacks);
	}

	private extractStepSummary(result: string): string {
		const lines = result.split('\n').map(l => l.trim()).filter(l => l);
		for (const line of lines) {
			if (line.startsWith('#') || line.startsWith('---') || line.startsWith('```')) continue;
			const clean = line.replace(/^[-*>]\s*/, '');
			if (clean.length > 0) {
				return clean.length > 50 ? clean.slice(0, 50) + '...' : clean;
			}
		}
		return '';
	}

	private getTimeBasedGreeting(): string {
		const now = new Date();
		const hours = now.getHours();
		const day = now.getDay();
		const isWeekend = day === 0 || day === 6;

		// Weekend greetings
		if (isWeekend) {
			if (hours >= 5 && hours < 12) return '😄 周末早安！';
			if (hours >= 12 && hours < 14) return '🌞 周午愉快！';
			if (hours >= 14 && hours < 18) return '☀️ 周末下午好！';
			if (hours >= 18 && hours < 22) return '🌙 周末晚上好！';
			return '🌟 夜深了，周末愉快！';
		}

		// Weekday greetings
		if (hours >= 5 && hours < 8) return '🌅 早起的鸟儿有虫吃！';
		if (hours >= 8 && hours < 11) return '☀️ 早上好！';
		if (hours >= 11 && hours < 14) return '🍱 午饭时间到了！';
		if (hours >= 14 && hours < 18) return '🧋 下午茶时间~';
		if (hours >= 18 && hours < 22) return '🌆 晚上好！';
		return '🌙 夜深了，早点休息！';
	}

	private async sendMessage(skipDetection = false) {
		const content = this.textarea.value.trim();
		if (!content || this.isStreaming) return;
		if (!(await this.ensureAuthenticated())) return;

		// 检测是否匹配某个动作（仅在非场景模式下且未跳过检测时）
		if (!skipDetection && !this.isSceneMode) {
			const matchedAction = detectAction(content);
			if (matchedAction) {
				this.showActionSuggestion(matchedAction, content);
				return;
			}
		}

		// 收集当前附加文件信息（用于消息气泡显示）
		const attachedFileNames: Array<{name: string; icon: string}> = [];
		const nameCount = new Map<string, number>();
		for (const [, file] of this.attachedFiles) {
			nameCount.set(file.basename, (nameCount.get(file.basename) || 0) + 1);
		}
		for (const [, file] of this.attachedFiles) {
			const ext = file.extension?.toLowerCase() || '';
			const hasDuplicate = (nameCount.get(file.basename) || 0) > 1;
			const displayName = hasDuplicate && file.parent
				? `${file.parent.name}/${file.basename}`
				: file.basename;
			attachedFileNames.push({ name: displayName, icon: getFileIcon(ext) });
		}

		// Add user message to store
		this.conversationStore.addUserMessage(content, attachedFileNames.length > 0 ? attachedFileNames : undefined);

		// Add user message to UI（带附加文件标签）
		this.addMessage('user', content, attachedFileNames.length > 0 ? attachedFileNames : undefined);
		this.textarea.value = '';
		// P1-2: 重置输入框高度
		this.textarea.style.height = 'auto';

		// Start streaming
		this.isStreaming = true;
		this.currentMessage = '';
		this.textBuffer = '';
		this.firstChunkReceived = false;
		this.thinkingContent = '';
		this.thinkingBuffer = '';

		// P0-2: 切换为停止按钮
		this.sendButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
		this.sendButton.classList.add('fuchouzhe-send-button-stop');

		// Clear tool calls
		this.activeToolCalls.clear();

		// Create assistant message placeholder
		const assistantMsgId = this.addMessage('assistant', '');
		this.currentAssistantMsgId = assistantMsgId;

		// P0-3: 显示思考动画
		this.showThinkingIndicator(assistantMsgId);

		// Get attached files content (multi-file context)
		let fileContent: string | undefined;
		let filePath: string | undefined;
		const attachedExts: Set<string> = new Set();

		if (this.attachedFiles.size > 0) {
			const parts: string[] = [];
			for (const [path, file] of this.attachedFiles) {
				const content = await this.readFileContent(file);
				parts.push(`--- ${file.basename} (${path}) ---\n${content}`);
				if (file.extension) attachedExts.add(file.extension.toLowerCase());
			}
			fileContent = parts.join('\n\n');
			filePath = Array.from(this.attachedFiles.keys()).join(', ');
		} else {
			const activeFile = this.plugin.getActiveFile();
			if (activeFile && this.plugin.settings.autoAttachFile) {
				filePath = activeFile.path;
				fileContent = await this.readFileContent(activeFile);
				if (activeFile.extension) attachedExts.add(activeFile.extension.toLowerCase());
			}
		}

		// 基于文件类型的智能提示注入
		const contextHint = this.buildFileTypeHint(attachedExts);

		// 发送后重置附件：只保留当前打开的笔记
		this.attachedFiles.clear();
		this.manuallyAttachedPaths.clear();
		const activeFileNow = this.plugin.getActiveFile();
		if (activeFileNow && this.plugin.settings.autoAttachFile) {
			this.autoAttachedPath = activeFileNow.path;
			this.attachedFiles.set(activeFileNow.path, activeFileNow);
		}
		this.renderAttachedFiles();

		// Get selected text
		const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const selection = activeView?.editor?.getSelection();

		// Get conversation history
		const history = this.conversationStore.getMessages();
		console.log('[ChatView] Sending message, history count:', history.length);
		if (history.length > 0) {
			console.log('[ChatView] History preview:', history.map(m => `${m.role}: ${m.content.substring(0, 30)}...`));
		}

		// Get memory context
		const memoryContext = await this.plugin.memoryManager.getMemoryContext();
		if (memoryContext) {
			console.log('[ChatView] Memory context loaded, length:', memoryContext.length);
		}

		// Send to API
		const sendContent = contextHint ? `${contextHint}\n\n${content}` : content;
		this.fuchouzheService.sendMessage({
			content: sendContent,
			filePath,
			fileContent,
			selection,
			history,
			memoryContext,
			onChunk: (chunk: string) => {
				// P0-3: 首次 chunk 移除思考动画
				if (!this.firstChunkReceived) {
					this.firstChunkReceived = true;
					this.hideThinkingIndicator();
				}
				this.textBuffer += chunk;
				this.scheduleFlush(assistantMsgId);
			},
			onThinking: (chunk: string) => {
				if (!this.firstChunkReceived) {
					this.firstChunkReceived = true;
					this.hideThinkingIndicator();
				}
				this.thinkingBuffer += chunk;
				this.scheduleThinkingFlush(assistantMsgId);
			},
			onTool: (tool: FuchouzheToolCall) => {
				this.handleToolCall(assistantMsgId, tool);
			},
			onEnd: () => {
				this.isStreaming = false;
				this.flushThinkingBuffer(assistantMsgId);
				this.flushBuffer(assistantMsgId);
				this.hideThinkingIndicator();
				this.resetSendButton();
				// Save assistant message to conversation store
				if (this.currentAssistantMsgId) {
					this.conversationStore.addAssistantMessage(this.currentMessage);
					this.currentAssistantMsgId = null;
				}
				// Update conversation trigger title
				this.updateConversationTriggerTitle();
			},
			onError: (error: string) => {
				this.hideThinkingIndicator();
				this.isStreaming = false;
				this.resetSendButton();
				// Show error with retry button
				const msgEl = this.messagesContainer.querySelector(`[data-id="${assistantMsgId}"]`);
				if (msgEl) {
					const contentEl = msgEl.querySelector('.fuchouzhe-message-content') as HTMLElement;
					if (contentEl) {
						contentEl.empty();
						const errorEl = contentEl.createDiv({ cls: 'fuchouzhe-error-block' });
						errorEl.createSpan({ text: `错误: ${error}` });
						const retryBtn = errorEl.createEl('button', {
							cls: 'fuchouzhe-retry-btn',
							text: '重试'
						});
						retryBtn.addEventListener('click', () => {
							this.regenerateMessage(assistantMsgId);
						});
					}
				}
			}
		});
	}

	/**
	 * Handle tool call from AI
	 */
	private handleToolCall(msgId: string, tool: FuchouzheToolCall): void {
		if (!this.plugin.settings.showToolCalls) return;

		const msgEl = this.messagesContainer.querySelector(`[data-id="${msgId}"]`);
		if (!msgEl) return;

		// Find message content element
		const contentEl = msgEl.querySelector('.fuchouzhe-message-content');
		if (!contentEl) return;

		// Find or create tool container (放在内容之前)
		let toolContainer = msgEl.querySelector(`.fuchouzhe-tool-container`) as HTMLElement;
		if (!toolContainer) {
			toolContainer = msgEl.createDiv({ cls: 'fuchouzhe-tool-container' });

			// 工具容器头部（可点击折叠）
			const header = toolContainer.createDiv({ cls: 'fuchouzhe-tool-header' });

			// 折叠图标
			const foldIcon = header.createSpan({ cls: 'fuchouzhe-tool-fold-icon', text: '▼' });

			// 标题
			header.createSpan({ text: '🔧 工具调用', cls: 'fuchouzhe-tool-title' });

			// 状态
			const status = header.createSpan({ cls: 'fuchouzhe-tool-status', text: '🔄 执行中...' });

			// 点击折叠功能
			header.addEventListener('click', () => {
				const list = toolContainer.querySelector('.fuchouzhe-tool-list') as HTMLElement;
				const icon = header.querySelector('.fuchouzhe-tool-fold-icon') as HTMLElement;
				if (list && icon) {
					const isHidden = list.getAttribute('data-collapsed') === 'true';
					if (isHidden) {
						list.removeAttribute('data-collapsed');
						list.style.display = 'flex';
						icon.textContent = '▼';
					} else {
						list.setAttribute('data-collapsed', 'true');
						list.style.display = 'none';
						icon.textContent = '▶';
					}
				}
			});

			// 创建工具列表（默认折叠）
			const toolList = toolContainer.createDiv({ cls: 'fuchouzhe-tool-list' });
			toolList.setAttribute('data-collapsed', 'true');
			toolList.style.display = 'none';

			// 将工具容器插入到内容之前
			msgEl.insertBefore(toolContainer, contentEl);
		}

		// 更新状态
		const statusEl = toolContainer.querySelector('.fuchouzhe-tool-status') as HTMLElement;
		const toolList = toolContainer.querySelector('.fuchouzhe-tool-list') as HTMLElement;

		// 收集所有工具状态
		this.activeToolCalls.set(tool.id, tool);
		const tools = Array.from(this.activeToolCalls.values());

		// 更新状态文字
		if (statusEl) {
			const running = tools.filter(t => t.status === 'running').length;
			const completed = tools.filter(t => t.status === 'completed').length;
			const error = tools.filter(t => t.status === 'error').length;

			if (running > 0) {
				statusEl.textContent = `🔄 ${running}个执行中...`;
			} else if (error > 0) {
				statusEl.textContent = `❌ 完成(${completed}) 失败(${error})`;
				statusEl.className = 'fuchouzhe-tool-status fuchouzhe-tool-status-error';
			} else {
				statusEl.textContent = `✅ 完成(${completed})`;
				statusEl.className = 'fuchouzhe-tool-status fuchouzhe-tool-status-completed';
			}
		}

		// 添加或更新工具项
		let toolItem = toolList.querySelector(`[data-tool-id="${tool.id}"]`) as HTMLElement;
		if (!toolItem) {
			toolItem = toolList.createDiv({ cls: 'fuchouzhe-tool-item' });
			toolItem.dataset['toolId'] = tool.id;

			// 工具项头部
			const itemHeader = toolItem.createDiv({ cls: 'fuchouzhe-tool-item-header' });

			// 状态图标
			const icon = itemHeader.createSpan({ cls: 'fuchouzhe-tool-icon', text: '🔄' });

			// 操作名称
			itemHeader.createSpan({ cls: 'fuchouzhe-tool-op', text: tool.name });

			// 结果容器
			itemHeader.createDiv({ cls: 'fuchouzhe-tool-item-result' });
		}

		// 更新状态
		if (tool.status) {
			toolItem.className = `fuchouzhe-tool-item fuchouzhe-tool-status-${tool.status}`;
			const icon = toolItem.querySelector('.fuchouzhe-tool-icon') as HTMLElement;
			if (icon) {
				icon.textContent = tool.status === 'completed' ? '✅' : tool.status === 'error' ? '❌' : '🔄';
			}
		}

		// 更新结果
		const resultContainer = toolItem.querySelector('.fuchouzhe-tool-item-result');
		if (resultContainer && (tool.result || tool.error)) {
			resultContainer.innerHTML = '';
			if (tool.error) {
				resultContainer.createDiv({ cls: 'fuchouzhe-tool-error', text: `错误: ${tool.error}` });
			} else if (tool.result) {
				const resultText = typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2);
				const truncated = resultText.length > 300 ? resultText.substring(0, 300) + '...' : resultText;
				resultContainer.createEl('pre', { cls: 'fuchouzhe-tool-result', text: truncated });
			}
		}

		this.toolCallElements.set(tool.id, toolItem);

		// Auto scroll
		if (this.plugin.settings.enableAutoScroll) {
			this.scrollToBottom();
		}
	}

	/**
	 * Clear all tool calls from UI
	 */
	private clearToolCalls(): void {
		this.activeToolCalls.clear();
		this.toolCallElements.clear();

		// 移除所有工具容器
		const containers = this.messagesContainer.querySelectorAll('.fuchouzhe-tool-container');
		containers.forEach(c => c.remove());

		// 移除思考动画
		this.hideThinkingIndicator();
	}

	/**
	 * 显示思考动画
	 */
	private showThinkingIndicator(msgId: string): void {
		const msgEl = this.messagesContainer.querySelector(`[data-id="${msgId}"]`);
		if (!msgEl) return;

		// 检查是否已有思考指示器
		let thinking = msgEl.querySelector('.fuchouzhe-thinking');
		if (!thinking) {
			thinking = msgEl.createDiv({ cls: 'fuchouzhe-thinking' });
			thinking.innerHTML = '<span class="fuchouzhe-thinking-dots">...</span>';
		}
	}

	/**
	 * 隐藏思考动画
	 */
	private hideThinkingIndicator(): void {
		const indicators = this.messagesContainer.querySelectorAll('.fuchouzhe-thinking');
		indicators.forEach(i => i.remove());
	}

	/**
	 * 更新思考内容块
	 */
	private updateThinkingBlock(msgId: string, content: string): void {
		const msgEl = this.messagesContainer.querySelector(`[data-id="${msgId}"]`);
		if (!msgEl) return;

		let thinkingBlock = msgEl.querySelector('.fuchouzhe-thinking-block') as HTMLElement;
		if (!thinkingBlock) {
			thinkingBlock = document.createElement('div');
			thinkingBlock.className = 'fuchouzhe-thinking-block';

			// Header (collapsible)
			const header = thinkingBlock.createDiv({ cls: 'fuchouzhe-thinking-header' });
			const foldIcon = header.createSpan({ cls: 'fuchouzhe-thinking-fold-icon', text: '▼' });
			header.createSpan({ cls: 'fuchouzhe-thinking-label', text: '💭 思考过程' });
			const thinkingBody = thinkingBlock.createDiv({ cls: 'fuchouzhe-thinking-body' });
			thinkingBody.createEl('p', { cls: 'fuchouzhe-thinking-text' });

			header.addEventListener('click', () => {
				const isCollapsed = thinkingBody.hasClass('fuchouzhe-collapsed');
				if (isCollapsed) {
					thinkingBody.removeClass('fuchouzhe-collapsed');
					foldIcon.textContent = '▼';
				} else {
					thinkingBody.addClass('fuchouzhe-collapsed');
					foldIcon.textContent = '▶';
				}
			});

			// Insert before content
			const contentEl = msgEl.querySelector('.fuchouzhe-message-content');
			if (contentEl) {
				msgEl.insertBefore(thinkingBlock, contentEl);
			} else {
				msgEl.appendChild(thinkingBlock);
			}
		}

		// 直接更新文本，不重建 DOM
		const textEl = thinkingBlock.querySelector('.fuchouzhe-thinking-text') as HTMLElement;
		if (textEl) {
			textEl.textContent = content;
		}

		// 自动滚动思考块到底部
		const body = thinkingBlock.querySelector('.fuchouzhe-thinking-body') as HTMLElement;
		if (body) {
			body.scrollTop = body.scrollHeight;
		}

		if (this.plugin.settings.enableAutoScroll) {
			this.scrollToBottom();
		}
	}

	private scheduleThinkingFlush(msgId: string) {
		if (this.thinkingFlushTimer) return;

		const TICK_MS = 16;
		const BASE_RATE = 2; // 固定每 tick 释放 2 字符

		this.thinkingFlushTimer = window.setInterval(() => {
			if (this.thinkingBuffer.length === 0) {
				clearInterval(this.thinkingFlushTimer!);
				this.thinkingFlushTimer = null;
				return;
			}

			// 固定速率 + 温和追赶：buffer 超过 100 时每 tick 多释放 1 字符
			const overflow = Math.max(0, this.thinkingBuffer.length - 100);
			const charsToRelease = Math.min(BASE_RATE + Math.floor(overflow / 50), this.thinkingBuffer.length);

			const toRelease = this.thinkingBuffer.substring(0, charsToRelease);
			this.thinkingBuffer = this.thinkingBuffer.substring(charsToRelease);

			this.thinkingContent += toRelease;
			this.requestThinkingRender(msgId);
		}, TICK_MS);
	}

	private requestThinkingRender(msgId: string) {
		if (this.pendingThinkingRender) return;
		this.pendingThinkingRender = true;

		requestAnimationFrame(() => {
			this.pendingThinkingRender = false;
			this.updateThinkingBlock(msgId, this.thinkingContent);
		});
	}

	private flushThinkingBuffer(msgId: string) {
		if (this.thinkingFlushTimer) {
			clearInterval(this.thinkingFlushTimer);
			this.thinkingFlushTimer = null;
		}
		this.pendingThinkingRender = false;

		if (this.thinkingBuffer.length > 0) {
			this.thinkingContent += this.thinkingBuffer;
			this.thinkingBuffer = '';
		}
		if (this.thinkingContent) {
			this.updateThinkingBlock(msgId, this.thinkingContent);
		}
	}

	private scheduleFlush(msgId: string) {
		// Already running a flush loop — just let it pick up the new buffer content
		if (this.flushTimer) return;

		const TICK_MS = 16;
		const BASE_RATE = 2; // 固定每 tick 释放 2 字符

		this.flushTimer = window.setInterval(() => {
			if (this.textBuffer.length === 0) {
				clearInterval(this.flushTimer!);
				this.flushTimer = null;
				return;
			}

			// 固定速率 + 温和追赶：buffer 超过 100 时每 tick 多释放 1 字符
			const overflow = Math.max(0, this.textBuffer.length - 100);
			const charsToRelease = Math.min(BASE_RATE + Math.floor(overflow / 50), this.textBuffer.length);

			const toRelease = this.textBuffer.substring(0, charsToRelease);
			this.textBuffer = this.textBuffer.substring(charsToRelease);

			this.currentMessage += toRelease;
			this.requestRender(msgId);
		}, TICK_MS);
	}

	/**
	 * Throttle DOM updates to once per animation frame
	 */
	private requestRender(msgId: string) {
		if (this.pendingRender) return;
		this.pendingRender = true;

		requestAnimationFrame(() => {
			this.pendingRender = false;
			this.updateMessage(msgId, this.currentMessage);

			if (this.plugin.settings.enableAutoScroll) {
				this.scrollToBottom();
			}
		});
	}

	private flushBuffer(msgId: string) {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		this.pendingRender = false;

		// Flush remaining buffer all at once
		if (this.textBuffer.length > 0) {
			this.currentMessage += this.textBuffer;
			this.textBuffer = '';
		}
		this.updateMessage(msgId, this.currentMessage);
	}

	private addMessage(role: 'user' | 'assistant', content: string, attachedFileNames?: Array<{name: string; icon: string}>): string {
		// Hide welcome message when first user message arrives
		if (role === 'user' && this.welcomeMessage) {
			this.welcomeMessage.addClass('fuchouzhe-hidden');
		}

		const id = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		const msgEl = this.messagesContainer.createDiv({
			cls: `fuchouzhe-message fuchouzhe-message-${role}`
		});
		msgEl.setAttribute('data-id', id);
		msgEl.setAttribute('data-time', new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));

		// 用户消息气泡上方显示附加文件
		if (role === 'user' && attachedFileNames && attachedFileNames.length > 0) {
			const filesBar = msgEl.createDiv({ cls: 'fuchouzhe-msg-attached-files' });
			for (const f of attachedFileNames) {
				filesBar.createSpan({ cls: 'fuchouzhe-msg-attached-tag', text: `${f.icon} ${f.name}` });
			}
		}

		const contentEl = msgEl.createDiv({ cls: 'fuchouzhe-message-content' });

		if (role === 'user') {
			contentEl.textContent = content;
			// Edit button for user messages
			const editBtn = msgEl.createDiv({ cls: 'fuchouzhe-message-edit-btn' });
			editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
			editBtn.addEventListener('click', () => {
				this.editUserMessage(id, content);
			});
		} else {
			// P0-1: 使用 MarkdownRenderer
			if (content) {
				MarkdownRenderer.render(
					this.plugin.app,
					content,
					contentEl,
					'',
					this.plugin
				);
				this.addCodeBlockCopyButtons(contentEl);
				this.enableExternalLinks(contentEl);
			}

			// P1-1 & P1-3: 消息操作栏（底部左对齐，ChatGPT 风格）
			const actionsEl = msgEl.createDiv({ cls: 'fuchouzhe-message-actions' });

			const copyBtn = actionsEl.createEl('button', {
				cls: 'fuchouzhe-action-btn',
				attr: { 'aria-label': '复制' }
			});
			copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
			copyBtn.addEventListener('click', () => {
				const textToCopy = contentEl.textContent || '';
				navigator.clipboard.writeText(textToCopy);
				copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
				copyBtn.classList.add('fuchouzhe-action-btn-success');
				setTimeout(() => {
					copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
					copyBtn.classList.remove('fuchouzhe-action-btn-success');
				}, 1500);
			});

			const regenBtn = actionsEl.createEl('button', {
				cls: 'fuchouzhe-action-btn',
				attr: { 'aria-label': '重新生成' }
			});
			regenBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
			regenBtn.addEventListener('click', () => {
				this.regenerateMessage(id);
			});
		}

		return id;
	}

	private updateMessage(id: string, content: string) {
		const msgEl = this.messagesContainer.querySelector(`[data-id="${id}"]`);
		if (msgEl) {
			const contentEl = msgEl.querySelector('.fuchouzhe-message-content') as HTMLElement;
			if (contentEl) {
				if (this.isStreaming) {
					// 流式输出：用轻量 innerHTML 避免每次完整 MarkdownRenderer 重建
					contentEl.innerHTML = this.fastFormatMarkdown(content);
					// 光标插入到最后一个元素内部
					const cursor = document.createElement('span');
					cursor.className = 'fuchouzhe-streaming-cursor';
					const lastBlock = contentEl.lastElementChild;
					if (lastBlock) {
						lastBlock.appendChild(cursor);
					} else {
						contentEl.appendChild(cursor);
					}
				} else {
					// 非流式：完整 MarkdownRenderer 渲染
					contentEl.empty();
					MarkdownRenderer.render(
						this.plugin.app,
						content,
						contentEl,
						'',
						this.plugin
					);
					this.addCodeBlockCopyButtons(contentEl);
					this.enableExternalLinks(contentEl);
				}
			}
		}
	}

	/**
	 * 轻量 Markdown 格式化（流式输出用，避免频繁调用 MarkdownRenderer）
	 * 输出结构尽量与 MarkdownRenderer 一致，避免流式→最终渲染时行距跳变
	 */
	private fastFormatMarkdown(text: string): string {
		// 先处理代码块（保护其内容不被后续替换）
		const codeBlocks: string[] = [];
		let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
			const idx = codeBlocks.length;
			codeBlocks.push(`<pre><code class="language-${lang}">${code}</code></pre>`);
			return `\x00CB${idx}\x00`;
		});

		// 行内代码
		processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');
		// 加粗
		processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
		// 斜体
		processed = processed.replace(/\*(.*?)\*/g, '<em>$1</em>');
		// 标题
		processed = processed.replace(/^### (.+)$/gm, '<h3>$1</h3>');
		processed = processed.replace(/^## (.+)$/gm, '<h2>$1</h2>');
		processed = processed.replace(/^# (.+)$/gm, '<h1>$1</h1>');
		// 无序列表
		processed = processed.replace(/^[-*] (.+)$/gm, '<li>$1</li>');

		// 段落处理：用双换行分段（与 MarkdownRenderer 一致）
		const paragraphs = processed.split(/\n{2,}/);
		processed = paragraphs.map(p => {
			p = p.trim();
			if (!p) return '';
			// 已经是块级元素的不再包裹
			if (/^<(h[1-6]|pre|li|ul|ol|blockquote)/.test(p)) {
				return p;
			}
			// 段内单换行转 <br>
			p = p.replace(/\n/g, '<br>');
			return `<p>${p}</p>`;
		}).join('');

		// 还原代码块
		processed = processed.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);

		return processed;
	}

	private scrollToBottom() {
		requestAnimationFrame(() => {
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		});
	}

	/**
	 * P0-2: 重置发送按钮
	 */
	private resetSendButton(): void {
		this.sendButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
		this.sendButton.classList.remove('fuchouzhe-send-button-stop');
	}

	/**
	 * 给被中断的消息添加中断标记和重新生成按钮
	 */
	private markMessageInterrupted(msgId: string): void {
		// 先 flush 残留的 buffer 到 UI 上
		this.flushThinkingBuffer(msgId);
		this.flushBuffer(msgId);

		const msgEl = this.messagesContainer.querySelector(`[data-id="${msgId}"]`);
		if (!msgEl) return;

		// 如果是场景执行卡片，更新卡片状态
		const execBadge = msgEl.querySelector('.fuchouzhe-exec-badge');
		if (execBadge) {
			execBadge.textContent = '已中断';
			execBadge.className = 'fuchouzhe-exec-badge fuchouzhe-exec-badge-interrupted';
			const execBar = msgEl.querySelector('.fuchouzhe-exec-bar');
			if (execBar) execBar.classList.add('fuchouzhe-exec-bar-interrupted');
		}

		// 添加中断提示条
		const contentEl = msgEl.querySelector('.fuchouzhe-message-content') as HTMLElement;
		if (!contentEl) return;

		// 避免重复添加
		if (contentEl.querySelector('.fuchouzhe-interrupted-bar')) return;

		const bar = contentEl.createDiv({ cls: 'fuchouzhe-interrupted-bar' });
		bar.createSpan({ cls: 'fuchouzhe-interrupted-icon', text: '⏸' });
		bar.createSpan({ cls: 'fuchouzhe-interrupted-text', text: '回复已中断' });

		const regenBtn = bar.createEl('button', { cls: 'fuchouzhe-interrupted-retry', text: '重新生成' });
		regenBtn.addEventListener('click', () => {
			this.regenerateMessage(msgId);
		});

		// 保存已有的部分内容到 conversationStore
		if (this.currentMessage) {
			this.conversationStore.addAssistantMessage(this.currentMessage + '\n\n*（已中断）*');
			this.updateConversationTriggerTitle();
		}
	}

	/**
	 * P1-3: 重新生成消息
	 */
	private async regenerateMessage(msgId: string): Promise<void> {
		if (this.isStreaming) return;

		const conv = this.conversationStore.getCurrentConversation();
		if (!conv) return;

		// 找到这条 assistant 消息在 UI 中对应的元素
		const msgEl = this.messagesContainer.querySelector(`[data-id="${msgId}"]`);
		if (!msgEl) return;

		// 找到 UI 中这条消息前面的 user 消息
		const allMsgEls = Array.from(this.messagesContainer.querySelectorAll('.fuchouzhe-message'));
		const msgIndex = allMsgEls.indexOf(msgEl);
		if (msgIndex <= 0) return;

		// 往前找最近的 user 消息
		let userMsgEl: Element | null = null;
		for (let i = msgIndex - 1; i >= 0; i--) {
			if (allMsgEls[i].classList.contains('fuchouzhe-message-user')) {
				userMsgEl = allMsgEls[i];
				break;
			}
		}
		if (!userMsgEl) return;

		const userContent = userMsgEl.querySelector('.fuchouzhe-message-content')?.textContent || '';
		if (!userContent) return;

		// 从 store 中删除最后一条 assistant 消息
		if (conv.messages.length > 0) {
			const lastMsg = conv.messages[conv.messages.length - 1];
			if (lastMsg.role === 'assistant') {
				conv.messages.pop();
			}
		}

		// 从 UI 中移除旧的 assistant 消息
		msgEl.remove();

		// 重新发送（复用 sendMessage 的核心逻辑）
		this.isStreaming = true;
		this.currentMessage = '';
		this.textBuffer = '';
		this.firstChunkReceived = false;
		this.thinkingContent = '';
		this.thinkingBuffer = '';
		this.sendButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
		this.sendButton.classList.add('fuchouzhe-send-button-stop');
		this.activeToolCalls.clear();

		const assistantMsgId = this.addMessage('assistant', '');
		this.currentAssistantMsgId = assistantMsgId;
		this.showThinkingIndicator(assistantMsgId);

		const activeFile = this.plugin.getActiveFile();
		let fileContent: string | undefined;
		let filePath: string | undefined;
		if (activeFile && this.plugin.settings.autoAttachFile) {
			filePath = activeFile.path;
			fileContent = await this.readFileContent(activeFile);
		}

		const history = this.conversationStore.getMessages();

		this.fuchouzheService.sendMessage({
			content: userContent,
			filePath,
			fileContent,
			history,
			onChunk: (chunk: string) => {
				if (!this.firstChunkReceived) {
					this.firstChunkReceived = true;
					this.hideThinkingIndicator();
				}
				this.textBuffer += chunk;
				this.scheduleFlush(assistantMsgId);
			},
			onTool: (tool: FuchouzheToolCall) => {
				this.handleToolCall(assistantMsgId, tool);
			},
			onEnd: () => {
				this.isStreaming = false;
				this.flushThinkingBuffer(assistantMsgId);
				this.flushBuffer(assistantMsgId);
				this.hideThinkingIndicator();
				this.resetSendButton();
				if (this.currentAssistantMsgId) {
					this.conversationStore.addAssistantMessage(this.currentMessage);
					this.currentAssistantMsgId = null;
				}
			},
			onError: (error: string) => {
				this.hideThinkingIndicator();
				this.updateMessage(assistantMsgId, `错误: ${error}`);
				this.isStreaming = false;
				this.resetSendButton();
			}
		});
	}

	/**
	 * P0-4: 切换对话面板
	 */
	private toggleConversationPanel(): void {
		this.showConversationPanel = !this.showConversationPanel;
		if (this.showConversationPanel) {
			this.buildConversationPanel();
			this.conversationPanel.removeClass('hidden');
		} else {
			this.conversationPanel.addClass('hidden');
		}
	}

	private closeConversationPanel(): void {
		this.showConversationPanel = false;
		this.conversationPanel.addClass('hidden');
	}

	private buildConversationPanel(): void {
		this.conversationPanel.empty();

		// 新建对话按钮
		const newBtn = this.conversationPanel.createEl('button', {
			cls: 'fuchouzhe-conv-new-btn',
			text: '+ 新建对话'
		});
		newBtn.addEventListener('click', () => {
			this.stopAndReset();
			this.conversationStore.createConversation();
			this.clearMessagesUI();
			if (this.welcomeMessage) {
				this.welcomeMessage.removeClass('fuchouzhe-hidden');
			}
			this.updateConversationTriggerTitle();
			this.closeConversationPanel();
		});

		// 对话列表
		const conversations = this.conversationStore.getAllConversations();
		const currentId = this.conversationStore.getCurrentConversationId();

		if (conversations.length === 0) {
			this.conversationPanel.createDiv({ cls: 'fuchouzhe-conv-empty', text: '暂无对话' });
			return;
		}

		const list = this.conversationPanel.createDiv({ cls: 'fuchouzhe-conv-list' });

		for (const conv of conversations) {
			const item = list.createDiv({
				cls: `fuchouzhe-conv-item ${conv.id === currentId ? 'fuchouzhe-conv-item-active' : ''}`
			});

			const info = item.createDiv({ cls: 'fuchouzhe-conv-item-info' });
			const titleEl = info.createDiv({ cls: 'fuchouzhe-conv-item-title', text: conv.title || '新对话' });
			// Double-click to rename
			titleEl.addEventListener('dblclick', (e) => {
				e.stopPropagation();
				this.startRenameConversation(titleEl, conv);
			});
			const meta = info.createDiv({ cls: 'fuchouzhe-conv-item-meta' });
			meta.textContent = `${conv.messages.length} 条消息 · ${this.formatTime(conv.updatedAt)}`;

			// 点击切换对话
			info.addEventListener('click', () => {
				this.stopAndReset();
				this.conversationStore.switchConversation(conv.id);
				this.clearMessagesUI();
				this.loadConversationHistory();
				this.updateConversationTriggerTitle();
				this.closeConversationPanel();
			});

			// 删除按钮
			if (conversations.length > 1) {
				const actions = item.createDiv({ cls: 'fuchouzhe-conv-item-actions' });

				// 重命名按钮
				const renameBtn = actions.createEl('button', {
					cls: 'fuchouzhe-conv-item-rename',
					attr: { 'aria-label': '重命名' }
				});
				renameBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
				renameBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					this.startRenameConversation(titleEl, conv);
				});

				// 删除按钮
				const delBtn = actions.createEl('button', {
					cls: 'fuchouzhe-conv-item-delete',
					text: '✕'
				});
				delBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					if (conv.id === currentId) {
						this.stopAndReset();
					}
					this.conversationStore.deleteConversation(conv.id);
					this.buildConversationPanel();
					if (conv.id === currentId) {
						this.clearMessagesUI();
						this.loadConversationHistory();
						this.updateConversationTriggerTitle();
					}
				});
			}
		}
	}

	private startRenameConversation(titleEl: HTMLElement, conv: any): void {
		const input = document.createElement('input');
		input.type = 'text';
		input.value = conv.title || '';
		input.className = 'fuchouzhe-conv-rename-input';
		titleEl.empty();
		titleEl.appendChild(input);
		input.focus();
		input.select();
		const save = () => {
			const newTitle = input.value.trim() || '新对话';
			conv.title = newTitle;
			conv.updatedAt = Date.now();
			this.conversationStore.switchConversation(conv.id);
			titleEl.empty();
			titleEl.textContent = newTitle;
			this.updateConversationTriggerTitle();
		};
		input.addEventListener('blur', save);
		input.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter') { input.blur(); }
			if (ke.key === 'Escape') { input.value = conv.title || '新对话'; input.blur(); }
		});
	}

	private clearMessagesUI(): void {
		// 移除所有非欢迎消息的子元素（包括 briefing-card、action-suggestion 等）
		const children = Array.from(this.messagesContainer.children);
		for (const child of children) {
			if ((child as HTMLElement).classList.contains('fuchouzhe-welcome-message')) continue;
			child.remove();
		}
	}

	private updateConversationTriggerTitle(): void {
		if (!this.conversationTrigger) return;
		const conv = this.conversationStore.getCurrentConversation();
		const textEl = this.conversationTrigger.querySelector('.fuchouzhe-conversation-trigger-text');
		if (textEl) {
			textEl.textContent = conv?.title || '新对话';
		} else {
			// Fallback: rebuild trigger content
			const arrow = this.conversationTrigger.querySelector('.fuchouzhe-conversation-arrow');
			this.conversationTrigger.textContent = '';
			const span = this.conversationTrigger.createSpan({ cls: 'fuchouzhe-conversation-trigger-text' });
			span.textContent = conv?.title || '新对话';
			if (arrow) {
				this.conversationTrigger.appendChild(arrow);
			} else {
				this.conversationTrigger.createSpan({ cls: 'fuchouzhe-conversation-arrow', text: '▾' });
			}
		}
	}

	private formatTime(timestamp: number): string {
		const now = Date.now();
		const diff = now - timestamp;
		if (diff < 60000) return '刚刚';
		if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
		const date = new Date(timestamp);
		return `${date.getMonth() + 1}/${date.getDate()}`;
	}

	/**
	 * @ mention file picker - 分层浏览式文件选择器
	 */
	private atMentionDropdown: HTMLElement | null = null;
	private atMentionCurrentPath: string = '';  // 当前浏览的文件夹路径
	private atMentionAtStart: number = 0;       // @ 符号在输入框中的位置
	private atMentionAtLength: number = 0;      // @query 的长度
	private atMentionSelectedIndex: number = -1; // 键盘选中项

	private handleAtMention(): void {
		const value = this.textarea.value;
		const cursorPos = this.textarea.selectionStart;
		const textBeforeCursor = value.substring(0, cursorPos);
		const atMatch = textBeforeCursor.match(/@([^\s]*)$/);

		if (atMatch) {
			const query = atMatch[1].toLowerCase();
			this.atMentionAtStart = atMatch.index!;
			this.atMentionAtLength = atMatch[0].length;

			if (query.length > 0) {
				// 有输入内容：全局模糊搜索（所有文件类型）
				this.showAtMentionSearch(query);
			} else {
				// 只输入了 @：显示根目录浏览
				this.atMentionCurrentPath = '';
				this.showAtMentionBrowse('');
			}
		} else {
			this.hideAtMentionDropdown();
		}
	}

	/**
	 * 全局模糊搜索模式
	 */
	private showAtMentionSearch(query: string): void {
		const allFiles = this.plugin.app.vault.getFiles();
		const matched = allFiles
			.filter(f => f.basename.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
			.slice(0, 10);

		if (matched.length === 0) {
			this.hideAtMentionDropdown();
			return;
		}

		this.ensureAtMentionDropdown();
		this.atMentionDropdown!.empty();
		this.atMentionSelectedIndex = -1;

		// 搜索结果头部
		const header = this.atMentionDropdown!.createDiv({ cls: 'fuchouzhe-at-mention-header' });
		header.createSpan({ text: `🔍 搜索: "${query}"` });

		const list = this.atMentionDropdown!.createDiv({ cls: 'fuchouzhe-at-mention-list' });
		for (const file of matched) {
			const ext = file.extension?.toLowerCase() || '';
			const icon = getFileIcon(ext);
			const item = list.createDiv({ cls: 'fuchouzhe-at-mention-item' });
			item.createSpan({ cls: 'fuchouzhe-at-mention-icon', text: icon });
			const textWrap = item.createDiv({ cls: 'fuchouzhe-at-mention-text' });
			textWrap.createSpan({ cls: 'fuchouzhe-at-mention-name', text: file.basename });
			textWrap.createSpan({ cls: 'fuchouzhe-at-mention-path', text: file.parent?.path || '' });
			item.addEventListener('click', () => this.selectAtMentionFile(file));
		}
	}

	/**
	 * 文件夹浏览模式
	 */
	private showAtMentionBrowse(folderPath: string): void {
		this.atMentionCurrentPath = folderPath;
		this.ensureAtMentionDropdown();
		this.atMentionDropdown!.empty();
		this.atMentionSelectedIndex = -1;

		// 面包屑导航
		const header = this.atMentionDropdown!.createDiv({ cls: 'fuchouzhe-at-mention-header' });
		if (folderPath) {
			const backBtn = header.createSpan({ cls: 'fuchouzhe-at-mention-back', text: '←' });
			const parentPath = folderPath.substring(0, folderPath.lastIndexOf('/')) || '';
			backBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.showAtMentionBrowse(parentPath);
			});
			header.createSpan({ text: ` ${folderPath.split('/').pop()}` });
		} else {
			header.createSpan({ text: '📂 笔记库' });
		}

		// 获取当前目录下的文件夹和文件
		const { folders, files } = this.getDirectoryContents(folderPath);
		const list = this.atMentionDropdown!.createDiv({ cls: 'fuchouzhe-at-mention-list' });

		// 文件夹
		for (const folder of folders) {
			const folderName = folder.split('/').pop() || folder;
			const item = list.createDiv({ cls: 'fuchouzhe-at-mention-item fuchouzhe-at-mention-folder' });
			item.createSpan({ cls: 'fuchouzhe-at-mention-icon', text: '📁' });
			const textWrap = item.createDiv({ cls: 'fuchouzhe-at-mention-text' });
			textWrap.createSpan({ cls: 'fuchouzhe-at-mention-name', text: folderName });
			item.createSpan({ cls: 'fuchouzhe-at-mention-arrow', text: '→' });
			item.addEventListener('click', (e) => {
				e.stopPropagation();
				this.showAtMentionBrowse(folder);
			});
		}

		// 文件
		for (const file of files) {
			const ext = file.extension?.toLowerCase() || '';
			const icon = getFileIcon(ext);
			const item = list.createDiv({ cls: 'fuchouzhe-at-mention-item' });
			item.createSpan({ cls: 'fuchouzhe-at-mention-icon', text: icon });
			const textWrap = item.createDiv({ cls: 'fuchouzhe-at-mention-text' });
			textWrap.createSpan({ cls: 'fuchouzhe-at-mention-name', text: file.basename });
			if (isBinaryDocument(ext)) {
				textWrap.createSpan({ cls: 'fuchouzhe-at-mention-badge', text: ext.toUpperCase() });
			}
			item.addEventListener('click', () => this.selectAtMentionFile(file));
		}

		if (folders.length === 0 && files.length === 0) {
			list.createDiv({ cls: 'fuchouzhe-at-mention-empty', text: '(空文件夹)' });
		}
	}

	/**
	 * 获取指定目录下的直接子文件夹和文件
	 */
	private getDirectoryContents(folderPath: string): { folders: string[]; files: TFile[] } {
		const allFiles = this.plugin.app.vault.getFiles();
		const allFolders = new Set<string>();
		const directFiles: TFile[] = [];

		for (const file of allFiles) {
			const filePath = file.path;
			const fileParent = file.parent?.path || '';

			if (folderPath === '') {
				// 根目录
				if (!filePath.includes('/')) {
					// 根目录直接文件
					directFiles.push(file);
				} else {
					// 提取顶层文件夹
					const topFolder = filePath.split('/')[0];
					allFolders.add(topFolder);
				}
			} else {
				if (fileParent === folderPath) {
					directFiles.push(file);
				} else if (fileParent.startsWith(folderPath + '/')) {
					// 提取下一层文件夹
					const rest = fileParent.substring(folderPath.length + 1);
					const nextFolder = rest.split('/')[0];
					allFolders.add(folderPath + '/' + nextFolder);
				}
			}
		}

		const folders = Array.from(allFolders).sort((a, b) => a.localeCompare(b));
		directFiles.sort((a, b) => a.basename.localeCompare(b.basename));

		return { folders, files: directFiles };
	}

	/**
	 * 选中文件：添加到附件栏并清理 @
	 */
	private selectAtMentionFile(file: TFile): void {
		this.addAttachedFile(file);
		this.dismissAtMention();
	}

	/**
	 * 取消 @ 操作：移除输入框中的 @query 并关闭下拉
	 */
	private dismissAtMention(): void {
		const before = this.textarea.value.substring(0, this.atMentionAtStart);
		const after = this.textarea.value.substring(this.atMentionAtStart + this.atMentionAtLength);
		this.textarea.value = before + after;
		this.hideAtMentionDropdown();
		this.textarea.focus();
	}

	/**
	 * 键盘导航：上下选择、左右切换层级、Enter 确认、Esc 取消
	 * 返回 true 表示事件已处理，阻止默认行为
	 */
	private handleAtMentionKeydown(e: KeyboardEvent): boolean {
		const list = this.atMentionDropdown?.querySelector('.fuchouzhe-at-mention-list');
		if (!list) return false;

		const items = Array.from(list.querySelectorAll('.fuchouzhe-at-mention-item')) as HTMLElement[];
		if (items.length === 0 && e.key !== 'Escape') return false;

		switch (e.key) {
			case 'ArrowDown': {
				e.preventDefault();
				this.atMentionSelectedIndex = Math.min(this.atMentionSelectedIndex + 1, items.length - 1);
				this.updateAtMentionSelection(items);
				return true;
			}
			case 'ArrowUp': {
				e.preventDefault();
				this.atMentionSelectedIndex = Math.max(this.atMentionSelectedIndex - 1, 0);
				this.updateAtMentionSelection(items);
				return true;
			}
			case 'ArrowRight': {
				// 进入选中的文件夹
				if (this.atMentionSelectedIndex >= 0 && this.atMentionSelectedIndex < items.length) {
					const selected = items[this.atMentionSelectedIndex];
					if (selected.classList.contains('fuchouzhe-at-mention-folder')) {
						e.preventDefault();
						selected.click();
						return true;
					}
				}
				return false;
			}
			case 'ArrowLeft': {
				// 返回上一层
				if (this.atMentionCurrentPath) {
					e.preventDefault();
					const parentPath = this.atMentionCurrentPath.substring(0, this.atMentionCurrentPath.lastIndexOf('/')) || '';
					this.showAtMentionBrowse(parentPath);
					return true;
				}
				return false;
			}
			case 'Enter': {
				e.preventDefault();
				if (this.atMentionSelectedIndex >= 0 && this.atMentionSelectedIndex < items.length) {
					items[this.atMentionSelectedIndex].click();
				}
				return true;
			}
			case 'Escape': {
				e.preventDefault();
				this.dismissAtMention();
				return true;
			}
			default:
				return false;
		}
	}

	/**
	 * 更新键盘选中项的高亮状态
	 */
	private updateAtMentionSelection(items: HTMLElement[]): void {
		items.forEach((el, i) => {
			el.classList.toggle('is-selected', i === this.atMentionSelectedIndex);
		});
		// 确保选中项可见
		if (this.atMentionSelectedIndex >= 0 && items[this.atMentionSelectedIndex]) {
			items[this.atMentionSelectedIndex].scrollIntoView({ block: 'nearest' });
		}
	}

	/**
	 * 确保 dropdown 容器存在
	 */
	private atMentionClickOutsideHandler: ((e: MouseEvent) => void) | null = null;

	private ensureAtMentionDropdown(): void {
		if (this.atMentionDropdown) return;
		const wrapper = this.textarea.closest('.fuchouzhe-input-wrapper');
		if (!wrapper) return;
		this.atMentionDropdown = wrapper.createDiv({ cls: 'fuchouzhe-at-mention-dropdown' });

		// 点击外部关闭
		this.atMentionClickOutsideHandler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (this.atMentionDropdown && !this.atMentionDropdown.contains(target) && target !== this.textarea) {
				this.dismissAtMention();
			}
		};
		setTimeout(() => {
			document.addEventListener('click', this.atMentionClickOutsideHandler!);
		}, 0);
	}

	private hideAtMentionDropdown(): void {
		if (this.atMentionClickOutsideHandler) {
			document.removeEventListener('click', this.atMentionClickOutsideHandler);
			this.atMentionClickOutsideHandler = null;
		}
		if (this.atMentionDropdown) {
			this.atMentionDropdown.remove();
			this.atMentionDropdown = null;
		}
		this.atMentionSelectedIndex = -1;
	}

	/**
	 * Add copy buttons to code blocks
	 */
	private addCodeBlockCopyButtons(container: HTMLElement): void {
		const codeBlocks = container.querySelectorAll('pre');
		codeBlocks.forEach(pre => {
			if (pre.querySelector('.fuchouzhe-code-copy-btn')) return;
			const wrapper = document.createElement('div');
			wrapper.className = 'fuchouzhe-code-block-wrapper';
			pre.parentNode?.insertBefore(wrapper, pre);
			wrapper.appendChild(pre);

			const copyBtn = wrapper.createEl('button', {
				cls: 'fuchouzhe-code-copy-btn',
				text: '复制'
			});
			copyBtn.addEventListener('click', () => {
				const code = pre.querySelector('code')?.textContent || pre.textContent || '';
				navigator.clipboard.writeText(code);
				copyBtn.textContent = '已复制';
				copyBtn.classList.add('fuchouzhe-code-copy-success');
				setTimeout(() => {
					copyBtn.textContent = '复制';
					copyBtn.classList.remove('fuchouzhe-code-copy-success');
				}, 1500);
			});
		});
	}

	/**
	 * 使渲染后的 Markdown 中的外部链接可点击（在浏览器中打开）
	 */
	private enableExternalLinks(container: HTMLElement): void {
		container.querySelectorAll('a').forEach(anchor => {
			const href = anchor.getAttribute('href');
			if (!href) return;
			// 外部链接：http/https 开头
			if (/^https?:\/\//i.test(href)) {
				anchor.addEventListener('click', (e) => {
					e.preventDefault();
					window.open(href, '_blank');
				});
			}
		});
	}

	/**
	 * Export conversation to markdown file
	 */
	private async exportConversation(): Promise<void> {
		const conv = this.conversationStore.getCurrentConversation();
		if (!conv || conv.messages.length === 0) {
			new Notice('当前没有对话内容可导出');
			return;
		}

		let md = `# ${conv.title || '对话记录'}\n\n`;
		md += `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;

		for (const msg of conv.messages) {
			const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
			if (msg.role === 'user') {
				md += `### 🧑 用户 (${time})\n\n${msg.content}\n\n`;
			} else {
				md += `### 🤖 AI (${time})\n\n${msg.content}\n\n`;
			}
			md += `---\n\n`;
		}

		const fileName = `对话导出-${conv.title || '未命名'}-${new Date().toISOString().slice(0, 10)}.md`;
		try {
			await this.plugin.app.vault.create(fileName, md);
			new Notice(`对话已导出到: ${fileName}`);
		} catch (e) {
			// File might already exist, try with timestamp
			const uniqueName = `对话导出-${Date.now()}.md`;
			await this.plugin.app.vault.create(uniqueName, md);
			new Notice(`对话已导出到: ${uniqueName}`);
		}
	}

	/**
	 * Edit user message and resend
	 */
	private editUserMessage(msgId: string, originalContent: string): void {
		if (this.isStreaming) return;
		const msgEl = this.messagesContainer.querySelector(`[data-id="${msgId}"]`);
		if (!msgEl) return;

		const contentEl = msgEl.querySelector('.fuchouzhe-message-content') as HTMLElement;
		if (!contentEl) return;

		// Replace content with editable textarea
		const editArea = document.createElement('textarea');
		editArea.className = 'fuchouzhe-edit-textarea';
		editArea.value = originalContent;
		contentEl.empty();
		contentEl.appendChild(editArea);
		editArea.focus();

		// Auto-height
		editArea.style.height = 'auto';
		editArea.style.height = editArea.scrollHeight + 'px';

		// Action buttons
		const editActions = contentEl.createDiv({ cls: 'fuchouzhe-edit-actions' });
		const saveBtn = editActions.createEl('button', { cls: 'fuchouzhe-edit-save-btn', text: '发送' });
		const cancelBtn = editActions.createEl('button', { cls: 'fuchouzhe-edit-cancel-btn', text: '取消' });

		cancelBtn.addEventListener('click', () => {
			contentEl.empty();
			contentEl.textContent = originalContent;
		});

		saveBtn.addEventListener('click', () => {
			const newContent = editArea.value.trim();
			if (!newContent) return;

			// Remove all messages after this one (in UI and store)
			const allMsgEls = Array.from(this.messagesContainer.querySelectorAll('.fuchouzhe-message'));
			const idx = allMsgEls.indexOf(msgEl as Element);
			for (let i = allMsgEls.length - 1; i > idx; i--) {
				allMsgEls[i].remove();
			}

			// Truncate store messages
			const conv = this.conversationStore.getCurrentConversation();
			if (conv) {
				// Find how many messages to keep (count user messages up to this one)
				let userCount = 0;
				for (const el of allMsgEls.slice(0, idx + 1)) {
					if (el.classList.contains('fuchouzhe-message-user')) userCount++;
				}
				// Keep messages up to this user message index
				let kept = 0;
				let cutIndex = 0;
				for (let i = 0; i < conv.messages.length; i++) {
					if (conv.messages[i].role === 'user') kept++;
					if (kept === userCount) { cutIndex = i; break; }
				}
				conv.messages.splice(cutIndex);
			}

			// Update the message content
			contentEl.empty();
			contentEl.textContent = newContent;

			// Add to store and resend
			this.conversationStore.addUserMessage(newContent);
			this.textarea.value = '';

			// Trigger send
			this.isStreaming = true;
			this.currentMessage = '';
			this.textBuffer = '';
			this.firstChunkReceived = false;
			this.sendButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
			this.sendButton.classList.add('fuchouzhe-send-button-stop');
			this.activeToolCalls.clear();

			const assistantMsgId = this.addMessage('assistant', '');
			this.currentAssistantMsgId = assistantMsgId;
			this.showThinkingIndicator(assistantMsgId);

			const history = this.conversationStore.getMessages();
			this.fuchouzheService.sendMessage({
				content: newContent,
				history,
				onChunk: (chunk: string) => {
					if (!this.firstChunkReceived) {
						this.firstChunkReceived = true;
						this.hideThinkingIndicator();
					}
					this.textBuffer += chunk;
					this.scheduleFlush(assistantMsgId);
				},
				onTool: (tool: FuchouzheToolCall) => {
					this.handleToolCall(assistantMsgId, tool);
				},
				onEnd: () => {
					this.isStreaming = false;
					this.flushBuffer(assistantMsgId);
					this.hideThinkingIndicator();
					this.resetSendButton();
					if (this.currentAssistantMsgId) {
						this.conversationStore.addAssistantMessage(this.currentMessage);
						this.currentAssistantMsgId = null;
					}
					this.updateConversationTriggerTitle();
				},
				onError: (error: string) => {
					this.hideThinkingIndicator();
					this.isStreaming = false;
					this.resetSendButton();
					this.updateMessage(assistantMsgId, `错误: ${error}`);
				}
			});
		});
	}

	/**
	 * Prompt template system - / command
	 */
	private slashDropdown: HTMLElement | null = null;
	private promptTemplates = [
		{ cmd: '/翻译', prompt: '请将以下内容翻译成英文：\n\n' },
		{ cmd: '/总结', prompt: '请总结以下内容的要点：\n\n' },
		{ cmd: '/改写', prompt: '请改写以下内容，使其更加清晰流畅：\n\n' },
		{ cmd: '/代码审查', prompt: '请审查以下代码，指出潜在问题和改进建议：\n\n' },
		{ cmd: '/周报', prompt: '请根据以下内容生成一份周报：\n\n' },
		{ cmd: '/大纲', prompt: '请为以下主题生成一份详细大纲：\n\n' },
	];

	private handleSlashCommand(): void {
		const value = this.textarea.value;
		if (!value.startsWith('/')) {
			this.hideSlashDropdown();
			return;
		}

		const query = value.toLowerCase();
		const matches = this.promptTemplates.filter(t => t.cmd.toLowerCase().startsWith(query));

		if (matches.length > 0 && value.length <= 10) {
			this.showSlashDropdown(matches);
		} else {
			this.hideSlashDropdown();
		}
	}

	private showSlashDropdown(templates: typeof this.promptTemplates): void {
		this.hideSlashDropdown();
		const wrapper = this.textarea.closest('.fuchouzhe-input-wrapper');
		if (!wrapper) return;

		this.slashDropdown = wrapper.createDiv({ cls: 'fuchouzhe-slash-dropdown' });
		for (const t of templates) {
			const item = this.slashDropdown.createDiv({
				cls: 'fuchouzhe-slash-item',
			});
			item.createSpan({ cls: 'fuchouzhe-slash-cmd', text: t.cmd });
			item.createSpan({ cls: 'fuchouzhe-slash-desc', text: t.prompt.split('：')[0] || '' });
			item.addEventListener('click', () => {
				this.textarea.value = t.prompt;
				this.textarea.focus();
				this.textarea.selectionStart = this.textarea.value.length;
				this.textarea.selectionEnd = this.textarea.value.length;
				this.textarea.dispatchEvent(new Event('input'));
				this.hideSlashDropdown();
			});
		}
	}

	private hideSlashDropdown(): void {
		if (this.slashDropdown) {
			this.slashDropdown.remove();
			this.slashDropdown = null;
		}
	}

	/**
	 * Multi-file context management
	 */
	private attachedFiles: Map<string, TFile> = new Map();
	private autoAttachedPath: string | null = null;  // 自动附加的基础笔记路径
	private manuallyAttachedPaths: Set<string> = new Set();  // 用户手动添加的文件路径

	/**
	 * 统一的文件内容读取 - 自动处理二进制文档
	 */
	private async readFileContent(file: TFile): Promise<string> {
		const ext = file.extension?.toLowerCase() || '';
		if (isBinaryDocument(ext)) {
			try {
				const buffer = await this.plugin.app.vault.readBinary(file);
				const result = await parseDocument(buffer, file.name, ext);
				return result.content;
			} catch (e: any) {
				console.error('[ChatView] Failed to parse document:', file.name, e);
				return `[无法解析文档: ${file.name} - ${e.message}]`;
			}
		}
		return await this.plugin.app.vault.read(file);
	}

	private addAttachedFile(file: TFile): void {
		if (this.attachedFiles.has(file.path)) return;
		this.attachedFiles.set(file.path, file);
		this.manuallyAttachedPaths.add(file.path);
		this.renderAttachedFiles();
	}

	private removeAttachedFile(path: string): void {
		this.attachedFiles.delete(path);
		this.manuallyAttachedPaths.delete(path);
		if (this.autoAttachedPath === path) {
			this.autoAttachedPath = null;  // 用户主动移除，不再自动附加
		}
		this.renderAttachedFiles();
	}

	private renderAttachedFiles(): void {
		if (!this.contextIndicator) return;
		this.contextIndicator.empty();

		if (this.attachedFiles.size === 0) {
			this.contextIndicator.addClass('fuchouzhe-hidden');
			return;
		}

		// 检测同名文件
		const nameCount = new Map<string, number>();
		for (const [, file] of this.attachedFiles) {
			const name = file.basename;
			nameCount.set(name, (nameCount.get(name) || 0) + 1);
		}

		this.contextIndicator.removeClass('fuchouzhe-hidden');
		// 先渲染手动添加的文件，再渲染被钉住的笔记（保持在底部）
		const autoEntry: [string, TFile] | null = this.autoAttachedPath && this.attachedFiles.has(this.autoAttachedPath)
			? [this.autoAttachedPath, this.attachedFiles.get(this.autoAttachedPath)!]
			: null;
		const entries = Array.from(this.attachedFiles.entries())
			.filter(([path]) => path !== this.autoAttachedPath);
		if (autoEntry) entries.push(autoEntry);

		for (const [path, file] of entries) {
			const ext = file.extension?.toLowerCase() || '';
			const icon = getFileIcon(ext);
			const isAuto = path === this.autoAttachedPath;
			const hasDuplicate = (nameCount.get(file.basename) || 0) > 1;
			const displayName = hasDuplicate && file.parent
				? `${file.parent.name}/${file.basename}`
				: file.basename;

			const chip = this.contextIndicator.createDiv({ cls: 'fuchouzhe-file-chip' });
			if (isAuto) chip.addClass('fuchouzhe-file-chip-auto');
			chip.setAttribute('title', path);  // tooltip 显示完整路径
			const label = isAuto ? `📌 ${icon} ${displayName}` : `${icon} ${displayName}`;
			const labelSpan = chip.createSpan({ text: label });
			// 点击芯片打开文件
			labelSpan.addEventListener('click', () => {
				const targetFile = this.plugin.app.vault.getAbstractFileByPath(path);
				if (targetFile && targetFile instanceof TFile) {
					this.plugin.app.workspace.getLeaf(false).openFile(targetFile);
				}
			});
			labelSpan.style.cursor = 'pointer';

			// 二进制文档：异步加载摘要预览
			if (isBinaryDocument(ext)) {
				chip.addClass('fuchouzhe-file-chip-doc');
				const summarySpan = chip.createSpan({ cls: 'fuchouzhe-file-chip-summary', text: '解析中...' });
				this.loadFileSummary(file, summarySpan);
			}

			const removeBtn = chip.createSpan({ cls: 'fuchouzhe-file-chip-remove', text: '✕' });
			removeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.removeAttachedFile(path);
			});
		}
	}

	/**
	 * 异步加载文档摘要到芯片上
	 */
	private async loadFileSummary(file: TFile, summaryEl: HTMLElement): Promise<void> {
		try {
			const ext = file.extension?.toLowerCase() || '';
			const buffer = await this.plugin.app.vault.readBinary(file);
			const result = await parseDocument(buffer, file.name, ext);
			summaryEl.setText(result.summary);
		} catch {
			summaryEl.setText('解析失败');
		}
	}

	/**
	 * 根据附加文件类型生成上下文提示
	 */
	private buildFileTypeHint(exts: Set<string>): string {
		if (exts.size === 0) return '';

		const hints: string[] = [];
		const hasExcel = ['xlsx', 'xlsm', 'xls'].some(e => exts.has(e));
		const hasWord = ['docx', 'doc'].some(e => exts.has(e));

		if (hasExcel) {
			hints.push(
				'[上下文提示] 用户附加了 Excel 表格数据。你可以：',
				'- 分析数据趋势和统计特征',
				'- 帮助筛选、排序或汇总数据',
				'- 生成数据可视化建议',
				'- 发现数据中的异常或模式',
			);
		}

		if (hasWord) {
			hints.push(
				'[上下文提示] 用户附加了 Word 文档。你可以：',
				'- 总结文档核心内容',
				'- 提取关键信息和要点',
				'- 帮助改写或润色文本',
				'- 分析文档结构和逻辑',
			);
		}

		return hints.length > 0 ? hints.join('\n') : '';
	}

	/**
	 * 中止所有进行中的操作并重置状态（流式输出、场景 pipeline、场景模式等）
	 */
	private stopAndReset(): void {
		// 在置空状态前，给被中断的消息加上中断标记
		if (this.isStreaming && this.currentAssistantMsgId) {
			this.markMessageInterrupted(this.currentAssistantMsgId);
		}

		// 中止流式输出
		if (this.isStreaming) {
			this.fuchouzheService.abort();
			if (this.activePipeline) {
				this.activePipeline.abort();
				this.activePipeline = null;
			}
		}

		// 重置流式状态
		this.isStreaming = false;
		this.currentMessage = '';
		this.textBuffer = '';
		this.currentAssistantMsgId = null;
		this.firstChunkReceived = false;
		this.thinkingContent = '';
		this.thinkingBuffer = '';
		this.activeToolCalls.clear();
		this.toolCallElements.clear();

		// 退出场景模式（如果正在场景模式中）
		if (this.isSceneMode) {
			this.exitSceneMode();
		}

		// 关闭场景覆盖层
		if (this.actionOverlay?.isVisible()) {
			this.actionOverlay.close();
			this.actionOverlay = null;
		}

		// 重置 UI
		this.resetSendButton();
		this.hideThinkingIndicator();
		this.hideAtMentionDropdown();
		this.hideSlashDropdown();
	}

	/**
	 * 清空当前上下文（开始新对话）
	 */
	private clearContext(): void {
		// 中止并重置所有进行中的操作
		this.stopAndReset();

		this.attachedFiles.clear();
		this.manuallyAttachedPaths.clear();

		// 清空当前对话（清除消息 + 重置 ContextManager）
		this.conversationStore.clearCurrentConversation();

		// 清空 UI 中的消息（排除欢迎消息）
		const messages = this.messagesContainer.children;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as HTMLElement;
			if (msg.classList.contains('fuchouzhe-welcome-message')) {
				continue;
			}
			if (msg.classList.contains('fuchouzhe-message')) {
				msg.remove();
			}
		}

		// 显示欢迎消息
		if (this.welcomeMessage) {
			this.welcomeMessage.removeClass('fuchouzhe-hidden');
		}

		// 重置上下文指示
		this.renderAttachedFiles();

		// 确保输入框可用
		this.textarea.value = '';
		this.textarea.style.height = 'auto';
		this.textarea.removeAttribute('disabled');
		// 延迟 focus，等 confirm 对话框完全关闭后再抢焦点
		setTimeout(() => {
			this.textarea.focus();
		}, 100);

		new Notice('对话已清空，开始新对话');
	}
}
