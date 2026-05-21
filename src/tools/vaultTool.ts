/**
 * Vault 工具 - 使用 Obsidian 原生 API 操作笔记库文件
 */

import { Tool, ToolResult, ToolCall } from './types';
import { isBinaryDocument, parseDocument } from '../documentReader';

export interface VaultToolOptions {
	app: any;
	allowedPaths?: string[]; // 允许操作的文件路径
}

export class VaultTool implements Tool {
	name = 'vault';
	description = '操作 Obsidian 笔记库中的文件';
	inputSchema: Tool['inputSchema'] = {
		type: 'object',
		properties: {
			operation: {
				type: 'string',
				enum: ['read', 'write', 'search', 'list', 'mkdir', 'delete', 'move', 'stat', 'get_properties', 'content_search'],
				description: '操作类型',
			},
			path: {
				type: 'string',
				description: '文件或文件夹路径（相对于笔记库根目录）',
			},
			destination: {
				type: 'string',
				description: '目标路径（用于 move 操作，相对于笔记库根目录）',
			},
			content: {
				type: 'string',
				description: '文件内容（用于 write 操作）',
			},
			query: {
				type: 'string',
				description: '搜索关键词（用于 search 操作）',
			},
		},
		required: ['operation'],
	};

	private app: any;
	private allowedPaths: string[];

	constructor(options: VaultToolOptions) {
		this.app = options.app;
		// 默认允许笔记库根目录
		this.allowedPaths = options.allowedPaths || [];
	}

	/**
	 * 检查路径是否在允许范围内
	 */
	private canAccess(path: string): boolean {
		if (this.allowedPaths.length === 0) {
			return true; // 没有限制则允许所有
		}

		const normalizedPath = this.normalizePath(path);
		return this.allowedPaths.some((allowed) => normalizedPath.startsWith(allowed));
	}

	/**
	 * 标准化路径
	 */
	private normalizePath(path: string | undefined): string {
		if (path == null) {
			console.error('[VaultTool] normalizePath received null/undefined path!');
			return '';
		}
		// 移除开头的斜杠
		return path.replace(/^\/+/, '').replace(/\\/g, '/');
	}

	/**
	 * 获取笔记库根目录
	 */
	private getVaultPath(): string {
		// @ts-ignore
		return this.app.vault.adapter.basePath;
	}

	/**
	 * 执行工具调用
	 */
	async execute(call: ToolCall): Promise<ToolResult> {
		if (!call.arguments) {
			return { success: false, error: 'call.arguments is undefined' };
		}
		const { operation, path, content, query, destination } = call.arguments;

		console.log('[VaultTool] execute, operation:', operation, 'path:', path);

		try {
			switch (operation) {
				case 'read':
					return await this.readFile(path);
				case 'write':
					return await this.writeFile(path, content);
				case 'search':
					return await this.searchFiles(query);
				case 'list':
					return await this.listFiles(path);
				case 'mkdir':
					return await this.createFolder(path);
				case 'delete':
					return await this.deleteFile(path);
				case 'move':
					return await this.moveFile(path, destination);
				case 'stat':
					return await this.getFileInfo(path);
				case 'get_properties':
					return await this.getProperties(path);
				case 'content_search':
					return await this.contentSearch(query);
				default:
					return { success: false, error: `Unknown operation: ${operation}` };
			}
		} catch (error: any) {
			console.error('[VaultTool] Error:', error);
			return { success: false, error: error.message };
		}
	}

	/**
	 * 读取文件
	 */
	private async readFile(filePath: string): Promise<ToolResult> {
		if (!filePath) {
			return { success: false, error: 'path is required' };
		}

		if (!this.canAccess(filePath)) {
			return { success: false, error: `Access denied: ${filePath}` };
		}

		try {
			const normalizedPath = this.normalizePath(filePath);
			const file = this.app.vault.getFileByPath(normalizedPath);

			if (!file) {
				return { success: false, error: `File not found: ${filePath}` };
			}

			const ext = file.extension?.toLowerCase() || '';

			// 二进制文档：使用共享解析器
			if (isBinaryDocument(ext)) {
				try {
					const buffer = await this.app.vault.readBinary(file);
					const result = await parseDocument(buffer, file.name, ext);
					return { success: true, content: result.content };
				} catch (error: any) {
					return { success: false, error: `读取文档失败: ${error.message}` };
				}
			}

			// 纯文本文件：直接读取
			const content = await this.app.vault.read(file);
			return { success: true, content };
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 写入文件（创建或修改）
	 */
	private async writeFile(filePath: string, content: string): Promise<ToolResult> {
		if (!filePath) {
			return { success: false, error: 'path is required' };
		}
		if (content === undefined) {
			return { success: false, error: 'content is required' };
		}

		if (!this.canAccess(filePath)) {
			return { success: false, error: `Access denied: ${filePath}` };
		}

		try {
			const normalizedPath = this.normalizePath(filePath);
			const existingFile = this.app.vault.getFileByPath(normalizedPath);

			// 处理 AI 输出的字面量 \n（替换为真正换行符）
			const normalizedContent = content
				.replace(/\\n/g, '\n')
				.replace(/\\r/g, '\r')
				.replace(/\\t/g, '\t');

			// 如果父目录不存在，自动创建
			const parentPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
			if (parentPath) {
				await this.ensureFolderExists(parentPath);
			}

			if (existingFile) {
				// 修改现有文件
				await this.app.vault.modify(existingFile, normalizedContent);
				return { success: true, content: `文件已更新: ${filePath}` };
			} else {
				// 创建新文件
				await this.app.vault.create(normalizedPath, normalizedContent);
				return { success: true, content: `文件已创建: ${filePath}` };
			}
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 确保文件夹存在（递归创建）
	 */
	private async ensureFolderExists(folderPath: string): Promise<void> {
		const normalizedPath = this.normalizePath(folderPath);
		const parts = normalizedPath.split('/').filter(p => p);

		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			// 检查文件夹是否已存在
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				// 文件夹不存在，创建它
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	/**
	 * 搜索文件
	 */
	private async searchFiles(query: string): Promise<ToolResult> {
		if (!query) {
			return { success: false, error: 'query is required' };
		}

		try {
			const files = this.app.vault.getFiles();
			const normalizedQuery = query.toLowerCase();
			const matched = files.filter((file: any) => {
				return (
					file.path.toLowerCase().includes(normalizedQuery) ||
					file.name.toLowerCase().includes(normalizedQuery)
				);
			});

			const results = matched.slice(0, 20).map((file: any) => ({
				path: file.path,
				name: file.name,
				type: file.extension,
			}));

			return {
				success: true,
				content: `找到 ${results.length} 个匹配结果:\n${results.map((r: any) => `- ${r.path}`).join('\n')}`,
				data: results,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 列出文件夹内容
	 */
	private async listFiles(folderPath?: string): Promise<ToolResult> {
		try {
			const normalizedPath = folderPath ? this.normalizePath(folderPath) : '';
			const allFiles = this.app.vault.getFiles();
			const folders = this.app.vault.getAllLoadedFiles();

			// 过滤指定目录下的内容
			const contents: { path: string; type: string }[] = [];
			const addedPaths = new Set<string>();

			for (const file of folders) {
				const filePath = (file as any).path;
				if (!filePath) continue;
				if (normalizedPath) {
					// 只显示直接子项
					const slashIdx = filePath.indexOf('/');
					const parentPath = slashIdx > 0 ? filePath.substring(0, slashIdx) : '';
					// 去除 normalizedPath 的尾部斜杠，避免 '1-收件箱' !== '1-收件箱/' 的问题
					const normalizedCompare = normalizedPath.replace(/\/$/, '');
					if (parentPath !== normalizedCompare) continue;
				} else {
					// 根目录，显示顶层文件和文件夹
					if (filePath.includes('/')) continue;
				}

				if (!addedPaths.has(filePath)) {
					addedPaths.add(filePath);
					contents.push({
						path: filePath,
						type: file instanceof this.app.vault.constructor ? 'folder' : 'file',
					});
				}
			}

			// 排序：文件夹在前，文件在后
			contents.sort((a, b) => {
				if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
				return a.path.localeCompare(b.path);
			});

			return {
				success: true,
				content: contents.map((c) => `${c.type === 'folder' ? '📁' : '📄'} ${c.path}`).join('\n'),
				data: contents,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 创建文件夹
	 */
	private async createFolder(folderPath: string): Promise<ToolResult> {
		if (!folderPath) {
			return { success: false, error: 'path is required' };
		}

		if (!this.canAccess(folderPath)) {
			return { success: false, error: `Access denied: ${folderPath}` };
		}

		try {
			const normalizedPath = this.normalizePath(folderPath);
			await this.app.vault.createFolder(normalizedPath);
			return { success: true, content: `文件夹已创建: ${folderPath}` };
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 删除文件
	 */
	private async deleteFile(filePath: string): Promise<ToolResult> {
		if (!filePath) {
			return { success: false, error: 'path is required' };
		}

		if (!this.canAccess(filePath)) {
			return { success: false, error: `Access denied: ${filePath}` };
		}

		try {
			const normalizedPath = this.normalizePath(filePath);
			const file = this.app.vault.getFileByPath(normalizedPath);

			if (!file) {
				return { success: false, error: `File not found: ${filePath}` };
			}

			await this.app.vault.delete(file);
			return { success: true, content: `文件已删除: ${filePath}` };
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 移动/重命名文件
	 */
	private async moveFile(fromPath: string, toPath: string): Promise<ToolResult> {
		if (!fromPath) {
			return { success: false, error: 'path is required' };
		}
		if (!toPath) {
			return { success: false, error: 'destination is required' };
		}

		if (!this.canAccess(fromPath) || !this.canAccess(toPath)) {
			return { success: false, error: `Access denied` };
		}

		try {
			const normalizedFrom = this.normalizePath(fromPath);
			const normalizedTo = this.normalizePath(toPath);

			const file = this.app.vault.getAbstractFileByPath(normalizedFrom);
			if (!file) {
				return { success: false, error: `File not found: ${fromPath}` };
			}

			// 确保目标目录存在
			const parentPath = normalizedTo.substring(0, normalizedTo.lastIndexOf('/'));
			if (parentPath) {
				await this.ensureFolderExists(parentPath);
			}

			// 使用 Obsidian fileManager.renameFile 以保持链接更新
			await this.app.fileManager.renameFile(file, normalizedTo);
			return { success: true, content: `文件已移动: ${fromPath} → ${toPath}` };
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 获取文件信息
	 */
	private async getFileInfo(filePath: string): Promise<ToolResult> {
		if (!filePath) {
			return { success: false, error: 'path is required' };
		}

		try {
			const normalizedPath = this.normalizePath(filePath);
			const file = this.app.vault.getFileByPath(normalizedPath);

			if (!file) {
				return { success: false, error: `File not found: ${filePath}` };
			}

			const info = {
				path: file.path,
				name: file.name,
				extension: file.extension,
				size: file.stat?.size || 0,
				created: file.stat?.ctime || 0,
				modified: file.stat?.mtime || 0,
			};

			return {
				success: true,
				content: `文件信息:\n- 路径: ${info.path}\n- 名称: ${info.name}\n- 类型: ${info.extension}\n- 大小: ${info.size} bytes\n- 创建: ${new Date(info.created).toLocaleString()}\n- 修改: ${new Date(info.modified).toLocaleString()}`,
				data: info,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 获取文件的 frontmatter 属性
	 */
	private async getProperties(filePath: string): Promise<ToolResult> {
		if (!filePath) {
			return { success: false, error: 'path is required' };
		}

		try {
			const normalizedPath = this.normalizePath(filePath);
			const file = this.app.vault.getFileByPath(normalizedPath);

			if (!file) {
				return { success: false, error: `File not found: ${filePath}` };
			}

			// 使用 metadataCache 读取 frontmatter
			const metadata = this.app.metadataCache.getFileCache(file);
			const frontmatter = metadata?.frontmatter || {};

			// 提取标签（包括正文中的标签）
			const tags: string[] = [];
			if (metadata?.tags) {
				for (const t of metadata.tags) {
					tags.push(t.tag);
				}
			}
			if (frontmatter.tags) {
				const fmTags = Array.isArray(frontmatter.tags)
					? frontmatter.tags
					: [frontmatter.tags];
				for (const t of fmTags) {
					const tagStr = String(t).startsWith('#') ? String(t) : `#${t}`;
					if (!tags.includes(tagStr)) {
						tags.push(tagStr);
					}
				}
			}

			// 提取链接
			const links: string[] = [];
			if (metadata?.links) {
				for (const l of metadata.links) {
					links.push(l.link);
				}
			}

			const result = {
				path: file.path,
				frontmatter,
				tags,
				links,
				headings: (metadata?.headings || []).map((h: any) => ({
					level: h.level,
					heading: h.heading,
				})),
			};

			return {
				success: true,
				content: JSON.stringify(result, null, 2),
				data: result,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 全文内容搜索
	 */
	private async contentSearch(query: string): Promise<ToolResult> {
		if (!query) {
			return { success: false, error: 'query is required' };
		}

		try {
			const files = this.app.vault.getMarkdownFiles();
			const normalizedQuery = query.toLowerCase();
			const results: Array<{
				path: string;
				name: string;
				matches: string[];
			}> = [];

			for (const file of files) {
				if (results.length >= 20) break;

				const content = await this.app.vault.cachedRead(file);
				const lowerContent = content.toLowerCase();

				if (lowerContent.includes(normalizedQuery)) {
					// 提取匹配行的上下文
					const lines = content.split('\n');
					const matchLines: string[] = [];
					for (let i = 0; i < lines.length; i++) {
						if (lines[i].toLowerCase().includes(normalizedQuery)) {
							matchLines.push(lines[i].trim());
							if (matchLines.length >= 3) break;
						}
					}

					results.push({
						path: file.path,
						name: file.name,
						matches: matchLines,
					});
				}
			}

			const summary = results
				.map((r) => `- ${r.path}\n  ${r.matches.map((m) => `  > ${m}`).join('\n')}`)
				.join('\n');

			return {
				success: true,
				content: `找到 ${results.length} 个匹配结果:\n${summary}`,
				data: results,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}

	/**
	 * 更新允许的路径
	 */
	setAllowedPaths(paths: string[]): void {
		this.allowedPaths = paths;
	}

	/**
	 * 获取允许的路径
	 */
	getAllowedPaths(): string[] {
		return this.allowedPaths;
	}
}
