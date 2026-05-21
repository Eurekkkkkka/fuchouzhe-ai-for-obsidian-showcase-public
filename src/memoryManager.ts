/**
 * 记忆管理器 - 长期记忆系统
 * 负责加载、截断、保存用户记忆文档
 */

import { App, TFile } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';

export interface MemoryEntry {
	content: string;
	timestamp: number;
	source?: 'auto' | 'manual';
}

export interface MemoryManagerOptions {
	app: App;
	budget?: number;       // token 预算，默认 4096
	filePath?: string;      // 记忆文件路径（vault 相对路径，如 .fuchouzhe/memory.md）
}

export class MemoryManager {
	private app: App;
	private budget: number;
	private filePath: string;
	private memoryContent: string = '';
	private lastModified: number = 0;

	constructor(options: MemoryManagerOptions) {
		this.app = options.app;
		this.budget = options.budget ?? 4096;
		// 统一存 vault 相对路径，后续用 adapter 处理路径转换
		this.filePath = options.filePath ?? '.fuchouzhe/memory.md';
	}

	/**
	 * 估算字符串的 token 数（粗略：中文≈1.5字符/token，英文≈4字符/token）
	 */
	estimateTokens(text: string): number {
		let tokens = 0;
		for (const char of text) {
			if (char.charCodeAt(0) > 127) {
				tokens += 1.5; // 中文
			} else {
				tokens += 0.25; // 英文/符号
			}
		}
		return Math.ceil(tokens);
	}

	/**
	 * 获取 vault 根目录的 OS 原生路径
	 */
	private getVaultDir(): string {
		// @ts-ignore
		return this.app.vault.adapter.basePath;
	}

	/**
	 * 加载记忆文件内容
	 */
	async load(): Promise<string> {
		try {
			const file = this.app.vault.getAbstractFileByPath(this.filePath);
			if (file instanceof TFile) {
				const stat = file.stat.mtime;
				if (stat === this.lastModified && this.memoryContent) {
					return this.memoryContent; // 未变，直接返回缓存
				}
				this.memoryContent = await this.app.vault.read(file);
				this.lastModified = stat;
				console.log('[MemoryManager] Loaded memory:', this.memoryContent.length, 'chars, ~', this.estimateTokens(this.memoryContent), 'tokens');
				return this.memoryContent;
			}
			this.memoryContent = '';
			return '';
		} catch (error: any) {
			if (error.status === 404 || error.message?.includes('not found')) {
				this.memoryContent = '';
				return '';
			}
			console.error('[MemoryManager] Failed to load memory:', error);
			return '';
		}
	}

	/**
	 * 获取记忆内容用于上下文注入（自动截断到预算内）
	 */
	async getMemoryContext(): Promise<string> {
		const content = await this.load();
		if (!content.trim()) return '';

		const tokens = this.estimateTokens(content);
		if (tokens <= this.budget) return content;

		return this.truncateToBudget(content);
	}

	/**
	 * 将内容截断到 budget tokens 内
	 * 策略：保留头部内容（重要性递减）
	 */
	private truncateToBudget(text: string): string {
		const sections = text.split(/(?=^#)/m);
		const result: string[] = [];
		let totalTokens = 0;

		for (const section of sections) {
			const sectionTokens = this.estimateTokens(section);
			if (totalTokens + sectionTokens <= this.budget * 0.9) {
				result.push(section);
				totalTokens += sectionTokens;
			} else {
				const remaining = this.budget * 0.9 - totalTokens;
				if (remaining > 200) {
					const charsToKeep = Math.floor(remaining * (text.includes('\n') ? 3 : 4));
					result.push(section.substring(0, charsToKeep) + '\n...');
				}
				break;
			}
		}

		const truncated = result.join('\n');
		console.log(`[MemoryManager] Truncated memory: ${this.estimateTokens(text)} → ${this.estimateTokens(truncated)} tokens`);
		return truncated;
	}

	/**
	 * 保存记忆内容（直接覆盖文件）
	 * @returns 创建/修改后的 TFile，若失败返回 null
	 */
	async save(content: string): Promise<TFile | null> {
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		if (file instanceof TFile) {
			// 文件存在，用 modify
			await this.app.vault.modify(file, content);
		} else {
			// 文件不存在，先确保目录存在，再用 vault.create 创建
			const dirPath = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
			if (dirPath) {
				try {
					await this.app.vault.createFolder(dirPath);
				} catch (folderErr: any) {
					if (folderErr.status !== 400 && !folderErr.message?.includes('already exists')) {
						throw folderErr;
					}
				}
			}
			// 用 fs 写文件（绕过 vault 缓存不一致问题），再通知 vault 扫描
			const fullPath = path.join(this.getVaultDir(), ...this.filePath.split('/'));
			await fs.promises.writeFile(fullPath, content, 'utf-8');
			// 通知 vault 扫描新创建的文件（使其进入 vault 缓存）
			// @ts-ignore - internal API
			if (this.app.vault.onCreate) {
				// @ts-ignore
				this.app.vault.onCreate({ path: this.filePath });
			}
		}
		this.memoryContent = content;
		this.lastModified = Date.now();
		console.log('[MemoryManager] Saved memory:', content.length, 'chars');

		const savedFile = this.app.vault.getAbstractFileByPath(this.filePath);
		return savedFile instanceof TFile ? savedFile : null;
	}

	/**
	 * 追加记忆条目（追加到文件末尾）
	 */
	async append(entry: string): Promise<void> {
		const current = await this.load();
		const separator = current ? '\n\n---\n\n' : '';
		const newContent = current + separator + entry;
		await this.save(newContent);
	}

	/**
	 * 解析记忆文件中的条目（按分隔符拆分）
	 */
	async getEntries(): Promise<MemoryEntry[]> {
		const content = await this.load();
		if (!content.trim()) return [];

		const parts = content.split(/(?:^---$)/m);
		const entries: MemoryEntry[] = [];

		for (const part of parts) {
			const trimmed = part.trim();
			if (!trimmed) continue;
			entries.push({
				content: trimmed,
				timestamp: Date.now(),
				source: 'auto',
			});
		}
		return entries;
	}

	/**
	 * 检查记忆文件是否存在
	 */
	async exists(): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		return file instanceof TFile;
	}

	/**
	 * 获取当前记忆文件的 token 估算
	 */
	async getCurrentTokens(): Promise<number> {
		const content = await this.load();
		return this.estimateTokens(content);
	}

	/**
	 * 获取记忆文件状态摘要（同步，使用缓存）
	 */
	getStatus(): { exists: boolean; tokens: number; budget: number; path: string } {
		return {
			exists: !!this.memoryContent || false,
			tokens: this.estimateTokens(this.memoryContent),
			budget: this.budget,
			path: this.filePath,
		};
	}

	/**
	 * 打开记忆文件（让用户在编辑器中查看/编辑）
	 */
	async openInEditor(): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(this.filePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf(true).openFile(file);
			} else {
				// vault 缓存不知道 fs 创建的文件，用 Node.js shell.openPath 直接打开（不走 vault 路径解析）
				const fullPath = path.join(this.getVaultDir(), ...this.filePath.split('/'));
				// @ts-ignore
				this.app.shell.openPath(fullPath);
			}
		} catch (error) {
			console.error('[MemoryManager] Failed to open memory file:', error);
		}
	}

	/** 更新 token 预算 */
	setBudget(tokens: number): void {
		this.budget = tokens;
	}
}
