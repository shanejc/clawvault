import { describe, expect, it, vi } from 'vitest';
import { runOpenClawOnboard } from './openclaw-onboard.js';

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

describe('runOpenClawOnboard', () => {
  it('detects first-run when preset is unset and prints preset menu', () => {
    const { logger, info } = createLogger();
    const applyPreset = vi.fn();

    const result = runOpenClawOnboard(
      {},
      logger,
      {
        readPreset: () => null,
        readConfig: () => 'clawvault',
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

    const result = runOpenClawOnboard(
      { mode: 'hybrid' },
      logger,
      {
        readPreset: () => null,
        readConfig: () => 'clawvault',
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

    const result = runOpenClawOnboard(
      { mode: 'legacy' },
      logger,
      {
        readPreset: () => 'thin',
        readConfig: () => 'clawvault',
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

    const result = runOpenClawOnboard(
      { mode: 'legacy', force: true },
      logger,
      {
        readPreset: () => 'thin',
        readConfig: () => 'clawvault',
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

    expect(() => runOpenClawOnboard(
      {},
      logger,
      {
        readPreset: () => {
          throw new Error('Failed to run openclaw config get: spawnSync openclaw ENOENT');
        },
        readConfig: () => 'clawvault',
        applyPreset: vi.fn(),
        listPresetInfo: () => [
          { mode: 'thin', description: 'manual', autonomousSideEffects: false },
          { mode: 'hybrid', description: 'mixed', autonomousSideEffects: true },
          { mode: 'legacy', description: 'legacy', autonomousSideEffects: true }
        ],
        getPresetInfo: (mode) => ({ mode, description: `${mode} desc`, autonomousSideEffects: mode !== 'thin' })
      }
    )).toThrow('OpenClaw CLI not found. Install `openclaw` and re-run onboard.');
  });

  it('does not print migration diagnostics for modern plugin entry + slot config', () => {
    const { logger, info, warn } = createLogger();

    const result = runOpenClawOnboard(
      {},
      logger,
      {
        readPreset: () => 'thin',
        readConfig: () => 'clawvault',
        applyPreset: vi.fn(),
        listPresetInfo: () => [
          { mode: 'thin', description: 'manual', autonomousSideEffects: false },
          { mode: 'hybrid', description: 'mixed', autonomousSideEffects: true },
          { mode: 'legacy', description: 'legacy', autonomousSideEffects: true }
        ],
        getPresetInfo: (mode) => ({ mode, description: `${mode} desc`, autonomousSideEffects: mode !== 'thin' })
      }
    );

    expect(result.changed).toBe(false);
    expect(info.join('\n')).not.toContain('Migration hints');
    expect(warn.join('\n')).not.toContain('incomplete');
  });

  it('prints migration commands when plugin entry/slot config is missing', () => {
    const { logger, info, warn } = createLogger();
    const readConfig = vi.fn((pathKey: string) => {
      if (pathKey === 'plugins.entries.clawvault.package') return undefined;
      if (pathKey === 'plugins.slots.memory') return undefined;
      return 'clawvault';
    });

    runOpenClawOnboard(
      {},
      logger,
      {
        readPreset: () => 'thin',
        readConfig,
        applyPreset: vi.fn(),
        listPresetInfo: () => [
          { mode: 'thin', description: 'manual', autonomousSideEffects: false },
          { mode: 'hybrid', description: 'mixed', autonomousSideEffects: true },
          { mode: 'legacy', description: 'legacy', autonomousSideEffects: true }
        ],
        getPresetInfo: (mode) => ({ mode, description: `${mode} desc`, autonomousSideEffects: mode !== 'thin' })
      }
    );

    expect(warn.join('\n')).toContain('config. ClawVault plugin registration is incomplete');
    expect(info.join('\n')).toContain('openclaw config set plugins.entries.clawvault.package clawvault');
    expect(info.join('\n')).toContain('openclaw config set plugins.slots.memory clawvault');
  });

  it('shows migration hints during dry-run output', () => {
    const { logger, info } = createLogger();

    const result = runOpenClawOnboard(
      { mode: 'hybrid', dryRun: true },
      logger,
      {
        readPreset: () => null,
        readConfig: () => undefined,
        applyPreset: vi.fn(),
        listPresetInfo: () => [
          { mode: 'thin', description: 'manual', autonomousSideEffects: false },
          { mode: 'hybrid', description: 'mixed', autonomousSideEffects: true },
          { mode: 'legacy', description: 'legacy', autonomousSideEffects: true }
        ],
        getPresetInfo: (mode) => ({ mode, description: `${mode} desc`, autonomousSideEffects: mode !== 'thin' })
      }
    );

    expect(result).toEqual({
      changed: false,
      mode: 'hybrid',
      previousMode: null,
      command: 'openclaw config set plugins.entries.clawvault.config.packPreset hybrid'
    });
    expect(info.join('\n')).toContain('openclaw config set plugins.entries.clawvault.package clawvault');
    expect(info.join('\n')).toContain('openclaw config set plugins.slots.memory clawvault');
  });
});
