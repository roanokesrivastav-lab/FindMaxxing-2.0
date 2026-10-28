// Metro in an npm-workspaces monorepo. Expo's default config already watches
// the workspace root; two things on top:
//   * React and React DOM resolve to this app's copies (React Native 0.86
//     needs exactly react 19.2.3; the web app at the root runs a later 19.2).
//   * @findmaxxing/shared is TypeScript source, compiled by Metro like app code.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const local = (name) => path.dirname(require.resolve(`${name}/package.json`, { paths: [__dirname] }));
const pinned = { react: local("react"), "react-dom": local("react-dom") };

const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  for (const [name, dir] of Object.entries(pinned)) {
    if (moduleName === name || moduleName.startsWith(`${name}/`)) {
      return context.resolveRequest(context, dir + moduleName.slice(name.length), platform);
    }
  }
  return (resolve ?? context.resolveRequest)(context, moduleName, platform);
};
config.resolver.unstable_enablePackageExports = true;
module.exports = config;
