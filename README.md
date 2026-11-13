# 墨页 Moye

墨页是一个 Windows Markdown 编辑器。写作时直接看见标题、表格、公式和代码排版，也可以随时切到源码。适合日常笔记、技术文档和需要打印的算法模板。

[下载 Windows x64 便携版](https://github.com/qqbb111/Moye/releases/latest)

![墨页白色主题中的城市漫步笔记，左侧显示大纲](docs/preview.png)

## 开始使用

1. 在 GitHub Releases 下载 `Moye-…-windows-x64.zip`，解压整个目录，运行 `Moye.exe`。
2. 点击标签栏的 **＋** 新建，或按 **Ctrl+O** 打开 Markdown。**Ctrl+P** 可以按文件名和路径快速打开文档。
3. 新安装默认使用白色主题。左上角的 **主题** 可以切换界面主题和代码配色，PDF 和 HTML 导出在 **文件** 菜单，**设置** 可调整排版及快捷键。

从 0.9.9 起，可在 **设置 → 关于 → 检查更新** 下载正式版并保存草稿后重启。0.9.8 用户需要手动升级一次。

目前发布的 Windows ZIP 未做 Authenticode 签名，首次启动时可能出现 SmartScreen 提示。下载后可用 Release 页面列出的 SHA-256 校验 ZIP。

## 写作与导出

- **即时排版**支持 Markdown 表格、任务列表、代码块、KaTeX 和 Mermaid。**Ctrl+/** 在源码与排版间切换，并跟随当前阅读位置。
- **文档管理**支持可拖动的标签页、独立窗口、文件树和大纲。按 **F2** 可在原位置编辑文件、草稿或活动标签的名称。未命名草稿保存在本机，重新打开墨页可以继续写。
- **中文与代码**支持一键整理中英文间距。浅色、夜间和 Copilot 深色主题内置霞鹜文楷，WorkBuddy 主题内置 Source Code Pro 和离线语法高亮。
- **快捷键**按文件、编辑、段落、格式、视图和应用分类。点按键即可录制，修改即时保存。
- **PDF**支持 A4 单栏和双栏、黑白省墨与浅色高亮。长代码按行分页，预览和保存使用同一份 PDF。打印含网络图片的文档前，请先将图片下载并通过「插入图片」导入为附件。
- **HTML**跟随当前主题及阅读宽度。表格铺满正文，长单元格会自动折行。

本地图片会从文档所在文件夹及其子文件夹加载。目录外的图片可通过 **插入图片** 选取，墨页会把它复制为附件。

## 本地数据

墨页在 Windows 将未保存草稿、打开的标签和偏好记录在 `%APPDATA%\Typora Replica\recovery\workspace.json`，上一份有效记录为同目录的 `workspace.json.bak`。尚未保存到文档目录的图片附件放在 `recovery\assets`。重装或迁移电脑前，可以备份整个 `recovery` 目录。已保存的 Markdown 文件仍放在你选定的位置。

## 从源码构建

使用 Node.js 24，在 Windows 上运行：

```powershell
npm ci
npm run build
npm start
```

`npm test` 运行单元测试，`npm run test:e2e` 运行桌面测试。验证均使用隔离配置。

`node scripts/smoke-release.mjs --targeted` 验证刚解压的 Windows ZIP，包括编辑保存、PDF 和重启恢复。Windows CI 在主分支更新和 PR 上执行同一套验证。版本记录见 [CHANGELOG](CHANGELOG.md)。

- `npm run package` 生成或更新本机便携版，启动路径为 `release/Typora Replica-win32-x64/Typora Replica.exe`，也可以使用项目根目录的 `启动Typora.bat`。
- `npm run package:zip` 生成发布用 Windows x64 ZIP。将 `Moye-<版本>-windows-x64.zip` 按原名附到对应 `v<版本>` 的正式 GitHub Release。应用内更新使用 GitHub 附件记录中的 SHA-256 校验 ZIP。

## 字体与第三方声明

便携包包含运行环境和字体，无需另行安装 Node.js、霞鹜文楷或 Source Code Pro。字体及依赖许可随包提供。[霞鹜文楷许可](assets/fonts/LICENSE-LXGWWenKai.txt) · [Source Code Pro 许可](assets/fonts/LICENSE-SourceCodePro.txt) · [第三方声明](THIRD_PARTY_NOTICES.txt)
