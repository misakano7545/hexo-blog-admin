# hexo-blog-admin

English | [简体中文](README.md)

`hexo-blog-admin` is a Vite + React + TypeScript dashboard for managing a Hexo blog from a Cloudflare Workers based admin app.

The intended data model is:

| Data | Storage |
| --- | --- |
| Published Markdown posts | GitHub repository |
| Published image assets | GitHub repository |
| Draft Markdown | Cloudflare D1 |
| Temporary draft images | Cloudflare R2, or the `BLOG_ADMIN_KV` namespace when R2 is not bound |
| Draft image metadata | Cloudflare D1 |
| Runtime configuration | Worker variables / KV |
| GitHub token | Worker secret |
| Build and deploy | GitHub Actions |
| Public admin index summary | Blog build artifact `admin-index.json` |

R2 is only a temporary draft cache, not the final image host; draft images live there (or in KV) just until they are published into the blog repository.

## Install

```bash
pnpm install
```

## Local Development

```bash
pnpm dev
```

For local debugging, create `.dev.vars` in the project root. Do not commit this file:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=local-admin-password
```

Useful checks:

```bash
pnpm typecheck
pnpm build
```

For architecture, APIs, and development conventions, see the [development guide](docs/development.md). For adding theme customization support, see the [Customize theme adapter development guide](docs/customize-adapter-development.en.md).

Preview a production build:

```bash
pnpm preview
```

## Troubleshooting

In production, if direct navigation to `/posts` or refreshing `/posts/edit` shows Not Found, the SPA fallback is not active. This project uses Worker fallback and wrangler assets `single-page-application` so production direct route visits keep returning `index.html`.

The Cloudflare Vite plugin local dev server may not behave exactly like the production Worker for deep SPA routes. If opening `/posts` directly under `pnpm dev --host` shows Not Found, open `/` first and navigate inside the app; production deployment should still support deep links and refreshes.

Deploy through Wrangler:

```bash
pnpm deploy
```

`pnpm deploy` is `vite build && wrangler deploy`. `vite build` writes an output config to `dist/hexo_blog_admin/wrangler.json` plus `.wrangler/deploy/config.json`, which makes the following `wrangler deploy` redirect to it. So do not delete `.wrangler/` between the build and the deploy, or `wrangler deploy` will use the root `wrangler.jsonc` and fail with `assets property is missing the required directory property`.

Two pitfalls worth knowing:

- **Do not declare `r2_buckets` in `wrangler.jsonc`.** A binding given only by name (no bucket) makes `wrangler deploy` treat it as a resource to auto-provision and call `POST /accounts/<id>/r2/buckets`; on an account without an R2 subscription the deploy dies with `code: 10042 Please enable R2` and the whole deployment aborts. If you want R2, add the `BLOG_ASSET_CACHE` binding manually in the dashboard.
- **Set `workers_dev` / `preview_urls` to `false` explicitly.** When unset, `wrangler deploy` enables `https://<worker>.<account>.workers.dev` and Preview URLs by default, which bypasses any Cloudflare Access policy in front of the Worker and exposes the admin panel on a public hostname. This repo pins both to `false`.

Post-deploy self check:

```bash
curl -s https://<your-admin-host>/api/health
curl -s https://<your-admin-host>/api/setup/status   # expect configured: true
```

## GitHub Token

Use a fine-grained personal access token scoped to only the selected blog repository.

Recommended permissions:

```txt
Metadata: Read
Contents: Read and write
```

Store the token as a Cloudflare Worker secret. Do not write it into repository files.

```bash
pnpm wrangler secret put GITHUB_TOKEN
```

Store the built-in admin username and password as Worker secrets too:

```bash
pnpm wrangler secret put ADMIN_USERNAME
pnpm wrangler secret put ADMIN_PASSWORD
```

## Worker Variables

Configure these Worker variables in Cloudflare Workers Dashboard under Variables and Secrets. The project does not write normal `vars` in `wrangler.jsonc`, and sets `keep_vars: true`, so `wrangler deploy` will not overwrite values maintained in the Cloudflare Dashboard.

```txt
GITHUB_OWNER=PLFJY
GITHUB_REPO=blog
GITHUB_BRANCH=main
POSTS_DIR=source/_posts
BLOG_PUBLIC_URL=https://your-blog-domain
ADMIN_INDEX_PATH=/admin-index.json
```

Variable meanings:

| Variable | Purpose |
| --- | --- |
| `GITHUB_OWNER` | GitHub account or organization that owns the blog repository, for example `PLFJY`. |
| `GITHUB_REPO` | Blog repository name, for example `blog`. The admin reads posts and publishes drafts to this repository. |
| `GITHUB_BRANCH` | Blog repository branch, for example `main`. Post reads and draft commits use this branch. |
| `POSTS_DIR` | Hexo posts directory, for example `source/_posts`. Used to calculate Markdown paths from `relativeId`. |
| `BLOG_PUBLIC_URL` | Public URL of the deployed blog. The admin reads `ADMIN_INDEX_PATH` from this site. |
| `ADMIN_INDEX_PATH` | Blog build artifact path for the public admin index summary, for example `/admin-index.json`. |

These variables have no fallback and no default value. If any required item is missing, the app shows SetupRequiredPage and blocks the main admin UI.

Optional variable:

```txt
BLOG_ASSET_PUBLIC_URL=https://your-r2-public-domain
```

`BLOG_ASSET_PUBLIC_URL` generates public R2 URLs for temporary draft images so Markdown previews and image warehouse thumbnails can bypass the Worker image proxy. When unset, the app keeps using the existing `/api/assets/blob` fallback. The matching R2 bucket/custom domain must be able to publicly serve `draft-assets/*` objects; do not hard-code this domain in source.

`ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `GITHUB_TOKEN` are secrets and are not shown in the setup status. `ADMIN_USERNAME` is the built-in admin account. After logging in, add regular accounts from Settings; regular account passwords are stored in KV as salted hashes.

Once signed in, the Settings page offers a **Change password** card:

- Regular accounts: the current password is verified, then the salt and hash in `auth:user:<username>` are rewritten and take effect immediately.
- Built-in admin: after verifying the current password, the new salt and hash are written to the KV key `auth:admin:builtin`, so no `wrangler secret put ADMIN_PASSWORD` is required.
- The `ADMIN_PASSWORD` secret always matches first, so a forgotten new password can still be recovered with the secret.
- Admins can also **Reset password** for other regular accounts from the account list (the built-in admin is excluded so it never fights the secret).
- New passwords must be 8-128 characters and contain both letters and digits.
- Changing a password does not sign out other devices: the session cookie only signs the username and expiry.

The compatibility date is pinned to `2026-04-30`, the latest date supported by the installed local Miniflare runtime; bump it after upgrading Cloudflare tooling if needed.

## KV, D1, And R2 Bindings

Create a KV namespace for low-frequency admin state. The namespace name can be anything, but the Worker binding name must be `BLOG_ADMIN_KV`:

```bash
pnpm wrangler kv namespace create BLOG_ADMIN_KV
```

Create the D1 database for draft Markdown and draft image metadata:

```bash
pnpm wrangler d1 create hexo-blog-admin
```

The D1 binding name must be:

```txt
BLOG_ADMIN_DB
```

Initialize the D1 schema. A D1 binding only lets the Worker connect to the database; after `BLOG_ADMIN_DB` is bound, this project automatically creates the `drafts` / `draft_assets` tables from the Worker. Opening the admin app or requesting `/api/setup/status` triggers initialization.

If you prefer explicit initialization before deployment, you can still run:

```bash
pnpm wrangler d1 migrations apply hexo-blog-admin
```

If automatic initialization fails, the setup page shows `BLOG_ADMIN_DB_SCHEMA`. Check Worker logs and D1 binding permissions, then refresh the page.

Temporary draft images can live in R2 or stay in KV, see the next section. To create an R2 bucket, the bucket name can be anything, but the Worker binding name must be `BLOG_ASSET_CACHE`:

```bash
pnpm wrangler r2 bucket create hexo-blog-admin-cache
```

If this R2 bucket has a public custom domain, you can additionally set `BLOG_ASSET_PUBLIC_URL` in Worker Variables so draft image previews use public URLs directly. Leaving it unset keeps the Worker `/api/assets/blob` fallback.

Bind them as:

```txt
BLOG_ADMIN_KV      required
BLOG_ADMIN_DB      required
BLOG_ASSET_CACHE   optional (draft images fall back to BLOG_ADMIN_KV)
```

## Draft Image Storage: R2 Or KV

Draft images only sit in the drafts area until you publish; publishing commits them into the blog GitHub repository as real assets. So this path needs no long-term storage. R2 requires enabling the R2 subscription and attaching a payment method to the Cloudflare account, so a free account can skip it entirely:

- With `BLOG_ASSET_CACHE` bound: image blobs go to R2 and `BLOG_ADMIN_KV` holds only accounts and UI config.
- Without `BLOG_ASSET_CACHE`: blobs fall back to the already-required `BLOG_ADMIN_KV` namespace, under the key prefix `asset:<r2_key>`, with the raw image bytes as the value and `contentType` in KV metadata. R2 always wins when both are bound.
- At least one of them must exist: with neither `BLOG_ASSET_CACHE` nor `BLOG_ADMIN_KV` bound, the setup page reports a missing `BLOG_ASSET_CACHE` and the admin UI stays blocked.

Hard limits on the KV path (official Workers KV quotas; the free plan resets daily at 00:00 UTC):

```txt
value size        25 MiB
writes            1,000/day (each image upload is one write)
deletes           1,000/day (each draft image delete is one)
lists             1,000/day (each refresh of the draft image list is one)
total storage     1 GB per account
```

Consequences:

- A single image above 25 MiB fails outright: KV rejects the `put` instead of truncating.
- Bulk uploads hit the write quota first, and a large backlog of draft images hits the 1 GB storage cap; once a quota is exhausted that operation fails for the rest of the day, so either wait for the reset or bind R2.
- Exceeding any one quota fails that operation type for the day, and operations from `wrangler` or the Dashboard count towards it too.
- The frontend asks whether to compress images above 500 KiB into WebP (longest edge 2560) and also allows uploading the original. On the KV path prefer compressing: it saves quota and stays clear of the 25 MiB cap.
- In both modes draft images are served through the Worker `/api/assets/blob` endpoint; `BLOG_ASSET_PUBLIC_URL` only helps with an R2 custom domain, the KV path has no public URL.

`wrangler.jsonc` only declares the binding name. It does not commit a placeholder `database_id` or `database_name`, because CI deploys can treat placeholder resource config as invalid. Bind the D1 database manually in the Cloudflare Dashboard. The binding name must still be `BLOG_ADMIN_DB`.

If your deployment flow requires an explicit id in `wrangler.jsonc`, use the real `database_id` returned by `pnpm wrangler d1 create hexo-blog-admin`; do not keep a placeholder value.

Bind your own KV/R2 resources to the names above in the Cloudflare Dashboard. KV keeps session/auth state, small configuration cache entries, and (when R2 is unbound) draft image blobs; draft Markdown and draft image metadata are stored in D1.

`BLOG_ADMIN_KV` and `BLOG_ADMIN_DB` are required: without them the admin UI stays blocked. `BLOG_ASSET_CACHE` is optional; when missing, draft images fall back to `BLOG_ADMIN_KV` (see the limits above).

Recommended deployment order:

```bash
pnpm wrangler d1 create hexo-blog-admin
pnpm deploy
```

After deployment, confirm that `BLOG_ADMIN_DB` is bound in the Cloudflare Dashboard. The Worker will initialize the D1 schema automatically when the admin app starts.

## Deployment Entrypoint

This project only supports deployment on a dedicated admin subdomain. The app runs at the root path `/`, and APIs are fixed under `/api/*`.

Cloudflare Worker route example:

```txt
admin.example.com/*
```

For the current deployment, use:

```txt
admin.blog.plfjy.top/*
```

Visit:

```txt
https://admin.blog.plfjy.top/
```

API paths:

```txt
/api/*
```

If you previously configured blog subpath routes such as `blog.plfjy.top/admin` or `blog.plfjy.top/admin/*`, remove them from Cloudflare Worker routes. The admin no longer supports being mounted under the blog subpath.

## Blog Repository admin-index.json Setup

The admin public summary comes from the deployed `admin-index.json` file on the blog site. It is no longer just a post list: it is the fast public index entry generated after the blog build. Your Hexo blog repository needs to generate this file into `public/` and publish it together with the blog output.

Recommended script path:

```txt
tools/generate-admin-index.mjs
```

This repository includes a copy-ready example script at `tools/generate-admin-index.mjs`.

The script should scan posts, read site summary config, and check whether Customize-related files exist:

```txt
source/_posts/**/*.md
```

And output:

```txt
public/admin-index.json
```

`admin-index.json` v2 contains:

- `posts` / `tree` / per-post `assets`: the post management index.
- `site`: site and theme summary.
- `customize`: available adapters, panels, and editable file existence.

It does not contain the body of `_config.yml`, theme config, or `_data/*.yml`. Customize still reads source files through the GitHub API when editing actual content.

The index should contain at least:

```json
{
  "version": 2,
  "generatedAt": "2026-05-05T00:00:00.000Z",
  "postsDir": "source/_posts",
  "assetMode": "post-folder",
  "site": {
    "title": "My Blog",
    "subtitle": "Notes and code",
    "author": "PLFJY",
    "url": "https://example.com",
    "language": "en",
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
      "title": "AP CSA 00 - About AP Computer Science A",
      "path": "source/_posts/ap-csa/00-about-ap-csa.md",
      "folderPath": "ap-csa",
      "postSlug": "00-about-ap-csa",
      "assetDir": "source/_posts/ap-csa/00-about-ap-csa/",
      "markdownAssetPrefix": "00-about-ap-csa",
      "assets": [
        {
          "filename": "ap-csa-range.png",
          "repoPath": "source/_posts/ap-csa/00-about-ap-csa/ap-csa-range.png",
          "markdownPath": "00-about-ap-csa/ap-csa-range.png"
        }
      ]
    }
  ],
  "tree": []
}
```

Add this script to the blog repository `package.json`:

```json
{
  "scripts": {
    "generate:admin-index": "node tools/generate-admin-index.mjs"
  }
}
```

Then run it in the blog repository GitHub Actions after the Hexo build and before Pages/static deployment:

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

After deployment, the blog should expose:

```txt
https://your-blog-domain/admin-index.json
```

Set `BLOG_PUBLIC_URL` and `ADMIN_INDEX_PATH` to match that URL:

```txt
BLOG_PUBLIC_URL=https://your-blog-domain
ADMIN_INDEX_PATH=/admin-index.json
```

## Implemented Features

- React 19 + Vite + TypeScript app shell.
- Fluent UI v9 dark themed layout with responsive `NavDrawer`.
- React Router routes for dashboard, posts, drafts, and settings.
- Chinese and English i18n with localStorage language preference.
- Cloudflare Worker APIs:
  - `/api/health`
  - `/api/auth/status`
  - `/api/auth/login`
  - `/api/auth/logout`
  - `/api/setup/status`
  - `/api/github/repo`
  - `/api/index`
  - `/api/posts/tree`
  - `/api/posts/content`
  - `/api/drafts`
  - `/api/drafts/:id`
  - `/api/drafts/publish`
- Setup gate for missing Worker variables, secrets, KV and D1 bindings (plus a missing draft image store when neither R2 nor KV is bound).
- Dedicated admin login page backed by Worker Secrets `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
- Account management in Settings; regular account passwords are stored in KV as salted hashes.
- Change password / reset password in Settings: the built-in admin's new password lands in KV (the secret stays usable for recovery), regular accounts have their salt and hash rewritten in place.
- Shared TypeScript API/domain types.
- Hexo post path utility functions for folder-based post IDs and post-folder assets.
- Reads `admin-index.json` from the blog site and shows the real post tree, site summary, and Customize capability summary.
- Reads post Markdown through the GitHub REST API.
- Creates, saves, reads, and deletes drafts in D1.
- Provides live Markdown preview for post and draft editing, including `==highlight==` syntax.
- Uploads images from the Markdown editor into the temporary draft cache (R2, or KV when R2 is unbound) and inserts the final Markdown image path.
- Manages draft image cache entries, including listing and deleting temporary images.
- Publishes both Markdown and cached draft images to the blog repository.
- Publishes drafts to the blog repository through a GitHub batch commit.
