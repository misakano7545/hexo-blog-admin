# hexo-blog-admin

简体中文 | [English](README.en.md)

`hexo-blog-admin` 是一个基于 Vite + React + TypeScript 的 Hexo 博客管理后台，运行在 Cloudflare Workers 上

目标数据模型如下：

| 数据 | 存储位置 |
| --- | --- |
| 正式 Markdown 文章 | GitHub 仓库 |
| 正式图片资源 | GitHub 仓库 |
| 草稿 Markdown | Cloudflare D1 |
| 草稿图片临时缓存 | Cloudflare R2，未绑 R2 时用 `BLOG_ADMIN_KV` |
| 草稿图片 metadata | Cloudflare D1 |
| 运行时配置 | Worker Variables / KV |
| GitHub Token | Worker Secret |
| 构建和部署 | GitHub Actions |
| 后台公开索引摘要 | 博客构建产物 `admin-index.json` |

R2 只作为草稿临时缓存，不作为正式图床；草稿图片只是在发布前临时停放，发布时会提交到博客仓库。

## 安装

```bash
pnpm install
```

## 本地开发

```bash
pnpm dev
```

本地调试可以在项目根目录创建 `.dev.vars`，这个文件不要提交：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=本地管理员密码
```

常用检查：

```bash
pnpm typecheck
pnpm build
```

更完整的架构、目录、API 和开发约定见 [开发文档](docs/development.md)。开发新主题设置 adapter 见 [主题设置 Adapter 开发指南](docs/customize-adapter-development.md)。

预览生产构建：

```bash
pnpm preview
```

## Troubleshooting

生产环境如果直接访问 `/posts` 或刷新 `/posts/edit` 出现 Not Found，说明 SPA fallback 没生效。本项目通过 Worker fallback 和 wrangler assets `single-page-application` 保证生产直达路由可用。

Cloudflare Vite plugin 的本地 dev server 对深层 SPA 直达路由可能和生产 Worker 不完全一致。如果 `pnpm dev --host` 下直接打开 `/posts` 出现 Not Found，可以先打开 `/`，再通过应用内导航进入对应页面；生产部署仍应正常支持深层直达和刷新。

通过 Wrangler 部署：

```bash
pnpm deploy
```

`pnpm deploy` 等价于 `vite build && wrangler deploy`。`vite build` 会在 `dist/hexo_blog_admin/wrangler.json` 生成一份输出配置，并写 `.wrangler/deploy/config.json` 让后续 `wrangler deploy` 自动重定向到它；所以不要在 `vite build` 和 `wrangler deploy` 之间删掉 `.wrangler/`，否则 `wrangler deploy` 会拿根 `wrangler.jsonc` 直接报 `assets property is missing the required directory property`。

两个实际踩过的坑：

- **不要在 `wrangler.jsonc` 里声明 `r2_buckets`。** 只写 binding 名（没有 bucket 名）时 `wrangler deploy` 会把它当成「需要自动创建的资源」，去调 `POST /accounts/<id>/r2/buckets`，没开通 R2 订阅的账号会直接失败：`code: 10042 Please enable R2`，整次部署中断。要用 R2 请在 Dashboard 的 Worker Bindings 里手动加 `BLOG_ASSET_CACHE`。
- **`workers_dev` / `preview_urls` 显式写 `false`。** 不写时 `wrangler deploy` 会默认启用 `https://<worker>.<account>.workers.dev` 和 Preview URL，这会绕过 Worker 前面的 Cloudflare Access 策略，把后台暴露在公网域名上。本项目已写入 `false`。

部署后自检：

```bash
curl -s https://<你的后台域名>/api/health
curl -s https://<你的后台域名>/api/setup/status   # 期望 configured: true
```

## GitHub Token

建议使用 Fine-grained Personal Access Token，并且只授权选中的博客仓库。

推荐权限：

```txt
Metadata: Read
Contents: Read and write
```

请把 token 保存为 Cloudflare Worker Secret，不要写入仓库文件。

```bash
pnpm wrangler secret put GITHUB_TOKEN
```

内置管理员账号和密码保存为 Worker Secret：

```bash
pnpm wrangler secret put ADMIN_USERNAME
pnpm wrangler secret put ADMIN_PASSWORD
```

## Worker Variables

在 Cloudflare Workers Dashboard 的 Variables and Secrets 中配置这些变量。项目不在 `wrangler.jsonc` 写普通 `vars`，并且设置了 `keep_vars: true`，避免每次 `wrangler deploy` 覆盖你在 Cloudflare Dashboard 手动维护的值。

```txt
GITHUB_OWNER=PLFJY
GITHUB_REPO=blog
GITHUB_BRANCH=main
POSTS_DIR=source/_posts
BLOG_PUBLIC_URL=https://你的博客域名
ADMIN_INDEX_PATH=/admin-index.json
```

变量用途：

| 变量 | 用途 |
| --- | --- |
| `GITHUB_OWNER` | 博客仓库所属账号或组织，例如 `PLFJY`。 |
| `GITHUB_REPO` | 博客仓库名，例如 `blog`。后台读取文章和发布草稿都会操作这个仓库。 |
| `GITHUB_BRANCH` | 博客仓库发布分支，例如 `main`。读取文章和提交草稿都使用这个分支。 |
| `POSTS_DIR` | Hexo 文章目录，例如 `source/_posts`。用于计算 `relativeId` 对应的 Markdown 路径。 |
| `BLOG_PUBLIC_URL` | 已部署博客的公开地址。后台会从这里读取 `ADMIN_INDEX_PATH`。 |
| `ADMIN_INDEX_PATH` | 博客构建产物里的后台公开索引摘要路径，例如 `/admin-index.json`。 |

这些变量没有 fallback，也没有默认值。缺少任意一项时，后台会显示 SetupRequiredPage 并阻止进入主界面。

可选变量：

```txt
BLOG_ASSET_PUBLIC_URL=https://blog-admin-cache.plfjy.top
```

`BLOG_ASSET_PUBLIC_URL` 用于给草稿暂存图片生成公开 R2 访问 URL，让 Markdown 预览和图片仓缩略图绕过 Worker 图片代理。不配置时仍保持原有 `/api/assets/blob` fallback 行为。该 URL 对应的 R2 bucket/custom domain 应能公开访问 `draft-assets/*` 对象；不要把这个域名写死在源码里。

`ADMIN_USERNAME`、`ADMIN_PASSWORD` 和 `GITHUB_TOKEN` 是 secret，不会显示在配置状态里。`ADMIN_USERNAME` 对应内置管理员账号；登录后台后可以在设置页新增普通账号，普通账号密码会以加盐哈希保存到 KV。

登录后可以在设置页「修改密码」自助改密码：

- 普通账号：校验当前密码后重写 `auth:user:<username>` 里的盐和哈希，改完立即生效。
- 内置管理员：校验当前密码后把新密码的盐和哈希写入 KV 的 `auth:admin:builtin`，不需要重新执行 `wrangler secret put ADMIN_PASSWORD`。
- `ADMIN_PASSWORD` secret 始终优先命中，所以忘记新密码时仍可用 secret 登录，改完再重新设置。
- 管理员还可以在账号列表里直接「重置密码」其他普通账号（内置管理员不支持，避免和 secret 冲突）。
- 新密码要求 8-128 位，并同时包含字母和数字。
- 修改密码不会让已登录的其他设备立即下线：session cookie 只签名用户名和过期时间。

当前兼容日期固定为 `2026-04-30`，这是已安装本地 Miniflare 运行时支持的最新日期；升级 Cloudflare 工具链后可以按需调高。

## KV、D1 和 R2 绑定

创建用于后台低频状态的 KV namespace。namespace 名字可以自定，但 Worker binding 名必须是 `BLOG_ADMIN_KV`：

```bash
pnpm wrangler kv namespace create BLOG_ADMIN_KV
```

创建 D1 database，用于草稿正文和草稿图片 metadata：

```bash
pnpm wrangler d1 create hexo-blog-admin
```

D1 binding 名必须是：

```txt
BLOG_ADMIN_DB
```

初始化 D1 表结构。D1 binding 只表示 Worker 能连接到这个 database；本项目会在 `BLOG_ADMIN_DB` 已绑定后由 Worker 自动创建 `drafts` / `draft_assets` 表，首次打开后台或请求 `/api/setup/status` 即会触发。

如果你希望在部署前显式初始化，也可以手动执行：

```bash
pnpm wrangler d1 migrations apply hexo-blog-admin
```

如果自动初始化失败，setup 页面会显示 `BLOG_ADMIN_DB_SCHEMA`，请查看 Worker 日志和 D1 绑定权限后刷新重试。

草稿图片临时缓存可以放 R2，也可以留在 KV 里，见下一节。要建 R2 bucket 时名字可以自定，但 Worker binding 名必须是 `BLOG_ASSET_CACHE`：

```bash
pnpm wrangler r2 bucket create hexo-blog-admin-cache
```

如果你给这个 R2 bucket 配置了公开 custom domain，可以在 Worker Variables 里额外设置 `BLOG_ASSET_PUBLIC_URL`，让草稿图片预览直接使用公开 URL；不设置也可以继续通过 Worker 的 `/api/assets/blob` 读取。

绑定名称如下：

```txt
BLOG_ADMIN_KV      必需
BLOG_ADMIN_DB      必需
BLOG_ASSET_CACHE   可选（R2 未绑定时草稿图片落在 BLOG_ADMIN_KV）
```

## 草稿图片存储：R2 或 KV

草稿图片只在「草稿箱」里临时停放，发布时会作为正式资源提交到博客 GitHub 仓库，所以这里不需要长期存储。R2 需要给 Cloudflare 账号开通 R2 订阅并绑定付款方式，免费账号如果不想开，可以直接跳过 R2：

- 绑定了 `BLOG_ASSET_CACHE`：图片 blob 存 R2，`BLOG_ADMIN_KV` 只放账号和 UI 配置。
- 没有绑定 `BLOG_ASSET_CACHE`：自动回落到已经必需的 `BLOG_ADMIN_KV`，key 前缀为 `asset:<r2_key>`，值直接是图片字节，`contentType` 放在 KV metadata 里。R2 始终优先，两者都绑定时不会用 KV。
- 仍然要求至少存在其中一个 binding：`BLOG_ASSET_CACHE`、`BLOG_ADMIN_KV` 都没有时 setup 页会提示缺 `BLOG_ASSET_CACHE`，后台不进主界面。

KV 这条路径的硬限制（Cloudflare Workers KV 官方配额，免费版每天 00:00 UTC 重置）：

```txt
单个 value      25 MiB
写入           1,000 次/天（每次上传图片算 1 次）
删除           1,000 次/天（每次删除草稿图片算 1 次）
列表           1,000 次/天（草稿图片列表页每刷新一次算 1 次）
总存储          1 GB/账号
```

所以：

- 超过 25 MiB 的单张图片会直接失败，KV 会在 `put` 时就报错，不是静默截断。
- 大批量上传会先撞写入配额，攒很多草稿图片会撞 1 GB 存储上限；配额用完后当天的上传、删除和发布都会报错，需要等配额重置或改成绑定 R2。
- 任何一项配额超限后，同一类操作当天都会失败，`wrangler` 和 Dashboard 里的操作也算配额。
- 前端对超过 500 KiB 的图片会弹窗询问是否压缩成 WebP（最长边 2560），也可以选择上传原图。用 KV 路径时建议保持压缩，既省配额也远离 25 MiB 上限。
- 两种模式下草稿图片都通过 Worker 的 `/api/assets/blob` 读取；`BLOG_ASSET_PUBLIC_URL` 只在有 R2 custom domain 时才有意义，KV 路径没有公开 URL。

`wrangler.jsonc` 只声明代码需要的 binding 名，不提交占位 `database_id` 或 `database_name`，避免 CI 部署时把占位值当成无效资源配置。请在 Cloudflare Dashboard 的 Worker Bindings 里手动绑定 D1 database；Dashboard 手动绑定时 binding 名必须是 `BLOG_ADMIN_DB`。

如果你的部署方式要求在 `wrangler.jsonc` 中显式写入 id，请使用 `pnpm wrangler d1 create hexo-blog-admin` 返回的真实 `database_id`，不要保留占位值。

请在 Cloudflare Dashboard 的 Worker Bindings 里把你自己的 KV/R2 资源绑定到上面的名称。KV 保留 session/auth 状态、少量配置缓存和（未绑 R2 时的）草稿图片 blob；`admin-index.json` 每次从博客公开站点直接读取。草稿正文和草稿图片 metadata 存在 D1。

`BLOG_ADMIN_KV` 和 `BLOG_ADMIN_DB` 是必需项：没有绑定时后台不会进入主界面。`BLOG_ASSET_CACHE` 不是必需项，缺省时草稿图片回落到 `BLOG_ADMIN_KV`（限制见上一节）。

推荐部署顺序：

```bash
pnpm wrangler d1 create hexo-blog-admin
pnpm deploy
```

部署完成后，在 Cloudflare Dashboard 中确认 `BLOG_ADMIN_DB` 已绑定；打开后台时 Worker 会自动完成 D1 表结构初始化。

## 部署入口

本项目只支持独立后台子域名部署，应用运行在根路径 `/`，API 固定为 `/api/*`。

Cloudflare Worker route 示例：

```txt
admin.example.com/*
```

你的实际部署可以使用：

```txt
admin.blog.plfjy.top/*
```

访问入口：

```txt
https://admin.blog.plfjy.top/
```

API 路径：

```txt
/api/*
```

如果以前配置过博客子路径 route，例如 `blog.plfjy.top/admin` 或 `blog.plfjy.top/admin/*`，可以从 Cloudflare Worker routes 中删除。后台不再支持挂载到博客子路径。

## 博客仓库侧配置 admin-index.json

后台的公开索引摘要来自博客站点发布的 `admin-index.json`。它不再只是文章列表，而是博客构建后生成的后台快速索引入口。你的 Hexo 博客仓库需要在构建产物 `public/` 中生成这个文件，并且在部署博客前把它一起发布出去。

推荐做法是在博客仓库新增一个脚本，例如：

```txt
tools/generate-admin-index.mjs
```

**本仓库提供了一份可直接复制的示例脚本：`tools/generate-admin-index.mjs`。**

脚本需要扫描文章、读取站点摘要配置，并检查 Hexo 设置和主题设置相关文件是否存在：

```txt
source/_posts/**/*.md
```

并输出：

```txt
public/admin-index.json
public/admin-index/post-assets/<relativeId>.json
```

`admin-index.json` v3 是后台公开轻索引摘要，包含：

- `posts` / `tree`：文章管理索引。
- 每篇文章的 `assetIndexPath` / `assetCount` / `assetTotalSize`。
- `site`：站点和主题摘要。
- `customize`：可用 adapter、面板和可编辑文件存在状态。

它不包含全站图片清单、每篇文章完整图片数组、`_config.yml`、主题配置或 `_data/*.yml` 的正文。Hexo 设置和主题设置真正编辑内容时仍然通过 GitHub API 读取源文件。

每篇文章的源站图片索引会单独生成到：

```txt
public/admin-index/post-assets/<relativeId>.json
```

后台编辑某篇文章时才通过 `/api/posts/assets?relativeId=...` 读取该文章自己的图片索引。

索引至少需要包含：

```json
{
  "version": 3,
  "generatedAt": "2026-05-09T00:00:00.000Z",
  "postsDir": "source/_posts",
  "assetMode": "post-folder",
  "assetIndexMode": "per-post-json",
  "assetIndexBasePath": "/admin-index/post-assets/",
  "site": {
    "title": "My Blog",
    "subtitle": "Notes and code",
    "author": "PLFJY",
    "url": "https://example.com",
    "language": "zh-CN",
    "timezone": "Asia/Shanghai",
    "theme": {
      "name": "redefine",
      "packageName": "hexo-theme-redefine",
      "packageVersion": "^2.9.0",
      "configPath": "_config.redefine.yml"
    }
  },
  "customize": {
    "detectedTheme": "redefine",
    "availableAdapters": ["common", "redefine"],
    "availablePanels": ["site-basic", "about-page", "redefine-basic", "redefine-visual"],
    "files": [
      {
        "id": "site-config",
        "path": "_config.yml",
        "type": "yaml",
        "exists": true
      }
    ]
  },
  "posts": [
    {
      "relativeId": "ap-csa/00-about-ap-csa",
      "title": "AP CSA 00 - 关于AP Computer Science A",
      "path": "source/_posts/ap-csa/00-about-ap-csa.md",
      "folderPath": "ap-csa",
      "postSlug": "00-about-ap-csa",
      "assetDir": "source/_posts/ap-csa/00-about-ap-csa/",
      "markdownAssetPrefix": "00-about-ap-csa",
      "assetIndexPath": "/admin-index/post-assets/ap-csa/00-about-ap-csa.json",
      "assetCount": 1,
      "assetTotalSize": 12345
    }
  ],
  "tree": [
    {
      "id": "ap-csa/00-about-ap-csa",
      "name": "00-about-ap-csa",
      "type": "post",
      "postRef": "ap-csa/00-about-ap-csa"
    }
  ]
}
```

单篇图片索引 shard 示例：

```json
{
  "version": 1,
  "relativeId": "ap-csa/00-about-ap-csa",
  "assetCount": 1,
  "assetTotalSize": 12345,
  "assets": [
    {
      "filename": "ap-csa-range.png",
      "repoPath": "source/_posts/ap-csa/00-about-ap-csa/ap-csa-range.png",
      "markdownPath": "00-about-ap-csa/ap-csa-range.png",
      "size": 12345
    }
  ]
}
```

在博客仓库 `package.json` 中添加：

```json
{
  "scripts": {
    "generate:admin-index": "node tools/generate-admin-index.mjs"
  }
}
```

然后在博客仓库的 GitHub Actions 中，放到 Hexo 构建之后、Pages/静态站点部署之前：

```yaml
- name: Build
  run: npm run build

- name: Generate admin index
  run: npm run generate:admin-index

- name: Deploy
  uses: peaceiris/actions-gh-pages@v4
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    publish_dir: ./public
```

这样部署后的博客应能访问：

```txt
https://你的博客域名/admin-index.json
```

后台的 `BLOG_PUBLIC_URL` 和 `ADMIN_INDEX_PATH` 需要对应这个地址，例如：

```txt
BLOG_PUBLIC_URL=https://你的博客域名
ADMIN_INDEX_PATH=/admin-index.json
```

## 已实现的功能

- React 19 + Vite + TypeScript 应用外壳。
- Fluent UI v9 深色主题布局和响应式 `NavDrawer`。
- Dashboard、Posts、Drafts、Settings 的 React Router 路由。
- 中文和英文 i18n，支持 localStorage 语言偏好。
- Cloudflare Worker API：
  - `/api/health`
  - `/api/auth/status`
  - `/api/auth/login`
  - `/api/auth/logout`
  - `/api/setup/status`
  - `/api/github/repo`
  - `/api/index`
  - `/api/posts/tree`
  - `/api/posts/content`
  - `/api/posts/assets`
  - `/api/drafts`
  - `/api/drafts/:id`
  - `/api/drafts/publish`
- 缺少 Worker variables、secrets、KV、D1 bindings（以及 R2/KV 草稿图片存储都不存在）时的 Setup Gate。
- 独立管理员登录页，内置管理员账号来自 Worker Secret `ADMIN_USERNAME` / `ADMIN_PASSWORD`。
- 设置页账号管理，新增账号的密码以加盐哈希保存到 KV。
- 设置页修改密码 / 重置密码：内置管理员的新密码写入 KV（secret 仍可恢复），普通账号原地更新盐和哈希。
- 前后端复用的 TypeScript API 和领域类型。
- 面向文件夹分类文章和文章资源目录的 Hexo 路径工具函数。
- 从博客站点读取 `admin-index.json`，展示真实文章树、站点摘要、Hexo 设置和主题设置能力摘要。
- 通过 GitHub REST API 读取文章 Markdown。
- 基于 D1 的草稿创建、保存、读取和删除。
- 文章和草稿编辑时提供实时 Markdown 预览，并支持 `==高亮==` 语法。
- 在 Markdown 编辑器中上传图片到草稿临时缓存（R2，未绑 R2 时用 KV），自动插入最终 Markdown 图片路径。
- 管理草稿图片缓存，支持查看和删除临时图片。
- 发布草稿时，将 Markdown 和草稿临时图片一起提交到博客仓库。
- 将草稿通过 GitHub batch commit 发布到博客仓库。
