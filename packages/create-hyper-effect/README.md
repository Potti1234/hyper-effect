# create-hyper-effect

Creates a hyper-effect app from `template/`: one page with sign-in, live shared state, a validated form, regions, crease/ui components, Story and HTTP tests, and a Playwright browser check.

```sh
npm create hyper-effect@alpha my-app       # anywhere → ./my-app, then npm install
npm run create -- my-app --title "My App"   # at the monorepo root → apps/my-app
npm install                                # links the new workspace
cd apps/my-app && npm start                # http://localhost:4000
```

Outside the monorepo, `npm create hyper-effect@alpha my-app` creates `./my-app`, depending on the `@hyper-effect/core` version published with it, with the hyper-effect agent skill in `.claude/skills`. Inside the monorepo the app goes to `apps/<name>` (a workspace on the local packages). `--core <version>` overrides the dependency (`file:<tarball>` for a packed build) and `--dir` the target.

The template is a working app, not a stub: `apps/starter` is generated from it, and its tests and browser check run with the rest. Change the template, regenerate `starter` (or apply the change to it), and run `npm run check` there.

Agents building on a generated app use the `hyper-effect` skill in `.claude/skills/hyper-effect`.
