# 开发文档

本文档面向继续维护 `hexo-blog-admin` 的开发者，说明项目结构、运行链路、主要数据模型、API、前后端协作方式和常见开发注意事项。

## 项目定位

`hexo-blog-admin` 是一个部署在 Cloudflare Workers 上的 Hexo 博客管理后台。前端使用 Vite、React 19、TypeScript、React Router 和 Fluent UI；后端是同仓库内的 Cloudflare Worker API。

核心职责：

- 从博客公开站点读取 `admin-index.json` v3 轻索引，展示正式文章列表、站点摘要、Hexo 设置和主题设置能力摘要，并按需读取单篇文章图片索引 shard。
- 通过 GitHub REST API 读取、移动、删除和提交正式 Markdown / 图片资源。
- 使用 Cloudflare D1 保存草稿正文和草稿图片 metadata。
- 使用 Cloudflare R2 临时保存草稿图片 blob。
- 使用 Cloudflare KV 保存登录用户和 UI 配置。

## 技术栈

- 前端：React 19、React Router、Fluent UI v9、CodeMirror、markdown-it、i18next。
- 后端：Cloudflare Workers、Workers Assets、KV、D1、R2。
- 构建：Vite + `@cloudflare/vite-plugin`。
- 包管理：pnpm 11。
- 代码质量：TypeScript strict、ESLint。

## 目录结构

```txt
src/
  app/                 应用外壳、导航、主题、语言、认证和设置检查 Gate
  components/          可复用 UI，尤其是 Markdown 编辑/预览/图片仓/冲突合并
  features/posts/      前后端共用的 Hexo 文章路径规则
  i18n/                中英文翻译资源
  lib/                 前端 API、缓存、图片压缩、编辑快照、Markdown 资源解析
  pages/               Dashboard、文章、草稿、设置、初始化等页面
  shared/              前后端共享的 API 和领域类型
  worker/              Cloudflare Worker 入口、路由、服务层和工具函数
scripts/               仓库自身辅助脚本
tools/                 给博客仓库复制使用的 admin-index 生成脚本
migrations/            D1 表结构迁移 SQL
```

## 本地开发

安装依赖：

```bash
pnpm install
```

启动开发服务器：

```bash
pnpm dev
```

常用检查：

```bash
pnpm typecheck
pnpm lint
pnpm build
```

`pnpm build` 实际执行 `scripts/safe-build.mjs`。该脚本会临时把 `.dev.vars` 改名为 `.dev.vars.local`，避免生产构建时把本地开发变量带进 Cloudflare Vite 插件读取流程，构建后再恢复文件名。

## 部署与运行时配置

Worker 入口是 `src/worker/index.ts`，Wrangler 配置在 `wrangler.jsonc`。

必须配置的普通变量：

```txt
GITHUB_OWNER
GITHUB_REPO
GITHUB_BRANCH
POSTS_DIR
BLOG_PUBLIC_URL
ADMIN_INDEX_PATH
```

必须配置的 Secret：

```txt
GITHUB_TOKEN
ADMIN_USERNAME
ADMIN_PASSWORD
```

必须绑定的 Cloudflare 资源：

```txt
BLOG_ADMIN_KV
BLOG_ADMIN_DB
BLOG_ASSET_CACHE
```

可选普通变量：

```txt
BLOG_ASSET_PUBLIC_URL=https://blog-admin-cache.plfjy.top
```

`BLOG_ASSET_PUBLIC_URL` 用于从 R2 key 动态生成草稿暂存图片公开 URL。配置后 `/api/assets`、`/api/assets/cache`、上传和改名响应中的 `DraftAsset.publicUrl` 会指向该公开域名；不配置时前端继续使用 `/api/assets/blob` fallback。对应的 R2 bucket/custom domain 需要能公开访问 `draft-assets/*` 对象，该值不要写死在源码里。

`wrangler.jsonc` 设置了 `keep_vars: true`，避免部署覆盖 Dashboard 中维护的变量和 Secret。D1 schema 会在请求 `/api/setup/status` 或进入已配置 API 后由 Worker 自动执行 `CREATE TABLE IF NOT EXISTS` 初始化。

## 数据模型

正式文章数据存在博客 GitHub 仓库：

- Markdown：`POSTS_DIR/<folder>/<slug>.md`
- 正式图片：`POSTS_DIR/<folder>/<slug>/<filename>`
- 后台公开索引摘要：博客构建产物 `BLOG_PUBLIC_URL + ADMIN_INDEX_PATH`

草稿数据存在 Cloudflare：

- `drafts` 表：草稿 ID、`relative_id`、标题、Markdown、创建/更新时间。
- `draft_assets` 表：草稿图片 metadata，包括 R2 key、Markdown 引用路径和最终 GitHub repo path。
- R2：保存草稿图片 blob。

KV 保存：

- `auth:user:<username>`：后台普通用户密码哈希（`salt` + `passwordHash`，改密码时原地更新）。
- `auth:admin:builtin`：内置管理员在前端改过的密码（`salt` + `passwordHash`）。存在时和 `ADMIN_PASSWORD` secret 同时有效，secret 优先，因此它不会困住管理员。
- `config:adminBackgroundUrl`：后台背景图 URL。

`admin-index.json` 不再写入 Worker KV；`/api/index` 和 `/api/posts/tree` 每次直接读取博客公开站点。

## 前端入口与路由

`src/main.tsx` 挂载 React 应用，`src/routes.tsx` 定义路由：

- `/login`：登录页；如果 setup 未完成，会嵌入初始化向导。
- `/`：Dashboard。
- `/posts`：正式文章列表。
- `/posts/edit?relativeId=...`：正式文章编辑页。
- `/drafts`：草稿列表。
- `/drafts/edit?draftId=...`：草稿编辑页；没有 `draftId` 时创建新草稿。
- `/cache`：R2 暂存图片缓存管理。
- `/settings`：配置状态、GitHub 状态、背景图、用户管理。

路由进入主应用后先经过 `SetupGate`，缺少变量、Secret 或绑定时显示初始化向导；配置完整后再经过 `AuthGate`，未登录时跳转 `/login`。

## 前端关键模块

### API 客户端

`src/lib/apiClient.ts` 提供：

- `buildApiUrl(path)`：统一把路径归一化到 `/api/*`。
- `getJson<T>()`：自动带 `credentials: include`，解析 JSON 或文本错误。
- `sendJson<T>()`：封装 POST/PUT/DELETE JSON 请求。

401 响应会触发页面刷新，让 `AuthGate` 重新判断登录态。

### Markdown 编辑工作区

`ArticleMarkdownWorkspace` 同时渲染 `MarkdownEditor` 与 `MarkdownPreview`：

- `MarkdownEditor` 使用 CodeMirror，支持工具栏格式化、粘贴图片、插入外部 Markdown 片段、IME 输入保护和滚动位置同步。
- `MarkdownPreview` 使用 markdown-it 插件渲染 Markdown、KaTeX、脚注、高亮等语法，并把图片/链接交给 `resolveMarkdownResourceUrl` 重写。
- 预览同步既支持滚动比例，也支持光标所在源码行定位。

### 图片仓

`MarkdownAssetPanel` 统一管理源站图片与草稿暂存图片：

- 源站图片来自 `/api/posts/assets?relativeId=...`，Worker 会读取 v3 的 `post.assetIndexPath` 对应 shard；旧 v2 `post.assets` 仅作短期兼容。
- 暂存图片来自 `/api/assets`，blob 在 R2，metadata 在 D1。
- 如果 Worker 配置了 `BLOG_ASSET_PUBLIC_URL`，暂存图片会带 `publicUrl`，预览和缩略图优先使用公开 R2 URL；未配置时回退到 `/api/assets/blob`。
- 上传大图时，浏览器端可先转 WebP 并压缩。
- 上传、粘贴、剪贴板读取共用同一套 incoming image flow。
- 重命名暂存图片会同步 D1 metadata，并回调编辑器替换 Markdown 路径。
- 源站图片重命名/删除会调用 Worker 提交 GitHub commit。

### 编辑快照与冲突处理

`src/lib/editorSnapshot.ts` 在 localStorage 保存编辑快照。V2 快照包含：

- 当前本地 Markdown。
- 打开页面时的云端 Markdown。
- base hash、revision 或 updatedAt。

`decideEditorConflict` 根据“本地、base、云端”三者关系判断：

- 本地与云端一致：使用云端并清理快照。
- 本地未改、云端已改：使用云端。
- 云端未改、本地已改：恢复本地。
- 双方都改：弹出 `EditorConflictResolverDialog`，支持逐 hunk 合并。

## Worker 请求链路

`src/worker/index.ts` 是唯一 Worker 入口：

1. `/api/health`、`/api/setup/status` 和少数认证接口可绕过完整 setup/auth 检查。
2. 其他 API 先调用 `getSetupStatus` 检查变量、Secret 和绑定。
3. 绑定了 D1 后调用 `ensureD1Schema`，保证表结构存在。
4. 未登录请求返回 401 并清理 session cookie。
5. 已登录请求分发到 route handler。
6. 非 `/api/*` 路径交给 Workers Assets；SPA 路由会重写到 `/index.html`。

## API 概览

认证与初始化：

- `GET /api/health`
- `GET /api/setup/status`
- `GET /api/auth/status`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/users`
- `POST /api/users`
- `DELETE /api/users/:username`
- `PUT /api/auth/password`：当前登录账号改密码，body `{ currentPassword, newPassword }`；失败返回 `INVALID_CURRENT_PASSWORD` / `WEAK_PASSWORD`。
- `PUT /api/users/:username/password`：管理员重置其他普通账号密码，body `{ newPassword }`；非管理员 403（`FORBIDDEN`），目标是内置管理员时 400（`BUILT_IN_ADMIN`）。

配置与状态：

- `GET /api/config/public`
- `GET /api/github/repo`
- `GET /api/settings/ui`
- `PUT /api/settings/ui`

文章索引与正式文章：

- `GET /api/index`
- `GET /api/posts/tree`
- `GET /api/posts/content?relativeId=...`
- `GET /api/posts/assets?relativeId=...`
- `GET /api/posts/asset/blob?repoPath=...`
- `POST /api/posts/asset/rename`
- `POST /api/posts/asset/delete`
- `POST /api/posts/rename`
- `POST /api/posts/published`
- `POST /api/posts/delete`

草稿与图片缓存：

- `GET /api/drafts`
- `POST /api/drafts`
- `GET /api/drafts/:id`
- `PUT /api/drafts/:id`
- `DELETE /api/drafts/:id`
- `POST /api/drafts/publish`
- `GET /api/assets`
- `POST /api/assets`
- `DELETE /api/assets?key=...`
- `GET /api/assets/blob?key=...`
- `POST /api/assets/rename`
- `GET /api/assets/cache`
- `DELETE /api/assets/cache`

## GitHub 集成

GitHub API 封装在 `src/worker/services/github/`：

- `githubClient.ts`：统一设置 GitHub headers、API version、User-Agent 和 Bearer token。
- `githubContent.ts`：读取 Markdown 或图片文件内容。
- `githubGitCommit.ts`：使用 Git Data API 批量创建 blob、tree、commit，并 fast-forward 更新分支。
- `githubRepo.ts`：检查仓库连接状态。

批量提交不会使用 contents API 的单文件更新，而是直接创建 tree，方便一次提交 Markdown、多个图片和删除项。

## admin-index 读取策略

`src/worker/services/indexer/adminIndex.ts` 从博客站点读取 `admin-index.json`，不再读写 Worker KV。

读取逻辑：

1. 组合 `BLOG_PUBLIC_URL + ADMIN_INDEX_PATH`。
2. 使用 `Cache-Control: no-cache` 和 `cf.cacheTtl = 0` 直接 fetch 线上 `admin-index.json`。
3. `/api/index` 和 `/api/posts/tree` 都返回这份线上结果。
4. `sourceCommitSha` 以 `admin-index.json` 自身字段为准。

前端通过 `src/lib/indexCache.ts` 把最近一次成功读取的 admin-index 保存在浏览器 localStorage。页面进入时先渲染浏览器缓存，再懒刷新线上索引；刷新失败时继续显示本地缓存并提示错误。

## post asset shard 读取策略

`admin-index.json` v3 不再包含全站图片清单或每篇文章完整 `assets` 数组。每篇文章只保留：

- `assetIndexPath`
- `assetCount`
- `assetTotalSize`

单篇源站图片索引由博客构建脚本输出到：

```txt
public/admin-index/post-assets/<relativeId>.json
```

Worker 的 `/api/posts/assets?relativeId=...` 会：

1. 读取最新 `admin-index.json`。
2. 找到对应 post。
3. 优先读取 `post.assetIndexPath` 指向的 shard。
4. shard 读取失败时返回空 `assets`，不让文章编辑页整体崩溃。
5. 旧 v2 索引没有 `assetIndexPath` 时，短期 fallback 到 `post.assets`。

## 草稿发布流程

草稿编辑页点击发布后：

1. 前端调用 `POST /api/drafts/publish`。
2. Worker 从 D1 读取草稿，从 R2 读取该草稿所有暂存图片。
3. Worker 计算 Hexo 目标路径：
   - Markdown：`POSTS_DIR/<relativeId>.md`
   - 图片：`POSTS_DIR/<folder>/<slug>/<filename>`
   - Markdown 引用：`<slug>/<filename>`
4. Worker 用 Git Data API 创建一个 batch commit。
5. 发布成功后删除 D1 草稿和对应 R2 暂存图片。

## 路径安全规则

正式文章和图片路径会经过 `src/worker/utils/pathSafety.ts`：

- `relativeId` 会去掉首尾斜杠、合并重复斜杠、替换反斜杠。
- 禁止空路径、绝对路径、`..`、`.` 和 `.git` 片段。
- 图片文件名只允许受支持扩展名：png、jpg、jpeg、gif、webp、svg、avif。
- GitHub repo path 必须位于 `POSTS_DIR` 下。

草稿 ID 由 `relativeId` 派生，逻辑在 `src/worker/services/d1/draftIds.ts`。

## 文章路径规则

`src/features/posts/postPathUtils.ts` 是前后端共享路径规则：

输入：

```ts
{
  postsDir: 'source/_posts',
  relativeId: 'ap-csa/00-about-ap-csa',
}
```

输出：

```ts
{
  folderPath: 'ap-csa',
  postSlug: '00-about-ap-csa',
  postPath: 'source/_posts/ap-csa/00-about-ap-csa.md',
  assetDir: 'source/_posts/ap-csa/00-about-ap-csa/',
  markdownAssetPrefix: '00-about-ap-csa',
}
```

图片 `example.png` 会变成：

```ts
{
  finalRepoPath: 'source/_posts/ap-csa/00-about-ap-csa/example.png',
  markdownPath: '00-about-ap-csa/example.png',
}
```

## 博客仓库脚本

`tools/generate-admin-index.mjs` 需要复制到博客仓库运行。它会：

- 扫描 `source/_posts/**/*.md`。
- 简单解析 front matter 的 title、date、updated、tags、categories、published。
- 扫描每篇文章同名资源目录里的图片。
- 读取 `_config.yml` 和 `package.json` 生成 `site` 摘要。
- 写入 `customize` adapter、panel 和 editable file 存在状态摘要，不写入配置正文。
- 输出 `public/admin-index.json` v3 轻索引。
- 输出 `public/admin-index/post-assets/<relativeId>.json` 单篇图片索引 shard。
- 尝试写入 Git commit SHA 和每篇文章最近 Git 提交日期。

后台依赖 `admin-index.json` 展示文章树、站点摘要、Hexo 设置和主题设置能力摘要；编辑某篇文章时再读取对应 post asset shard 展示源站图片。

## 开发约定

- 共享 API 类型优先放在 `src/shared/`，避免前后端类型漂移。
- 涉及文章路径时优先使用 `buildPostPaths` / `buildPostAssetPaths`。
- Worker 中任何来自请求的路径都要先经过 `pathSafety` 校验。
- 新增主题设置 adapter 时参考 [主题设置 Adapter 开发指南](customize-adapter-development.md)。
- D1 schema 修改时同时更新 `migrations/0001_create_drafts.sql` 和 `src/worker/services/d1/d1Schema.ts`。
- 新增可见文案时同步更新 `src/i18n/resources.ts` 的中英文翻译。
- 新增 API 时同时更新本文档的 API 概览。
- 前端页面按 `loading / ready / error` 状态建模，复杂页面可继续使用 discriminated union。

## 常见调试路径

- 登录失败：检查 `ADMIN_USERNAME`、`ADMIN_PASSWORD`，以及浏览器是否带上 `hba_session` cookie。
- Setup 页面缺项：访问 `/api/setup/status` 看 `missing` 数组。
- 文章列表为空：确认博客站点能访问 `BLOG_PUBLIC_URL + ADMIN_INDEX_PATH`。
- 源站图片预览失败：确认 `post.assetIndexPath` 指向的 shard 已发布，shard 内 `assets[].repoPath` 在 `POSTS_DIR` 下，且 GitHub token 有 contents read 权限。
- 草稿图片上传失败：检查 D1/R2 binding，确认 `BLOG_ASSET_CACHE` 可写。
- 发布失败：检查 GitHub token 是否有 contents write 权限，目标分支是否允许 fast-forward 更新。
