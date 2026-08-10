const { resolve } = require("node:path");

// Metro cannot follow tsconfig `paths`, so the shared aliases are declared here
// too. They must stay in step with apps/capture's vite config: every surface has
// to sign bytes produced by one and the same canonical encoder.
//
// The paths are absolute. module-resolver resolves a relative alias against the
// *importing* file, so "../../packages/..." would silently mean something
// different in src/lib than in src/screens.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
          alias: {
            "@shared/canonical": resolve(__dirname, "../../packages/shared/src/canonical-core.ts"),
            "@shared/types": resolve(__dirname, "../../packages/shared/src/types.ts"),
          },
        },
      ],
    ],
  };
};
