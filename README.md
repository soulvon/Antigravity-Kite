# Antigravity Kite 🪁 

[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE) [![Issues](https://img.shields.io/github/issues/soulvon/Antigravity-Kite?style=flat-square)](https://github.com/soulvon/Antigravity-Kite/issues) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/soulvon/Antigravity-Kite/pulls) [![Discussions](https://img.shields.io/github/discussions/soulvon/Antigravity-Kite?style=flat-square)](https://github.com/soulvon/Antigravity-Kite/discussions)

为 **Antigravity IDE**（反重力集成开发环境）量身打造的无感号池管理、多实例分身运行与底层核心增强补丁插件。支持号池池化、多版本账号合并迁移、实时额度监控、Google OAuth 快捷登录，并注入 LaTeX 渲染、智能气泡选项、自动化流转及界面汉化等超级核心增强特性！

---

## 🌟 核心特性

### 1. 📂 号池池化与卡片管理
*   **多账号一键托管** — 支持轻松添加、删除、启用/禁用多个开发账号。
*   **卡片/列表双视图** — 提供高颜值的 **Liquid Glass（流体玻璃态）卡片视图** 与极简的紧凑**列表视图**，自由切换。
*   **标签分组（Tags）** — 为账号贴上自定义标签（如：工作、PRO、备用），支持颜色自定义与全局筛选。
*   **智能检索** — 顶栏快速模糊搜索，一秒定位目标账号。
*   **多窗口同步** — 基于物理共享文件驱动，多个窗口实例实时同步号池状态与账号数据。

### 2. ⚡ 逆天无感秒级切换
*   **一键极速切号** — 在侧边栏卡片上轻轻一点，一秒完成全局账号凭证无感重载，无需注销或重启 IDE！
*   **全局快捷键** — 绑定 `Ctrl+Alt+Shift+K`（macOS 上为 `Cmd+Alt+Shift+K`）可在后台静默秒切下一个账号。
*   **切号限频保护** — 智能计算调用频次，防止操作过快导致账号被官方机制拦截。
*   **多通道极速导入** — 支持 Google OAuth 登录、提取当前会话账号、批量 `邮箱:Token` 文本极速解析，以及与 Cockpit Tools、Antigravity Manager 的数据互通。

### 3. 👥 多实例分身管理 (Multi-Instance Manager)
*   **独立数据目录** — 一键克隆新建或从 Cockpit 导入独立的 IDE 分身实例，每个窗口配置独立 `userDataDir` 数据目录，实现多窗口多号同时运行。
*   **多版本智能探测** — 智能模糊匹配各种安装路径，自动识别 1.x 时代的主程序（`Antigravity.exe`）与 2.0 新独立版（`Antigravity IDE.exe`）。
*   **一键手动选路径** — 在多实例面板上直观提供“浏览/选择”主程序组件，允许用户手动指定改名共存版（如 `Antigravity1.20.5`）的 EXE 路径，提供最高优先级的自定义。
*   **深度去重合并迁移** — 当多版本共存启动时，插件自动将各版本 legacy globalStorage 下的账号与实例数据进行去重合并，并重命名备份（生成 `.migrated` 后缀），防止数据覆盖丢失。

### 4. 🛠️ 强大的底层核心增强 (Enhancement Pack)
*   **LaTeX 公式渲染** — 自动实时解析并渲染 AI 回复内容中的块级（Block）和行内（Inline）LaTeX 数学公式，让公式显示为精美的印刷级排版。
*   **回复建议气泡 (Interactive Bubbles)** — 智能解析 AI 回复中的 `:::bubbles` 标记，生成带渐变主题流光动画的交互式按钮。支持多选、单选及自动填充发送。
*   **自动同意与继续 (Auto-Accept & Auto-Continue)** — 自动模拟点击 AI 执行的各项弹窗确认（如 Accept、Run、Allow、Continue 等），大幅提升自动化流转效率。支持设置限制执行次数及危险黑名单命令拦截。
*   **界面汉化 (Localization Translation)** — 动态翻译 IDE 各大系统级设置和核心菜单文本，提供更贴心的本土化体验。
*   **校验和自动修复** — 针对注入补丁修改，自动计算并修复 `product.json` 中的 SHA256 校验和，彻底告警“IDE 已损坏，请重新安装”的 VS Code 系统提示弹窗。

### 5. 📊 实时配额与额度监控
*   **模型级配额进度条** — 分模型实时监控限额，配额条自带渐进彩色与**高级 Shimmer 动态流光动效**。
*   **一键全额刷新** — 顶部一键并行获取并更新所有在线账号的可用模型额度。
*   **OAuth 自动刷新** — 在执行额度查询或切号前，系统自动在后台静默刷新 OAuth Token，确保会话永远在线。

---

## 🚀 安装与编译

```bash
# 1. 克隆代码后安装依赖
npm install

# 2. 编译 TypeScript 代码
npm run compile

# 3. 打包生成新版本 VSIX 插件文件
npm run package
```

编译并打包完成后，项目根目录会生成 `antigravity-kite-0.8.9.vsix`。在 Antigravity IDE 插件市场选择“**从 VSIX 安装...**”即可。

---

## 💡 快速上手

1. 打开 **Antigravity Kite** 侧边栏面板（顶部的 🪁 标志）。
2. 通过 **Google 登录**、**导入当前账号** 或**手动输入 Token** 的方式向池中添加您的账号。
3. 点击任意账号卡片底部的 **▶ 切换** 按钮，开启丝滑切号。
4. 在 **增强** 面板中，开启汉化、公式渲染与智能气泡等选项，点击 **“应用增强配置”** 并重启一次 IDE 即可生效。
5. 在 **实例** 面板中，配置主程序路径，点击 **“+ 新建”** 即可快速生成并启动完全隔离的独立 IDE 窗口！

---

## ⌨️ 默认快捷键

| 快捷键             | 对应动作                     |
| ------------------ | ---------------------------- |
| `Ctrl+Alt+Shift+K` | 自动切换至号池中的下一个账号 |
| `Ctrl+Shift+Q`     | 快速打开 Kite 日志控制台面板 |

---

## ⚙️ 插件配置参数

在 IDE 的设置（Settings）中搜索 `antigravityKite` 即可进行定制化配置：
*   `antigravityKite.customIdeExePath` — 手动设置自定义的 Antigravity 主程序可执行文件路径（用于多实例分身）。
*   `antigravityKite.update.autoCheck` — 启动时是否自动检查插件更新。
*   `antigravityKite.update.autoInstall` — 发现新版本时是否自动静默下载安装。

---

## 🔒 兼容性与运行系统

- **Windows / macOS / Linux**。
- **Antigravity IDE 1.18.4 ~ 2.0+** — 完美支持多版本兼容及数据无缝同步迁移。

---

## 🤝 参与贡献与问题反馈

- 🐛 **发现 Bug** → [提交 Issue](https://github.com/soulvon/Antigravity-Kite/issues)
- 💡 **功能建议** → [提交 Feature Request](https://github.com/soulvon/Antigravity-Kite/issues/new/choose) 或参与 [Discussions 讨论](https://github.com/soulvon/Antigravity-Kite/discussions)
- 🚀 **提交 PR** → 欢迎提交 Pull Request，详情请参考 [贡献指南](.github/CONTRIBUTING.md)

---

## 👤 作者信息

**soulvon** — [GitHub 主页](https://github.com/soulvon)

---

## 📄 开源协议

本项目基于 **MIT** 开源协议。
