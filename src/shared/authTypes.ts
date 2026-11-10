export type AuthUser = {
  username: string
  role: 'admin' | 'user'
  builtIn: boolean
  createdAt?: string
}

export type AuthStatusResponse = {
  authenticated: boolean
  user?: AuthUser
}

export type CreateUserRequest = {
  username: string
  password: string
}

export type ChangePasswordRequest = {
  currentPassword: string
  newPassword: string
}

export type ResetUserPasswordRequest = {
  newPassword: string
}

export type PasswordChangeResponse = {
  changed: boolean
}

export type PasswordChangeErrorPayload = {
  error: 'INVALID_CURRENT_PASSWORD' | 'USER_NOT_FOUND' | 'WEAK_PASSWORD' | 'BUILT_IN_ADMIN' | 'FORBIDDEN'
}

