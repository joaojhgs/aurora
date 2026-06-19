export type AuthSessionState = 'anonymous' | 'pairing' | 'authenticated' | 'expired'

export interface AuthSessionSnapshot {
  state: AuthSessionState
  principalId: string | null
  permissions: string[]
  tokenExpiresAt: string | null
}

export class AuthSession {
  private snapshotValue: AuthSessionSnapshot = {
    state: 'anonymous',
    principalId: null,
    permissions: [],
    tokenExpiresAt: null
  }

  snapshot(): AuthSessionSnapshot {
    return {
      ...this.snapshotValue,
      permissions: [...this.snapshotValue.permissions]
    }
  }

  setAuthenticated(principalId: string, permissions: string[], tokenExpiresAt: string | null = null): void {
    this.snapshotValue = {
      state: 'authenticated',
      principalId,
      permissions: [...permissions],
      tokenExpiresAt
    }
  }

  setPairing(): void {
    this.snapshotValue = {
      state: 'pairing',
      principalId: null,
      permissions: [],
      tokenExpiresAt: null
    }
  }

  expire(): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      state: 'expired'
    }
  }

  clear(): void {
    this.snapshotValue = {
      state: 'anonymous',
      principalId: null,
      permissions: [],
      tokenExpiresAt: null
    }
  }
}
