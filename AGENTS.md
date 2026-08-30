# Working rules for agents in this repo

## 1. Commit regularly, one concern per commit

Do not hold a batch of work for one big commit at the end. Each logical
change — a feature, a fix, a doc section that belongs to it — is its own
commit as soon as it is done and verified (tests for the touched area,
`npm run typecheck`, `eslint` on the changed files).

"Focused" means: one concern per commit, code and its tests and the
`docs/*.md` section that records it travel together, and the tree at that
commit builds and passes on its own. When two changes touch the same file,
split the hunks rather than mixing concerns.

Push after the work is committed.

## 2. Rebuild before handing off

The app runs from the built bundle (`package.json` `main` → `out/main/`),
not from `src/` — launching `node_modules/electron/dist/electron.exe .`
against a stale `out/` shows an old interface no matter what landed in
git. After any change to app source, run `npm run build` so `out/` matches
what was just committed, and say so when handing off.

(`npm run dev` watches and rebuilds on its own; the rebuild rule is for the
build-and-launch workflow.)
