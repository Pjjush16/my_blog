# my_blog · YAONET

自用的极简静态博客系统。**读者端零后台**：读者访问博客时，不需要数据库、不需要登录、不需要任何服务端 API，也不依赖运行时后端进程。所有页面和文章都是静态文件，浏览器拿到后在前端完成渲染。作者侧另有一个 Cloudflare Worker 管理控制台，但它不参与读者访问链路。

## 读者端零后台（核心设计）

读者打开博客时，请求链路只有一条：

```
浏览器 → Cloudflare Pages 静态文件 → 浏览器内 marked / highlight 渲染
```

具体来说：

- **没有数据库**：文章就是 `content/posts/` 下的 Markdown 文件。
- **没有登录**：读者不需要账号、Cookie 或会话。
- **没有服务端 API**：读者端不调用任何后端接口。
- **没有运行时后端**：不需要 Node、PHP、Java 等进程常驻。
- **没有服务端渲染依赖**：文章列表读取预生成的 `content/index.json`，正文由浏览器端 `marked.min.js` 渲染。
- **Worker 不参与读者端**：`Cloudflare/workers/workers.js` 只给作者管理文章用，读者完全不经过它。即使 Worker 不可用，读者端博客仍可正常浏览。

需要区分的是：**构建时**会由 GitHub Actions 生成索引，但**读者请求时**没有任何后台参与。这是“读者端零后台”，不是“零构建”。

## 在线地址

| 用途 | 地址 |
|---|---|
| 个人主页（Cloudflare Pages） | https://yaonet.de5.net |
| 博客文章列表 | https://blog.yaonet.de5.net |
| 管理控制台（作者侧 Worker） | `/admin` 路径，需自行配置环境变量 |
| GitHub 仓库 | https://github.com/Pjjush16/my_blog |

## 仓库结构

```
my_blog/
├── .github/
│   └── workflows/
│       └── main.yml              # 索引自动重建工作流
├── Cloudflare/
│   ├── Pages/
│   │   ├── email.png             # 邮箱二维码
│   │   ├── favicon.ico
│   │   ├── index.html            # 个人主页（Pages 部署）
│   │   └── telegram.png          # Telegram 二维码
│   └── workers/
│       └── workers.js            # 作者侧管理控制台 Worker
├── content/
│   ├── posts/                    # 6 篇 Markdown 文章
│   │   ├── post-mvvo2j6t.md
│   │   ├── post-mvvwck6q.md
│   │   ├── post-mvx2q754.md
│   │   ├── post-mw4sz2xx.md
│   │   ├── post-mwc7nti6.md
│   │   └── post-mwf06jqg.md
│   └── index.json                # 自动生成的文章索引，勿手动编辑
├── lib/
│   ├── github-dark.min.css       # 代码高亮深色主题
│   ├── github.min.css            # 代码高亮浅色主题
│   ├── gitkeep                   # 目录占位文件
│   ├── highlight.min.js          # 代码高亮
│   └── marked.min.js             # Markdown 渲染
├── scripts/
│   └── build-index.js            # 零依赖索引构建脚本
├── .nojekyll                     # 绕过 GitHub Pages Jekyll 处理
├── CNAME                         # blog.yaonet.de5.net
├── LICENSE                       # AGPL-3.0
├── favicon.ico
└── index.html                    # 博客文章列表页
```

根目录没有 `package.json`、`.gitignore` 或 `.editorconfig`，项目刻意保持最小文件集。

## 读者端如何工作

1. 读者访问 `blog.yaonet.de5.net`，Cloudflare Pages 直接返回静态 `index.html`、`lib/` 下的 JS/CSS 和 `content/index.json`。
2. 浏览器读取 `content/index.json`，渲染文章列表。
3. 读者打开文章时，浏览器加载对应 Markdown 文件，由 `marked.min.js` 解析为 HTML，再由 `highlight.min.js` 做代码高亮。
4. 全程没有数据库查询、没有服务端接口、没有登录态校验。

文章 frontmatter 包含 `title`、`excerpt`、`createdAt` 三个字段。文件名采用 `post-` 加一段 ID 的格式。

## 作者侧管理控制台（与读者端隔离）

`Cloudflare/workers/workers.js` 是一个 Cloudflare Worker，提供作者用的文章管理界面，直接读写 GitHub Contents API。它暴露以下路由：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` 或 `/admin` | 管理页面 HTML |
| GET | `/favicon.ico` | 头像（可通过 `FAVICON_URL` 环境变量覆盖） |
| GET | `/api/posts` | 文章列表 |
| GET | `/api/post` | 单篇文章内容 |
| POST | `/api/save` | 保存文章 |
| POST | `/api/delete` | 删除文章 |

Worker 本身不包含 Basic Auth，注释中明确建议在 Cloudflare Access 或外层网关做鉴权。需要配置的环境变量包括 `GITHUB_TOKEN`、`GITHUB_OWNER`、`GITHUB_REPO`，可选 `GITHUB_BRANCH`（默认 `main`）和 `FAVICON_URL`。

这个 Worker 是**作者侧工具**，不是读者端后台。读者浏览博客不会调用它。

## 索引构建：`scripts/build-index.js`

脚本仅依赖 Node.js 内置模块，零 npm 依赖。它扫描 `content/posts/*.md`，解析 frontmatter，按 `createdAt` 倒序排列，写出 `content/index.json`。本地重建：

```bash
node scripts/build-index.js
```

## 自动化：`.github/workflows/main.yml`

工作流在两种情况下触发：

1. **推送触发**：`content/posts/**.md` 有变更并推送到 `main` 时运行。
2. **定时兜底**：每 30 分钟运行一次（`cron: '*/30 * * * *'`），防止手动修改文件或异常情况下索引未更新。GitHub Actions 的 cron 不保证准点，延迟几分钟属正常。

提交使用 `github-actions[bot]` 身份，仅当 `index.json` 实际变化时才 commit push，避免空提交。工作流有 `concurrency` 控制，同一时间只运行一个重建任务。

## 部署

博客和主页通过 **Cloudflare Pages** 托管，推送到 `main` 即触发部署。Pages 只负责静态文件分发，不在部署侧运行任何构建命令——索引由 GitHub Actions 维护。`CNAME` 绑定 `blog.yaonet.de5.net`，`.nojekyll` 确保 `content/` 等目录被原样发布。

Worker 需要在 Cloudflare 仪表板或 Wrangler 中单独部署，并配置上述环境变量。它只影响作者管理文章，不影响读者端零后台浏览。

## 本地预览

```bash
git clone https://github.com/Pjjush16/my_blog.git
cd my_blog

# 可选：重建索引
node scripts/build-index.js

# 预览博客列表
npx serve .
# 或
python3 -m http.server 8080
```

预览个人主页时，进入 `Cloudflare/Pages/` 目录，用同样的方式启动静态服务器即可。

## License

GNU Affero General Public License v3.0（AGPL-3.0），见根目录 `LICENSE` 文件。
