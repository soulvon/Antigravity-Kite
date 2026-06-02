/**
 * Kite Localization v1.0
 * Antigravity IDE 中文汉化模块
 * 基于 DOM MutationObserver 实时翻译界面文本
 */

// ========== 排除选择器 ==========
const EXCLUDE_SELECTOR = [
  '.monaco-editor', '.monaco-diff-editor',
  '[class*="diffEditor"]', '[class*="diff-editor"]',
  '[class*="codeBlock"]', '[class*="code-block"]',
  '.hljs', '[class*="hljs"]',
  '.shiki', '[class*="shiki"]',
  '[class*="language-"]',
  '[class*="token"]',
  'pre', 'code', 'kbd', 'samp', 'var',
  'textarea', 'input', '[contenteditable="true"]',
  '.xterm', '.terminal', '.debug-console',
  '[id*="workbench.panel.output"]',
  '[id*="workbench.panel.markers"]',
  '.ab-bubbles', '.kite-enhance-btn',
  '[aria-label*="Model Selector"]',
  '[class*="model-selector"]', '[class*="modelSelector"]',
  '.explorer-folders-view',
  '[id*="workbench.view.explorer"]',
  '[id*="workbench.view.search"]',
  '[id*="workbench.view.scm"]',
  '.outline-tree',
  '.monaco-list-row[role="treeitem"]',
  '.monaco-icon-label',
  '.breadcrumbs',
  '.tabs-container .tab',
  '.editor-group-container .title',
  '.statusbar',
  '[class*="markdown-body"]', '[class*="markdownBody"]',
  '[class*="tool-call"]', '[class*="toolCall"]',
  '[class*="code-citation"]', '[class*="codeCitation"]',
  '[class*="file-citation"]', '[class*="fileCitation"]',
  '[class*="diff-line"]', '[class*="diffLine"]',
  '[data-language]',
  '[role="code"]',
  '.notebook-editor', '.notebook-cell-list',
  '.quick-input-widget', '.quick-input-list',
  '.monaco-hover code', '.monaco-hover pre',
  '.notification-list-item-source',
].join(', ');

const MODEL_LABEL_SKIP_RE = /\b(claude|gpt-?\d|gpt-?o|o\d-|gemini|llama|qwen|deepseek|mistral|mixtral|swe-?\d|grok|haiku|sonnet|opus|codestral|devstral|devin)\b/i;
const MODEL_DESC_RE = /\b(for|via|using|with|agent|coding|powered|based|built|available|supported|requires?|enables?|provides?|settings|apply|saved|balance|draw|from|describe|task)\b/i;
const ATTRS_TO_TRANSLATE = ['aria-label', 'title', 'placeholder', 'data-tooltip'];

// ========== 翻译字典 ==========
const TRANSLATIONS = new Map([
  // Section 标题
  ['User Interface', '用户界面'],
  ['Windsurf Tab', 'Windsurf 补全'],
  ['Shortcuts', '快捷键'],
  ['Advanced', '高级'],
  ['General', '通用'],
  ['Editor', '编辑器'],
  ['Cascade', 'Cascade'],
  ['Cascade Configuration', 'Cascade 配置'],
  ['Notifications', '通知'],
  ['Agent', '智能体'],
  ['Agents', '智能体'],
  ['Settings', '设置'],
  ['Account', '账户'],
  ['Profile', '个人资料'],
  ['Subscription', '订阅'],

  // User Interface 设置
  ['Show Inlay Shortcuts', '显示内联快捷键'],
  ['Show in-line shortcut actions while the cursor is on an empty line', '当光标在空行上时，显示行内快捷操作'],
  ['Show Explain Problem Inlay Hint', '显示问题解释内联提示'],
  ['Show in-line explain problem actions while the cursor is on a line with an error squiggle', '当光标所在行有错误波浪线时，在行内显示解释问题的操作'],
  ['Show Selection Popup', '显示选区弹窗'],
  ['Show clickable shortcut popup when selecting text', '选中文本时显示浮动快捷弹窗'],
  ['Scroll to Next Diff on Accept', '接受时滚动到下一个差异'],
  ['Automatically scroll to the next Diff when accepting the current one', '接受当前差异时自动滚动到下一个差异'],

  // Windsurf Tab 设置
  ['Completion Mode', '补全模式'],
  ['Choose your preferred code completion experience', '选择你偏好的代码补全体验'],
  ['Aggression', '主动程度'],
  ['Controls how proactively Supercomplete suggests edits near your cursor', '控制 Supercomplete 在光标附近主动建议编辑的频率'],
  ['Tab to Jump', 'Tab 跳转'],
  ['Predict the location of your next edit and navigates you there with a tab keypress', '预测下一个编辑位置，按 Tab 跳转到该位置'],
  ['Tab to Import', 'Tab 导入'],
  ['Quickly add and update imports with a tab keypress', '按 Tab 快速添加和更新导入语句'],
  ['Clipboard Context', '剪贴板上下文'],
  ['When enabled, Windsurf will use the clipboard as context for completions', '启用后，Windsurf 将使用剪贴板内容作为补全的上下文'],
  ['Auto-Generate Memories', '自动生成记忆'],
  ['When enabled, Cascade will autonomously generate memories to remember important context. When disabled, Cascade will only create memories when you explicitly ask', '启用后，Cascade 将自动生成记忆以记住重要上下文。禁用后，Cascade 仅在你明确要求时创建记忆'],
  ['Allow Cascade in Background', '允许 Cascade 在后台运行'],
  ['Auto-Continue', '自动继续'],
  ['Controls whether Cascade automatically continues when it reaches the invocation limit. When on, Cascade continues indefinitely without prompting. When off, Cascade stops at the invocation limit and asks you to continue', '控制 Cascade 达到调用限制时是否自动继续。开启时，Cascade 无限期继续而无需提示。关闭时，Cascade 在调用限制处停止并询问你是否继续'],
  ['Disable Fast Context Agent', '禁用快速上下文智能体'],
  ['Disable the Fast Context agent that executes parallel searches as a subagent', '禁用执行并行搜索的快速上下文智能体'],
  ['Arena Always Open Fullscreen', 'Arena 始终全屏打开'],
  ['Cascade Completion Notifications', 'Cascade 完成通知'],
  ['Always Notify on Cascade Completion', '始终通知 Cascade 完成'],
  ['Read Claude Code Config', '读取 Claude Code 配置'],

  // Cascade Configuration 设置
  ['Explain and Fix in Current Conversation', '在当前对话中解释和修复'],
  ['Send explain and fix request to the current conversation', '向当前对话发送解释和修复请求'],
  ['Gitignore access', 'Gitignore 访问权限'],
  ['Allow Cascade, tab, and supercomplete to view and edit the files in .gitignore', '允许 Cascade、tab 和 supercomplete 查看和编辑 .gitignore 中的文件'],
  ['Cascade Auto-Fix Lints', 'Cascade 自动修复 Lint 错误'],
  ['Windsurf Preview', 'Windsurf 预览'],
  ['Auto Execution', '自动执行'],
  ['Auto Web Requests', '自动 Web 请求'],

  // Advanced 设置
  ['Search Max Workspace File Count', '最大工作区文件搜索数'],
  ['Open Editor Settings', '打开编辑器设置'],
  ['Customize Application Icon', '自定义应用图标'],
  ['Enable ACP', '启用 ACP'],
  ['Marketplace Extension Gallery Service URL', 'Marketplace 扩展库服务 URL'],
  ['Marketplace Gallery Item URL', 'Marketplace 库项目 URL'],

  // Shortcuts 设置
  ['Open Command', '打开命令'],
  ['Open Chat with Cascade', '打开 Cascade 聊天'],
  ['View All Windsurf shortcuts', '查看所有 Windsurf 快捷键'],
  ['Open Command Palette', '打开命令面板'],
  ['Change keybindings', '修改快捷键'],
  ['Keyboard Shortcuts', '键盘快捷键'],
  ['Reset to default shortcuts', '重置为默认快捷键'],
  ['Reset to defaults', '重置为默认'],

  // 选项值
  ['Conservative suggestions with higher confidence', '保守的建议，置信度更高'],
  ['Balanced suggestions', '平衡的建议'],
  ['More frequent and ambitious suggestions', '更频繁、更大胆的建议'],
  ['Supercomplete', '超级补全'],
  ['Intelligent edit suggestions near your cursor', '光标附近的智能编辑建议'],
  ['Autocomplete', '自动补全'],
  ['Standard inline completions without side hint code box suggestions', '标准内联补全，不含侧边代码提示框'],
  ['OFF', '关闭'],
  ['Disable all code completions', '禁用所有代码补全'],
  ['Disabled', '已禁用'],
  ['Allowlist', '允许列表'],
  ['Auto', '自动'],
  ['Turbo', '极速'],

  // 通用选项
  ['On', '开启'],
  ['Off', '关闭'],
  ['Enabled', '已启用'],
  ['Yes', '是'],
  ['No', '否'],
  ['None', '无'],
  ['Default', '默认'],
  ['Custom', '自定义'],
  ['Manual', '手动'],

  // 其他界面文本
  ['Search settings...', '搜索设置...'],
  ['Search settings', '搜索设置'],
  ['Log in to Windsurf', '登录 Windsurf'],
  ['Getting started with Windsurf', '开始使用 Windsurf'],
  ['Code with Cascade', '使用 Cascade 编码'],
  ['Edit code inline', '内联编辑代码'],
  ['Open Agent Window', '打开智能体窗口'],
  ['Thought', '思考'],
  ['Created Todo List', '已创建任务列表'],
  ['Analyzed content', '已分析内容'],
  ['Detect Proxy', '自动检测代理'],

  // MCP 相关
  ['MCP Servers', 'MCP 服务器'],
  ['Browse and install MCP servers', '浏览并安装 MCP 服务器'],
  ['Open MCP Registry', '打开 MCP 注册表'],
  ['Manage installed servers', '管理已安装的服务器'],
  ['Install', '安装'],
  ['Uninstall', '卸载'],
  ['Server URL', '服务器 URL'],
  ['Command', '命令'],
  ['Environment Variables', '环境变量'],
  ['Arguments', '参数'],
  ['Headers', '请求头'],
  ['Getting Started', '入门指南'],
  ['No tools found', '未找到工具'],
  ['All Tools', '所有工具'],
  ['No description available', '无可用描述'],
  ['required', '必需'],

  // Plan 和 Quota 相关
  ['Plan ends', '套餐到期'],
  ['Daily quota usage', '每日配额使用'],
  ['Weekly quota usage', '每周配额使用'],
  ['Extra usage balance', '额外使用余额'],
  ['Purchase extra usage', '购买额外使用量'],
  ['Manage your plan', '管理你的套餐'],
  ['Upgrade', '升级'],
  ['Cancel', '取消'],
  ['Billing', '账单'],
  ['Payment method', '支付方式'],
  ['Usage', '使用量'],
  ['Resets daily', '每日重置'],
  ['Resets weekly', '每周重置'],
  ['Trial', '试用'],
  ['Free', '免费'],
  ['Pro', '专业版'],
  ['Plan Info', '套餐信息'],

  // 右键菜单/面板菜单
  ['Open Preview', '打开预览'],
  ['Deploy', '部署'],
  ['Download Trajectory', '下载对话记录'],
  ['Cascade Usage', 'Cascade 使用量'],
  ['Download Diagnostics', '下载诊断信息'],
  ['Configure Rules', '配置规则'],
  ['Configure Skills', '配置技能'],
  ['Configure Workflows', '配置工作流'],
  ['Edit Memories', '编辑记忆'],
  ['MCPs', 'MCP 服务'],

  // Customizations 页面
  ['Customizations', '自定义'],
  ['Learn more', '了解更多'],
  ['Rules', '规则'],
  ['Skills', '技能'],
  ['Workflows', '工作流'],
  ['Memories', '记忆'],
  ['Workspace', '工作区'],
  ['Global', '全局'],
  ['Back', '返回'],
  ['Cascade Rules', 'Cascade 规则'],
  ['Manage rules', '管理规则'],
  ['Manage workflows', '管理工作流'],
  ['Cascade Memories', 'Cascade 记忆'],
  ['View memories', '查看记忆'],
  ['Manage', '管理'],
  ['Search memories', '搜索记忆'],

  // 通用操作
  ['Save', '保存'],
  ['Delete', '删除'],
  ['Edit', '编辑'],
  ['Close', '关闭'],
  ['Apply', '应用'],
  ['Reset', '重置'],
  ['Confirm', '确认'],
  ['Search', '搜索'],
  ['Refresh', '刷新'],
  ['Copy', '复制'],
  ['Paste', '粘贴'],
  ['Undo', '撤销'],
  ['Redo', '重做'],
  ['Error', '错误'],
  ['Warning', '警告'],
  ['Info', '信息'],
  ['Success', '成功'],
  ['Loading', '加载中'],
  ['Retry', '重试'],

  // 模型选择相关
  ['Search all models', '搜索所有模型'],
  ['Group by', '分组'],
  ['Adaptive', '自适应'],
  ['Automatically balances quality and cost', '自动平衡质量和成本'],
  ['Recently Used', '最近使用'],
  ['Recommended', '推荐'],
  ['Cost', '成本'],
  ['Higher effort consumes more tokens', '越高越消耗 tokens'],
  ['Input', '输入'],
  ['Cached input', '缓存输入'],
  ['Effort', '推理强度'],
  ['Output', '输出'],

  // 聊天模式相关
  ['Code', '代码'],
  ['Can write and edit code', '可以编写和编辑代码'],
  ["Reads but won't edit", '读取但不会编辑'],
  ['Plan changes before implementing', '先规划，再实施'],
  ['Use', '使用'],
  ['to switch modes', '切换模式'],
  ['Ask anything', '询问任何问题'],
  ['Single', '单模型'],
  ['Arena', '竞技场'],

  // 输入框菜单
  ['Mentions', '提及'],
  ['Trigger Workflow', '触发工作流'],
  ['Upload Image', '上传图片'],

  // 顶部标签和按钮
  ['Chat', '聊天'],
  ['Composer', '编排'],
  ['Documentation', '文档'],
  ['Commit', '提交'],
  ['Continue', '继续'],
  ['Accept', '接受'],
  ['Reject', '拒绝'],
  ['Generating', '生成中'],
  ['Complete', '完成'],
  ['Insert', '插入'],

  // AI补全相关
  ['Generating code...', '正在生成代码...'],
  ['Tab to accept', '按 Tab 接受'],
  ['Press Tab to accept', '按 Tab 接受'],

  // 文件/编辑器相关
  ['New File', '新文件'],
  ['New Folder', '新文件夹'],
  ['Open File', '打开文件'],
  ['Open Folder', '打开文件夹'],
  ['Save All', '保存全部'],
  ['Close Editor', '关闭编辑器'],
  ['Close All', '关闭全部'],
  ['Split Editor', '拆分编辑器'],
  ['Find in Files', '在文件中查找'],
  ['Replace in Files', '在文件中替换'],

  // 终端相关
  ['Terminal', '终端'],
  ['New Terminal', '新建终端'],
  ['Split Terminal', '拆分终端'],
  ['Kill Terminal', '关闭终端'],
  ['Clear', '清除'],

  // 状态相关
  ['Ready', '就绪'],
  ['Busy', '忙碌'],
  ['Disconnected', '已断开'],
  ['Connecting', '连接中'],
  ['Syncing', '同步中'],
  ['Indexing', '索引中'],
  ['Analyzing', '分析中'],
  ['Building', '构建中'],
  ['Testing', '测试中'],
  ['Debugging', '调试中'],

  // Git相关
  ['Source Control', '源代码管理'],
  ['Changes', '更改'],
  ['Staged Changes', '暂存更改'],
  ['Modified', '已修改'],
  ['Added', '已添加'],
  ['Deleted', '已删除'],
  ['Renamed', '已重命名'],
  ['Message', '消息'],
  ['Stage All', '全部暂存'],
  ['Unstage All', '全部取消暂存'],
  ['Discard Changes', '放弃更改'],
  ['Pull', '拉取'],
  ['Push', '推送'],
  ['Fetch', '获取'],
  ['Sync', '同步'],
  ['Branch', '分支'],
  ['Create Branch', '创建分支'],
  ['Merge Branch', '合并分支'],
  ['Checkout', '签出'],
  ['Revert', '还原'],

  // Cascade 状态文本
  ['Surfing..', '驰骋中..'],
  ['Surfing.', '驰骋中.'],
  ['Exploring..', '探索中..'],
  ['Exploring.', '探索中.'],
  ['Floating..', '酝酿中..'],
  ['Floating.', '酝酿中.'],
  ['Thinking..', '思考中..'],
  ['Thinking.', '思考中.'],
  ['Generating..', '生成中..'],
  ['Generating.', '生成中.'],
  ['Sailing..', '航行中..'],
  ['Sailing.', '航行中.'],

  // 输入框/模式切换
  ['Switch mode', '切换模式'],
  ['+ Add', '+ 添加'],

  // 发送按钮菜单
  ['Queue', '排队发送'],
  ['Send now', '立即发送'],
  ['Send', '发送'],

  // 顶栏按钮
  ['Past Conversations', '历史对话'],
  ['Start a New Conversation', '开始新对话'],
  ['Start recording', '开始录音'],
  ['Add Context', '添加上下文'],
  ['Model Selector', '模型选择'],
  ['Conversation', '对话'],

  // 欢迎页
  ['Start', '开始'],
  ['Generate a New Project', '创建新项目'],
  ['Clone Repository', '克隆仓库'],
  ['Connect via SSH', '通过 SSH 连接'],
  ['Recent Projects', '最近的项目'],
  ['Show More...', '显示更多...'],

  // 会话管理
  ['All sessions', '所有会话'],
  ['New session', '新建会话'],
  ['Spaces', '空间'],
  ['Running', '运行中'],
  ['Blocked', '已阻塞'],
  ['Uncategorized', '未分类'],
  ['Search sessions...', '搜索会话...'],
  ['Last 24 hours', '最近 24 小时'],
  ['Include archived', '包含已归档'],
  ['Rename', '重命名'],
  ['Archive', '归档'],
  ['Last run', '上次运行'],

  // 文件变更区域
  ['files with changes', '个文件有变更'],
  ['View all', '查看全部'],
  ['View all changes', '查看所有变更'],

  // 上下文/缓存状态
  ['context used', '上下文已用'],
  ['Prompt cache expires in', '提示缓存过期于'],
  ['message queued', '条消息排队中'],
  ['Enter to send queued message', '按回车发送排队消息'],

  // 终端命令
  ['Command Auto-ran', '命令已自动运行'],
  ['Copy command', '复制命令'],
  ['Review', '审查'],

  // 回复操作按钮
  ['Copy response', '复制回复'],
  ['Create a Codemap', '创建代码地图'],
  ['View response statistics', '查看回复统计'],
  ['Other actions', '更多操作'],

  // Web 请求弹窗
  ['Allow web request?', '允许 Web 请求？'],
  ['Allow Once', '允许一次'],
  ['Always allow this page', '始终允许此页面'],
  ['Allow all requests', '允许所有请求'],

  // 回复截断
  ['Continue response', '继续回复'],

  // 预览/命令状态
  ['Checked command status', '已检查命令状态'],
  ['System Browser', '系统浏览器'],

  // 允许/禁止列表
  ['Allow / Deny List', '允许 / 禁止列表'],
  ['Allow List', '允许列表'],
  ['Deny List', '禁止列表'],

  // 智能体/模型切换
  ['Send the task to a single model', '发送任务到单个模型'],
  ['Select multiple models to compare', '选择多个模型进行对比'],
  ['Switch agent location', '切换智能体位置'],
  ['Switch agent', '切换智能体'],
  ['See more', '查看更多'],
  ['Model provider unreachable', '模型提供商不可达'],
  ['Reasoning Effort', '推理强度'],
  ['Install Update', '安装更新'],
  ['Auto-fix', '自动修复'],
  ['Auto-continued', '自动继续'],

  // 底部栏
  ['Reject all', '全部拒绝'],
  ['Accept all', '全部接受'],
  ['Windsurf - Settings', 'Windsurf - 设置'],
  ['Antigravity - Settings', 'Antigravity - 设置'],
  ['File With Changes', '有变更的文件'],
  ['Re-build extension package finished', '重新打包扩展已完成'],
  ['Wait for task completion: Timer Cancelled', '等待任务完成：定时器已取消'],

  // Cascade 对话区域
  ['Thoughts', '思考过程'],
  ['Analyzed', '已分析'],
  ['tasks done', '个任务完成'],
  ['more', '更多'],
  ['Read', '读取'],

  // 设置菜单
  ['Windsurf Settings', 'Windsurf 设置'],
  ['Windsurf Usage', 'Windsurf 用量'],
  ['Quick Settings Panel', '快捷设置面板'],
  ['Windsurf Account', 'Windsurf 账户'],
  ['Join the Community', '加入社区'],
  ['Changelog', '更新日志'],
  ['Current Workspace', '当前工作区'],

  // 文件编辑操作
  ['edits', '处编辑'],
  ['Accept File', '接受文件'],
  ['Reject File', '拒绝文件'],

  // Codemaps
  ['Codemaps', '代码地图'],
  ['Your Codemaps', '你的代码地图'],

  // 配额提示
  ['Connecting to server...', '正在连接服务器...'],
  ['Your included daily usage quota is exhausted.', '您的每日配额已用完。'],
  ['Your included usage quota is exhausted.', '您的配额已用完。'],
  ['Purchase additional usage', '购买额外使用量'],

  // ═══════ Antigravity 设置页面 ═══════
  // 侧边导航
  ['Permissions', '权限'],
  ['Appearance', '外观'],
  ['Models', '模型'],
  ['Browser', '浏览器'],
  ['Workspaces', '工作区'],
  ['Provide Feedback', '提供反馈'],

  // Permissions — 安全模式
  ['Agent security mode', '智能体安全模式'],
  ['Select one of the three options. Agent settings and permissions can be further customized below.', '从三个选项中选择一个。智能体的设置和权限可在下方进一步自定义。'],
  ['Full access', '完全访问'],
  ['Agents have full access to your machine and external resources.', '智能体可完全访问你的设备和外部资源。'],
  ['Sandboxed', '沙盒模式'],
  ['Agents run in a secure sandbox that restricts access to external resources outside of your trusted folders.', '智能体在安全沙盒中运行，限制访问受信任文件夹之外的外部资源。'],
  ['Strict', '严格模式'],
  ['Terminal commands always require review and the agent cannot access files outside of its given workspaces.', '终端命令始终需要审查，且智能体无法访问指定工作区之外的文件。'],

  // Permissions — Terminal
  ['Terminal Command Auto Execution', '终端命令自动执行'],
  ['Controls whether terminal commands require your approval before running.', '控制终端命令在运行前是否需要你的批准。'],
  ['Note: A change to this setting will only apply to new messages sent to Agent. In-progress responses will use the previous setting value.', '注意：此设置的更改仅对发送给智能体的新消息生效。进行中的回复将使用先前的设置值。'],
  ['Always Proceed', '始终继续'],
  ['Enable Shell Integration', '启用 Shell 集成'],
  ["When enabled, Agent will use IDE's shell integration to detect and report terminal command execution.", '启用后，智能体将使用 IDE 的 Shell 集成来检测和报告终端命令的执行。'],

  // Permissions — File Access
  ['File Access', '文件访问'],
  ['Agent Non-Workspace File Access', '智能体非工作区文件访问'],
  ['Allows the agent to access files outside of your current workspace.', '允许智能体访问当前工作区之外的文件。'],
  ['Auto-Open Edited Files', '自动打开已编辑文件'],
  ['Open files in the background if Agent creates or edits them', '当智能体创建或编辑文件时在后台打开它们'],

  // Permissions — Planning
  ['Planning', '规划'],
  ['Review Policy', '审查策略'],
  ["Specifies Agent's behavior when asking for review on artifacts, which are documents it creates to enable a richer conversation experience.", '指定智能体在请求审查制品（即它创建的用于提供更丰富对话体验的文档）时的行为。'],

  // Permissions — Automation
  ['Automation', '自动化'],
  ['Agent Auto-Fix Lints', '智能体自动修复 Lint'],
  ['When enabled, Agent is given awareness of lint errors created by its edits and may fix them without explicit user prompting.', '启用后，智能体可感知其编辑产生的 lint 错误，并可能在无需用户明确提示的情况下修复它们。'],

  // Permissions — History
  ['History', '历史'],
  ['Conversation History', '对话历史'],
  ['When enabled, the agent will be able to access past conversations to inform its responses.', '启用后，智能体将能够访问以往对话以辅助其回复。'],
  ['Knowledge', '知识库'],
  ['When enabled, the agent will be able to access its knowledge base to inform its responses and automatically generate knowledge items in the background.', '启用后，智能体将能够访问其知识库以辅助回复，并在后台自动生成知识条目。'],

  // Permissions — General
  ['When enabled, \'Explain and Fix\' actions will continue in the current conversation instead of starting a new one.', '启用后，"解释并修复"操作将在当前对话中继续，而不是开始新对话。'],
  ['Open Agent on Reload', '重新加载时打开智能体'],
  ['Open Agent panel on window reload', '窗口重新加载时打开智能体面板'],
  ['Enable Sounds for Agent', '启用智能体提示音'],
  ['When enabled, Antigravity will play a sound when Agent finishes generating a response.', '启用后，当智能体完成回复生成时 Antigravity 将播放提示音。'],
  ['Auto-Expand Changes Overview', '自动展开变更概览'],
  ['When enabled, the Changes Overview toolbar will automatically expand when Agent finishes generating a response.', '启用后，当智能体完成回复生成时变更概览工具栏将自动展开。'],
  ['[Dev] GCP Project ID', '[开发] GCP 项目 ID'],
  ['GCP Project ID for enterprise features.', '用于企业功能的 GCP 项目 ID。'],

  // Permissions — Advanced
  ['Allow List Terminal Commands', '终端命令允许列表'],
  ["Agent auto-executes commands matched by an allow list entry. For Unix shells, an allow list entry matches a command if its space-separated tokens form a prefix of the command's tokens. For PowerShell, the entry tokens may match any contiguous subsequence of the command tokens.", '智能体会自动执行与允许列表条目匹配的命令。对于 Unix shell，若条目的空格分隔标记构成命令标记的前缀，即视为匹配。对于 PowerShell，条目标记可匹配命令标记中任意连续子序列。'],
  ['Deny List Terminal Commands', '终端命令禁止列表'],
  ['Agent asks for permission before executing commands matched by a deny list entry. The deny list follows the same matching rules as the allow list and takes precedence over the allow list.', '智能体在执行与禁止列表条目匹配的命令前会请求许可。禁止列表遵循与允许列表相同的匹配规则，且优先级高于允许列表。'],
  ['Advanced File Access', '高级文件访问'],
  ['Read Files', '读取文件'],
  ['Paths the agent can read.', '智能体可读取的路径。'],
  ['Write Files', '写入文件'],
  ['Paths the agent can modify.', '智能体可修改的路径。'],
  ['Allow', '允许'],
  ['Deny', '拒绝'],
  ['Advanced Command Access', '高级命令访问'],
  ['Terminal Commands', '终端命令'],
  ['Terminal commands the agent can execute.', '智能体可执行的终端命令。'],
  ['Commands Outside Sandbox', '沙盒外命令'],
  ['Commands the agent can run outside the sandbox.', '智能体可在沙盒外运行的命令。'],
  ['MCP Tools', 'MCP 工具'],
  ['External tools the agent can call via Model Context Protocol.', '智能体可通过 Model Context Protocol 调用的外部工具。'],
  ['Advanced Web Access', '高级网络访问'],
  ['Read URLs', '读取 URL'],
  ['URLs the agent can read or open in the browser.', '智能体可在浏览器中读取或打开的 URL。'],
  ['Execute URLs', '执行 URL'],
  ['URLs the agent can actuate on using the browser.', '智能体可使用浏览器操作的 URL。'],
  ['Advanced Settings', '高级设置'],
  ['Enable Demo Mode (Beta)', '启用演示模式（Beta）'],
  ['When enabled, your UI will be slightly modified to ensure more consistent demos. This is only recommended for demo purposes. In most cases, you can run "Antigravity: Start Demo Mode" and "Antigravity: Stop Demo Mode" to control this switch and update your ~/.gemini/antigravity data directory.', '启用后，你的界面将被略微修改以确保更一致的演示效果。仅建议在演示场景使用。多数情况下，你可运行 "Antigravity: Start Demo Mode" 和 "Antigravity: Stop Demo Mode" 来控制此开关并更新你的 ~/.gemini/antigravity 数据目录。'],

  // Account 页面
  ['Manage your plan, credentials, and general preferences.', '管理你的套餐、凭证和通用偏好设置。'],
  ['Enable Telemetry', '启用遥测'],
  ['When toggled on, Antigravity IDE collects usage data to help Google enhance performance and features.', '开启后，Antigravity IDE 将收集使用数据以帮助 Google 提升性能和功能。'],
  ['Marketing Emails', '营销邮件'],
  ['Receive product updates, tips, and promotions from Google Antigravity IDE via email.', '通过邮件接收来自 Google Antigravity IDE 的产品更新、提示和推广信息。'],
  ['Your Plan: Google AI Pro', '你的套餐：Google AI Pro'],
  ['You can upgrade to a Google AI Ultra plan to receive the highest rate limits.', '你可升级到 Google AI Ultra 套餐以获得最高速率限制。'],
  ['Email', '邮箱'],
  ['Sign Out', '退出登录'],
  ['Terms of Service', '服务条款'],

  // Appearance 页面
  ["Configure the agent's visual theme and display preferences.", '配置智能体的视觉主题和显示偏好。'],
  ['Chat Settings', '聊天设置'],
  ['Verbose agent chat', '详细智能体对话'],
  ['Display and preserve intermediate thinking steps', '显示并保留中间思考步骤'],

  // Notifications 页面
  ['Manage your notification preferences.', '管理你的通知偏好。'],
  ['Notification Settings', '通知设置'],
  ["To modify notification settings, open your operating system's system preferences.", '若要修改通知设置，请打开操作系统的系统偏好设置。'],
  ['Open System Preferences', '打开系统偏好设置'],

  // Models 页面
  ['Configure AI models and view your quota.', '配置 AI 模型并查看你的配额。'],
  ['Model Credits', '模型积分'],
  ['Enable AI Credit Overages', '启用 AI 积分超额'],
  ["When toggled on, Antigravity IDE will use your AI credits to fulfill model requests once you're out of model quota. Antigravity IDE will always use your model quota first before using AI credits.", '开启后，当你的模型配额用尽时，Antigravity IDE 将使用你的 AI 积分来完成模型请求。Antigravity IDE 始终会优先使用模型配额，然后才使用 AI 积分。'],
  ['Model Quota', '模型配额'],
  ['View your available model quota and AI credits. Model quota refreshes periodically based on your plan. Enable AI Credit Overages to continue using models when your quota is exhausted.', '查看你可用的模型配额和 AI 积分。模型配额会根据你的套餐定期刷新。启用 AI 积分超额可在配额耗尽时继续使用模型。'],

  // Customizations 页面
  ['Configure default behaviors, skills, and MCP servers.', '配置默认行为、技能和 MCP 服务器。'],
  ['Token Usage', 'Token 用量'],
  ['The breakdown below shows token usage from customizations like skills, rules, and MCP. If the budget is exceeded, large customizations will be truncated automatically.', '下方明细展示来自技能、规则和 MCP 等自定义项的 token 用量。若超出预算，较大的自定义项将被自动截断。'],
  ['Installed MCP Servers', '已安装的 MCP 服务器'],
  ['Add MCP', '添加 MCP'],
  ['Open MCP Config', '打开 MCP 配置'],
  ['No MCP Servers', '暂无 MCP 服务器'],
  ["You currently don't have any MCP Servers installed. Add an MCP server above or add a custom one via the MCP Config.", '你当前未安装任何 MCP 服务器。请在上方添加 MCP 服务器，或通过 MCP 配置添加自定义服务器。'],
  ['Build With Google Plugins', 'Build With Google 插件'],
  ['Customize', '自定义'],

  // Browser 页面
  ['Browser Settings', '浏览器设置'],
  ['Configure the browser subagent. It requires Google Chrome to be installed.', '配置浏览器子智能体。需要已安装 Google Chrome。'],
  ['Enable Browser Tools', '启用浏览器工具'],
  ['When enabled, Agent can use browser tools to open URLs, read web pages, and interact with browser content. This allows the Agent access to important (and often critical) knowledge and methods of validation, but any browser integration does increase exposure to external malicious parties for security exploits.', '启用后，智能体可使用浏览器工具打开 URL、阅读网页并与浏览器内容交互。这使智能体能够获取重要（且通常关键）的知识和验证方法，但任何浏览器集成都会增加遭受外部恶意方安全攻击的风险。'],
  ['Browser Javascript Execution Policy', '浏览器 JavaScript 执行策略'],
  ['Controls whether the agent can run custom JavaScript to automate complex browser actions.', '控制智能体是否可运行自定义 JavaScript 来自动化复杂的浏览器操作。'],
  ['Actuation Permissions', '操作权限'],
  ['Browser Actuation Rules', '浏览器操作规则'],
  ['Configure allowed and denied URLs for browser actuation.', '为浏览器操作配置允许和拒绝的 URL。'],

  // Tab 页面
  ['Suggestions', '建议'],
  ['Suggestions in Editor', '编辑器内建议'],
  ['Show suggestions when typing in the editor', '在编辑器中输入时显示建议'],
  ['Tab Speed', 'Tab 速度'],
  ['Set the speed of tab suggestions', '设置 Tab 建议的速度'],
  ['Fast', '快速'],
  ['Highlight After Accept', '接受后高亮'],
  ['Highlight newly inserted text after accepting a Tab completion.', '接受 Tab 补全后高亮新插入的文本。'],
  ['Quickly add and update imports with a tab keypress.', '按一次 Tab 快速添加和更新导入语句。'],
  ['Navigation', '导航'],
  ['Predict the location of your next edit and navigates you there with a tab keypress.', '预测你下一处编辑的位置，并通过按 Tab 将你导航到该处。'],
  ['Context', '上下文'],
  ['Tab Gitignore Access', 'Tab Gitignore 访问'],
  ['Allow Tab to view and edit the files in .gitignore. Use with caution if your .gitignore lists files containing credentials, secrets, or other sensitive information.', '允许 Tab 查看和编辑 .gitignore 中的文件。若你的 .gitignore 列出了包含凭证、密钥或其他敏感信息的文件，请谨慎使用。'],

  // Editor 页面
  ['Editor Settings', '编辑器设置'],
  ['Configure editor-specific behaviors and shortcuts.', '配置编辑器特定的行为和快捷键。'],
  ['Marketplace', '扩展市场'],
  ['Marketplace Item URL', '扩展市场项目 URL'],
  ['Changes the base URL on each extension page. You must restart Antigravity IDE to use the new marketplace after changing this value.', '更改每个扩展页面的基础 URL。更改此值后必须重启 Antigravity IDE 才能使用新的扩展市场。'],
  ['Marketplace Gallery URL', '扩展市场库 URL'],
  ['Changes the base URL for marketplace search results. You must restart Antigravity IDE to use the new marketplace after changing this value.', '更改扩展市场搜索结果的基础 URL。更改此值后必须重启 Antigravity IDE 才能使用新的扩展市场。'],
  ['Selection Actions', '选区操作'],
  ['Show Selection Actions', '显示选区操作'],
  ['Show "Edit" and "Chat" buttons when selecting text in the editor.', '在编辑器中选中文本时显示"编辑"和"聊天"按钮。'],
  ['To modify editor settings, open Settings within the editor window.', '若要修改编辑器设置，请在编辑器窗口内打开设置。'],

  // Provide Feedback 页面
  ['Feedback Type', '反馈类型'],
  ['Bug Report', '错误报告'],
  ['Feature Request', '功能请求'],
  ['Auth and Billing', '认证与账单'],
  ['General Feedback', '一般反馈'],
  ['Description', '描述'],
  ['Please describe the issue in detail. The more actionable your feedback, the quicker our team can address your request. Some helpful information includes:', '请详细描述问题。你的反馈越具可操作性，我们的团队就能越快处理你的请求。有用的信息包括：'],
  ['Steps to reproduce the issue', '复现该问题的步骤'],
  ['Expected behavior', '预期行为'],
  ['Actual behavior', '实际行为'],
  ['Any error messages', '任何错误信息'],
  ['Any relevant information', '任何相关信息'],
  ['Steps to Reproduce', '复现步骤'],
  ['Attach a screenshot (optional)', '附加截图（可选）'],
  ['Attach Antigravity server logs', '附加 Antigravity 服务器日志'],
  ['Submit', '提交'],

  // 占位符
  ['Describe the bug you encountered...', '描述你遇到的错误...'],
  ['Please list the steps to reproduce the issue', '请列出复现该问题的步骤'],

  // ═══════ 快捷设置 / 菜单 / 快捷键 ═══════
  // 快捷设置面板
  ['Auto Execution', '自动执行'],
  ['Request Review', '请求审查'],
  ['Snooze', '暂停'],
  ['AI Shortcuts', 'AI 快捷键'],
  ['Open Agent', '打开智能体'],
  ['No Shortcut', '无快捷键'],
  ['View all Antigravity IDE shortcuts', '查看所有 Antigravity IDE 快捷键'],

  // 输入框占位符
  ['Ask anything, @ to mention, / for actions', '询问任何问题，@ 提及，/ 执行操作'],

  // 添加上下文菜单
  ['Media', '媒体'],
  ['Actions', '操作'],

  // 顶部菜单
  ['Docs', '文档'],
  ['Report Issue', '报告问题'],
  ['Additional Options', '更多选项'],
  ['Customization', '自定义'],
  ['Editor-Specific Settings', '编辑器专属设置'],
  ['Open Browser (Preview)', '打开浏览器（预览）'],
  ['Open Antigravity IDE User Settings', '打开 Antigravity IDE 用户设置'],
  ['New Conversation', '新对话'],

  // Customizations — Back to Agent 页
  ['Back to Agent', '返回智能体'],
  ['Customize Agent to get a better, more personalized experience.', '自定义智能体以获得更好、更个性化的体验。'],
  ['Rules help guide the behavior of Agent.', '规则帮助引导智能体的行为。'],
  ['Workflows are saved prompts that Agent can follow. To trigger a workflow, type "/" in Agent.', '工作流是智能体可遵循的已保存提示。要触发工作流，请在智能体中输入 "/"。'],
  ['+ Workspace', '+ 工作区'],
  ['+ Global', '+ 全局'],
  ['to navigate', '导航'],
  ['to select', '选择'],

  // Shortcuts 页面
  ['Keyboard shortcuts for quick navigation and control.', '用于快速导航和控制的键盘快捷键。'],
  ['RECOMMENDED', '推荐'],
  ['Open Conversation Picker', '打开对话选择器'],
  ['Open File Search', '打开文件搜索'],
  ['Focus Input', '聚焦输入框'],
  ['Open Workspace Selector', '打开工作区选择器'],
  ['NAVIGATION', '导航'],
  ['Go Back', '后退'],
  ['Go Forward', '前进'],
  ['File Picker', '文件选择器'],
  ['Toggle Editor', '切换编辑器'],
  ['Select Previous Conversation', '选择上一个对话'],
  ['Select Next Conversation', '选择下一个对话'],
  ['Open Settings', '打开设置'],
  ['CONVERSATION', '对话'],
  ['Toggle Model Selector', '切换模型选择器'],
  ['Start Voice Recording', '开始语音录制'],
  ['Stop Voice Recording', '停止语音录制'],
  ['Find in Pane', '在面板中查找'],
  ['Open Workspace', '打开工作区'],
  ['LAYOUT CONTROLS', '布局控制'],
  ['Toggle Sidebar', '切换侧边栏'],
  ['Toggle Auxiliary Pane', '切换辅助面板'],
  ['Toggle Terminal', '切换终端'],
  ['Zoom In', '放大'],
  ['Zoom Out', '缩小'],
  ['Reset Zoom', '重置缩放'],
  ['Hold', '按住'],
  ['Release', '松开'],

  // ═══════ 错误横幅 / 工具栏 / MCP ═══════
  // 智能体错误横幅
  ['Agent terminated due to error', '智能体因错误终止'],
  ['You can prompt the model to try again or start a new conversation if the error persists.', '你可以提示模型重试，若错误持续存在则开始新对话。'],
  ['See our troubleshooting guide for more help.', '查看我们的故障排查指南以获取更多帮助。'],
  ['troubleshooting guide', '故障排查指南'],
  ['Dismiss', '忽略'],
  ['Copy debug info', '复制调试信息'],

  // 上下文菜单
  ['Files', '文件'],
  ['Directories', '目录'],
  ['Code Context Items', '代码上下文项'],

  // MCP 商店 / 管理
  ['MCP Store', 'MCP 商店'],
  ['Manage MCP Servers', '管理 MCP 服务器'],
  ['Manage MCP servers', '管理 MCP 服务器'],
  ['Search MCP servers', '搜索 MCP 服务器'],
  ['View raw config', '查看原始配置'],
  ['No MCP servers installed.', '未安装任何 MCP 服务器。'],
  ['Click here', '点击此处'],
  ['to view the MCP server store.', '查看 MCP 服务器商店。'],
  ['Configuring MCP', '配置 MCP'],
  ['MCP (Model Context Protocol) enables LLMs to access custom tools and services. An MCP server implements the MCP protocol and provides a set of related tools and services.', 'MCP（Model Context Protocol）使 LLM 能够访问自定义工具和服务。MCP 服务器实现 MCP 协议，并提供一组相关的工具和服务。'],
  ['In this file, you can specify MCP servers you want Agent to use. Here is an example configuration that sets up a single MCP server, for GitHub:', '在此文件中，你可以指定希望智能体使用的 MCP 服务器。以下是为 GitHub 配置单个 MCP 服务器的示例配置：'],
  ['Remote MCP connections are also supported. Here is an example configuration for the remote GitHub MCP server:', '同样支持远程 MCP 连接。以下是远程 GitHub MCP 服务器的示例配置：'],
  ['There is a growing ecosystem of MCP servers that you can find online. See the docs for more information.', 'MCP 服务器的生态系统正在不断壮大，你可在网上找到它们。详见文档了解更多信息。'],

  // 杂项 UI
  ['AI may make mistakes. Double-check all generated code.', 'AI 可能会出错，请仔细检查所有生成的代码。'],
  ['Limited time', '限时'],
  ['By default, Antigravity IDE uses Open VSX as a marketplace. This can be changed in Antigravity IDE settings.', '默认情况下，Antigravity IDE 使用 Open VSX 作为扩展市场。可在 Antigravity IDE 设置中更改。'],
  ['Antigravity IDE settings', 'Antigravity IDE 设置'],

  // 终端自动执行下拉选项
  ['Agent never asks for confirmation before executing terminal commands (except those in the Deny list). This provides the Agent with the maximum ability to operate over long periods without intervention, but also has the highest risk of an Agent executing an unsafe terminal command.', '智能体在执行终端命令前从不请求确认（禁止列表中的除外）。这使智能体能够在无人干预下长时间运行，但也带来了智能体执行不安全终端命令的最高风险。'],
  ['Proceed In Sandbox', '在沙盒中执行'],
  ['Terminal command automatically proceeds if the command runs inside the sandbox. Otherwise, it requests review.', '若命令在沙盒内运行，终端命令将自动执行；否则将请求审查。'],
  ['Agent always asks for confirmation before executing terminal commands (except those in the Allow list).', '智能体在执行终端命令前始终请求确认（允许列表中的除外）。'],
  ['Always Ask', '始终询问'],
  ['Agent never asks for review. This maximizes the autonomy of the Agent, but also has the highest risk of the Agent operating over unsafe or injected Artifact content.', '智能体从不请求审查。这最大化了智能体的自主性，但也带来了智能体处理不安全或被注入制品内容的最高风险。'],
  ['Agent always asks for review.', '智能体始终请求审查。'],

  // Build With Google 插件页
  ['Build with Antigravity IDE Plugins', '使用 Antigravity IDE 插件构建'],
  ['Plugins are packaged collections of skills and MCPs to help the Agent in Antigravity IDE work with Google developer products. You can always change your choices in Settings.', '插件是技能和 MCP 的打包集合，帮助 Antigravity IDE 中的智能体与 Google 开发者产品协同工作。你随时可在设置中更改选择。'],
  ['Download', '下载'],
  ['Core tools and knowledge required to develop for Android', '为 Android 开发所需的核心工具和知识'],
  ['Modern Web Guidance', '现代 Web 指南'],
  ['Keep your coding agent up to date with the latest web best practices.', '让你的编码智能体紧跟最新的 Web 最佳实践。'],
  ['Using the Antigravity Python SDK to build AI agents', '使用 Antigravity Python SDK 构建 AI 智能体'],
  ['Science', '科学'],
  ['Curated collection of agent skills for science.', '为科学领域精选的智能体技能集合。'],
  ["Prototype, build & run modern apps users love with Firebase's backend, AI, and operational infrastructure.", '借助 Firebase 的后端、AI 和运维基础设施，原型设计、构建并运行用户喜爱的现代应用。'],
  ['Reliable automation, in-depth debugging, and performance analysis in Chrome using Chrome DevTools and Puppeteer', '使用 Chrome DevTools 和 Puppeteer 在 Chrome 中实现可靠的自动化、深入调试和性能分析'],
  
  // 新版汉化增补 (Settings & Credits)
  ['By using this app, you agree to its', '使用此应用即表示你同意其'],
  ['Sandbox Allow Network', '沙盒允许网络连接'],
  ['When enabled, sandboxed commands are allowed to make network requests.', '启用后，允许沙盒内的命令发起网络请求。'],
  ['Agent will always ask to review in strict mode.', '智能体在严格模式下将始终请求审查。'],
  ['Agent cannot modify files outside of the workspace in strict mode.', '智能体在严格模式下无法修改工作区之外的文件。'],
  ['See Activity', '查看明细'],
  ['Get More AI Credits', '获取更多 AI 积分'],
  ['Select one of the three options.', '从三个选项中选择一个。'],
  ['Agent settings and permissions can be further customized below.', '智能体的设置和权限可在下方进一步自定义。'],
  ['Note: A change to this setting will only apply to new messages sent to Agent.', '注意：此设置的更改仅对发送给智能体的新消息生效。'],
  ['In-progress responses will use the previous setting value.', '进行中的回复将使用先前的设置值。'],
  ['Configure the browser subagent.', '配置浏览器子智能体。'],
  ['It requires Google Chrome to be installed.', '需要已安装 Google Chrome。'],

  // 2026.06 新增汉化补强
  ['Allow read access to this path?', '允许读取此路径的访问权限吗？'],
  ['Yes, allow this time', '是，仅允许本次'],
  ['Yes, and always allow', '是，且始终允许'],
  ['No (tell the agent what to do instead)', '否 (告诉智能体该做什么)'],
  ['Enable Demo Mode (Beta)', '启用演示模式 (Beta)'],
  ['When enabled, your UI will be slightly modified to ensure more consistent demos. This is only recommended for demo purposes.', '启用后，你的界面将被略微修改以确保更一致的演示效果。仅建议在演示场景使用。'],
  ['In most cases, you can run "Antigravity: Start Demo Mode" and "Antigravity: Stop Demo Mode" to control this switch and update your ~/.gemini/antigravity data directory.', '多数情况下，你可运行 "Antigravity: Start Demo Mode" 和 "Antigravity: Stop Demo Mode" 来控制此开关并更新你的 ~/.gemini/antigravity 数据目录。'],
  ['When enabled, your UI will be slightly modified to ensure more consistent demos. This is only recommended for demo purposes. In most cases, you can run "Antigravity: Start Demo Mode" and "Antigravity: Stop Demo Mode" to control this switch and update your ~/.gemini/antigravity data directory.', '启用后，你的界面将被略微修改以确保更一致的演示效果。仅建议在演示场景使用。多数情况下，你可运行 "Antigravity: Start Demo Mode" 和 "Antigravity: Stop Demo Mode" 来控制此开关并更新你的 ~/.gemini/antigravity 数据目录。'],
  ['Ask', '询问'],
  ['External tools the agent can call via Model Context Protocol', '智能体可通过 Model Context Protocol 调用的外部工具'],
  ['Add', '添加'],
  ['Model Context Protocol', '模型上下文协议'],
  ['Model Context Protocol (MCP)', '模型上下文协议 (MCP)'],
  ['(tell the agent what to do instead)', '(告诉智能体该做什么)'],
  ['tell the agent what to do instead', '告诉智能体该做什么'],
  ['Skip', '跳过'],
  ['Allow write access to this path?', '允许写入此路径的访问权限吗？'],
  ['Allow execute access to this path?', '允许执行此路径的访问权限吗？'],
  ['Allow access to this path?', '允许访问此路径吗？'],
  ['Configure the browser subagent. It requires Google Chrome to be installed.', '配置浏览器子智能体。这需要安装 Google Chrome。'],
  ['Block all browser JavaScript execution.', '阻止所有浏览器的 JavaScript 执行。'],
  ['Prompt for approval before running browser scripts.', '在运行浏览器脚本前请求审查。'],
  ['Allow full browser script execution without prompting.', '允许执行所有浏览器脚本而无需确认。'],
  ['Slow', '慢速'],
  ['Configure workspace-specific permissions, resources, and customizations.', '配置工作区特有的权限、资源和自定义设置。'],
  ['Describe the bug you encountered...', '描述你遇到的 Bug...'],
  ['Please list the steps to reproduce the issue', '请列出复现此问题的步骤'],
  ['By using this app, you agree to its', '使用此应用即表示你同意其'],
  ['Available AI Credits:', '可用 AI 积分：'],
  ['Available AI Credits', '可用 AI 积分'],
  ['of the customization budget is available.', '的自定义预算可用。'],
  ['of the customization budget is available', '的自定义预算可用'],
  ['Agent Decides', '智能体自主决定'],
  ['Decides', '自主决定'],
  ['Invalid Media', '无效媒体'],
  ['Review Changes', '审查变更'],
  ['No changes to review', '暂无需要审查的变更'],
  ['Record Audio', '录制音频'],
  ['Code with Agent', '与智能体结对编程'],
]);

// ========== 正则翻译 ==========
const REGEX_TRANSLATIONS = [
  [/^Available AI Credits:\s*(\d+)$/i, '可用 AI 积分：$1'],
  [/^for\s+(\d+)s$/i, '耗时 $1 秒'],
  [/^(\d+)\s+tasks$/i, '$1 个任务'],
  [/^(\d+)\s+chunks$/i, '$1 个分片'],
  [/^Quota resets daily\/weekly\.\s*Plan ends in (\d+) days$/i, '配额每日/每周重置。套餐剩余 $1 天'],
  [/^Plan ends in (\d+) days\s*\((.+)\)$/i, '套餐剩余 $1 天 ($2)'],
  [/^Resets\s+(.+)$/i, '重置于 $1'],
  [/^(\d+)K context$/i, '$1K 上下文'],
  [/^(\d+)\s+tools$/i, '$1 个工具'],
  [/^(\d+)\s*\/\s*(\d+)\s+tools$/i, '$1 / $2 个工具'],
  [/^Switch mode\s*\((.+)\)$/i, '切换模式 ($1)'],
  [/^Queue\s*\((.+)\)$/i, '排队发送 ($1)'],
  [/^Send now\s*\((.+)\)$/i, '立即发送 ($1)'],
  [/^Ask anything\s*\((.+)\)$/i, '询问任何问题 ($1)'],
  [/^(\d+)\s+resources$/i, '$1 个资源'],
  [/^Start a New Conversation\s+(.+)$/i, '开始新对话 $1'],
  [/^(\d+)m ago$/i, '$1 分钟前'],
  [/^(\d+)h ago$/i, '$1 小时前'],
  [/^(\d+)d ago$/i, '$1 天前'],
  [/^(\d+)s ago$/i, '$1 秒前'],
  [/^(\d+)\s+files$/i, '$1 个文件'],
  [/^(\d+)\s+MCP servers?$/i, '$1 个 MCP 服务器'],
  [/^Daily:\s*(\d+)%\s*quota used\s*[·\-]\s*Weekly:\s*(\d+)%\s*quota used$/i, '日配额已用 $1% · 周配额已用 $2%'],
  [/^Daily:\s*(\d+)%\s*quota used$/i, '日配额已用 $1%'],
  [/^Weekly:\s*(\d+)%\s*quota used$/i, '周配额已用 $1%'],
  [/^(\d+)%\s*quota used$/i, '配额已用 $1%'],
  [/^(\d+)\s+files with changes$/i, '$1 个文件有变更'],
  [/^Send\s*\((.+)\)$/i, '发送 ($1)'],
  [/^(\d+)\s+messages?\s+queued$/i, '$1 条消息排队中'],
  [/^(\d+)\s*\/\s*(\d+)\s+tasks?\s+done$/i, '$1 / $2 个任务完成'],
  [/^(\d+)\s+tasks?\s+done$/i, '$1 个任务完成'],
  [/^(\d+)\s+more$/i, '还有 $1 项'],
  [/^Analyzed\s+(.+)$/i, '已分析 $1'],
  [/^Read\s+(.+)$/i, '读取 $1'],
  [/^(\d+)\s+edits?$/i, '$1 处编辑'],
  [/^Accept File\s+(.+)$/i, '接受文件 $1'],
  [/^Reject File\s+(.+)$/i, '拒绝文件 $1'],
  [/^Cancel\s*\((.+)\)$/i, '取消 ($1)'],
  [/^Plan ends in (\d+) days?$/i, '套餐剩余 $1 天'],
  [/^([\d.]+[KMB]?)\s*\/\s*([\d.]+[KMB]?)\s*context used$/i, '$1 / $2 上下文已用'],
  [/^([\d.]+[KMB]?)\s*context used$/i, '$1 上下文已用'],
  [/^Cascade can make up to (\d+) tool calls per prompt\.?$/i, 'Cascade 每次提示最多可调用 $1 次工具'],
  [/^Windsurf Account\s*\((.+)\)$/i, 'Windsurf 账户 ($1)'],
  [/^Model Selector\s*\((.+)\)$/i, '模型选择 ($1)'],
  [/^Past Conversations\s*\((.+)\)$/i, '历史对话 ($1)'],
  // Antigravity 设置页动态文本
  [/^Refreshes in (\d+) hours?, (\d+) minutes?$/i, '$1 小时 $2 分钟后刷新'],
  [/^Refreshes in (\d+) hours?$/i, '$1 小时后刷新'],
  [/^Refreshes in (\d+) minutes?$/i, '$1 分钟后刷新'],
  [/^Refreshes in (\d+) seconds?$/i, '$1 秒后刷新'],
  [/^([\d.]+)% of the customization budget is available\.?$/i, '自定义预算剩余 $1% 可用。'],
  [/^Show (\d+) breakdown$/i, '显示 $1 项明细'],
  [/^Your Plan:\s*(.+)$/i, '你的套餐：$1'],
  [/^Changes Overview \((\d+) Files? With Changes\)$/i, '变更概览（$1 个文件有变更）'],
  [/^Terminal \((\d+) Background Process(?:es)? Running\)$/i, '终端（$1 个后台进程运行中）'],
  [/^Artifacts \((\d+) Files? for Conversation\)$/i, '制品（$1 个对话文件）'],
  [/^Media upload failed after (\d+) attempts\.?$/i, '媒体上传尝试 $1 次均失败。'],
  [/^Send feedback as (.*)$/i, '以 $1 身份发送反馈'],
];

// ========== 软翻译（子串替换兜底）==========
const SOFT_TRANSLATIONS = [
  [/\bcontext used\b/gi, '上下文已用'],
  [/\bquota used\b/gi, '配额已用'],
  [/\bquota exhausted\b/gi, '配额已耗尽'],
  [/\bdaily quota\b/gi, '每日配额'],
  [/\bweekly quota\b/gi, '每周配额'],
  [/\bPlease try again later\.?/gi, '请稍后再试。'],
  [/\bGenerating\b/gi, '生成中'],
  [/\bSearching\b/gi, '搜索中'],
  [/\bLoading\b/gi, '加载中'],
  [/\bConnecting\b/gi, '连接中'],
  [/\bRetrying\b/gi, '重试中'],
  [/\bWaiting\b/gi, '等待中'],
];

// ========== 翻译引擎 ==========
let _translationsLowerIndex = null;
function getTranslationsLowerIndex() {
  if (_translationsLowerIndex) return _translationsLowerIndex;
  _translationsLowerIndex = new Map();
  for (const k of TRANSLATIONS.keys()) {
    const lk = k.toLowerCase();
    if (!_translationsLowerIndex.has(lk)) _translationsLowerIndex.set(lk, k);
  }
  return _translationsLowerIndex;
}

const TRAILING_PUNCT_RE = /[\s\u00A0]*([.\u2026:;!?\u3002\uFF1A\uFF1B\uFF01\uFF1F]+|\.\.\.|[\u2192\u25B8\u25BE\u25BC])$/;
function splitTrailingPunct(s) {
  const m = s.match(TRAILING_PUNCT_RE);
  if (!m) return [s, ''];
  return [s.slice(0, m.index), m[0]];
}

function normalizeWhitespace(s) {
  return s.replace(/[\u200B\u200C\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
}

const PUNCT_CN_MAP = { '.': '。', ':': '：', ';': '；', '!': '！', '?': '？' };
function localizePunct(p) {
  if (p && p.length === 1 && PUNCT_CN_MAP[p]) return PUNCT_CN_MAP[p];
  if (/^\.{3,}$/.test(p.trim())) return '…';
  return p;
}

function lookupTranslation(core) {
  if (TRANSLATIONS.has(core)) return TRANSLATIONS.get(core);
  const idx = getTranslationsLowerIndex();
  const orig = idx.get(core.toLowerCase());
  if (orig) return TRANSLATIONS.get(orig);
  return null;
}

function applyRegex(core) {
  for (const [pattern, replacement] of REGEX_TRANSLATIONS) {
    if (pattern.test(core)) return core.replace(pattern, replacement);
  }
  return null;
}

function applySoftReplacement(s) {
  let out = s;
  let changed = false;
  for (const [re, rep] of SOFT_TRANSLATIONS) {
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, rep);
      changed = true;
    }
    re.lastIndex = 0;
  }
  return changed ? out : null;
}

function translateText(text) {
  if (!text || !text.trim()) return text;
  const leading = text.match(/^\s*/)?.[0] ?? '';
  const trailing = text.match(/\s*$/)?.[0] ?? '';
  let core = text.trim();

  if (core.length < 80 && MODEL_LABEL_SKIP_RE.test(core) && !MODEL_DESC_RE.test(core)) return text;

  // 第 1 轮：精确/大小写不敏感
  let hit = lookupTranslation(core);
  if (hit) return leading + hit + trailing;

  // 第 2 轮：归一化空白
  const normalized = normalizeWhitespace(core);
  if (normalized !== core) {
    hit = lookupTranslation(normalized);
    if (hit) return leading + hit + trailing;
  }

  // 第 3 轮：剥离尾部标点
  const [stripped, tail] = splitTrailingPunct(normalized);
  if (tail && stripped) {
    hit = lookupTranslation(stripped);
    if (hit) return leading + hit + localizePunct(tail) + trailing;
  }

  // 第 4 轮：正则匹配
  let regHit = applyRegex(core);
  if (regHit) return leading + regHit + trailing;

  // 第 5 轮：正则匹配（归一化后）
  if (normalized !== core) {
    regHit = applyRegex(normalized);
    if (regHit) return leading + regHit + trailing;
  }

  // 第 6 轮：正则匹配（剥离标点后）
  if (tail && stripped) {
    regHit = applyRegex(stripped);
    if (regHit) return leading + regHit + localizePunct(tail) + trailing;
  }

  // 第 7 轮：软翻译子串替换
  const softHit = applySoftReplacement(core);
  if (softHit) return leading + softHit + trailing;

  return text;
}

// ========== DOM 翻译 ==========
const _translatedTextNodes = new WeakMap();

function shouldSkip(node) {
  if (!node) return true;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el) return true;

  // 1. 设置界面的特殊处理：放行除输入框、编辑器、代码块之外的一切
  const inSettings = el.closest('.settings-editor, .settings-body, [id*="settings"], [class*="settings-"], .account-editor, [class*="account-"], .customizations-editor, .customization-editor, [class*="customization-"], .models-editor, [class*="models-"], .feedback-editor, [class*="feedback-"]');
  if (inSettings) {
    const excludedInSettings = el.closest('input, textarea, [contenteditable="true"], .monaco-editor, pre, code');
    return Boolean(excludedInSettings);
  }

  // 2. 权限 QuickInput 弹窗及快捷菜单的特殊处理：白名单放行
  const quickInput = el.closest('.quick-input-widget, .quick-input-list');
  if (quickInput) {
    const val = (node.nodeType === Node.ELEMENT_NODE ? node.textContent : node.nodeValue || '').trim();
    const isWhitelist = /^(Allow read access to this path\?|Yes, allow this time|Yes, and always allow|No \(tell the agent what to do instead\)|Skip|Submit|Ask|Allow|Deny|\(tell the agent what to do instead\)|tell the agent what to do instead|Agent Decides|Decides|Agent)$/i.test(val);
    return !isWhitelist;
  }

  // 3. 常规排除逻辑
  const excluded = el.closest(EXCLUDE_SELECTOR);
  return Boolean(excluded);
}

function translateAttributes(el) {
  if (!el || shouldSkip(el)) return;
  for (const attr of ATTRS_TO_TRANSLATE) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    if (el.hasAttribute('data-kite-orig-' + attr)) continue;
    const translated = translateText(value);
    if (translated !== value) {
      el.setAttribute('data-kite-orig-' + attr, value);
      el.setAttribute(attr, translated);
    }
  }
}

function translateTextNode(node) {
  if (!node || shouldSkip(node)) return;
  const original = node.nodeValue;
  const translated = translateText(original);
  if (translated !== original) {
    node.nodeValue = translated;
    _translatedTextNodes.set(node, original);
    try {
      const parent = node.parentElement;
      if (parent && original && original.trim()) {
        const prev = parent.getAttribute('data-kite-orig') || '';
        if (!prev.includes(original)) {
          parent.setAttribute('data-kite-orig', prev ? prev + '\n' + original : original);
        }
        const trimmed = translated.trim();
        if (trimmed.length <= 10 && /[\u4e00-\u9fff]/.test(trimmed) && !parent.getAttribute('data-kite-nowrap')) {
          parent.style.whiteSpace = 'nowrap';
          parent.setAttribute('data-kite-nowrap', '1');
        }
      }
    } catch {}
  }
}

function revertLocalization() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let cur = walker.nextNode();
  let count = 0;
  while (cur) {
    const orig = _translatedTextNodes.get(cur);
    if (orig != null && orig !== cur.nodeValue) {
      cur.nodeValue = orig;
      count++;
    }
    cur = walker.nextNode();
  }
  document.querySelectorAll('*').forEach(el => {
    for (const attr of ATTRS_TO_TRANSLATE) {
      const stored = el.getAttribute('data-kite-orig-' + attr);
      if (stored != null) {
        el.setAttribute(attr, stored);
        el.removeAttribute('data-kite-orig-' + attr);
      }
    }
  });
  document.querySelectorAll('[data-kite-nowrap]').forEach(el => {
    el.style.whiteSpace = '';
    el.removeAttribute('data-kite-nowrap');
  });
  document.querySelectorAll('[data-kite-orig]').forEach(el => el.removeAttribute('data-kite-orig'));
  console.log('[Kite][Localization] 已还原 ' + count + ' 个 textNode');
}

function scanAndTranslate(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    if (!root.parentNode || !root.parentNode.isConnected) return;
    translateTextNode(root);
    return;
  }
  const elementRoot = root.nodeType === Node.ELEMENT_NODE ? root : document.body;
  if (!elementRoot || !elementRoot.isConnected) return;
  if (elementRoot.closest && elementRoot.closest(EXCLUDE_SELECTOR)) return;

  translateAttributes(elementRoot);
  const elementList = elementRoot.querySelectorAll ? elementRoot.querySelectorAll('*') : [];
  for (const el of elementList) { translateAttributes(el); }

  const walker = document.createTreeWalker(elementRoot, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) { translateTextNode(current); current = walker.nextNode(); }
}

// ========== 调度器 ==========
let pendingRoots = new Set();
let _locFlushTimer = 0;
let _isTranslating = false;
let localizationObserver = null;
const LOC_DEBOUNCE_MS = 60;

function flushQueue() {
  _locFlushTimer = 0;
  _isTranslating = true;
  try {
    for (const root of pendingRoots) {
      if (root && root.nodeType === Node.ELEMENT_NODE && !root.isConnected) continue;
      if (root && root.nodeType === Node.TEXT_NODE && (!root.parentNode || !root.parentNode.isConnected)) continue;
      scanAndTranslate(root);
    }
  } finally {
    _isTranslating = false;
    if (localizationObserver) localizationObserver.takeRecords();
  }
  pendingRoots.clear();
}

function enqueue(root) {
  pendingRoots.add(root || document.body);
  if (_locFlushTimer) clearTimeout(_locFlushTimer);
  _locFlushTimer = setTimeout(flushQueue, LOC_DEBOUNCE_MS);
}

function startLocalizationObserver() {
  if (localizationObserver) localizationObserver.disconnect();
  localizationObserver = new MutationObserver((mutations) => {
    if (_isTranslating) return;
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') { enqueue(mutation.target); continue; }
      if (mutation.type === 'attributes') { enqueue(mutation.target); continue; }
      for (const node of mutation.addedNodes) { enqueue(node); }
    }
  });
  localizationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS_TO_TRANSLATE,
  });
}

// ========== 入口 ==========
function startLocalization() {
  startLocalizationObserver();
  enqueue(document.body);
  console.log('[Kite][Localization] ✅ 汉化已启用');
}
