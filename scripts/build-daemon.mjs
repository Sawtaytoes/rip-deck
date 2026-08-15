// Bundle the daemon to a single ESM file that runs on plain `node`.
//
// The image used to run `tsx packages/daemon/src/cli.ts`, which keeps
// esbuild resident to transpile on every start — ~300 MB of RAM for a
// long-lived watcher, and it drags the whole devDependency tree
// (tsx, typescript, vite…) into the deployed image. We never want tsx
// in the actual image. This produces `packages/daemon/dist/cli.js`,
// which the container launcher runs directly with `node`.
//
// A single bundle rather than `tsc`: the source imports with explicit
// `.ts` extensions (the tsx/ESM style), which `tsc` cannot emit for
// (`allowImportingTsExtensions` forces `noEmit`). esbuild rewrites
// them and folds the workspace `@rip-deck/contracts` + `rxjs` + `mqtt`
// in, so the runtime image needs no `node_modules` at all.
import { build } from "esbuild"

await build({
  entryPoints: ["packages/daemon/src/cli.ts"],
  outfile: "packages/daemon/dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  // Some bundled CJS deps call `require` at runtime; ESM output has
  // none, so shim it from the module URL.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
})
