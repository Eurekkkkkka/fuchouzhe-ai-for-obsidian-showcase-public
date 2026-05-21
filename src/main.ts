import { App, Plugin, PluginSettingTab, Setting, Notice, WorkspaceLeaf, TFile, MarkdownView } from 'obsidian';
import { FuchouzheService } from './fuchouzheService';
import { FuchouzheChatView, VIEW_TYPE_FUCHOUZHE_CHAT } from './chatView';
import { initI18n, t } from './i18n';
import { ToolManager, MiniMaxMcpClient } from './tools';
import { MemoryManager } from './memoryManager';

export { FuchouzhePlugin };
export type { FuchouzheSettings };

// API Provider 类型
type APIProvider = 'minimax' | 'zhipin';

// 模型配置项
interface ModelConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

// 模型配置档案（多套配置）
interface ModelProfile {
	id: string;         // 唯一标识
	name: string;       // 显示名称，如 "MiniMax M2.7"
	provider: APIProvider;
	model: string;
	apiKey: string;
	baseUrl: string;
}

interface FuchouzheSettings {
	// 当前激活的模型档案
	activeProfileId: string;

	// 模型档案列表
	modelProfiles: ModelProfile[];

	// API Provider 配置（兼容旧数据，从档案读取）
	apiProvider: APIProvider;
	apiKey: string;
	baseUrl: string;
	model: string;
	timeout: number;

	// MiniMax 特定配置
	miniMaxBaseUrl: string;
	miniMaxModel: string;
	miniMaxApiKey: string;

	// 智谱 GLM 特定配置（免费模型）
	zhipuBaseUrl: string;
	zhipuModel: string;
	zhipuApiKey: string;

	// 工具配置
	enableMcp: boolean;
	enableVaultTools: boolean;
	enableSkills: boolean;

	// UI 配置
	enableAutoScroll: boolean;
	excludedTags: string[];
	language: string;
	autoAttachFile: boolean;
	showToolCalls: boolean;
}

const DEFAULT_SETTINGS: FuchouzheSettings = {
	activeProfileId: 'default',
	modelProfiles: [
		{
			id: 'default',
			name: 'MiniMax-M2.7',
			provider: 'minimax',
			model: 'MiniMax-M2.7',
			apiKey: '',
			baseUrl: 'https://api.minimaxi.com/anthropic',
		},
	],

	apiProvider: 'minimax',
	apiKey: '',
	baseUrl: 'https://api.minimaxi.com/anthropic',
	model: 'MiniMax-M2.7',
	timeout: 300000, // 5 分钟超时

	// MiniMax 默认值
	miniMaxBaseUrl: 'https://api.minimaxi.com/anthropic',
	miniMaxModel: 'MiniMax-M2.7',
	miniMaxApiKey: '',

	// 智谱 GLM 默认值（免费）
	zhipuBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
	zhipuModel: 'glm-4-flash',
	zhipuApiKey: '',

	// 工具默认开启
	enableMcp: true,
	enableVaultTools: true,
	enableSkills: true,

	// UI 默认值
	enableAutoScroll: true,
	excludedTags: ['private', 'sensitive'],
	language: 'zh-CN',
	autoAttachFile: true,
	showToolCalls: true,
};

export default class FuchouzhePlugin extends Plugin {
	settings: FuchouzheSettings;
	fuchouzheService: FuchouzheService;
	toolManager: ToolManager;
	memoryManager: MemoryManager;
	chatView: FuchouzheChatView | null = null;

	async onload() {
		console.log('Loading 富酬者AI for Obsidian plugin');

		// 加载设置
		await this.loadSettings();

		// 初始化 i18n
		initI18n(this.settings.language);

		// 初始化工具管理器
		this.toolManager = new ToolManager({
			app: this.app,
			apiKey: this.settings.apiKey,
			apiProvider: this.settings.apiProvider,
			enableMcp: this.settings.enableMcp,
			enableVault: this.settings.enableVaultTools,
			enableSkills: this.settings.enableSkills,
		});

		// 初始化 AI 服务
		this.fuchouzheService = new FuchouzheService(this.app, this.toolManager);
		this.updateServiceConfig();

		// 初始化记忆管理器
		this.memoryManager = new MemoryManager({ app: this.app });

		// 启动 MCP（如启用）
		if (this.settings.enableMcp) {
			this.checkAndStartMcp();
		}

		// 注册侧边栏视图
		this.registerView(
			VIEW_TYPE_FUCHOUZHE_CHAT,
			(leaf) => (this.chatView = new FuchouzheChatView(leaf, this, this.fuchouzheService))
		);

		// 添加功能图标
		this.addRibbonIcon('message-square', 'Open 富酬者AI Chat', () => {
			this.activateView();
		});

		// 添加打开聊天命令
		this.addCommand({
			id: 'open-fuchouzi-ai-chat',
			name: 'Open 富酬者AI Chat',
			callback: () => this.activateView(true),
		});

		// 添加选中文字打开聊天命令
		this.addCommand({
			id: 'open-fuchouzi-ai-chat-with-selection',
			name: 'Open 富酬者AI Chat with Selection',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				const selection = activeView?.editor?.getSelection();

				if (selection) {
					if (!checking) {
						this.activateView();
					}
					return true;
				}
				return false;
			},
		});

		// 打开记忆文件
		this.addCommand({
			id: 'open-memory-file',
			name: 'Open Memory File',
			callback: () => {
				this.memoryManager.openInEditor();
			},
		});

		// 添加设置页面
		this.addSettingTab(new FuchouzheSettingTab(this.app, this));

		// 页面加载完成后打开聊天视图
		this.app.workspace.onLayoutReady(async () => {
			this.activateView(true);
		});
	}

	/**
	 * 检查并启动 MCP
	 */
	async checkAndStartMcp(): Promise<void> {
		const uvxAvailable = await MiniMaxMcpClient.checkUvxAvailable();
		if (!uvxAvailable) {
			new Notice('⚠️ uvx 未安装，无法启用 MCP。请运行: curl -LsSf https://astral.sh/uv/install.sh | sh');
			return;
		}

		const started = await this.toolManager.startMcp();
		if (started) {
			new Notice('✅ MiniMax MCP 已启动');
		}
	}

	/**
	 * 更新服务配置
	 */
	public updateServiceConfig(): void {
		const provider = this.settings.apiProvider;
		let baseUrl: string;
		let model: string;
		let apiKey: string;

		switch (provider) {
			case 'zhipin':
				baseUrl = this.settings.zhipuBaseUrl;
				model = this.settings.zhipuModel;
				apiKey = this.settings.zhipuApiKey;
				break;
			case 'minimax':
			default:
				baseUrl = this.settings.miniMaxBaseUrl;
				model = this.settings.miniMaxModel;
				apiKey = this.settings.miniMaxApiKey;
				break;
		}

		this.fuchouzheService.updateConfig({
			apiProvider: provider as 'minimax' | 'zhipin',
			apiKey,
			baseUrl,
			model,
			timeout: this.settings.timeout,
			enableSkills: this.settings.enableSkills,
		});
	}

	onunload() {
		console.log('Unloading 富酬者AI for Obsidian plugin');
		this.toolManager.dispose();
		this.fuchouzheService.dispose();
	}

	async activateView(forceOpen = false) {
		const { workspace } = this.app;

		// 查找已有的聊天视图 leaf
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_FUCHOUZHE_CHAT);

		if (leaves.length > 0) {
			// 已有视图：切换右侧栏的展开/收起
			const rightSplit = workspace.rightSplit;
			if (rightSplit) {
				if (rightSplit.collapsed) {
					rightSplit.expand();
					workspace.revealLeaf(leaves[0]);
				} else {
					// 如果当前活跃的 leaf 就是聊天视图，则收起
					const activeLeaf = workspace.activeLeaf;
					if (activeLeaf && leaves.includes(activeLeaf)) {
						rightSplit.collapse();
					} else {
						// 否则切换到聊天视图
						workspace.revealLeaf(leaves[0]);
					}
				}
			}
		} else {
			// 没有已有视图：创建新的
			const leaf = workspace.getRightLeaf(false);
			await leaf!.setViewState({ type: VIEW_TYPE_FUCHOUZHE_CHAT, active: true });
			workspace.revealLeaf(leaf!);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// 更新服务配置
		this.updateServiceConfig();
		// 更新工具配置
		this.toolManager.updateConfig({
			enableMcp: this.settings.enableMcp,
			enableVault: this.settings.enableVaultTools,
			enableSkills: this.settings.enableSkills,
		});
	}

	getActiveFile(): TFile | null {
		return this.app.workspace.getActiveFile();
	}

	getVaultPath(): string {
		// @ts-ignore - adapter is available but not in types
		return this.app.vault.adapter.basePath;
	}

	/** 从档案列表获取当前激活的档案 */
	getActiveProfile(): ModelProfile | undefined {
		return this.settings.modelProfiles.find(p => p.id === this.settings.activeProfileId);
	}

	/** 根据档案更新全局服务配置 */
	applyProfileConfig(profile: ModelProfile): void {
		this.settings.apiProvider = profile.provider;
		this.settings.model = profile.model;
		this.settings.apiKey = profile.apiKey;
		this.settings.baseUrl = profile.baseUrl;

		if (profile.provider === 'minimax') {
			this.settings.miniMaxModel = profile.model;
			this.settings.miniMaxApiKey = profile.apiKey;
			this.settings.miniMaxBaseUrl = profile.baseUrl;
		} else {
			this.settings.zhipuModel = profile.model;
			this.settings.zhipuApiKey = profile.apiKey;
			this.settings.zhipuBaseUrl = profile.baseUrl;
		}

		// 通知 toolManager 重建 MCP 客户端（如有必要）
		this.toolManager.updateConfig({
			apiKey: profile.apiKey,
			apiProvider: profile.provider,
		});
	}
}

class FuchouzheSettingTab extends PluginSettingTab {
	plugin: FuchouzhePlugin;

	constructor(app: App, plugin: FuchouzhePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: '富酬者AI 设置' });

		// ========== 模型配置档案 ==========
		containerEl.createEl('h3', { text: '🤖 模型配置档案' });

		// 迁移旧数据：如果没有档案，从旧配置生成
		if (!this.plugin.settings.modelProfiles || this.plugin.settings.modelProfiles.length === 0) {
			this.plugin.settings.modelProfiles = [
				{
					id: 'default',
					name: 'MiniMax-M2.7',
					provider: 'minimax',
					model: this.plugin.settings.miniMaxModel || 'MiniMax-M2.7',
					apiKey: this.plugin.settings.miniMaxApiKey || '',
					baseUrl: this.plugin.settings.miniMaxBaseUrl || 'https://api.minimaxi.com/anthropic',
				},
			];
			this.plugin.settings.activeProfileId = 'default';
		}

		const profiles = this.plugin.settings.modelProfiles;
		const activeProfile = this.plugin.getActiveProfile() || profiles[0];

		// --- 顶部：档案选择下拉框 + 新增按钮 ---
		const selectorRow = containerEl.createDiv({
			attr: { style: 'display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap;' }
		});

		const selectEl = selectorRow.createEl('select', {
			cls: 'fuchouzhe-model-select',
			attr: { style: 'flex: 1; min-width: 180px;' }
		}) as HTMLSelectElement;

		profiles.forEach(p => {
			const opt = selectEl.createEl('option', { value: p.id, text: p.name });
			if (p.id === activeProfile?.id) opt.setAttribute('selected', 'true');
		});

		selectEl.addEventListener('change', async () => {
			const selected = profiles.find(p => p.id === selectEl.value);
			if (!selected) return;
			this.plugin.settings.activeProfileId = selected.id;
			this.plugin.applyProfileConfig(selected);
			await this.plugin.saveSettings();
			this.display();
		});

		// 新增档案按钮
		const addBtn = selectorRow.createEl('button', {
			text: '+ 新增档案',
			attr: { style: 'padding: 6px 14px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-secondary); color: var(--text-normal); cursor: pointer; font-size: 13px;' }
		});
		addBtn.addEventListener('click', async () => {
			const newId = Date.now().toString();
			const newProfile: ModelProfile = {
				id: newId,
				name: `新配置 ${profiles.length + 1}`,
				provider: 'minimax',
				model: 'MiniMax-M2.7',
				apiKey: '',
				baseUrl: 'https://api.minimaxi.com/anthropic',
			};
			this.plugin.settings.modelProfiles.push(newProfile);
			this.plugin.settings.activeProfileId = newId;
			this.plugin.applyProfileConfig(newProfile);
			await this.plugin.saveSettings();
			this.display();
		});

		// --- 当前档案编辑卡片 ---
		if (activeProfile) {
			const card = containerEl.createDiv({
				cls: `fuchouzhe-model-card is-active-minimax`,
				attr: { style: 'max-width: 500px;' }
			});

			// 档案名称
			card.createEl('div', { cls: 'fuchouzhe-model-card-title', text: `📝 ${activeProfile.name}` });

			// 提供商标签
			const providerBadge = card.createEl('span', {
				text: activeProfile.provider === 'minimax' ? '🟣 MiniMax' : '🌟 智谱 GLM',
				attr: {
					style: 'display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-bottom: 12px; background: color-mix(in srgb, var(--fuchouzhe-brand) 15%, var(--background-secondary)); color: var(--text-normal);'
				}
			});

			// 档案名称输入
			card.createEl('div', { cls: 'fuchouzhe-model-card-info-label', text: '档案名称' });
			const nameInput = card.createEl('input', {
				type: 'text',
				cls: 'fuchouzhe-model-select',
				attr: { value: activeProfile.name, placeholder: '如：MiniMax M2.7 主号' }
			}) as HTMLInputElement;
			nameInput.addEventListener('change', async () => {
				activeProfile.name = nameInput.value;
				await this.plugin.saveSettings();
				this.display();
			});

			// 提供商切换
			card.createEl('div', { cls: 'fuchouzhe-model-card-info-label', text: '提供商' });
			const providerSelect = card.createEl('select', { cls: 'fuchouzhe-model-select' }) as HTMLSelectElement;
			['minimax', 'zhipin'].forEach(p => {
				const opt = providerSelect.createEl('option', { value: p, text: p === 'minimax' ? '🟣 MiniMax' : '🌟 智谱 GLM' });
				if (p === activeProfile.provider) opt.setAttribute('selected', 'true');
			});
			providerSelect.addEventListener('change', async () => {
				activeProfile.provider = providerSelect.value as APIProvider;
				// 切换默认模型
				if (activeProfile.provider === 'minimax') {
					activeProfile.model = 'MiniMax-M2.7';
					activeProfile.baseUrl = 'https://api.minimaxi.com/anthropic';
				} else {
					activeProfile.model = 'glm-4-flash';
					activeProfile.baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
				}
				this.plugin.applyProfileConfig(activeProfile);
				await this.plugin.saveSettings();
				this.display();
			});

			// 模型选择
			card.createEl('div', { cls: 'fuchouzhe-model-card-info-label', text: '模型' });
			const modelSelect = card.createEl('select', { cls: 'fuchouzhe-model-select' }) as HTMLSelectElement;
			const minimaxModels = ['MiniMax-M2.7', 'MiniMax-M2.5'];
			const zhipinModels = ['glm-4-flash', 'glm-4', 'glm-4v'];
			const modelOptions = activeProfile.provider === 'minimax' ? minimaxModels : zhipinModels;
			modelOptions.forEach(m => {
				const opt = modelSelect.createEl('option', { value: m, text: m });
				if (m === activeProfile.model) opt.setAttribute('selected', 'true');
			});
			modelSelect.addEventListener('change', async () => {
				activeProfile.model = modelSelect.value;
				this.plugin.applyProfileConfig(activeProfile);
				await this.plugin.saveSettings();
			});

			// Base URL
			card.createEl('div', { cls: 'fuchouzhe-model-card-info-label', text: 'API Base URL' });
			const baseUrlInput = card.createEl('input', {
				type: 'text',
				cls: 'fuchouzhe-model-select',
				attr: { value: activeProfile.baseUrl, placeholder: 'https://...' }
			}) as HTMLInputElement;
			baseUrlInput.addEventListener('change', async () => {
				activeProfile.baseUrl = baseUrlInput.value;
				this.plugin.applyProfileConfig(activeProfile);
				await this.plugin.saveSettings();
			});

			// API Key
			card.createEl('div', { cls: 'fuchouzhe-model-card-info-label', text: 'API Key' });
			const apiKeyInput = card.createEl('input', {
				type: 'password',
				cls: 'fuchouzhe-model-select',
				attr: {
					value: activeProfile.apiKey,
					placeholder: activeProfile.provider === 'minimax' ? '输入 MiniMax API Key' : '输入智谱 API Key'
				}
			}) as HTMLInputElement;
			apiKeyInput.addEventListener('change', async () => {
				activeProfile.apiKey = apiKeyInput.value;
				this.plugin.applyProfileConfig(activeProfile);
				await this.plugin.saveSettings();
				this.display();
			});

			// 删除档案按钮
			if (profiles.length > 1) {
				const delBtn = card.createEl('button', {
					text: '🗑️ 删除此档案',
					attr: {
						style: 'margin-top: 12px; padding: 6px 12px; border-radius: 4px; border: 1px solid color-mix(in srgb, #ef4444 40%, var(--background-modifier-border)); background: transparent; color: #ef4444; cursor: pointer; font-size: 12px;'
					}
				});
				delBtn.addEventListener('click', async () => {
					if (!confirm(`确定删除档案「${activeProfile.name}」？`)) return;
					this.plugin.settings.modelProfiles = profiles.filter(p => p.id !== activeProfile.id);
					const next = this.plugin.settings.modelProfiles[0];
					this.plugin.settings.activeProfileId = next.id;
					this.plugin.applyProfileConfig(next);
					await this.plugin.saveSettings();
					this.display();
				});
			}
		}

		// ========== 超时设置 ==========
		containerEl.createEl('hr', { cls: 'fuchouzhe-settings-divider' });
		containerEl.createEl('h3', { text: '⏱️ 其他设置' });

		new Setting(containerEl)
			.setName('请求超时')
			.setDesc('API 请求超时时间（毫秒）')
			.addText(text => text
				.setValue(String(this.plugin.settings.timeout))
				.onChange(async (value) => {
					const timeout = parseInt(value);
					if (!isNaN(timeout) && timeout > 0) {
						this.plugin.settings.timeout = timeout;
						await this.plugin.saveSettings();
					}
				}));

		// ========== 工具配置 ==========
		containerEl.createEl('hr', { cls: 'fuchouzhe-settings-divider' });
		containerEl.createEl('h3', { text: '工具能力' });

		if (this.plugin.settings.apiProvider === 'minimax') {
			// ---- MiniMax: 外部 MCP ----
			const mcpStatus = this.plugin.toolManager.isMcpReady();
			const statusEmoji = mcpStatus ? '✅' : '⚪';
			const statusText = mcpStatus ? '已连接' : '未连接';

			new Setting(containerEl)
				.setName('启用 MCP')
				.setDesc(`${statusEmoji} 连接状态: ${statusText} | 启用后提供 web_search 和图片分析（需安装 uvx）`)
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.enableMcp)
					.onChange(async (value) => {
						this.plugin.settings.enableMcp = value;
						await this.plugin.saveSettings();
						if (value) {
							this.plugin.checkAndStartMcp();
						} else {
							this.plugin.toolManager.stopMcp();
						}
						this.display();
					}));

		} else {
			// ---- GLM: 内置工具 ----
			const glmpNotice = containerEl.createDiv({
				attr: {
					style: 'padding: 12px 14px; background: color-mix(in srgb, #22c55e 8%, var(--background-secondary)); border: 1px solid color-mix(in srgb, #22c55e 30%, var(--background-modifier-border)); border-radius: 6px; margin-bottom: 12px;'
				}
			});
			glmpNotice.createEl('div', {
				attr: { style: 'font-size: 13px; font-weight: 600; color: var(--text-normal); margin-bottom: 6px;' },
				text: '🌟 智谱 GLM - 内置工具'
			});
			const glmpDesc = glmpNotice.createEl('div', {
				attr: { style: 'font-size: 12px; color: var(--text-muted); line-height: 1.6;' }
			});
			glmpDesc.createEl('span', { attr: { style: 'font-weight: 600;' }, text: 'GLM-4-AllTools（付费）' });
			glmpDesc.createEl('span', { text: ' 模型内置网页搜索+图片理解，无需 MCP。' });
			glmpDesc.createEl('br');
			glmpDesc.createEl('span', { attr: { style: 'font-weight: 600;' }, text: 'GLM-4-Flash / GLM-4（免费）' });
			glmpDesc.createEl('span', { text: ' 无工具能力，仅基础对话。' });
		}

		// Vault 工具开关（两个 provider 都通用）

		// Vault 工具开关
		new Setting(containerEl)
			.setName('启用 Vault 工具')
			.setDesc('启用文件读写搜索等笔记库操作工具')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableVaultTools)
				.onChange(async (value) => {
					this.plugin.settings.enableVaultTools = value;
					await this.plugin.saveSettings();
				}));

		// Skills 开关
		new Setting(containerEl)
			.setName('启用 Skills')
			.setDesc('启用预置技能（如开始一天、启动项目等）')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableSkills)
				.onChange(async (value) => {
					this.plugin.settings.enableSkills = value;
					await this.plugin.saveSettings();
				}));

		// ========== 记忆系统 ==========
		containerEl.createEl('hr', { cls: 'fuchouzhe-settings-divider' });
		containerEl.createEl('h3', { text: '🧠 长期记忆' });

		// 记忆状态（同步读取缓存）
		const memStatus = this.plugin.memoryManager.getStatus();
		const memStatusText = memStatus.exists
			? `📄 ${memStatus.path} | ~${memStatus.tokens} / ${memStatus.budget} tokens`
			: `⚠️ 尚未创建 | 点击「打开记忆文件」初始化`;

		const memStatusEl = containerEl.createDiv({
			attr: {
				style: `padding: 10px 14px; background: color-mix(in srgb, var(--fuchouzhe-brand) 8%, var(--background-secondary)); border: 1px solid color-mix(in srgb, var(--fuchouzhe-brand) 25%, var(--background-modifier-border)); border-radius: 6px; margin-bottom: 12px; font-size: 12px; color: var(--text-muted);`
			}
		});
		memStatusEl.createEl('span', { text: memStatusText });

		// 打开记忆文件按钮
		new Setting(containerEl)
			.setName('打开记忆文件')
			.setDesc('在编辑器中打开 .fuchouzhe/memory.md，可直接编辑记忆内容')
			.addButton(button => button
				.setButtonText('📄 打开记忆')
				.onClick(async () => {
					await this.plugin.memoryManager.openInEditor();
				}));

		// Token 预算设置
		new Setting(containerEl)
			.setName('记忆预算')
			.setDesc('每次对话注入记忆的最大 token 数（建议 2048-4096）')
			.addText(text => text
				.setValue(String(this.plugin.memoryManager['budget']))
				.onChange(async (value) => {
					const budget = parseInt(value);
					if (!isNaN(budget) && budget >= 512) {
						this.plugin.memoryManager.setBudget(budget);
					}
				}));

		// 刷新记忆状态
		new Setting(containerEl)
			.setName('刷新状态')
			.setDesc('重新读取记忆文件状态')
			.addButton(button => button
				.setButtonText('🔄 刷新')
				.onClick(async () => {
					await this.plugin.memoryManager.load();
					const status = this.plugin.memoryManager.getStatus();
					memStatusEl.setText(status.exists
						? `📄 ${status.path} | ~${status.tokens} / ${status.budget} tokens`
						: `⚠️ 尚未创建`);
				}));

		// 扫描 Skills 按钮
		let skillsListEl: HTMLDivElement | null = null;
		let skillsSummaryEl: HTMLElement | null = null;
		new Setting(containerEl)
			.setName('扫描 Skills')
			.setDesc('手动扫描 Skills 文件夹，加载新增的技能')
			.addButton(button => button
				.setButtonText('扫描')
				.onClick(async () => {
					button.setButtonText('扫描中...');
					button.setDisabled(true);
					try {
						const skills = this.plugin.fuchouzheService.rescanSkills();
						if (skills.length === 0) {
							new Notice('未扫描到任何 Skills');
						} else {
							new Notice(`✅ 已扫描到 ${skills.length} 个 Skills`);
						}
						// 更新 Skills 列表显示
						if (skillsListEl) {
							skillsListEl.empty();
							if (skills.length === 0) {
								skillsListEl.setText('（暂无 Skills）');
							} else {
								skills.forEach(skill => {
									skillsListEl!.createEl('div', {
										cls: 'fuchouzhe-skill-item',
										text: `• ${skill.name}`
									});
								});
							}
						}
						// 更新折叠标题
						if (skillsSummaryEl) {
							skillsSummaryEl.textContent = skills.length > 0
								? `已扫描到 ${skills.length} 个 Skills`
								: '暂无 Skills';
						}
					} catch (e) {
						new Notice('❌ 扫描 Skills 失败');
					}
					button.setButtonText('扫描');
					button.setDisabled(false);
				}));

		// Skills 列表显示区域（折叠）
		const initialSkills = this.plugin.fuchouzheService.rescanSkills();
		const skillsDetails = containerEl.createEl('details', { cls: 'fuchouzhe-skills-details' });
		const skillsSummary = skillsDetails.createEl('summary');
		skillsSummaryEl = skillsSummary;
		skillsSummary.textContent = initialSkills.length > 0
			? `已扫描到 ${initialSkills.length} 个 Skills`
			: '暂无 Skills';

		skillsListEl = skillsDetails.createEl('div', { cls: 'fuchouzhe-skills-list' });
		if (initialSkills.length === 0) {
			skillsListEl.setText('（暂无 Skills）');
		} else {
			initialSkills.forEach(skill => {
				skillsListEl!.createEl('div', {
					cls: 'fuchouzhe-skill-item',
					text: `• ${skill.name}`
				});
			});
		}

		// ========== UI 配置 ==========
		containerEl.createEl('hr', { cls: 'fuchouzhe-settings-divider' });
		containerEl.createEl('h3', { text: '界面设置' });

		// 显示工具调用
		new Setting(containerEl)
			.setName('显示工具调用')
			.setDesc('在聊天中显示 AI 工具调用过程')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showToolCalls)
				.onChange(async (value) => {
					this.plugin.settings.showToolCalls = value;
					await this.plugin.saveSettings();
				}));

		// 自动滚动
		new Setting(containerEl)
			.setName('自动滚动')
			.setDesc('聊天时自动滚动到最新消息')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableAutoScroll)
				.onChange(async (value) => {
					this.plugin.settings.enableAutoScroll = value;
					await this.plugin.saveSettings();
				}));

		// 自动附加文件
		new Setting(containerEl)
			.setName('自动附加文件')
			.setDesc('发送消息时自动附加当前文件内容')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoAttachFile)
				.onChange(async (value) => {
					this.plugin.settings.autoAttachFile = value;
					await this.plugin.saveSettings();
				}));

		// 排除标签
		new Setting(containerEl)
			.setName('排除标签')
			.setDesc('自动附加文件时排除这些标签的内容（逗号分隔）')
			.addText(text => text
				.setValue(this.plugin.settings.excludedTags.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.excludedTags = value
						.split(',')
						.map(tag => tag.trim())
						.filter(tag => tag.length > 0);
					await this.plugin.saveSettings();
				}));

		// 语言设置
		new Setting(containerEl)
			.setName('界面语言')
			.setDesc('选择插件界面语言')
			.addDropdown(dropdown => dropdown
				.addOption('zh-CN', '中文简体')
				.addOption('en-US', 'English')
				.setValue(this.plugin.settings.language)
				.onChange(async (value) => {
					this.plugin.settings.language = value;
					await this.plugin.saveSettings();
					initI18n(value);
					this.display();
				}));

	}
}
