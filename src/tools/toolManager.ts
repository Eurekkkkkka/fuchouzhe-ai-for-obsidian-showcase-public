/**
 * 工具管理器 - 统一调度所有工具
 */

import { Notice } from 'obsidian';
import { Tool, ToolResult, ToolCall, ToolManagerOptions } from './types';
import { MiniMaxMcpClient } from './minimaxMcpClient';
import { VaultTool } from './vaultTool';

export class ToolManager {
	private app: any;
	private mcpClient: MiniMaxMcpClient | null = null;
	private vaultTool: VaultTool;
	private enableMcp: boolean;
	private enableVault: boolean;
	private enableSkills: boolean;
	private vaultPath: string;
	// 保存 MCP 重建所需的固定参数
	private mcpImageLocalPath: string | undefined;
	private mcpApiProvider: 'minimax' | 'zhipin';
	private mcpApiKey: string;

	constructor(options: ToolManagerOptions) {
		this.app = options.app;
		this.enableMcp = options.enableMcp;
		this.enableVault = options.enableVault;
		this.enableSkills = options.enableSkills;
		this.mcpImageLocalPath = options.mcpImageLocalPath;
		this.mcpApiProvider = options.apiProvider;
		this.mcpApiKey = options.apiKey;

		// 获取 vault 根目录路径
		// @ts-ignore
		this.vaultPath = this.app.vault.adapter.basePath;

		// 初始化 Vault 工具
		this.vaultTool = new VaultTool({
			app: this.app,
		});

		// 初始化 MCP 客户端（不自动启动）
		this.initMcpClient();
	}

	/** 初始化或重建 MCP 客户端 */
	private initMcpClient(): void {
		if (this.mcpClient) {
			this.mcpClient.stop();
			this.mcpClient = null;
		}

		if (this.enableMcp && this.mcpApiProvider === 'minimax') {
			this.mcpClient = new MiniMaxMcpClient({
				apiKey: this.mcpApiKey,
				apiHost: 'https://api.minimaxi.com',
				basePath: this.mcpImageLocalPath,
				resourceMode: 'local',
				onError: (error) => {
					console.error('[ToolManager] MCP Error:', error);
				},
			});
		}
	}

	/**
	 * 启动 MCP 客户端
	 */
	async startMcp(): Promise<boolean> {
		if (!this.mcpClient) {
			console.warn('[ToolManager] MCP client not initialized — was it created in constructor?');
			new Notice('❌ MCP 启动失败：客户端未初始化，请确认当前使用 MiniMax 并已开启 MCP 开关');
			return false;
		}

		try {
			await this.mcpClient.start();
			new Notice('✅ MiniMax MCP 已连接');
			return true;
		} catch (error: any) {
			console.error('[ToolManager] Failed to start MCP:', error);
			new Notice(`❌ MCP 启动失败: ${error?.message || error}`);
			return false;
		}
	}

	/**
	 * 停止 MCP 客户端
	 */
	stopMcp(): void {
		if (this.mcpClient) {
			this.mcpClient.stop();
		}
	}

	/**
	 * 检查 MCP 是否就绪
	 */
	isMcpReady(): boolean {
		return this.mcpClient?.isReady() || false;
	}

	/**
	 * 执行工具调用
	 */
	async executeTool(call: ToolCall): Promise<ToolResult> {
		const { name } = call;

		// 判断是 MCP 工具还是 Vault 工具
		if (this.isMcpTool(name)) {
			return this.executeMcpTool(call);
		} else if (this.isVaultTool(name)) {
			return this.executeVaultTool(call);
		} else {
			return { success: false, error: `Unknown tool: ${name}` };
		}
	}

	/**
	 * 判断是否为 MCP 工具
	 */
	private isMcpTool(name: string): boolean {
		if (!this.mcpClient || !this.enableMcp) return false;
		const mcpTools = this.mcpClient.getTools();
		// 支持带 mcp_ 前缀和不带前缀的名称
		let checkName = name;
		if (name.startsWith('mcp_')) {
			checkName = name.substring(4);
		}
		return mcpTools.some((t) => t.name === checkName);
	}

	/**
	 * 判断是否为 Vault 工具
	 */
	private isVaultTool(name: string): boolean {
		if (!this.enableVault) return false;
		// 支持 vault_read, vault_write 等，也支持通用的 vault 工具名（带 operation 参数）
		const vaultTools = ['vault_read', 'vault_write', 'vault_search', 'vault_list', 'vault_mkdir', 'vault_delete', 'vault_move', 'vault_stat', 'vault_get_properties', 'vault_content_search', 'vault'];
		return vaultTools.includes(name);
	}

	/**
	 * 执行 MCP 工具
	 */
	private async executeMcpTool(call: ToolCall): Promise<ToolResult> {
		if (!this.mcpClient) {
			return { success: false, error: 'MCP client not available' };
		}

		const { name, arguments: args } = call;

		// 转换工具名称
		let toolName = name;
		let toolArgs = { ...args };

		// 如果是 vault_xxx 格式的 MCP 调用，转换
		if (name.startsWith('mcp_')) {
			toolName = name.substring(4); // 移除 mcp_ 前缀
		}

		// 修复 understand_image 工具的图片路径问题
		// 如果 image_source 是相对路径，转换为绝对路径
		if (toolName === 'understand_image' && toolArgs.image_source) {
			const imagePath = toolArgs.image_source as string;
			// 检查是否是相对路径（不是绝对路径，不以盘符或 / 开头）
			const isRelativePath = !imagePath.match(/^[A-Za-z]:|^\//);
			if (isRelativePath) {
				// 转换为 Windows 绝对路径
				const absolutePath = this.vaultPath + '\\' + imagePath.replace(/\//g, '\\');
				console.log('[ToolManager] Resolving image path:', imagePath, '->', absolutePath);
				toolArgs.image_source = absolutePath;
			}
		}

		return this.mcpClient.callTool(toolName, toolArgs);
	}

	/**
	 * 执行 Vault 工具
	 */
	private async executeVaultTool(call: ToolCall): Promise<ToolResult> {
		console.log('[ToolManager] executeVaultTool called, call.arguments:', JSON.stringify(call.arguments));
		if (!this.enableVault) {
			return { success: false, error: 'Vault tools disabled' };
		}

		const { name, arguments: args } = call;

		// 转换 vault_xxx 为 operation 格式
		const operationMap: Record<string, string> = {
			vault_read: 'read',
			vault_write: 'write',
			vault_search: 'search',
			vault_list: 'list',
			vault_mkdir: 'mkdir',
			vault_delete: 'delete',
			vault_move: 'move',
			vault_stat: 'stat',
			vault_get_properties: 'get_properties',
			vault_content_search: 'content_search',
		};

		// 获取操作名称：优先从映射表获取，否则从 args.operation 获取
		let operation = operationMap[name];
		if (!operation && args?.operation) {
			operation = args.operation;
		}

		if (!operation) {
			console.error('[ToolManager] executeVaultTool: operation still undefined! name:', name, 'args:', JSON.stringify(args));
			return { success: false, error: `Unknown vault operation: ${name}` };
		}

		console.log('[ToolManager] executeVaultTool: calling vaultTool.execute with operation:', operation);
		return await this.vaultTool.execute({ name: operation, arguments: { operation, ...args } });
	}

	/**
	 * 获取所有可用工具
	 */
	getAvailableTools(): Tool[] {
		const tools: Tool[] = [];

		// MCP 工具
		if (this.mcpClient && this.enableMcp) {
			const mcpTools = this.mcpClient.getTools();
			for (const t of mcpTools) {
				tools.push({
					name: `mcp_${t.name}`,
					description: t.description || '',
					inputSchema: {
						type: 'object',
						properties: t.inputSchema?.properties || {},
						required: t.inputSchema?.required || [],
					},
				});
			}
		}

		// Vault 工具
		if (this.enableVault) {
			tools.push(this.vaultTool);
		}

		return tools;
	}

	/**
	 * 获取 Vault 工具实例
	 */
	getVaultTool(): VaultTool {
		return this.vaultTool;
	}

	/**
	 * 更新配置
	 */
	updateConfig(options: Partial<ToolManagerOptions>): void {
		if (options.enableMcp !== undefined) {
			this.enableMcp = options.enableMcp;
		}
		if (options.enableVault !== undefined) {
			this.enableVault = options.enableVault;
		}
		if (options.enableSkills !== undefined) {
			this.enableSkills = options.enableSkills;
		}
		// 如果 API Key 或 Provider 变了，重建 MCP 客户端
		let needsRebuild = false;
		if (options.apiKey !== undefined && options.apiKey !== this.mcpApiKey) {
			this.mcpApiKey = options.apiKey;
			needsRebuild = true;
		}
		if (options.apiProvider !== undefined && options.apiProvider !== this.mcpApiProvider) {
			this.mcpApiProvider = options.apiProvider as 'minimax' | 'zhipin';
			needsRebuild = true;
		}
		if (needsRebuild) {
			this.initMcpClient();
		}
	}

	/**
	 * 获取 Skills 是否启用
	 */
	isSkillsEnabled(): boolean {
		return this.enableSkills;
	}

	/**
	 * 销毁
	 */
	dispose(): void {
		this.stopMcp();
	}
}
