const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["build/*", "plugin/build/*", "example/ios/*", "example/android/*", "example/.expo/*"],
  },
  {
    // The example imports the module through its tsconfig path.
    files: ["example/**"],
    settings: { "import/resolver": { typescript: { project: "example/tsconfig.json" } } },
  },
]);
