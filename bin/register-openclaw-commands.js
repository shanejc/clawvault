/**
 * OpenClaw integration convenience commands.
 */

function printPresetTable(chalk, presets) {
  console.log('Available OpenClaw ClawVault presets:');
  for (const preset of presets) {
    const warning = preset.autonomousSideEffects
      ? chalk.yellow('⚠ autonomous side effects')
      : chalk.green('manual / no autonomous hooks');
    console.log(`- ${chalk.cyan(preset.mode)}: ${preset.description} (${warning})`);
  }
}

export function registerOpenClawCommands(program, { chalk }) {
  const openclaw = program
    .command('openclaw')
    .description('OpenClaw integration helpers for ClawVault plugin config');

  openclaw
    .command('onboard [mode]')
    .description('Interactive-safe onboard helper for OpenClaw plugin mode (thin|hybrid|legacy)')
    .option('--force', 'Allow changing an existing preset when one is already configured')
    .option('--dry-run', 'Print the OpenClaw config command without executing it')
    .action(async (mode, options) => {
      try {
        const { runOpenClawOnboard } = await import('../dist/index.js');
        runOpenClawOnboard({
          mode,
          force: options.force === true,
          dryRun: options.dryRun === true
        });
      } catch (err) {
        const message = err?.message || String(err);
        if (message.includes('OpenClaw CLI not found')) {
          console.error(chalk.yellow('Warning: openclaw CLI not found. Install OpenClaw, then re-run onboard.'));
          process.exit(1);
        }
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });

  openclaw
    .command('preset <mode>')
    .description('Apply first-run ClawVault plugin mode: thin, hybrid, or legacy')
    .option('--dry-run', 'Print the OpenClaw config command without executing it')
    .action(async (mode, options) => {
      try {
        const {
          applyOpenClawPackPreset,
          buildOpenClawPackPresetArgs,
          getOpenClawPresetInfo,
          isFirstRunOpenClawPreset,
          listOpenClawPresetInfo
        } = await import('../dist/index.js');

        if (!isFirstRunOpenClawPreset(mode)) {
          printPresetTable(chalk, listOpenClawPresetInfo());
          throw new Error(`Unsupported mode: ${mode}`);
        }

        const args = buildOpenClawPackPresetArgs(mode);
        const command = `openclaw ${args.join(' ')}`;

        if (options.dryRun) {
          console.log(command);
          return;
        }

        const result = applyOpenClawPackPreset(mode);
        const info = getOpenClawPresetInfo(mode);

        console.log(chalk.green(`✓ Applied mode '${result.mode}' via ${result.configPath}`));
        console.log(chalk.dim(`  Command: ${command}`));
        console.log(chalk.dim('  Non-destructive: only packPreset is changed; existing packToggles/feature flags are preserved.'));

        if (info.autonomousSideEffects) {
          console.log(chalk.yellow('⚠ This mode enables autonomous hook side effects (automatic context/checkpoint/observation behavior).'));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
