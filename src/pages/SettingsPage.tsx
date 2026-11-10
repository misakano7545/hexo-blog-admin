import { Button, Body1, Field, Input, Popover, PopoverSurface, PopoverTrigger, Switch, Text, Title1, Title3, makeStyles, tokens } from '@fluentui/react-components'
import { ArrowClockwiseRegular, DeleteRegular, KeyRegular } from '@fluentui/react-icons'
import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useAdminBackground } from '../app/AdminBackgroundContext'
import { ErrorState } from '../components/ErrorState'
import { LoadingState } from '../components/LoadingState'
import { PressRevealPasswordInput } from '../components/PressRevealPasswordInput'
import { StatusBadge } from '../components/StatusBadge'
import { ApiError, getJson, sendJson } from '../lib/apiClient'
import type { AdminUiSettingsResponse, GitHubRepoStatus, SetupIncompleteError, SetupStatus, UpdateAdminUiSettingsRequest } from '../shared/apiTypes'
import type {
  AuthUser,
  ChangePasswordRequest,
  CreateUserRequest,
  PasswordChangeErrorPayload,
  PasswordChangeResponse,
} from '../shared/authTypes'
import { usePageStyles } from './pageStyles'

const useSettingsStyles = makeStyles({
  dangerPrimaryButton: {
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: tokens.colorPaletteRedBackground3,
    ':hover': { color: tokens.colorNeutralForegroundOnBrand, backgroundColor: tokens.colorPaletteRedForeground1 },
    ':disabled': {
      backgroundColor: tokens.colorNeutralBackgroundDisabled,
      color: tokens.colorNeutralForegroundDisabled,
      borderTopColor: tokens.colorNeutralStrokeDisabled,
      borderRightColor: tokens.colorNeutralStrokeDisabled,
      borderBottomColor: tokens.colorNeutralStrokeDisabled,
      borderLeftColor: tokens.colorNeutralStrokeDisabled,
    },
  },
  confirmSurface: { display: 'grid', gap: tokens.spacingVerticalM, width: '300px' },
  confirmActions: { display: 'flex', justifyContent: 'flex-end', gap: tokens.spacingHorizontalS },
  formActions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  userForm: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  statusText: { color: tokens.colorNeutralForeground3 },
})

type SettingsState =
  | { status: 'loading' }
  | {
      status: 'ready'
      setup: SetupStatus
      github: GitHubRepoStatus | SetupIncompleteError
      users: AuthUser[]
      uiSettings: AdminUiSettingsResponse
      me: AuthUser | undefined
    }
  | { status: 'error'; message: string }

const githubFallback = (error: unknown): GitHubRepoStatus | SetupIncompleteError => {
  if (error instanceof ApiError && typeof error.payload === 'object' && error.payload !== null) {
    const payload = error.payload as Partial<SetupIncompleteError>
    if (payload.error === 'SETUP_INCOMPLETE' && Array.isArray(payload.missing)) {
      return { error: 'SETUP_INCOMPLETE', missing: payload.missing }
    }
  }

  return { connected: false, error: error instanceof Error ? error.message : 'Unknown error' }
}

export function SettingsPage() {
  const styles = usePageStyles()
  const { t } = useTranslation()
  const { setAssetPublicUrlDebug, setBackgroundUrl } = useAdminBackground()
  const [state, setState] = useState<SettingsState>({ status: 'loading' })

  const load = () => {
    setState({ status: 'loading' })
    void Promise.all([
      getJson<SetupStatus>('/setup/status'),
      getJson<GitHubRepoStatus>('/github/repo').catch(githubFallback),
      getJson<{ users: AuthUser[] }>('/users'),
      getJson<AdminUiSettingsResponse>('/settings/ui'),
      getJson<{ authenticated: boolean; user?: AuthUser }>('/auth/status'),
    ])
      .then(([setup, github, users, uiSettings, auth]) =>
        setState({ status: 'ready', setup, github, users: users.users, uiSettings, me: auth.user }),
      )
      .catch((error: unknown) => {
        setState({ status: 'error', message: error instanceof Error ? error.message : 'Unknown error' })
      })
  }

  useEffect(() => {
    queueMicrotask(load)
  }, [])

  if (state.status === 'loading') return <LoadingState />
  if (state.status === 'error') return <ErrorState message={state.message} onRetry={load} />

  const github = state.github
  const githubConnected = 'connected' in github && github.connected
  const createUser = (request: CreateUserRequest) => {
    void sendJson<AuthUser>('/users', 'POST', request).then((user) =>
      setState({ ...state, users: [...state.users, user] }),
    )
  }
  const deleteUser = (username: string) => {
    void sendJson<{ deleted: boolean }>(`/users/${encodeURIComponent(username)}`, 'DELETE').then(() =>
      setState({ ...state, users: state.users.filter((user) => user.username !== username) }),
    )
  }
  const resetUserPassword = (username: string, newPassword: string) =>
    sendJson<PasswordChangeResponse>(`/users/${encodeURIComponent(username)}/password`, 'PUT', { newPassword }).then(
      () => undefined,
    )
  const updateUiSettings = (request: UpdateAdminUiSettingsRequest) =>
    sendJson<AdminUiSettingsResponse>('/settings/ui', 'PUT', request).then((uiSettings) => {
      setBackgroundUrl(uiSettings.backgroundUrl)
      setAssetPublicUrlDebug(uiSettings.assetPublicUrlDebug)
      setState({ ...state, uiSettings })
      return uiSettings
    })

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <Title1>{t('settings.title')}</Title1>
        <Body1>{t('settings.description')}</Body1>
        <Button appearance="secondary" icon={<ArrowClockwiseRegular />} onClick={load}>
          {t('actions.refresh')}
        </Button>
      </header>
      <section className={styles.card}>
        <Title3>{t('settings.setupStatus')}</Title3>
        <StatusBadge status={state.setup.configured ? 'success' : 'danger'}>
          {state.setup.configured ? t('setup.configured') : t('setup.incomplete')}
        </StatusBadge>
        <Text>{t('setup.missing')}</Text>
        <ul>
          {state.setup.missing.map((item) => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
        <pre className={styles.codeBlock}>
          <code>{JSON.stringify(state.setup.config, null, 2)}</code>
        </pre>
      </section>
      <section className={styles.card}>
        <Title3>{t('settings.githubStatus')}</Title3>
        <StatusBadge status={githubConnected ? 'success' : 'danger'}>
          {githubConnected ? t('settings.connected') : t('settings.failed')}
        </StatusBadge>
        <pre className={styles.codeBlock}>
          <code>{JSON.stringify(github, null, 2)}</code>
        </pre>
      </section>
      <AppearanceSettings uiSettings={state.uiSettings} onUpdate={updateUiSettings} />
      <PasswordSettings me={state.me} />
      <UserManager
        users={state.users}
        onCreate={createUser}
        onDelete={deleteUser}
        onResetPassword={resetUserPassword}
        canResetPassword={state.me?.role === 'admin'}
      />
    </section>
  )
}

type AppearanceSettingsProps = {
  uiSettings: AdminUiSettingsResponse
  onUpdate: (request: UpdateAdminUiSettingsRequest) => Promise<AdminUiSettingsResponse>
}

function AppearanceSettings({ uiSettings, onUpdate }: AppearanceSettingsProps) {
  const styles = usePageStyles()
  const localStyles = useSettingsStyles()
  const { t } = useTranslation()
  const [backgroundUrl, setBackgroundUrl] = useState(uiSettings.backgroundUrl)
  const [assetPublicUrlDebug, setAssetPublicUrlDebug] = useState(uiSettings.assetPublicUrlDebug)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const save = () => {
    setStatus('saving')
    setMessage('')
    void onUpdate({ backgroundUrl, assetPublicUrlDebug })
      .then((settings) => {
        setBackgroundUrl(settings.backgroundUrl)
        setAssetPublicUrlDebug(settings.assetPublicUrlDebug)
        setStatus('saved')
      })
      .catch((error: unknown) => {
        setStatus('error')
        setMessage(error instanceof Error ? error.message : 'Unknown error')
      })
  }

  return (
    <section className={styles.card}>
      <Title3>{t('settings.appearanceTitle')}</Title3>
      <Field label={t('settings.backgroundUrlLabel')} hint={t('settings.backgroundUrlHint')}>
        <Input value={backgroundUrl} placeholder="https://example.com/background.jpg" onChange={(_, data) => setBackgroundUrl(data.value)} />
      </Field>
      <Field label={t('settings.assetPublicUrlDebugLabel')}>
        <Switch
          checked={assetPublicUrlDebug}
          label={assetPublicUrlDebug ? t('actions.enabled') : t('actions.disabled')}
          onChange={(_, data) => setAssetPublicUrlDebug(data.checked)}
        />
      </Field>
      <div className={localStyles.formActions}>
        <Button appearance="primary" onClick={save} disabled={status === 'saving'}>
          {status === 'saving' ? t('actions.saving') : t('actions.save')}
        </Button>
        <Button
          appearance="secondary"
          onClick={() => {
            setBackgroundUrl('')
            setStatus('idle')
            setMessage('')
          }}
        >
          {t('actions.clear')}
        </Button>
        {status === 'saved' && <Text className={localStyles.statusText}>{t('settings.saved')}</Text>}
        {status === 'error' && <Text className={localStyles.statusText}>{message}</Text>}
      </div>
    </section>
  )
}

const passwordErrorCodes = new Set<PasswordChangeErrorPayload['error']>([
  'INVALID_CURRENT_PASSWORD',
  'WEAK_PASSWORD',
  'USER_NOT_FOUND',
  'BUILT_IN_ADMIN',
  'FORBIDDEN',
])

// 后端用稳定错误码区分失败原因，前端再翻译，避免把 Worker 的英文 message 直接抛给用户。
function passwordErrorMessage(error: unknown, t: TFunction) {
  if (error instanceof ApiError && typeof error.payload === 'object' && error.payload !== null && 'error' in error.payload) {
    const code = (error.payload as PasswordChangeErrorPayload).error
    if (passwordErrorCodes.has(code)) {
      switch (code) {
        case 'INVALID_CURRENT_PASSWORD':
          return t('auth.invalidCurrentPassword')
        case 'WEAK_PASSWORD':
          return t('auth.weakPassword')
        case 'USER_NOT_FOUND':
          return t('auth.userNotFound')
        case 'BUILT_IN_ADMIN':
          return t('auth.builtInPasswordManagedBySecret')
        case 'FORBIDDEN':
          return t('auth.forbidden')
      }
    }
  }

  return error instanceof Error ? error.message : 'Unknown error'
}

type PasswordSettingsProps = {
  me: AuthUser | undefined
}

function PasswordSettings({ me }: PasswordSettingsProps) {
  const styles = usePageStyles()
  const localStyles = useSettingsStyles()
  const { t } = useTranslation()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const fail = (key: string) => {
    setStatus('error')
    setMessage(t(key))
  }

  const submit = () => {
    if (status === 'saving') return
    if (!currentPassword || !newPassword || !confirmPassword) return fail('auth.passwordRequired')
    if (newPassword !== confirmPassword) return fail('auth.passwordMismatch')
    if (newPassword === currentPassword) return fail('auth.passwordSameAsCurrent')

    setStatus('saving')
    setMessage('')
    const request: ChangePasswordRequest = { currentPassword, newPassword }
    void sendJson<PasswordChangeResponse>('/auth/password', 'PUT', request)
      .then(() => {
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
        setStatus('saved')
        setMessage(t('auth.passwordChanged'))
      })
      .catch((error: unknown) => {
        setStatus('error')
        setMessage(passwordErrorMessage(error, t))
      })
  }

  return (
    <section className={styles.card}>
      <Title3>{t('auth.changePassword')}</Title3>
      <Text className={localStyles.statusText}>
        {me ? t('auth.currentAccount', { username: me.username }) : ''}
      </Text>
      <Text className={localStyles.statusText}>
        {me?.builtIn ? t('auth.changePasswordHintBuiltIn') : t('auth.changePasswordHintUser')}
      </Text>
      <form
        className={localStyles.userForm}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Field label={t('auth.currentPassword')}>
          <PressRevealPasswordInput
            value={currentPassword}
            onChange={(_, data) => setCurrentPassword(data.value)}
            autoComplete="current-password"
          />
        </Field>
        <Field label={t('auth.newPassword')}>
          <PressRevealPasswordInput
            value={newPassword}
            onChange={(_, data) => setNewPassword(data.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label={t('auth.confirmPassword')}>
          <PressRevealPasswordInput
            value={confirmPassword}
            onChange={(_, data) => setConfirmPassword(data.value)}
            autoComplete="new-password"
          />
        </Field>
        <Button appearance="primary" disabled={status === 'saving'} type="submit">
          {status === 'saving' ? t('auth.updatingPassword') : t('auth.updatePassword')}
        </Button>
      </form>
      {status === 'saved' && <Text className={localStyles.statusText}>{message}</Text>}
      {status === 'error' && <Text className={localStyles.statusText}>{message}</Text>}
    </section>
  )
}

type UserManagerProps = {
  users: AuthUser[]
  onCreate: (request: CreateUserRequest) => void
  onDelete: (username: string) => void
  onResetPassword: (username: string, newPassword: string) => Promise<void>
  canResetPassword: boolean
}

function UserManager({ users, onCreate, onDelete, onResetPassword, canResetPassword }: UserManagerProps) {
  const styles = usePageStyles()
  const localStyles = useSettingsStyles()
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  return (
    <section className={styles.card}>
      <Title3>{t('auth.users')}</Title3>
      <div className={localStyles.userForm}>
        <Field label={t('auth.username')}>
          <Input value={username} onChange={(_, data) => setUsername(data.value)} />
        </Field>
        <Field label={t('auth.password')}>
          <PressRevealPasswordInput value={password} onChange={(_, data) => setPassword(data.value)} autoComplete="new-password" />
        </Field>
        <Button
          appearance="primary"
          onClick={() => {
            onCreate({ username, password })
            setUsername('')
            setPassword('')
          }}
        >
          {t('auth.newUser')}
        </Button>
      </div>
      <ul>
        {users.map((user) => (
          <li key={user.username} style={{margin: '10px 0 0 0'}}>
            <div className={styles.row}>
              <Text>{user.username}</Text>
              <Text>{user.builtIn ? t('auth.builtInAdmin') : user.role}</Text>
              {canResetPassword && !user.builtIn && (
                <ResetPasswordPopover username={user.username} onConfirm={(newPassword) => onResetPassword(user.username, newPassword)} />
              )}
              <DeleteUserPopover disabled={user.builtIn} username={user.username} onConfirm={() => onDelete(user.username)} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function DeleteUserPopover({ username, disabled, onConfirm }: { username: string; disabled?: boolean; onConfirm: () => void }) {
  const styles = useSettingsStyles()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={(_, data) => setOpen(data.open)}>
      <PopoverTrigger disableButtonEnhancement>
        <Button appearance="primary" className={styles.dangerPrimaryButton} icon={<DeleteRegular />} disabled={disabled}>
          {t('auth.deleteUser')}
        </Button>
      </PopoverTrigger>
      <PopoverSurface className={styles.confirmSurface}>
        <Text weight="semibold">{t('auth.confirmDeleteUserTitle')}</Text>
        <Text>{t('auth.confirmDeleteUserDescription', { username })}</Text>
        <div className={styles.confirmActions}>
          <Button onClick={() => setOpen(false)}>{t('actions.cancel')}</Button>
          <Button appearance="primary" className={styles.dangerPrimaryButton} icon={<DeleteRegular />} onClick={() => { setOpen(false); onConfirm() }}>{t('actions.delete')}</Button>
        </div>
      </PopoverSurface>
    </Popover>
  )
}

type ResetPasswordPopoverProps = {
  username: string
  onConfirm: (newPassword: string) => Promise<void>
}

function ResetPasswordPopover({ username, onConfirm }: ResetPasswordPopoverProps) {
  const styles = useSettingsStyles()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const close = () => {
    setOpen(false)
    setNewPassword('')
    setError('')
    setSaving(false)
  }

  const submit = () => {
    if (!newPassword) {
      setError(t('auth.passwordRequired'))
      return
    }

    setSaving(true)
    setError('')
    void onConfirm(newPassword)
      .then(close)
      .catch((values: unknown) => {
        setSaving(false)
        setError(passwordErrorMessage(values, t))
      })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(_, data) => {
        if (data.open) setOpen(true)
        else close()
      }}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button appearance="secondary" icon={<KeyRegular />}>
          {t('auth.resetPassword')}
        </Button>
      </PopoverTrigger>
      <PopoverSurface className={styles.confirmSurface}>
        <Text weight="semibold">{t('auth.confirmResetPasswordTitle')}</Text>
        <Text>{t('auth.confirmResetPasswordDescription', { username })}</Text>
        <Field label={t('auth.newPassword')}>
          <PressRevealPasswordInput
            value={newPassword}
            onChange={(_, data) => setNewPassword(data.value)}
            autoComplete="new-password"
          />
        </Field>
        {error && <Text>{error}</Text>}
        <div className={styles.confirmActions}>
          <Button onClick={close}>{t('actions.cancel')}</Button>
          <Button appearance="primary" disabled={saving} icon={<KeyRegular />} onClick={submit}>
            {saving ? t('auth.updatingPassword') : t('auth.resetPassword')}
          </Button>
        </div>
      </PopoverSurface>
    </Popover>
  )
}
