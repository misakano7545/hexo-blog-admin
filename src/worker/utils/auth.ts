import type { AuthUser } from '../../shared/authTypes'
import type { WorkerEnv } from '../env'

const cookieName = 'hba_session'
const sessionMaxAgeSeconds = 60 * 60 * 24
const userPrefix = 'auth:user:'

type StoredUser = {
  username: string
  salt: string
  passwordHash: string
  role: 'admin' | 'user'
  createdAt: string
}

const encodeBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

const timingSafeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false
  let result = 0
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return result === 0
}

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value)
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

async function hashPassword(password: string, salt: string) {
  return digest(`${salt}:${password}`)
}

async function sign(env: WorkerEnv, username: string, expiresAt: number) {
  return digest(`${username}.${expiresAt}.${env.ADMIN_PASSWORD ?? ''}`)
}

function userKey(username: string) {
  return `${userPrefix}${username.toLowerCase()}`
}

// 内置管理员的密码原本只来自 Worker Secret `ADMIN_PASSWORD`。前端自助改密码时把加盐哈希写进这个 KV key，
// 这样改密码不需要重新执行 `wrangler secret put`；Secret 仍然优先命中，忘记新密码时它还是恢复入口。
const builtInPasswordKey = 'auth:admin:builtin'

type StoredPassword = {
  salt: string
  passwordHash: string
  updatedAt: string
}

const minPasswordLength = 8
const maxPasswordLength = 128

export type PasswordUpdateError = 'INVALID_CURRENT_PASSWORD' | 'USER_NOT_FOUND' | 'WEAK_PASSWORD' | 'BUILT_IN_ADMIN'

export type PasswordUpdateResult = { ok: true } | { ok: false; error: PasswordUpdateError }

export function isStrongPassword(password: string) {
  if (password.length < minPasswordLength || password.length > maxPasswordLength) return false
  return /[A-Za-z]/.test(password) && /[0-9]/.test(password)
}

function publicUser(user: StoredUser, builtIn = false): AuthUser {
  return {
    username: user.username,
    role: user.role,
    builtIn,
    createdAt: user.createdAt,
  }
}

export async function createSessionCookie(env: WorkerEnv, request: Request, username: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds
  const signature = await sign(env, username, expiresAt)
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  const value = `${encodeURIComponent(username)}.${expiresAt}.${signature}`
  return `${cookieName}=${value}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${sessionMaxAgeSeconds}`
}

export function clearSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${cookieName}=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0`
}

export async function getSessionUser(request: Request, env: WorkerEnv): Promise<AuthUser | null> {
  const cookie = request.headers.get('cookie') ?? ''
  const token = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1)

  if (!token || !env.ADMIN_PASSWORD) return null
  const [usernameRaw, expiresAtRaw, signature] = token.split('.')
  const username = decodeURIComponent(usernameRaw ?? '')
  const expiresAt = Number(expiresAtRaw)
  if (!username || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000) || !signature) return null
  if (!timingSafeEqual(signature, await sign(env, username, expiresAt))) return null

  if (username === env.ADMIN_USERNAME) {
    return { username, role: 'admin', builtIn: true }
  }

  const stored = await env.BLOG_ADMIN_KV?.get<StoredUser>(userKey(username), 'json')
  return stored ? publicUser(stored) : null
}

export async function isAuthenticated(request: Request, env: WorkerEnv) {
  return Boolean(await getSessionUser(request, env))
}

async function verifyBuiltInPassword(env: WorkerEnv, password: string) {
  if (env.ADMIN_PASSWORD && timingSafeEqual(password, env.ADMIN_PASSWORD)) return true
  const stored = await env.BLOG_ADMIN_KV?.get<StoredPassword>(builtInPasswordKey, 'json')
  if (!stored) return false
  return timingSafeEqual(await hashPassword(password, stored.salt), stored.passwordHash)
}

export async function verifyLogin(env: WorkerEnv, username: string, password: string): Promise<AuthUser | null> {
  if (username === env.ADMIN_USERNAME) {
    return (await verifyBuiltInPassword(env, password)) ? { username, role: 'admin', builtIn: true } : null
  }

  const stored = await env.BLOG_ADMIN_KV?.get<StoredUser>(userKey(username), 'json')
  if (!stored) return null
  return timingSafeEqual(await hashPassword(password, stored.salt), stored.passwordHash) ? publicUser(stored) : null
}

export async function listUsers(env: WorkerEnv): Promise<AuthUser[]> {
  const list = await env.BLOG_ADMIN_KV?.list({ prefix: userPrefix })
  const storedUsers = list
    ? await Promise.all(list.keys.map((key) => env.BLOG_ADMIN_KV?.get<StoredUser>(key.name, 'json')))
    : []
  const users = storedUsers.filter((user): user is StoredUser => Boolean(user)).map((user) => publicUser(user))
  return env.ADMIN_USERNAME ? [{ username: env.ADMIN_USERNAME, role: 'admin', builtIn: true }, ...users] : users
}

export async function createUser(env: WorkerEnv, username: string, password: string): Promise<AuthUser> {
  const normalized = username.trim()
  if (!normalized || !password) throw new Error('Username and password are required')
  if (normalized === env.ADMIN_USERNAME) throw new Error('Cannot overwrite built-in admin')

  const salt = crypto.randomUUID()
  const stored: StoredUser = {
    username: normalized,
    salt,
    passwordHash: await hashPassword(password, salt),
    role: 'user',
    createdAt: new Date().toISOString(),
  }
  await env.BLOG_ADMIN_KV?.put(userKey(normalized), JSON.stringify(stored))
  return publicUser(stored)
}

export async function deleteUser(env: WorkerEnv, username: string): Promise<{ deleted: boolean }> {
  if (username === env.ADMIN_USERNAME) throw new Error('Cannot delete built-in admin')
  await env.BLOG_ADMIN_KV?.delete(userKey(username))
  return { deleted: true }
}

export async function changePassword(
  env: WorkerEnv,
  user: AuthUser,
  currentPassword: string,
  newPassword: string,
): Promise<PasswordUpdateResult> {
  if (!isStrongPassword(newPassword)) return { ok: false, error: 'WEAK_PASSWORD' }
  if (!env.BLOG_ADMIN_KV) return { ok: false, error: 'USER_NOT_FOUND' }

  if (user.builtIn) {
    if (!(await verifyBuiltInPassword(env, currentPassword))) return { ok: false, error: 'INVALID_CURRENT_PASSWORD' }
    const salt = crypto.randomUUID()
    const record: StoredPassword = {
      salt,
      passwordHash: await hashPassword(newPassword, salt),
      updatedAt: new Date().toISOString(),
    }
    await env.BLOG_ADMIN_KV.put(builtInPasswordKey, JSON.stringify(record))
    return { ok: true }
  }

  const stored = await env.BLOG_ADMIN_KV.get<StoredUser>(userKey(user.username), 'json')
  if (!stored) return { ok: false, error: 'USER_NOT_FOUND' }
  if (!timingSafeEqual(await hashPassword(currentPassword, stored.salt), stored.passwordHash)) {
    return { ok: false, error: 'INVALID_CURRENT_PASSWORD' }
  }

  const salt = crypto.randomUUID()
  const updated: StoredUser = {
    ...stored,
    salt,
    passwordHash: await hashPassword(newPassword, salt),
  }
  await env.BLOG_ADMIN_KV.put(userKey(stored.username), JSON.stringify(updated))
  return { ok: true }
}

export async function resetUserPassword(
  env: WorkerEnv,
  username: string,
  newPassword: string,
): Promise<PasswordUpdateResult> {
  const normalized = username.trim()
  if (normalized === env.ADMIN_USERNAME) return { ok: false, error: 'BUILT_IN_ADMIN' }
  if (!isStrongPassword(newPassword)) return { ok: false, error: 'WEAK_PASSWORD' }
  if (!env.BLOG_ADMIN_KV) return { ok: false, error: 'USER_NOT_FOUND' }

  const stored = await env.BLOG_ADMIN_KV.get<StoredUser>(userKey(normalized), 'json')
  if (!stored) return { ok: false, error: 'USER_NOT_FOUND' }

  const salt = crypto.randomUUID()
  const updated: StoredUser = {
    ...stored,
    salt,
    passwordHash: await hashPassword(newPassword, salt),
  }
  await env.BLOG_ADMIN_KV.put(userKey(stored.username), JSON.stringify(updated))
  return { ok: true }
}
