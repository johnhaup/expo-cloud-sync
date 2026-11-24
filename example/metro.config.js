// Resolves the module from the repo root (its committed build/), with one copy of react, react-native and expo:
// the root's dev copies are blocked so only this app's node_modules serve them.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const root = path.resolve(__dirname, "..");
const config = getDefaultConfig(__dirname);

config.watchFolders = [root];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.resolve(root, "node_modules")];
config.resolver.extraNodeModules = { "@johnhaup/expo-cloud-sync": root };
config.resolver.blockList = [
  ...Array.from(config.resolver.blockList ?? []),
  new RegExp(`${path.resolve(root, "node_modules", "react")}/`),
  new RegExp(`${path.resolve(root, "node_modules", "react-native")}/`),
  new RegExp(`${path.resolve(root, "node_modules", "expo")}/`),
  new RegExp(`${path.resolve(root, "node_modules", "expo-sqlite")}/`),
];

module.exports = config;
