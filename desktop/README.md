# DeepSeek Harness —— 桌面应用壳

把 `Deepseek_DP` 里已构建的 `dsh web` 包成**独立桌面窗口应用**（Electron）。
窗口加载本地 `http://127.0.0.1:3080` 的 Harness Web UI，不占用浏览器标签页，
并以自己的图标/标题栏/任务栏存在，观感接近原生桌面软件。

## 运行

```powershell
# 首次：安装 Electron（走 npmmirror 镜像，快）
pnpm --dir desktop install

# 启动桌面应用
pnpm --dir desktop start
```

或直接双击桌面的 **「DeepSeek Harness」** 快捷方式
（其目标为 `desktop\node_modules\electron\dist\electron.exe`，工作目录 `desktop`）。

## 行为

- 在**专属端口 `5180`** 启动这个 DeepSeek Harness 自己的 `dsh web` 服务
  （不占用网页版惯用的 `3080`，以免与本机其他 Harness/页面实例冲突；可用环境变量 `DSH_DESKTOP_PORT` 覆盖）。
- 只有当端口上**已经是真实的 Harness 界面**（返回含 `#root` / Harness 标题）时才复用；
  若被无关 Web 程序占用或为空，则自动新起自己的服务（必要时改用系统空闲端口）。
- 窗口关闭时停止本次启动的服务进程并退出进程树。
- 渲染进程 `sandbox + contextIsolation` 开启，`nodeIntegration` 关闭，只做桌面框查看，不注入特权 API。
- 外部 `https?` 链接用系统默认浏览器打开（`setWindowOpenHandler` 拦截 + `shell.openExternal`）。

## 换 Tauri（后续优化）

壳与核心完全分离：`main.js` 只负责「拉起 dsh web 服务 + 开一个窗口加载 3080」。
日后换 Tauri 壳时，`dsh web` 启动逻辑整体复用，仅替换窗口载体即可。
