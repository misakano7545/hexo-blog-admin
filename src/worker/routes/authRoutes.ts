import type { WorkerEnv } from '../env'
import {
  changePassword,
  clearSessionCookie,
  createSessionCookie,
  createUser,
  deleteUser,
  getSessionUser,
  listUsers,
  resetUserPassword,
  verifyLogin,
} from '../utils/auth'
import { json } from '../utils/response'

export async function handleAuthStatus(request: Request, env: WorkerEnv): Promise<Response> {
  const user = await getSessionUser(request, env)
  return json({ authenticated: Boolean(user), user })
}

export async function handleLogin(request: Request, env: WorkerEnv): Promise<Response> {
  const body = (await request.json()) as { username?: string; password?: string }
  const user = await verifyLogin(env, body.username ?? '', body.password ?? '')
  if (!user) {
    return json({ error: 'INVALID_CREDENTIALS' }, { status: 401 })
  }

  return json(
    { authenticated: true, user },
    {
      headers: {
        'set-cookie': await createSessionCookie(env, request, user.username),
      },
    },
  )
}

export function handleLogout(request: Request): Response {
  return json(
    { authenticated: false },
    {
      headers: {
        'set-cookie': clearSessionCookie(request),
      },
    },
  )
}

export async function handleListUsers(env: WorkerEnv): Promise<Response> {
  return json({ users: await listUsers(env) })
}

export async function handleCreateUser(env: WorkerEnv, request: Request): Promise<Response> {
  const body = (await request.json()) as { username?: string; password?: string }
  return json(await createUser(env, body.username ?? '', body.password ?? ''), { status: 201 })
}

export async function handleDeleteUser(env: WorkerEnv, username: string): Promise<Response> {
  return json(await deleteUser(env, username))
}

export async function handleChangePassword(request: Request, env: WorkerEnv): Promise<Response> {
  const user = await getSessionUser(request, env)
  if (!user) return json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const body = (await request.json()) as { currentPassword?: string; newPassword?: string }
  const result = await changePassword(env, user, body.currentPassword ?? '', body.newPassword ?? '')
  if (!result.ok) {
    return json({ error: result.error }, { status: result.error === 'USER_NOT_FOUND' ? 404 : 400 })
  }

  return json({ changed: true })
}

export async function handleResetUserPassword(request: Request, env: WorkerEnv, username: string): Promise<Response> {
  const requester = await getSessionUser(request, env)
  if (!requester) return json({ error: 'UNAUTHORIZED' }, { status: 401 })
  if (requester.role !== 'admin') return json({ error: 'FORBIDDEN' }, { status: 403 })

  const body = (await request.json()) as { newPassword?: string }
  const result = await resetUserPassword(env, username, body.newPassword ?? '')
  if (!result.ok) {
    return json({ error: result.error }, { status: result.error === 'USER_NOT_FOUND' ? 404 : 400 })
  }

  return json({ changed: true })
}
