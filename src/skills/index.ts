/**
 * Skills 管理器
 * 从 .agent/skills/ 目录加载 MD 文件格式的 Skills
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SkillDefinition {
	id: string;
	name: string;
	description: string;
	triggers: string[];        // 触发关键词
	systemPrompt: string;      // 系统提示词
	userPromptTemplate?: string; // 用户提示词模板
	visibility: 'user' | 'internal'; // user = 可被用户消息触发, internal = 仅 pipeline 内部调用
}

export interface SkillContext {
	userMessage: string;
	currentFile?: string;
	date: string;
	time: string;
	vaultPath: string;
}

export class SkillManager {
	private skills: Map<string, SkillDefinition> = new Map();
	private app: any;
	private vaultPath: string = '';
	private loaded: boolean = false;

	constructor(app?: any) {
		this.app = app;
		if (app) {
			// @ts-ignore
			this.vaultPath = app.vault.adapter.basePath;
		}
	}

	/**
	 * 重新扫描 Skills 文件夹（强制刷新）
	 */
	reloadSkills(): void {
		this.loaded = false;
		this.skills.clear();
		this.loadSkills();
	}

	/**
	 * 加载所有 Skills（从 .agent/skills/ 目录）
	 * 注意：.agent 是隐藏文件夹，Obsidian vault API 不暴露它，使用 Node.js fs 直接读取
	 */
	async loadSkills(): Promise<void> {
		if (this.loaded || !this.app) return;

		const skillsPath = '.agent/skills';
		console.debug('[SkillManager] Loading skills from:', skillsPath);

		try {
			// 使用 Node.js fs 读取隐藏文件夹（Obsidian vault API 不支持）
			// @ts-ignore
			const vaultBasePath = this.app.vault.adapter.basePath;
			const fullSkillsPath = path.join(vaultBasePath, skillsPath);

			if (!fs.existsSync(fullSkillsPath)) {
				console.debug('[SkillManager] Skills folder not found:', fullSkillsPath);
				this.loaded = true;
				return;
			}

			// 读取 skills 目录下的一级子文件夹
			const entries = fs.readdirSync(fullSkillsPath, { withFileTypes: true });
			const skillFolders = entries.filter(e => e.isDirectory());

			for (const entry of skillFolders) {
				const skillName = entry.name;
				const skillFilePath = path.join(fullSkillsPath, skillName, 'SKILL.md');

				try {
					if (!fs.existsSync(skillFilePath)) {
						continue;
					}

					const content = fs.readFileSync(skillFilePath, 'utf-8');
					const skill = this.parseSkillFile(content, skillName);
					if (skill) {
						this.skills.set(skill.id, skill);
					}
				} catch (e) {
					console.warn('[SkillManager] Failed to load skill:', skillName, e);
				}
			}

			this.loaded = true;
			console.debug('[SkillManager] Total skills loaded:', this.skills.size);
		} catch (e) {
			console.error('[SkillManager] Failed to load skills:', e);
		}
	}

	/**
	 * 解析 SKILL.md 文件
	 */
	private parseSkillFile(content: string, skillName: string): SkillDefinition | null {
		// 解析 YAML frontmatter
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

		if (!frontmatterMatch) {
			console.debug('[SkillManager] Skill file missing frontmatter:', skillName);
			return null;
		}

		const [, frontmatterStr, body] = frontmatterMatch;
		const frontmatter: Record<string, any> = {};

		// 解析 YAML frontmatter（支持多行文本 | 和 >）
		const lines = frontmatterStr.split('\n');
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			const colonIndex = line.indexOf(':');

			if (colonIndex === -1) {
				i++;
				continue;
			}

			const key = line.substring(0, colonIndex).trim();
			let value = line.substring(colonIndex + 1).trim();

			// 如果值以 | 或 > 开头，说明是多行文本
			if (value === '|' || value === '>') {
				// 收集所有缩进的行作为多行值
				const multilineLines: string[] = [];
				i++;
				while (i < lines.length) {
					const nextLine = lines[i];
					// 检查是否仍是缩进的（多行值的一部分）
					if (nextLine.match(/^\s+\S/)) {
						multilineLines.push(nextLine.replace(/^\s+/, ''));
						i++;
					} else {
						break;
					}
				}
				frontmatter[key] = multilineLines.join('\n');
				// 不在这里 i++，让外层循环处理当前行（非缩进）
				continue;
			}

			// 空值可能是数组，跟随的缩进行
			if (value === '') {
				// 检查是否是数组（下一行是缩进的 - 开头）
				const nextLine = lines[i + 1] || '';
				if (nextLine.match(/^\s+-/)) {
					const arrayLines: string[] = [];
					i++;
					while (i < lines.length) {
						const arrLine = lines[i];
						if (arrLine.match(/^\s+-\s*(.*)/)) {
							arrayLines.push(arrLine.replace(/^\s+-\s*/, '').replace(/^["']|["']$/g, ''));
							i++;
						} else {
							break;
						}
					}
					frontmatter[key] = arrayLines;
					// 不在这里 i++，让外层循环处理当前行
					continue;
				}
				i++;
				continue;
			}

			// 处理引号包裹的值
			if ((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			frontmatter[key] = value;
			i++;
		}

		const name = frontmatter.name || skillName;
		const triggers = frontmatter.triggers || [name];
		const description = frontmatter.description || '';

		// 将 triggers 转换为数组（如果它是逗号分隔的字符串）
		const triggersArray = Array.isArray(triggers)
			? triggers
			: String(triggers).split(',').map((t: string) => t.trim());

		return {
			id: `skill-${skillName}`,
			name,
			description,
			triggers: triggersArray,
			systemPrompt: frontmatter.systemPrompt || body.trim(),
			userPromptTemplate: frontmatter.userPromptTemplate || undefined,
			visibility: (frontmatter.visibility === 'internal') ? 'internal' : 'user',
		};
	}

	/**
	 * 检测用户消息是否触发某个 Skill（仅匹配 visibility: user 的 skill）
	 */
	detectSkill(userMessage: string): SkillDefinition | null {
		const lowerMessage = userMessage.toLowerCase();

		for (const skill of this.skills.values()) {
			if (skill.visibility === 'internal') continue;

			for (const trigger of skill.triggers) {
				if (lowerMessage.includes(trigger.toLowerCase())) {
					return skill;
				}
			}
		}

		return null;
	}

	/**
	 * 获取所有 Skills
	 */
	getAllSkills(): SkillDefinition[] {
		return Array.from(this.skills.values());
	}

	/**
	 * 根据 ID 获取 Skill
	 */
	getSkill(id: string): SkillDefinition | undefined {
		return this.skills.get(id);
	}

	/**
	 * 根据文件夹名获取 Skill（用于 pipeline 精确查找）
	 */
	getSkillByFolderName(folderName: string): SkillDefinition | undefined {
		return this.skills.get(`skill-${folderName}`);
	}

	/**
	 * 构建 Skill 的完整提示词
	 */
	buildPrompt(skill: SkillDefinition, context: SkillContext): { systemPrompt: string; userPrompt: string } {
		let userPrompt = skill.userPromptTemplate || context.userMessage || '';

		// 替换模板变量
		userPrompt = userPrompt
			.replace(/\{\{date\}\}/g, context.date || '')
			.replace(/\{\{time\}\}/g, context.time || '')
			.replace(/\{\{currentFile\}\}/g, context.currentFile || '')
			.replace(/\{\{userMessage\}\}/g, context.userMessage || '')
			.replace(/\{\{vaultPath\}\}/g, context.vaultPath || '');

		return {
			systemPrompt: skill.systemPrompt,
			userPrompt
		};
	}
}
