import type { HealthResponse } from '../shared/apiTypes'
import type { WorkerEnv } from './env'
import { handleAssetBlob, handleAssetCache, handleAssetRename, handleAssets } from './routes/assetRoutes'
import {
  handleAuthStatus,
  handleChangePassword,
  handleCreateUser,
  handleDeleteUser,
  handleListUsers,
  handleLogin,
  handleLogout,
  handleResetUserPassword,
} from './routes/authRoutes'
import { handleAdminUiSettings, handlePublicConfig, handleSetupStatus, handleUpdateAdminUiSettings } from './routes/configRoutes'
import {
  handleCustomizeFile,
  handleCustomizeManifest,
  handleCustomizePanel,
  handleSaveCustomizeFile,
  handleSaveCustomizePanel,
} from './routes/customizeRoutes'
import { handleBatchDrafts, handleCreateDraft, handleDraftById, handleDrafts, handlePublishDraft } from './routes/draftRoutes'
import { handleGitHubRepo } from './routes/githubRoutes'
import { handleAdminIndex } from './routes/indexRoutes'
import {
  handleDeletePostAsset,
  handleBatchPosts,
  handleDeletePost,
  handlePostAssetBlob,
  handlePostAssets,
  handlePostContent,
  handlePostsTree,
  handlePublishPost,
  handleRenamePost,
  handleRenamePostAsset,
  handleTogglePostPublished,
} from './routes/postRoutes'
import { json } from './utils/response'
import { getSetupStatus } from './utils/setup'
import { ensureD1Schema } from './services/d1/d1Schema'
import { clearSessionCookie, isAuthenticated } from './utils/auth'

const health: HealthResponse = {
  ok: true,
  name: 'hexo-blog-admin',
  runtime: 'cloudflare-workers',
}

const setupBypassPaths = new Set(['/api/health', '/api/setup/status'])
const authBypassPaths = new Set(['/api/health', '/api/setup/status', '/api/auth/status', '/api/auth/login'])

function apiErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Unknown error'
  const lowerMessage = message.toLowerCase()
  const isMissingD1Schema =
    lowerMessage.includes('no such table: drafts') ||
    lowerMessage.includes('no such table: draft_assets')

  if (isMissingD1Schema) {
    return json(
      {
        error: 'D1_MIGRATIONS_REQUIRED',
        message: 'D1 tables are missing. Open `/api/setup/status` or refresh the setup page so the Worker can initialize BLOG_ADMIN_DB automatically.',
      },
      { status: 503 },
    )
  }

  console.error(error)
  return json({ error: 'INTERNAL_ERROR', message }, { status: 500 })
}

function isStaticAssetPath(pathname: string) {
  return (
    pathname.startsWith('/assets/') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    /\.[a-zA-Z0-9]+$/.test(pathname)
  )
}

function shouldServeSpa(pathname: string): boolean {
  if (pathname.startsWith('/api/')) return false
  if (isStaticAssetPath(pathname)) return false
  return true
}

function rewriteToIndexRequest(request: Request): Request {
  const url = new URL(request.url)
  url.pathname = '/index.html'
  return new Request(url.toString(), request)
}

async function handleApiRequest(request: Request, env: WorkerEnv, pathname: string): Promise<Response> {
  if (pathname === '/api/health') return json(health)
  if (pathname === '/api/setup/status') return handleSetupStatus(env, request)
  if (pathname === '/api/config/public') return handlePublicConfig(env)
  if (pathname === '/api/auth/status') return handleAuthStatus(request, env)

  // Most APIs depend on GitHub/KV/D1/R2, so setup is checked before auth-gated routing.
  const setup = await getSetupStatus(env)
  if (!setup.configured && !setupBypassPaths.has(pathname)) {
    return json({ error: 'SETUP_INCOMPLETE', missing: setup.missing }, { status: 503 })
  }

  // D1 can be bound after deploy from the Cloudflare dashboard; initialize lazily on requests.
  if (env.BLOG_ADMIN_DB) await ensureD1Schema(env)

  if (pathname === '/api/auth/login' && request.method === 'POST') return handleLogin(request, env)
  if (pathname === '/api/auth/logout' && request.method === 'POST') return handleLogout(request)
  if (!authBypassPaths.has(pathname) && !(await isAuthenticated(request, env))) {
    return json({ error: 'UNAUTHORIZED' }, {
      status: 401,
      headers: { 'set-cookie': clearSessionCookie(request) },
    })
  }

  if (pathname === '/api/github/repo') return handleGitHubRepo(env)
  if (pathname === '/api/settings/ui' && request.method === 'GET') return handleAdminUiSettings(env)
  if (pathname === '/api/settings/ui' && request.method === 'PUT') return handleUpdateAdminUiSettings(env, request)
  if (pathname === '/api/users' && request.method === 'GET') return handleListUsers(env)
  if (pathname === '/api/users' && request.method === 'POST') return handleCreateUser(env, request)
  if (pathname === '/api/auth/password' && request.method === 'PUT') return handleChangePassword(request, env)
  if (pathname.startsWith('/api/users/') && pathname.endsWith('/password') && request.method === 'PUT') {
    const username = decodeURIComponent(pathname.slice('/api/users/'.length, -'/password'.length))
    return handleResetUserPassword(request, env, username)
  }
  if (pathname.startsWith('/api/users/') && request.method === 'DELETE') {
    return handleDeleteUser(env, decodeURIComponent(pathname.slice('/api/users/'.length)))
  }
  if (pathname === '/api/index') return handleAdminIndex(env)
  if (pathname === '/api/customize/manifest') return handleCustomizeManifest(env)
  if (pathname === '/api/customize/file' && request.method === 'GET') return handleCustomizeFile(env, request)
  if (pathname === '/api/customize/file' && request.method === 'PUT') return handleSaveCustomizeFile(env, request)
  if (pathname === '/api/customize/panel' && request.method === 'GET') return handleCustomizePanel(env, request)
  if (pathname === '/api/customize/panel' && request.method === 'PUT') return handleSaveCustomizePanel(env, request)
  if (pathname === '/api/posts/tree') return handlePostsTree(env)
  if (pathname === '/api/posts/content') return handlePostContent(env, request)
  if (pathname === '/api/posts/assets') return handlePostAssets(env, request)
  if (pathname === '/api/posts/asset/blob') return handlePostAssetBlob(env, request)
  if (pathname === '/api/posts/asset/rename') return handleRenamePostAsset(env, request)
  if (pathname === '/api/posts/asset/delete') return handleDeletePostAsset(env, request)
  if (pathname === '/api/posts/rename') return handleRenamePost(env, request)
  if (pathname === '/api/posts/publish') return handlePublishPost(env, request)
  if (pathname === '/api/posts/published') return handleTogglePostPublished(env, request)
  if (pathname === '/api/posts/batch') return handleBatchPosts(env, request)
  if (pathname === '/api/posts/delete') return handleDeletePost(env, request)
  if (pathname === '/api/drafts' && request.method === 'GET') return handleDrafts(env)
  if (pathname === '/api/drafts' && request.method === 'POST') return handleCreateDraft(env, request)
  if (pathname === '/api/drafts/batch') return handleBatchDrafts(env, request)
  if (pathname === '/api/drafts/publish' && request.method === 'POST') return handlePublishDraft(env, request)
  if (pathname.startsWith('/api/drafts/')) {
    const id = decodeURIComponent(pathname.slice('/api/drafts/'.length))
    return handleDraftById(env, request, id)
  }
  if (pathname === '/api/assets') return handleAssets(env, request)
  if (pathname === '/api/assets/blob') return handleAssetBlob(env, request)
  if (pathname === '/api/assets/rename') return handleAssetRename(env, request)
  if (pathname === '/api/assets/cache') return handleAssetCache(env, request)
  return json({ error: 'NOT_FOUND' }, { status: 404 })
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname

    if (pathname.startsWith('/api/')) {
      try {
        return await handleApiRequest(request, env, pathname)
      } catch (error) {
        return apiErrorResponse(error)
      }
    }

    if (env.ASSETS) {
      if (shouldServeSpa(pathname)) {
        // Workers Assets must receive /index.html for deep React Router URLs such as /posts/edit.
        return env.ASSETS.fetch(rewriteToIndexRequest(request))
      }

      return env.ASSETS.fetch(request)
    }

    return new Response('Not Found', { status: 404 })
  },
} satisfies ExportedHandler<WorkerEnv & { ASSETS?: Fetcher }>
