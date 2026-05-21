/**
 * 工具系统类型定义
 */

// 工具结果
export interface ToolResult {
	success: boolean;
	content?: string;
	error?: string;
	data?: any;
}

// 工具调用请求
export interface ToolCall {
	name: string;
	arguments: Record<string, any>;
}

// 工具定义
export interface Tool {
	name: string;
	description: string;
	inputSchema: ToolSchema;
}

// JSON Schema for tool input
export interface ToolSchema {
	type: 'object';
	properties: Record<string, ToolProperty>;
	required?: string[];
}

export interface ToolProperty {
	type: string;
	description?: string;
	default?: any;
	enum?: string[];
}

// MCP JSON-RPC 类型
export interface MCPRequest {
	jsonrpc: '2.0';
	id: number;
	method: string;
	params?: any;
}

export interface MCPResponse {
	jsonrpc: '2.0';
	id: number;
	result?: any;
	error?: { code: number; message: string };
}

// MCP 通知
export interface MCPNotification {
	jsonrpc: '2.0';
	method: string;
	params?: any;
}

// MCP 工具
export interface MCPTool {
	name: string;
	description?: string;
	inputSchema: {
		type: 'object';
		properties: Record<string, any>;
		required?: string[];
	};
}

// 工具管理器选项
export interface ToolManagerOptions {
	app: any;
	apiKey: string;
	apiProvider: 'minimax' | 'zhipin';
	enableMcp: boolean;
	enableVault: boolean;
	enableSkills: boolean;
	mcpImageLocalPath?: string;
}

// API Provider 配置
export interface APIProviderConfig {
	provider: 'minimax' | 'zhipin';
	apiKey: string;
	baseUrl: string;
	model: string;
}
