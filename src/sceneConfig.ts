/**
 * 场景配置数据层 v2
 * 从"6 个领域 + pipeline 配置"改为"分类 + 动作"模型
 * 用户选动作即执行，不再手动勾选 skill
 */

// ============ 类型定义 ============

export type CategoryId = 'daily' | 'content';

export type InputRequirement = 'text' | 'file' | 'text_or_file';

export interface CategoryConfig {
	id: CategoryId;
	name: string;
	icon: string;
	order: number;
}

export interface ActionConfig {
	id: string;
	name: string;
	icon: string;
	description: string;
	category: CategoryId;
	requiredInput: InputRequirement;
	/** 按顺序执行的 skill id 列表 */
	pipeline: string[];
	/** 可由用户关闭的 skill id 列表（不在此列表中的为必选） */
	optionalSkills?: string[];
	/** 默认输出文件夹 */
	defaultOutputFolder: string;
	/** 默认文件名模板，支持 {{date}} {{year}} {{month}} {{title}} */
	defaultFileName: string;
	/** 默认输出路径（由 folder + fileName + .md 组合，向后兼容） */
	defaultOutputPath: string;
	/** skill id → 输出笔记中的 section 标题 */
	sectionMap: Record<string, string>;
	/** 每个 pipeline skill 的用户友好进度文案 */
	stepLabels: Record<string, string>;
	/** 每个 pipeline skill 的用户友好名称（用于配置面板显示） */
	skillLabels?: Record<string, string>;
	/** 自然语言触发关键词（用于从聊天中检测意图） */
	keywords?: string[];
	/** 输入示例（显示在任务简报卡片中，可点击填入输入框） */
	examples?: string[];
	/** 点击「开始」后自动执行的内置提示词（跳过用户输入步骤） */
	autoExecutePrompt?: string;
	/** 用户空输入时的默认提示词（仍展示简报卡片，但空输入自动填入） */
	defaultPrompt?: string;
}

export interface PipelineContext {
	actionId: string;
	input: string;
	attachments: string[];
	/** 附件解析后的文本内容（文件路径 → 解析内容） */
	attachmentContents: Map<string, string>;
	outputPath: string;
	/** 用户是否手动编辑过文件名 */
	fileNameEdited: boolean;
	/** pipeline 中每个 skill 的执行结果 */
	skillResults: Map<string, string | null>;
}

export function createPipelineContext(
	action: ActionConfig,
	input: string,
	attachments: string[] = [],
	options?: { outputFolder?: string; fileName?: string; fileNameEdited?: boolean; autoFilename?: boolean },
): PipelineContext {
	const folder = options?.outputFolder ?? action.defaultOutputFolder;
	const fileName = options?.fileName ?? resolveTemplatePath(action.defaultFileName);
	const outputPath = `${folder}/${fileName}.md`;
	// autoFilename 为 true 时，让 pipeline 使用 skill 输出的文件名（fileNameEdited = false）
	const fileNameEdited = options?.autoFilename ? false : (options?.fileNameEdited ?? false);
	return {
		actionId: action.id,
		input,
		attachments,
		attachmentContents: new Map(),
		outputPath,
		fileNameEdited,
		skillResults: new Map(),
	};
}

export function resolveTemplatePath(template: string): string {
	const now = new Date();
	const yyyy = String(now.getFullYear());
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	const dd = String(now.getDate()).padStart(2, '0');
	return template
		.replace(/\{\{date\}\}/g, `${yyyy}-${mm}-${dd}`)
		.replace(/\{\{year\}\}/g, yyyy)
		.replace(/\{\{month\}\}/g, `${yyyy}-${mm}`);
}

/** 组合文件夹 + 文件名为完整路径 */
export function composeOutputPath(folder: string, fileName: string): string {
	return `${folder}/${fileName}.md`;
}

// ============ 分类定义 ============

export const CATEGORIES: CategoryConfig[] = [
	{ id: 'daily',   name: '日常',       icon: '☀️', order: 1 },
	{ id: 'content', name: '自媒体创作', icon: '✍️', order: 2 },
];

// ============ 动作配置 ============

export const ACTION_CONFIGS: ActionConfig[] = [

	// ── 日常 ──

	{
		id: 'morning-start',
		name: '开始一天',
		icon: '🌅',
		description: '晨间日程 + 待办汇总',
		category: 'daily',
		requiredInput: 'text',
		keywords: ['开始一天', '晨间', '早安', '今天计划', '日程'],
		examples: ['帮我汇总今天的日程和待办'],
		defaultPrompt: '帮我汇总今天的日常和待办',
		pipeline: ['start-my-day', 'writeback-output'],
		defaultOutputFolder: '2-日记',
		defaultFileName: '{{date}}_晨间',
		defaultOutputPath: '2-日记/{{date}}_晨间.md',
		sectionMap: {
			'start-my-day': '## 今日待办',
		},
		stepLabels: {
			'start-my-day': '正在汇总今日日程...',
			'writeback-output': '正在保存...',
		},
	},
	{
		id: 'ai-news',
		name: 'AI资讯',
		icon: '🤖',
		description: '搜索最新AI/科技/商业资讯',
		category: 'daily',
		requiredInput: 'text',
		keywords: ['AI资讯', '科技新闻', '最新资讯', 'AI新闻'],
		examples: ['帮我搜索今天的AI资讯'],
		autoExecutePrompt: '帮我搜索今天的AI资讯',
		pipeline: ['websearch-news', 'writeback-output'],
		defaultOutputFolder: '7-资源/资讯',
		defaultFileName: 'AI资讯_{{date}}',
		defaultOutputPath: '7-资源/资讯/AI资讯_{{date}}.md',
		sectionMap: {
			'websearch-news': '## AI资讯',
		},
		stepLabels: {
			'websearch-news': '正在搜索AI资讯...',
			'writeback-output': '正在保存...',
		},
	},
	{
		id: 'finance-today',
		name: '今日财经',
		icon: '📈',
		description: '当日财经要闻与市场行情',
		category: 'daily',
		requiredInput: 'text',
		keywords: ['财经', '行情', '股市', '市场', '今日财经'],
		examples: ['帮我看看今天的财经要闻'],
		autoExecutePrompt: '帮我看看今天的财经新闻',
		pipeline: ['websearch-finance', 'writeback-output'],
		defaultOutputFolder: '7-资源/资讯',
		defaultFileName: '财经_{{date}}',
		defaultOutputPath: '7-资源/资讯/财经_{{date}}.md',
		sectionMap: {
			'websearch-finance': '## 今日财经',
		},
		stepLabels: {
			'websearch-finance': '正在抓取财经资讯...',
			'writeback-output': '正在保存...',
		},
	},
	{
		id: 'archive-organize',
		name: '归档整理',
		icon: '📦',
		description: '将散乱笔记归档到知识库',
		category: 'daily',
		requiredInput: 'text_or_file',
		keywords: ['归档', '整理', '归类', '知识库'],
		examples: ['帮我把这些笔记归档整理'],
		pipeline: ['archive-ingest', 'archive-classifier', 'archive-linker', 'writeback-output'],
		defaultOutputFolder: '8-归档',
		defaultFileName: '归档_{{date}}',
		defaultOutputPath: '8-归档/归档_{{date}}.md',
		sectionMap: {
			'archive-ingest': '## 内容摘要',
			'archive-classifier': '## 分类归档',
			'archive-linker': '## 知识关联',
		},
		stepLabels: {
			'archive-ingest': '正在读取内容...',
			'archive-classifier': '正在分类归档...',
			'archive-linker': '正在关联知识库...',
			'writeback-output': '正在保存...',
		},
	},

	// ── 自媒体创作 ──

	{
		id: 'viral-script',
		name: '爆款文案',
		icon: '🔥',
		description: '生成有传播力的短视频/推文文案',
		category: 'content',
		requiredInput: 'text',
		keywords: ['爆款', '文案', '短视频', '脚本', '推文', '传播'],
		examples: ['帮我写一个关于AI工具的爆款短视频脚本'],
		pipeline: ['viral-script', 'dbs-content', 'writeback-output'],
		optionalSkills: ['dbs-content'],
		skillLabels: {
			'viral-script': '生成脚本',
			'dbs-content': '内容诊断',
			'writeback-output': '保存',
		},
		defaultOutputFolder: '6-知识库/内容创作',
		defaultFileName: '爆款文案_{{date}}',
		defaultOutputPath: '6-知识库/内容创作/爆款文案_{{date}}.md',
		sectionMap: {
			'viral-script': '## 爆款脚本',
			'dbs-content': '## 内容诊断',
		},
		stepLabels: {
			'viral-script': '正在生成爆款脚本...',
			'dbs-content': '正在进行内容诊断...',
			'writeback-output': '正在保存...',
		},
	},
	{
		id: 'improve-hook',
		name: '改善开头',
		icon: '🎬',
		description: '优化视频/文章开头，提升完播率/打开率',
		category: 'content',
		requiredInput: 'text',
		keywords: ['开头', '优化开头', '完播率', '打开率', 'hook'],
		examples: ['帮我优化这个视频的开头'],
		pipeline: ['dbs-hook', 'writeback-output'],
		defaultOutputFolder: '6-知识库/内容创作',
		defaultFileName: '改善开头_{{date}}',
		defaultOutputPath: '6-知识库/内容创作/改善开头_{{date}}.md',
		sectionMap: {
			'dbs-hook': '## 开头优化',
		},
		stepLabels: {
			'dbs-hook': '正在诊断并优化开头...',
			'writeback-output': '正在保存...',
		},
	},
	{
		id: 'de-ai-flavor',
		name: '去AI味',
		icon: '🫧',
		description: '将AI生成文本改写得更自然、口语化',
		category: 'content',
		requiredInput: 'text',
		keywords: ['去AI味', '太AI了', '口语化', '自然', '人味'],
		examples: ['帮我把这段文字改得更自然一些'],
		pipeline: ['ljg-plain', 'writeback-output'],
		defaultOutputFolder: '6-知识库/内容创作',
		defaultFileName: '去AI味_{{date}}',
		defaultOutputPath: '6-知识库/内容创作/去AI味_{{date}}.md',
		sectionMap: {
			'ljg-plain': '## 去AI味改写',
		},
		stepLabels: {
			'ljg-plain': '正在重写为自然语言...',
			'writeback-output': '正在保存...',
		},
	},
	{
		id: 'benchmark-explore',
		name: '对标探索',
		icon: '🔬',
		description: '找同类爆款，分析结构规律',
		category: 'content',
		requiredInput: 'text',
		keywords: ['对标', '爆款分析', '对标探索', '结构分析'],
		examples: ['帮我分析这个爆款视频的结构规律'],
		pipeline: ['dbs-benchmark', 'writeback-output'],
		defaultOutputFolder: '6-知识库/对标分析',
		defaultFileName: '对标分析_{{date}}',
		defaultOutputPath: '6-知识库/对标分析/对标分析_{{date}}.md',
		sectionMap: {
			'dbs-benchmark': '## 对标分析',
		},
		stepLabels: {
			'dbs-benchmark': '正在分析对标内容...',
			'writeback-output': '正在保存...',
		},
	},
	{
		id: 'content-card',
		name: '卡片制作',
		icon: '🎨',
		description: '把内容转成可视化卡片',
		category: 'content',
		requiredInput: 'text',
		keywords: ['卡片', '可视化', '做卡片', '内容卡片'],
		examples: ['帮我把这段内容做成一张卡片'],
		pipeline: ['ljg-card', 'writeback-output'],
		defaultOutputFolder: '6-知识库/内容创作',
		defaultFileName: '内容卡片_{{date}}',
		defaultOutputPath: '6-知识库/内容创作/内容卡片_{{date}}.md',
		sectionMap: {
			'ljg-card': '## 可视化卡片',
		},
		stepLabels: {
			'ljg-card': '正在生成可视化卡片...',
			'writeback-output': '正在保存...',
		},
	},
	{
		id: 'writing-engine',
		name: '写作引擎',
		icon: '✏️',
		description: '带着观点写深度文章',
		category: 'content',
		requiredInput: 'text',
		keywords: ['写作', '写文章', '深度文章', '写作引擎'],
		examples: ['帮我围绕这个观点写一篇深度文章'],
		pipeline: ['ljg-writes', 'writeback-output'],
		defaultOutputFolder: '6-知识库/深度文章',
		defaultFileName: '文章_{{date}}',
		defaultOutputPath: '6-知识库/深度文章/文章_{{date}}.md',
		sectionMap: {
			'ljg-writes': '## 深度文章',
		},
		stepLabels: {
			'ljg-writes': '正在深度写作...',
			'writeback-output': '正在保存...',
		},
	},
];

// ============ 查询函数 ============

export function getActionConfig(id: string): ActionConfig | undefined {
	return ACTION_CONFIGS.find(a => a.id === id);
}

export function getActionsByCategory(categoryId: CategoryId): ActionConfig[] {
	return ACTION_CONFIGS.filter(a => a.category === categoryId);
}

export function getCategoryConfig(id: CategoryId): CategoryConfig | undefined {
	return CATEGORIES.find(c => c.id === id);
}

/**
 * 从用户自然语言中检测匹配的动作
 * 返回匹配度最高的动作（匹配关键词数最多的）
 */
export function detectAction(userMessage: string): ActionConfig | null {
	const lower = userMessage.toLowerCase();
	let bestMatch: ActionConfig | null = null;
	let bestScore = 0;

	for (const action of ACTION_CONFIGS) {
		if (!action.keywords || action.keywords.length === 0) continue;

		let score = 0;
		for (const kw of action.keywords) {
			if (lower.includes(kw.toLowerCase())) {
				score++;
			}
		}

		if (score > bestScore) {
			bestScore = score;
			bestMatch = action;
		}
	}

	// 至少匹配 1 个关键词才返回
	return bestScore >= 1 ? bestMatch : null;
}
