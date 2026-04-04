export interface SessionContextCacheEntry {
  recapText?: string;
  initializedAt: string;
  recapInjected: boolean;
}

export interface RecallStateEntry {
  lastTriggerText?: string;
  lastQueryText?: string;
  lastResultDigest?: string;
  updatedAt: string;
}

export interface WritebackStateEntry {
  lastDigest?: string;
  lastRoute?: "boot" | "durable" | "source" | "discard";
  updatedAt: string;
}

export class ClawVaultPluginRuntimeState {
  private startupRecoveryNotice: string | null = null;
  private readonly sessionContextByKey = new Map<string, SessionContextCacheEntry>();
  private readonly recallStateByKey = new Map<string, RecallStateEntry>();
  private readonly writebackStateByKey = new Map<string, WritebackStateEntry>();
  private lastWeeklyReflectionWeekKey: string | null = null;
  private onboardingPrompted = false;

  setStartupRecoveryNotice(message: string): void {
    const trimmed = message.trim();
    this.startupRecoveryNotice = trimmed || null;
  }

  consumeStartupRecoveryNotice(): string | null {
    const notice = this.startupRecoveryNotice;
    this.startupRecoveryNotice = null;
    return notice;
  }

  setSessionRecap(sessionKey: string, recapText: string): void {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    this.sessionContextByKey.set(normalizedSessionKey, {
      recapText: recapText.trim(),
      initializedAt: new Date().toISOString(),
      recapInjected: false
    });
  }

  getSessionRecap(sessionKey: string | undefined): SessionContextCacheEntry | null {
    if (!sessionKey) return null;
    return this.sessionContextByKey.get(sessionKey) ?? null;
  }

  markSessionRecapInjected(sessionKey: string): void {
    const current = this.sessionContextByKey.get(sessionKey);
    if (!current) return;
    this.sessionContextByKey.set(sessionKey, { ...current, recapInjected: true });
  }

  getRecallState(sessionKey: string | undefined): RecallStateEntry | null {
    if (!sessionKey) return null;
    return this.recallStateByKey.get(sessionKey) ?? null;
  }

  setRecallState(sessionKey: string, state: Omit<RecallStateEntry, "updatedAt">): void {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    this.recallStateByKey.set(normalizedSessionKey, {
      ...state,
      updatedAt: new Date().toISOString()
    });
  }

  clearRecallState(sessionKey: string | undefined): void {
    if (!sessionKey) return;
    this.recallStateByKey.delete(sessionKey);
  }

  getWritebackState(sessionKey: string | undefined): WritebackStateEntry | null {
    if (!sessionKey) return null;
    return this.writebackStateByKey.get(sessionKey) ?? null;
  }

  setWritebackState(sessionKey: string, state: Omit<WritebackStateEntry, "updatedAt">): void {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    this.writebackStateByKey.set(normalizedSessionKey, {
      ...state,
      updatedAt: new Date().toISOString()
    });
  }

  clearWritebackState(sessionKey: string | undefined): void {
    if (!sessionKey) return;
    this.writebackStateByKey.delete(sessionKey);
  }

  clearSession(sessionKey: string | undefined): void {
    if (!sessionKey) return;
    this.sessionContextByKey.delete(sessionKey);
    this.recallStateByKey.delete(sessionKey);
    this.writebackStateByKey.delete(sessionKey);
  }

  shouldRunWeeklyReflection(weekKey: string): boolean {
    return this.lastWeeklyReflectionWeekKey !== weekKey;
  }

  markWeeklyReflectionRun(weekKey: string): void {
    this.lastWeeklyReflectionWeekKey = weekKey;
  }

  shouldPromptOnboarding(): boolean {
    return !this.onboardingPrompted;
  }

  markOnboardingPrompted(): void {
    this.onboardingPrompted = true;
  }
}
