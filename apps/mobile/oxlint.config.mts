import { defineConfig } from "oxlint";
import react from "ultracite/oxlint/react";
import reactNative from "ultracite/oxlint/react-native";

import root from "../../oxlint.config.mts";

// Oxlint lints each file with its nearest config alone, so this extends the
// root config and repeats the properties that extends doesn't carry over.
export default defineConfig({
  env: root.env,
  extends: [root, react, reactNative],
  ignorePatterns: root.ignorePatterns,
  settings: root.settings,
});
