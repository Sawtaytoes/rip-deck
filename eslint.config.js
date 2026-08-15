import vitest from "@vitest/eslint-plugin"
import tseslint from "typescript-eslint"

// ESLint earns its place here only by doing what Biome
// structurally cannot: type-aware analysis. Biome keeps its
// monopoly on formatting and on syntax-only lint, so this config
// deliberately adds no stylistic rules — a rule Biome could have
// enforced does not belong here, because two tools disagreeing
// about the same file is how a lint step gets ignored.
//
// The rules that matter for this codebase are the promise ones
// (no-floating-promises, no-misused-promises, await-thenable):
// a rip is a tree of child processes and async device I/O, and a
// dropped promise there is a rip that silently never finishes.
export default tseslint.config(
  {
    ignores: [
      ".yarn/",
      "coverage/",
      // Agent fan-out worktrees live at `.claude/worktrees/<slug>`
      // (see the root workspace's subagent-pr-workflow runbook),
      // and each one is a FULL checkout of this repo. Without
      // this, `yarn lint` in the main tree lints every parallel
      // agent's half-written branch as if it were ours: Stage 7
      // ran six at once, which reported another unit's unused
      // variable as a failure here and pushed eslint past node's
      // default heap into an OOM that read like a broken gate.
      ".claude/",
      "**/__fixtures__/",
      "**/build/",
      "**/dist/",
      // Storybook's generated build output — the same class as
      // `build/`/`dist/`, and never in a fresh CI checkout
      // (gitignored) but present after a local `build-storybook`.
      "**/storybook-static/",
      // Storybook's config (`main.ts`/`preview.tsx`/`themeAxes.ts`)
      // is build-time tooling, not the runtime code this
      // type-aware config exists to keep promise-safe. It also
      // belongs to no workspace tsconfig (`include: ["src"]`), so
      // `projectService` cannot parse it and `npx eslint .` HARD
      // FAILED on it in CI — which, since `docker-deploy needs:
      // [check]`, silently skipped the image build. Ignore it the
      // way `.claude/` worktrees are ignored: not ours to type-lint.
      "**/.storybook/",
    ],
  },
  {
    // `.tsx` is here for `@rip-deck/web`. The promise rules are
    // exactly as load-bearing in a component as in the daemon:
    // an `onClick` handed an async function is
    // no-misused-promises, and it is how a click that failed
    // ends up looking like a click that worked.
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // The workspace tsconfigs `include: ["src"]`, and the
          // root one excludes `packages` outright, so these two
          // files belong to no project and would otherwise be a
          // hard parse error rather than a lint result.
          allowDefaultProject: [
            "packages/*/vitest.config.ts",
            // The declaration beside `optimizeDeps.js`. That list is
            // plain JS so `charcuterie-check-optimize-deps` can read it
            // from a plain Node process; this `.d.ts` is what keeps the
            // Vitest config's import of it typed.
            "packages/*/optimizeDeps.d.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    extends: [vitest.configs.recommended],
    rules: {
      // A test double standing in for an async dependency has to
      // be declared async to match the signature it replaces,
      // even when the fake body has nothing to await. Requiring
      // an await there would mean adding a pointless one to
      // every stub.
      "@typescript-eslint/require-await": "off",

      // The pattern this flags here is not the swallowed-throw
      // anti-pattern the rule is aimed at. It is
      // `expect(x.kind).toBe("ready")` followed by
      // `if (x.kind === "ready")`, which exists so TypeScript
      // narrows the discriminated union before the assertions
      // that read its variant-specific fields.
      "vitest/no-conditional-expect": "off",
    },
  },
)
