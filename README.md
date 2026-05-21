# 富酬者 AI for Obsidian Showcase

> 一个可安装体验的 Obsidian 本地 AI 工作流插件展示版，让 AI 读取笔记、理解文档、调用 Vault 工具，并把结果沉淀回知识库。

这是富酬者 AI for Obsidian 的公开 Showcase 版本，用于作品集展示、HR 体验和技术审阅。公开版保留插件主体能力，移除了商业版中的手机号登录、付费授权、服务端白名单和私有交付配置。

## 可以体验什么

- **Obsidian 内 AI 对话**：在右侧栏与 AI 对话，支持流式输出、Markdown 渲染和历史会话。
- **本地上下文读取**：读取当前笔记、选中文本和手动附加文件，减少反复复制粘贴。
- **文档解析**：支持 Markdown、Word、Excel 等资料解析，适合整理课程、项目资料和内容素材。
- **Vault 工具调用**：AI 可以搜索、读取、写入和整理 Obsidian 笔记库文件。
- **场景动作面板**：内置开始一天、AI 资讯、归档整理、爆款文案、去 AI 味、写作引擎等任务入口。
- **Skills 工作流**：支持从 `.agent/skills` 加载 `SKILL.md`，把固定任务沉淀为可复用工作流。
- **MiniMax MCP**：可选启用联网搜索和图片理解等扩展能力。

## 公开版边界

公开版采用 **Demo Mode**，安装后不需要手机号登录即可进入插件界面。

已移除：

- 手机号白名单登录
- 密码设置和登录态校验
- 商业版后端 API 地址
- 付费授权逻辑
- 私有用户数据和交付配置

商业化版本仍保留在私有仓库中。这个公开仓库展示的是产品能力、插件架构和 AI 工作流落地方式。

## 安装体验

### 方式一：下载 Release

1. 打开 GitHub Releases。
2. 下载 `fuchouzhe-ai-for-obsidian-showcase-public.zip`。
3. 解压到你的 Obsidian 仓库插件目录：

```text
.obsidian/plugins/fuchouzhe-ai-for-obsidian-showcase/
  main.js
  manifest.json
  styles.css
```

4. 打开 Obsidian。
5. 进入设置，关闭安全模式并启用社区插件。
6. 启用 `富酬者AI Showcase`。

### 方式二：本地构建

```bash
npm install
npm run build
```

构建后复制以下文件到 Obsidian 插件目录：

```text
main.js
manifest.json
styles.css
```

## 配置

基础聊天能力需要在插件设置里填入 MiniMax API Key。

可选配置：

- 模型名称
- API Base URL
- 是否启用 MCP
- 是否启用 Vault 工具
- 是否启用 Skills
- 是否自动附加当前文件
- 排除标签，例如 `private`、`sensitive`

MCP 联网搜索和图片理解需要额外安装本地 `uvx` 环境。基础聊天、笔记读取和 Vault 工具不依赖 MCP。

## 技术栈

- Obsidian Plugin API
- TypeScript
- esbuild
- MiniMax API
- MiniMax MCP
- Markdown / Word / Excel document parsing
- Local file workflow
- Claude Code / Codex / Agent Skills 辅助开发与文档整理

## 项目结构

```text
src/
  main.ts                 插件入口、设置项、服务初始化
  chatView.ts             右侧栏 AI 聊天界面
  fuchouzheService.ts     AI 对话与工具调用编排
  miniMaxClient.ts        MiniMax API 客户端
  contextManager.ts       当前笔记与上下文管理
  documentReader.ts       Word / Excel / Markdown 文件解析
  memoryManager.ts        长期记忆文件管理
  scenePanel.ts           场景动作面板
  scenePipeline.ts        场景化工作流执行
  sceneConfig.ts          场景动作配置
  authService.ts          公开版 Demo 会话，不包含真实商业授权
  authUI.ts               公开版 Demo 入口，不包含手机号登录
  tools/
    toolManager.ts        工具调度
    vaultTool.ts          Obsidian Vault 读写工具
    minimaxMcpClient.ts   MiniMax MCP 客户端
  skills/
    index.ts              Skills 工作流加载
```

## 安全说明

请不要向公开仓库提交：

- `data.json`
- API Key
- 手机号、密码或用户授权数据
- 私有后端接口地址
- 本地 Obsidian 仓库信息
- `node_modules/`
- `main.js.map`

如果旧私有仓库曾经提交过真实 API Key，公开前应先撤销或轮换对应 Key。

## License

MIT License
