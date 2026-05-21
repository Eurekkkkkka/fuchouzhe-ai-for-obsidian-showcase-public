/**
 * 场景面板 UI 组件 v3
 * - ActionOverlay: 独立全屏覆盖层，不嵌入聊天消息流
 * - ActionConfigPanel: 选动作后显示配置面板（可选 skill 开关 + 输出路径）
 */

import { CATEGORIES, ACTION_CONFIGS, ActionConfig, CategoryConfig, getActionsByCategory, getActionConfig, resolveTemplatePath, composeOutputPath } from './sceneConfig';

// ============ 最近使用记录 ============

const RECENT_ACTIONS_KEY = 'fuchouzhezhe-recent-actions';
const MAX_RECENT = 4;

export function getRecentActionIds(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_ACTIONS_KEY);
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}

export function recordRecentAction(actionId: string): void {
	const recent = getRecentActionIds().filter(id => id !== actionId);
	recent.unshift(actionId);
	localStorage.setItem(RECENT_ACTIONS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

// ============ 动作配置结果 ============

export interface ActionSelection {
	action: ActionConfig;
	disabledSkills: Set<string>;
	outputFolder: string;
	fileName: string;
	outputPath: string;
	fileNameEdited: boolean;
	autoFilename: boolean;
}

// ============ 场景覆盖层（独立页面） ============

export class ActionOverlay {
	private rootEl: HTMLElement;
	private overlayEl: HTMLElement | null = null;
	private configPanel: ActionConfigPanel | null = null;
	private onSelect: (selection: ActionSelection) => void;
	private onClose: () => void;
	private app: any;

	constructor(
		rootEl: HTMLElement,
		onSelect: (selection: ActionSelection) => void,
		onClose: () => void,
		app?: any,
	) {
		this.rootEl = rootEl;
		this.onSelect = onSelect;
		this.onClose = onClose;
		this.app = app || null;
	}

	show(): void {
		if (this.overlayEl) return;

		this.overlayEl = this.rootEl.createDiv({ cls: 'fuchouzhe-overlay' });

		// 渲染动作选择页
		this.renderActionGrid();
	}

	close(): void {
		this.configPanel = null;
		this.overlayEl?.remove();
		this.overlayEl = null;
		this.onClose();
	}

	isVisible(): boolean {
		return this.overlayEl !== null;
	}

	// ---- 第一页：动作选择 ----

	private renderActionGrid(): void {
		if (!this.overlayEl) return;
		this.overlayEl.empty();

		const page = this.overlayEl.createDiv({ cls: 'fuchouzhe-overlay-page' });

		// 头部
		const header = page.createDiv({ cls: 'fuchouzhe-overlay-header' });
		const closeBtn = header.createEl('button', { cls: 'fuchouzhe-overlay-close', text: '✕' });
		closeBtn.addEventListener('click', () => this.close());
		header.createSpan({ cls: 'fuchouzhe-overlay-title', text: '选择操作' });

		// 内容区（可滚动）
		const body = page.createDiv({ cls: 'fuchouzhe-overlay-body' });

		// 最近使用
		this.renderRecentSection(body);

		// 按分类渲染
		for (const category of CATEGORIES) {
			const actions = getActionsByCategory(category.id);
			if (actions.length === 0) continue;
			this.renderCategory(body, category, actions);
		}
	}

	private renderRecentSection(container: HTMLElement): void {
		const recentIds = getRecentActionIds();
		const recentActions = recentIds
			.map(id => getActionConfig(id))
			.filter((a): a is ActionConfig => !!a);

		if (recentActions.length === 0) return;

		const section = container.createDiv({ cls: 'fuchouzhe-overlay-section' });
		const sectionHeader = section.createDiv({ cls: 'fuchouzhe-overlay-section-header' });
		sectionHeader.createSpan({ cls: 'fuchouzhe-overlay-section-icon', text: '⏱️' });
		sectionHeader.createSpan({ cls: 'fuchouzhe-overlay-section-name', text: '最近使用' });

		const grid = section.createDiv({ cls: 'fuchouzhe-overlay-grid' });
		for (const action of recentActions) {
			this.renderCard(grid, action);
		}
	}

	private renderCategory(container: HTMLElement, category: CategoryConfig, actions: ActionConfig[]): void {
		const section = container.createDiv({ cls: 'fuchouzhe-overlay-section' });

		const sectionHeader = section.createDiv({ cls: 'fuchouzhe-overlay-section-header' });
		sectionHeader.createSpan({ cls: 'fuchouzhe-overlay-section-icon', text: category.icon });
		sectionHeader.createSpan({ cls: 'fuchouzhe-overlay-section-name', text: category.name });

		const grid = section.createDiv({ cls: 'fuchouzhe-overlay-grid' });
		for (const action of actions) {
			this.renderCard(grid, action);
		}
	}

	private renderCard(grid: HTMLElement, action: ActionConfig): void {
		const card = grid.createDiv({ cls: 'fuchouzhe-overlay-card' });

		const iconRow = card.createDiv({ cls: 'fuchouzhe-overlay-card-top' });
		iconRow.createSpan({ cls: 'fuchouzhe-overlay-card-icon', text: action.icon });

		const badge = action.requiredInput === 'file' ? '📎' : action.requiredInput === 'text' ? '✍️' : null;
		if (badge) {
			iconRow.createSpan({ cls: 'fuchouzhe-overlay-card-badge', text: badge });
		}

		card.createDiv({ cls: 'fuchouzhe-overlay-card-name', text: action.name });
		card.createDiv({ cls: 'fuchouzhe-overlay-card-desc', text: action.description });

		card.addEventListener('click', () => this.openConfigPanel(action));
	}

	// ---- 第二页：动作配置 ----

	private openConfigPanel(action: ActionConfig): void {
		if (!this.overlayEl) return;
		this.overlayEl.empty();

		this.configPanel = new ActionConfigPanel({
			container: this.overlayEl,
			action,
			app: this.app,
			onExecute: (selection) => {
				this.close();
				this.onSelect(selection);
			},
			onBack: () => {
				this.configPanel = null;
				this.renderActionGrid();
			},
		});
		this.configPanel.render();
	}
}

// ============ 动作配置面板 ============

interface ActionConfigPanelOptions {
	container: HTMLElement;
	action: ActionConfig;
	app: any;
	onExecute: (selection: ActionSelection) => void;
	onBack: () => void;
}

class ActionConfigPanel {
	private container: HTMLElement;
	private action: ActionConfig;
	private app: any;
	private disabledSkills: Set<string> = new Set();
	private outputFolder: string;
	private fileName: string;
	private fileNameEdited = false;
	private autoFilename = false;
	private onExecute: (selection: ActionSelection) => void;
	private onBack: () => void;

	constructor(options: ActionConfigPanelOptions) {
		this.container = options.container;
		this.action = options.action;
		this.app = options.app;
		this.onExecute = options.onExecute;
		this.onBack = options.onBack;
		this.outputFolder = options.action.defaultOutputFolder;
		this.fileName = resolveTemplatePath(options.action.defaultFileName);
	}

	render(): void {
		const page = this.container.createDiv({ cls: 'fuchouzhe-overlay-page' });

		// 头部
		const header = page.createDiv({ cls: 'fuchouzhe-overlay-header' });
		const backBtn = header.createEl('button', { cls: 'fuchouzhe-overlay-back', text: '←' });
		backBtn.addEventListener('click', () => this.onBack());
		header.createSpan({ cls: 'fuchouzhe-overlay-title', text: '配置操作' });

		// 内容区
		const body = page.createDiv({ cls: 'fuchouzhe-overlay-body' });

		// 动作卡片（大号，带 icon 和描述）
		this.renderActionHeader(body);

		// Pipeline 步骤（可选开关）
		this.renderPipelineConfig(body);

		// 输出路径
		this.renderOutputConfig(body);

		// 底部执行按钮
		const footer = page.createDiv({ cls: 'fuchouzhe-config-footer' });
		const execBtn = footer.createEl('button', { cls: 'fuchouzhe-config-execute' });
		execBtn.textContent = `${this.action.icon} 开始 ${this.action.name}`;
		execBtn.addEventListener('click', () => {
			const outputPath = composeOutputPath(this.outputFolder, this.fileName);
			this.onExecute({
				action: this.action,
				disabledSkills: new Set(this.disabledSkills),
				outputFolder: this.outputFolder,
				fileName: this.fileName,
				outputPath,
				fileNameEdited: this.fileNameEdited,
				autoFilename: this.autoFilename,
			});
		});
	}

	private renderActionHeader(container: HTMLElement): void {
		const hero = container.createDiv({ cls: 'fuchouzhe-config-hero' });

		const iconEl = hero.createDiv({ cls: 'fuchouzhe-config-hero-icon' });
		iconEl.textContent = this.action.icon;

		const info = hero.createDiv({ cls: 'fuchouzhe-config-hero-info' });
		info.createDiv({ cls: 'fuchouzhe-config-hero-name', text: this.action.name });
		info.createDiv({ cls: 'fuchouzhe-config-hero-desc', text: this.action.description });

		// 输入类型提示
		const inputHint = this.action.requiredInput === 'file'
			? '📎 需要附加文件'
			: this.action.requiredInput === 'text'
			? '✍️ 输入文本即可'
			: '✍️📎 文本或文件均可';
		info.createDiv({ cls: 'fuchouzhe-config-hero-hint', text: inputHint });
	}

	private renderPipelineConfig(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'fuchouzhe-config-section' });
		section.createDiv({ cls: 'fuchouzhe-config-section-title', text: '处理步骤' });

		const optionalSkills = new Set(this.action.optionalSkills || []);
		const skillLabels = this.action.skillLabels || {};

		const list = section.createDiv({ cls: 'fuchouzhe-config-pipeline' });

		for (let i = 0; i < this.action.pipeline.length; i++) {
			const skillId = this.action.pipeline[i];
			if (skillId === 'writeback-output') continue; // 写回步骤不显示

			const isOptional = optionalSkills.has(skillId);
			const label = skillLabels[skillId] || this.action.stepLabels[skillId]?.replace(/^正在/, '').replace(/\.{3}$/, '') || skillId;

			const row = list.createDiv({ cls: 'fuchouzhe-config-step' });

			// 步骤序号
			const numEl = row.createSpan({ cls: 'fuchouzhe-config-step-num' });
			numEl.textContent = String(i + 1);

			// 步骤名称
			row.createSpan({ cls: 'fuchouzhe-config-step-label', text: label });

			if (isOptional) {
				// 可选：toggle 开关
				const toggle = row.createEl('label', { cls: 'fuchouzhe-config-toggle' });
				const checkbox = toggle.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
				checkbox.checked = true;
				toggle.createSpan({ cls: 'fuchouzhe-config-toggle-slider' });

				checkbox.addEventListener('change', () => {
					if (checkbox.checked) {
						this.disabledSkills.delete(skillId);
						row.removeClass('fuchouzhe-config-step-disabled');
					} else {
						this.disabledSkills.add(skillId);
						row.addClass('fuchouzhe-config-step-disabled');
					}
				});
			} else {
				// 必选：锁定标记
				row.createSpan({ cls: 'fuchouzhe-config-step-lock', text: '🔒' });
			}
		}
	}

	private renderOutputConfig(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'fuchouzhe-config-section' });
		section.createDiv({ cls: 'fuchouzhe-config-section-title', text: '保存位置' });

		// 文件夹选择（下拉）
		const folderRow = section.createDiv({ cls: 'fuchouzhe-config-path-row' });
		folderRow.createSpan({ cls: 'fuchouzhe-config-path-icon', text: '📁' });

		const folderSelect = folderRow.createEl('select', { cls: 'fuchouzhe-config-folder-select' });
		this.populateFolderOptions(folderSelect);
		folderSelect.value = this.outputFolder;

		folderSelect.addEventListener('change', () => {
			this.outputFolder = folderSelect.value;
		});

		// 自动文件名复选框
		const autoRow = section.createDiv({ cls: 'fuchouzhe-config-path-row' });
		const autoCheckbox = autoRow.createEl('input', {
			cls: 'fuchouzhe-config-auto-filename',
			attr: { type: 'checkbox' },
		});
		autoRow.createSpan({ text: '让富酬者AI自动生成文件名' });
		autoCheckbox.checked = this.autoFilename;

		autoCheckbox.addEventListener('change', () => {
			this.autoFilename = autoCheckbox.checked;
			nameRow.style.display = this.autoFilename ? 'none' : 'flex';
			if (this.autoFilename) {
				this.fileNameEdited = false;
			}
		});

		// 文件名编辑
		const nameRow = section.createDiv({ cls: 'fuchouzhe-config-path-row' });
		nameRow.createSpan({ cls: 'fuchouzhe-config-path-icon', text: '📝' });

		const nameInput = nameRow.createEl('input', {
			cls: 'fuchouzhe-config-filename-input',
			attr: { type: 'text', value: this.fileName },
		});
		nameRow.createSpan({ cls: 'fuchouzhe-config-ext', text: '.md' });
		nameRow.style.display = this.autoFilename ? 'none' : 'flex';

		nameInput.addEventListener('input', () => {
			this.fileName = nameInput.value;
			this.fileNameEdited = true;
		});
	}

	private populateFolderOptions(select: HTMLSelectElement): void {
		const folders = new Set<string>();

		if (this.app?.vault) {
			const allFiles = this.app.vault.getAllLoadedFiles();
			for (const file of allFiles) {
				if (file.children !== undefined && file.path) {
					folders.add(file.path);
				}
			}
		}

		folders.add(this.outputFolder);

		const sorted = Array.from(folders).sort((a, b) => a.localeCompare(b));
		for (const folder of sorted) {
			select.createEl('option', { text: folder, attr: { value: folder } });
		}
	}
}
