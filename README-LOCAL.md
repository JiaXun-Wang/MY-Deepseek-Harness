# DeepSeek Harness 本地版（dsh web）

这是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的本地可运行安装（`0.1.0-rc.5`，基线 commit `47f9438`，`master` 跟踪官方上游）。

- **纯软件版本**：Node.js + pnpm 管理的纯 JS/TS 包，无需编译 native 层即可运行 `dsh web`。
- **Web UI 主题已美化**：默认暗色，中性暖灰底 + DeepSeek 蓝强调，风格接近 Codex 的简洁现代暗色界面；全部 Harness 功能保留。
- **支持 `git pull` 接入上游更新**：本地 `master` 基于官方 `origin/master`，含一个本地美化提交。

## 环境要求

- [Node.js](https://nodejs.org) `^22.19.0 || >=24.0.0`
- [pnpm](https://pnpm.io) `11.x`

## 一键启动

双击桌面快捷方式 **「DeepSeek Harness Web」**（对应本目录 `start-dsh-web.ps1`）：

1. 启动本地服务（默认 `http://127.0.0.1:3080`）。
2. 服务就绪后自动在浏览器打开界面。
3. 若 3080 已被其他程序占用，会自动改用系统分配的端口并在日志中给出实际地址。

命令行方式：

```powershell
# PowerShell，切换到本目录
powershell -ExecutionPolicy Bypass -File .\start-dsh-web.ps1
```

或直接从源码：

```sh
pnpm dsh web             # 默认 127.0.0.1:3080
pnpm dsh web --port 8080 # 指定端口
```

> **首次使用模型**：对话需要配置 DeepSeek API Key。在本目录 `.env` 设置 `DEEPSEEK_API_KEY=...`（可选 `DEEPSEEK_BASE_URL=...`），重启服务即可。

## 目录结构（交付物）

| 路径 | 说明 |
| --- | --- |
| `start-dsh-web.ps1` | 启动脚本：拉起服务 + 打开浏览器（端口冲突自动换端口） |
| `apps/web/dist/` | 已构建的前端（`dsh web` 直接服务它） |
| `apps/cli/lib/` | 已构建的 CLI（`node apps/cli/lib/bin.js web` 即 `dsh web`） |
| `packages/client/ui-theme/src/styles/` | 主题 token 源（本项目的美化修改点） |
| `.npmrc` | pnpm 本地 store 配置 |
| `logs/dsh-web.log` | 服务日志（启动后生成） |

## 源码构建（可选 / 更新后）

首次或拉取上游后需要重新构建：

```sh
pnpm install
pnpm run build     # = build:lib (host+client) + build:web (前端)
```

然后启动即可。macOS/Linux 之外无需编译 native 包；Windows 上 `koffi` 等 native 依赖的 `postinstall` 会被 `--ignore-scripts` 跳过，不影响 `dsh web` 运行。

## 拉取上游更新

```sh
git pull origin master
```

- 本地 `master` 已跟踪 `origin/master`，并以 `http.sslBackend=openssl` 配置好（当前网络对 github.com 的默认 schannel 证书握手可能失败，使用 openssl 后端可稳定拉取）。
- 拉取后如有上游 `.css`/主题改动与本地美化冲突，`git status` 会提示；本地美化都集中在 `packages/client/ui-theme/`，冲突时先看 `design-platform.css` 与 `theme-settings.ts`。
- 拉取后运行 `pnpm install && pnpm run build` 使改动生效。
