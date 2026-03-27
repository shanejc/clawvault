import { describe, expect, it, vi } from 'vitest';
import { runOpenClawOnboarding } from './openclaw-onboarding.js';

function createLogger() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    logger: {
      info: (message: string) => info.push(message),
      warn: (message: string) => warn.push(message)
    }
  };
}

describe('runOpenClawOnboarding', () => {
  it('detects first-run when preset is unset and prints preset menu', () => {
    const { logger, info } = createLogger();
    const applyPreset = vi.fn();

    const result = runOpenClawOnboarding(
      {},
      logger,
      {
        readPreset: () => null,
        applyPreset,
        listPresetInfo: () => [
          { mode: 'thin', description: 'manual', autonomousSideEffects: false },
          { mode: 'hybrid', description: 'mixed', autonomousSideEffects: true },
          { mode: 'legacy', description: 'legacy', autonomousSideEffects: true }
        ],
        getPresetInfo: () => ({ mode: 'thin', description: 'manual', autonomousSideEffects: false })
      }
    );

    expect(result).toEqual({ changed: false, mode: null, previousMode: null });
    expect(applyPreset).not.toHaveBeenCalled();
    expect(info.join('\n')).toContain('OpenClaw packPreset is currently unset');
    expect(info.join('\n')).toContain('- thin: manual');
    expect(info.join('\n')).toContain('- hybrid: mixed');
    expect(info.join('\n')).toContain('- legacy: legacy');
  });

  it('applies selected mode on first run', () => {
    const { logger } = createLogger();
    const applyPreset = vi.fn(() => ({
      mode: 'hybrid',
      configPath: 'plugins.entries.clawvault.config.packPreset',
      command: 'openclaw config set plugins.entries.clawvault.config.packPreset hybrid',
      changedOnlyPackPreset: true as const
    }));

    const result = runOpenClawOnboarding(
      { mode: 'hybrid' },
      logger,
      {
        readPreset: () => null,
        applyPreset,
        listPresetInfo: () => [
          { mode: 'thin', description: 'manual', autonomousSideEffects: false },
          { mode: 'hybrid', description: 'mixed', autonomousSideEffects: true },
          { mode: 'legacy', description: 'legacy', autonomousSideEffects: true }
        ],
        getPresetInfo: (mode) => ({ mode, description: `${mode} desc`, autonomousSideEffects: mode !== 'thin' })
      }
    );

    expect(applyPreset).toHaveBeenCalledWith('hybrid');
    expect(result.changed).toBe(true);
    expect(result.mode).toBe('hybrid');
    expect(result.previousMode).toBe(null);
  });

  it('avoids silent override when preset already exists unless --force is set', () => {
    const { logger, warn } = createLogger();
    const applyPreset = vi.fn();

    const result = runOpenClawOnboarding(
      { mode: 'legacy' },
      logger,
      {
        readPreset: () => 'thin',
        applyPreset,
        listPresetInfo: () => [
          { mode: 'thin', description: 'manual', autonomousSideEffects: false },
          { mode: 'hybrid', description: 'mixed', autonomousSideEffects: true },
          { mode: 'legacy', description: 'legacy', autonomousSideEffects: true }
        ],
        getPresetInfo: (mode) => ({ mode, description: `${mode} desc`, autonomousSideEffects: mode !== 'thin' })
      }
    );

    expect(result.changed).toBe(false);
    expect(result.mode).toBe('thin');
    expect(applyPreset).not.toHaveBeenCalled();
    expect(warn.join('\n')).toContain('Refusing to override existing mode');
  });

  it('supports explicit override with --force', () => {
    const { logger } = createLogger();
    const applyPreset = vi.fn(() => ({
      mode: 'legacy',
      configPath: 'plugins.entries.clawvault.config.packPreset',
      command: 'openclaw config set plugins.entries.clawvault.config.packPreset legacy',
      changedOnlyPackPreset: true as const
    }));

    const result = runOpenClawOnboarding(
      { mode: 'legacy', force: true },
      logger,
      {
        readPreset: () => 'thin',
        applyPreset,
        listPresetInfo: () => [
          { mode: 'thin', description: 'manual', autonomousSideEffects: false },
          { mode: 'hybrid', description: 'mixed', autonomousSideEffects: true },
          { mode: 'legacy', description: 'legacy', autonomousSideEffects: true }
        ],
        getPresetInfo: (mode) => ({ mode, description: `${mode} desc`, autonomousSideEffects: mode !== 'thin' })
      }
    );

    expect(applyPreset).toHaveBeenCalledWith('legacy');
    expect(result.changed).toBe(true);
    expect(result.previousMode).toBe('thin');
  });

  it('surfaces openclaw-unavailable failures safely', () => {
    const { logger } = createLogger();

    expect(() => runOpenClawOnboarding(
      {},
      logger,
      {
        readPreset: () => {
          throw new Error('Failed to run openclaw config get: spawnSync openclaw ENOENT');
        },
        applyPreset: vi.fn(),
        listPresetInfo: () => [
          { mode: 'thin', description: 'manual', autonomousSideEffects: false },
          { mode: 'hybrid', description: 'mixed', autonomousSideEffects: true },
          { mode: 'legacy', description: 'legacy', autonomousSideEffects: true }
        ],
        getPresetInfo: (mode) => ({ mode, description: `${mode} desc`, autonomousSideEffects: mode !== 'thin' })
      }
    )).toThrow('OpenClaw CLI not found. Install `openclaw` and re-run onboarding.');
  });
});
