#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pluginPath = resolve("src/openclaw-plugin.ts");
const source = readFileSync(pluginPath, "utf8");

function fail(message) {
  console.error(`\n[architecture-check] ${message}`);
  process.exit(1);
}

function extractRegion(startMarker, endMarker) {
  const startIndex = source.indexOf(startMarker);
  if (startIndex === -1) {
    fail(`Could not find marker: ${startMarker}`);
  }

  const endIndex = source.indexOf(endMarker, startIndex);
  if (endIndex === -1) {
    fail(`Could not find marker: ${endMarker}`);
  }

  return source.slice(startIndex, endIndex);
}

const automationHooksBody = extractRegion(
  "function registerAutomationHooks",
  "function isOpenClawPluginApi"
);
const alwaysOnRegistrationBody = extractRegion(
  "function registerOpenClawPlugin",
  "const clawvaultPlugin ="
);

const automationGuardIndex = alwaysOnRegistrationBody.indexOf("if (isAutomationModeEnabled(pluginConfig))");
const guardedRegistrationIndex = alwaysOnRegistrationBody.indexOf("registerAutomationHooks(api,");

if (automationGuardIndex === -1 || guardedRegistrationIndex === -1 || guardedRegistrationIndex < automationGuardIndex) {
  fail(
    "registerAutomationHooks(api, ...) must stay behind if (isAutomationModeEnabled(pluginConfig))."
  );
}

const hooksInAutomationBody = (automationHooksBody.match(/\bapi\.on\s*\(/g) ?? []).length;
if (hooksInAutomationBody === 0) {
  fail("registerAutomationHooks must contain api.on(...) registrations.");
}

if (/\bapi\.on\s*\(/.test(alwaysOnRegistrationBody)) {
  fail(
    [
      "Detected api.on(...) inside registerOpenClawPlugin (always-on path).",
      "Per src/plugin/ARCHITECTURE.md hard rule, hook automation must be pack-gated.",
      "Move hook registration into registerAutomationHooks and guard it with pack checks."
    ].join(" ")
  );
}

console.log("[architecture-check] OK: plugin hooks remain pack-gated.");
