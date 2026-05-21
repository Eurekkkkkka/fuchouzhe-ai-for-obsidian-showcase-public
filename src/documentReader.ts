/**
 * 文档解析器 - 统一处理二进制文档（Excel、Word）的读取
 * 供 chatView 附件系统和 vaultTool 共用
 */

import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import WordExtractor from 'word-extractor';

/** 二进制文档扩展名 */
const BINARY_DOC_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xls', 'docx', 'doc']);

/** 文档解析结果 */
export interface DocumentParseResult {
	content: string;       // 解析后的文本内容
	summary: string;       // 简要摘要（用于 UI 预览）
	icon: string;          // 文件类型图标
	type: 'excel' | 'word' | 'text';
}

/**
 * 判断文件是否为需要特殊解析的二进制文档
 */
export function isBinaryDocument(ext: string): boolean {
	return BINARY_DOC_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * 获取文件类型图标
 */
export function getFileIcon(ext: string): string {
	switch (ext.toLowerCase()) {
		case 'xlsx': case 'xlsm': case 'xls':
			return '📊';
		case 'docx': case 'doc':
			return '📝';
		case 'pdf':
			return '📕';
		case 'md':
			return '📋';
		default:
			return '📄';
	}
}

/**
 * 读取并解析文档文件
 * @param buffer 文件的二进制数据
 * @param fileName 文件名
 * @param ext 文件扩展名
 */
export async function parseDocument(buffer: ArrayBuffer, fileName: string, ext: string): Promise<DocumentParseResult> {
	const lowerExt = ext.toLowerCase();

	switch (lowerExt) {
		case 'xlsx': case 'xlsm': case 'xls':
			return parseExcel(buffer, fileName);
		case 'docx':
			return parseDocx(buffer, fileName);
		case 'doc':
			return parseDoc(buffer, fileName);
		default:
			throw new Error(`不支持的文档格式: ${ext}`);
	}
}

/**
 * 解析 Excel 文件
 */
async function parseExcel(buffer: ArrayBuffer, fileName: string): Promise<DocumentParseResult> {
	const workbook = XLSX.read(buffer, { type: 'array' });

	const lines: string[] = [];
	let totalRows = 0;
	let totalCols = 0;

	for (const sheetName of workbook.SheetNames) {
		const sheet = workbook.Sheets[sheetName];
		const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

		lines.push(`\n--- 工作表: ${sheetName} ---`);
		lines.push(`行数: ${jsonData.length}`);
		totalRows += jsonData.length;

		if (jsonData.length === 0) {
			lines.push('(空工作表)');
			continue;
		}

		const headers = jsonData[0] || [];
		totalCols = Math.max(totalCols, headers.length);
		lines.push(`列数: ${headers.length}`);
		lines.push(`列名: ${headers.join(' | ')}`);

		// Markdown 表格预览（最多 50 行）
		const maxRows = Math.min(jsonData.length, 51);
		lines.push('');
		lines.push('| ' + headers.map((h: any) => String(h ?? '')).join(' | ') + ' |');
		lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');

		for (let i = 1; i < maxRows; i++) {
			const row = jsonData[i] || [];
			const cells = headers.map((_: any, idx: number) => String(row[idx] ?? ''));
			lines.push('| ' + cells.join(' | ') + ' |');
		}

		if (jsonData.length > 51) {
			lines.push(`\n... 还有 ${jsonData.length - 51} 行未显示`);
		}
	}

	const sheetCount = workbook.SheetNames.length;
	const summary = `${sheetCount} 个工作表, ${totalRows} 行 × ${totalCols} 列`;

	return {
		content: `📊 Excel 文件: ${fileName}\n工作表: ${workbook.SheetNames.join(', ')}\n${lines.join('\n')}`,
		summary,
		icon: '📊',
		type: 'excel',
	};
}

/**
 * 解析 Word 文档 (.docx)
 */
async function parseDocx(buffer: ArrayBuffer, fileName: string): Promise<DocumentParseResult> {
	const result = await mammoth.extractRawText({ arrayBuffer: buffer });
	const text = result.value;
	const paragraphs = text.split('\n').filter((l: string) => l.trim());

	const output = [
		`📝 Word 文档: ${fileName}`,
		`段落数: ${paragraphs.length}`,
		`字符数: ${text.length}`,
		'',
		'--- 文档内容 ---',
		'',
		text,
	];

	if (result.messages && result.messages.length > 0) {
		output.push('', '--- 解析警告 ---');
		for (const msg of result.messages) {
			output.push(`[${msg.type}] ${msg.message}`);
		}
	}

	const summary = `${paragraphs.length} 段落, ${text.length} 字符`;

	return {
		content: output.join('\n'),
		summary,
		icon: '📝',
		type: 'word',
	};
}

/**
 * 解析旧版 Word 文档 (.doc)
 */
async function parseDoc(buffer: ArrayBuffer, fileName: string): Promise<DocumentParseResult> {
	const nodeBuffer = Buffer.from(buffer);
	const extractor = new WordExtractor();
	const doc = await extractor.extract(nodeBuffer);
	const text = doc.getBody();
	const paragraphs = text.split('\n').filter((l: string) => l.trim());

	const output = [
		`📝 Word 文档 (旧版): ${fileName}`,
		`段落数: ${paragraphs.length}`,
		`字符数: ${text.length}`,
		'',
		'--- 文档内容 ---',
		'',
		text,
	];

	const summary = `${paragraphs.length} 段落, ${text.length} 字符`;

	return {
		content: output.join('\n'),
		summary,
		icon: '📝',
		type: 'word',
	};
}
