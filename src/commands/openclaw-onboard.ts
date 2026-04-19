import {
  applyOpenClawPackPreset,
  getOpenClawPresetInfo,
  isFirstRunOpenClawPreset,
  listOpenClawPresetInfo,
  readOpenClawPackPreset,
  type FirstRunOpenClawPreset
} from '../plugin/openclaw-config-helper.js';
import { spawnSync } from 'child_process';

export interface OpenClawOnboardOptions {
  mode?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface OpenClawOnboardResult {
  changed: boolean;
  mode: FirstRunOpenClawPreset | null;
  previousMode: FirstRunOpenClawPreset | null;
  command?: string;
}

interface OpenClawOnboardDeps {
  readPreset: () => FirstRunOpenClawPreset | null;
  readConfig: (pathKey: string) => string | undefined;
  applyPreset: typeof applyOpenClawPackPreset;
  listPresetInfo: typeof listOpenClawPresetInfo;
  getPresetInfo: typeof getOpenClawPresetInfo;
}

interface OpenClawOnboardLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

const OPENCLAW_PLUGIN_ENTRY_PACKAGE_PATH = 'plugins.entries.clawvault.package';
const OPENCLAW_MEMORY_SLOT_PATH = 'plugins.slots.memory';

function readOpenClawConfig(pathKey: string): string | undefined {
  const result = spawnSync('openclaw', ['config', 'get', pathKey], {
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });

  if (result.error) {
    throw new Error(`Failed to run openclaw config get: ${result.error.message}`);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    return undefined;
  }

  if (result.signal) {
    throw new Error(`openclaw config get terminated by signal ${result.signal}`);
  }

  const trimmed = String(result.stdout ?? '').trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^['"]|['"]$/g, '').trim() || undefined;
}

const DEFAULT_DEPS: OpenClawOnboardDeps = {
  readPreset: readOpenClawPackPreset,
  readConfig: readOpenClawConfig,
  applyPreset: applyOpenClawPackPreset,
  listPresetInfo: listOpenClawPresetInfo,
  getPresetInfo: getOpenClawPresetInfo
};

function printLegacyMigrationDiagnostics(logger: OpenClawOnboardLogger, deps: OpenClawOnboardDeps): void {
  const pluginEntryPackage = deps.readConfig(OPENCLAW_PLUGIN_ENTRY_PACKAGE_PATH);
  const memorySlot = deps.readConfig(OPENCLAW_MEMORY_SLOT_PATH);

  const migrationCommands: string[] = [];
  if (pluginEntryPackage !== 'clawvault') {
    migrationCommands.push(`openclaw config set ${OPENCLAW_PLUGIN_ENTRY_PACKAGE_PATH} clawvault`);
  }
  if (memorySlot !== 'clawvault') {
    migrationCommands.push(`openclaw config set ${OPENCLAW_MEMORY_SLOT_PATH} clawvault`);
  }

  if (!migrationCommands.length) {
    return;
  }

  logger.warn('Detected pre-change OpenClaw config. ClawVault plugin registration is incomplete.');
  logger.info('Migration hints (run manually if needed):');
  for (const command of migrationCommands) {
    logger.info(`- ${command}`);
  }
  logger.info('Onboard remains non-destructive: it only changes packPreset unless you run migration commands yourself.');
}

function printPresetMenu(logger: OpenClawOnboardLogger, deps: OpenClawOnboardDeps): void {
  logger.info('Available OpenClaw ClawVault presets:');
  for (const preset of deps.listPresetInfo()) {
    const sideEffectLabel = preset.autonomousSideEffects
      ? '⚠ autonomous side effects'
      : 'manual / no autonomous hooks';
    logger.info(`- ${preset.mode}: ${preset.description} (${sideEffectLabel})`);
  }
}

function buildModeCommand(mode: FirstRunOpenClawPreset): string {
  return `clawvault openclaw onboard ${mode}`;
}

export function runOpenClawOnboard(
  options: OpenClawOnboardOptions,
  logger: OpenClawOnboardLogger = { info: console.log, warn: console.warn },
  deps: OpenClawOnboardDeps = DEFAULT_DEPS
): OpenClawOnboardResult {
  const requestedMode = options.mode;

  if (requestedMode && !isFirstRunOpenClawPreset(requestedMode)) {
    printPresetMenu(logger, deps);
    throw new Error(`Unsupported mode: ${requestedMode}`);
  }
  const selectedMode: FirstRunOpenClawPreset | undefined =
    requestedMode && isFirstRunOpenClawPreset(requestedMode) ? requestedMode : undefined;

  let currentMode: FirstRunOpenClawPreset | null;
  try {
    currentMode = deps.readPreset();
    printLegacyMigrationDiagnostics(logger, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('spawnSync openclaw ENOENT')) {
      throw new Error('OpenClaw CLI not found. Install `openclaw` and re-run onboard.');
    }
    throw err;
  }

  if (!currentMode && !selectedMode) {
    logger.info('OpenClaw packPreset is currently unset. Pick a mode to complete setup.');
    printPresetMenu(logger, deps);
    logger.info(`Run one of: ${buildModeCommand('thin')} | ${buildModeCommand('hybrid')} | ${buildModeCommand('legacy')}`);
    return { changed: false, mode: null, previousMode: null };
  }

  if (currentMode) {
    const currentInfo = deps.getPresetInfo(currentMode);
    logger.info(`Current OpenClaw mode: ${currentMode} — ${currentInfo.description}`);

    if (!selectedMode) {
      printPresetMenu(logger, deps);
      logger.info('No changes made. To switch modes, run: clawvault openclaw onboard <mode> --force');
      return { changed: false, mode: currentMode, previousMode: currentMode };
    }

    if (selectedMode === currentMode) {
      logger.info(`Mode '${currentMode}' is already set. No change needed.`);
      return { changed: false, mode: currentMode, previousMode: currentMode };
    }

    if (!options.force) {
      logger.warn(`Refusing to override existing mode '${currentMode}' with '${selectedMode}' without --force.`);
      logger.info(`Re-run with: ${buildModeCommand(selectedMode)} --force`);
      return { changed: false, mode: currentMode, previousMode: currentMode };
    }
  }

  if (!selectedMode) {
    throw new Error('Internal error: requested mode missing during apply path.');
  }

  const commandPreview = `openclaw config set plugins.entries.clawvault.config.packPreset ${selectedMode}`;
  if (options.dryRun) {
    logger.info(commandPreview);
    return { changed: false, mode: selectedMode, previousMode: currentMode, command: commandPreview };
  }

  const result = deps.applyPreset(selectedMode);
  const info = deps.getPresetInfo(selectedMode);
  logger.info(`✓ Applied mode '${result.mode}'.`);
  logger.info(`  Command: ${result.command}`);
  logger.info('  Non-destructive: only packPreset is changed; existing packToggles/feature flags are preserved.');
  if (info.autonomousSideEffects) {
    logger.warn('⚠ This mode enables autonomous hook side effects (automatic context/checkpoint/observation behavior).');
  }

  return {
    changed: true,
    mode: result.mode,
    previousMode: currentMode,
    command: result.command
  };
}
