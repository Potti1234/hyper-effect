import { readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { Effect } from 'effect'
import ts from 'typescript'

import type { Check } from './changes.ts'
import { listFiles } from './files.ts'

/* What an extension's code may reach, checked statically before a run goes
   live (docs/jellyware/open-work.md#extensions-run-with-the-apps-rights).

   Extension code runs in the server process, so `requires` limits the
   services its layer is typed against, not what the code can do. This check
   parses every script of a changed extension and refuses:

   - imports (static, `export ... from` and `import()`) of modules outside
     an allow-list, or of names a module is not allowed for (a package can
     export both what extensions need and what reaches the file system), and
     relative imports that leave the extension's folder;
   - `import()` of anything but a string literal;
   - the globals that reach the process or the network (`process`,
     `globalThis`, `require`, `eval`, `Function`, `fetch`, ...), as plain
     names or as `x['name']`;
   - names that are dangerous wherever they appear, such as Effect's `Config`
     and `ConfigProvider` (they read the environment);
   - `import.meta` (the module's own URL and resolver).

   It is a check of what the code says, not a sandbox: code that gets past
   it still runs with the app's rights. Only a separate process removes that
   (design.md#8-trust). Type-only imports are erased, so they are not
   checked. */

/** A module of which only some names may be imported (by name: no
 *  namespace, default, `export *` or `import()`). */
export type NamedImports = Readonly<{ module: string; names: ReadonlyArray<string> }>

export type ImportRules = Readonly<{
  /** What an extension may import. A string allows a whole module: `name`
   *  allows `name` and its subpaths (`foldkit` allows `foldkit/html`);
   *  `prefix*` every specifier that starts with `prefix`; `=name` exactly
   *  `name`. `NamedImports` allows some names of one module. */
  allow: ReadonlyArray<string | NamedImports>
  /** Specifiers refused even when `allow` matches them, in the notation of
   *  the strings of `allow`. */
  deny?: ReadonlyArray<string>
  /** Global names refused where they are used as values; default
   *  `DEFAULT_GLOBALS`. */
  globals?: ReadonlyArray<string>
  /** Names refused wherever they appear, property names included; default
   *  `DEFAULT_NAMES`. */
  names?: ReadonlyArray<string>
  /** Test files (`*.test.ts` and the like) may also import these, such as
   *  the test runner; every other rule holds for them too. */
  testAllow?: ReadonlyArray<string | NamedImports>
}>

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/** Whether a file of an extension is a test. */
export const isTestFile = (path: string): boolean => TEST_FILE.test(path)

export const DEFAULT_GLOBALS: ReadonlyArray<string> = [
  'process',
  'globalThis',
  'global',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'eval',
  'Function',
  'Deno',
  'Bun',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'importScripts',
]

export const DEFAULT_NAMES: ReadonlyArray<string> = ['Config', 'ConfigProvider']

const SCRIPT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

const matches = (specifier: string, rule: string) =>
  rule.startsWith('=')
    ? specifier === rule.slice(1)
    : rule.endsWith('*')
      ? specifier.startsWith(rule.slice(0, -1))
      : specifier === rule || specifier.startsWith(`${rule}/`)

/** What `specifier` may be imported for: everything, some names, or
 *  nothing (null). */
const permission = (specifier: string, rules: ImportRules): 'all' | ReadonlySet<string> | null => {
  if ((rules.deny ?? []).some(rule => matches(specifier, rule))) return null
  if (rules.allow.some(rule => typeof rule === 'string' && matches(specifier, rule))) return 'all'
  const named = rules.allow.filter((rule): rule is NamedImports => typeof rule !== 'string' && rule.module === specifier)
  return named.length === 0 ? null : new Set(named.flatMap(rule => rule.names))
}

const describeRules = (rules: ImportRules) =>
  rules.allow.map(rule => (typeof rule === 'string' ? rule : `${rule.module} (${rule.names.join(', ')})`)).join('; ')

/** Whether `node` is only a name here (a property, a member, an imported or
 *  exported name), not a use of the global of that name. */
const isMemberName = (node: ts.Identifier): boolean => {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) {
    return ts.isPropertyAccessExpression(parent) ? parent.name === node : parent.right === node
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true
  // `{ x as y }`: the module is checked.
  return ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)
}

const scriptKind = (path: string): ts.ScriptKind => {
  switch (extname(path)) {
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TS
  }
}

/** The problems in one script, at `path` in the extension folder `folder`
 *  (relative imports must stay in it). */
export const findProblems = (
  source: string,
  path: string,
  folder: string,
  rules: ImportRules,
): ReadonlyArray<string> => {
  const globals = new Set(rules.globals ?? DEFAULT_GLOBALS)
  const names = new Set(rules.names ?? DEFAULT_NAMES)
  const root = resolve(folder)
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path))
  const shown = relative(root, path).split(sep).join('/')
  const problems: Array<string> = []
  const at = (node: ts.Node) => `${shown}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`

  /** Checks one import of `specifier`; `imported` are the value names it
   *  takes, or null when it takes the whole module. */
  const checkSpecifier = (node: ts.Node, specifier: string, imported: ReadonlyArray<string> | null) => {
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(path), specifier)
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        problems.push(`${at(node)}: "${specifier}" is outside the extension's folder.`)
      }
      return
    }
    const names = permission(specifier, rules)
    if (names === null) {
      problems.push(`${at(node)}: extensions may not import "${specifier}" (allowed: ${describeRules(rules)}).`)
    } else if (names !== 'all') {
      const list = [...names].join(', ')
      if (imported === null) {
        problems.push(`${at(node)}: import names from "${specifier}" one by one ({ ${list} }).`)
      } else {
        for (const name of imported.filter(each => !names.has(each))) {
          problems.push(`${at(node)}: extensions may not import ${name} from "${specifier}" (allowed: ${list}).`)
        }
      }
    }
  }

  /** The value names an import takes; null for a namespace or default
   *  import. */
  const importedNames = (clause: ts.ImportClause | undefined): ReadonlyArray<string> | null => {
    if (clause === undefined) return []
    if (clause.name !== undefined) return null
    const bindings = clause.namedBindings
    if (bindings === undefined) return []
    if (ts.isNamespaceImport(bindings)) return null
    return bindings.elements.filter(element => !element.isTypeOnly).map(element => (element.propertyName ?? element.name).text)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const typeOnly = node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        checkSpecifier(node, node.moduleSpecifier.text, importedNames(node.importClause))
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.exportClause
        const exported =
          clause !== undefined && ts.isNamedExports(clause)
            ? clause.elements.filter(element => !element.isTypeOnly).map(element => (element.propertyName ?? element.name).text)
            : null
        checkSpecifier(node, node.moduleSpecifier.text, exported)
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      problems.push(`${at(node)}: use \`import\`, not \`import x = require(...)\`.`)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteralLike(argument)) checkSpecifier(node, argument.text, null)
      else problems.push(`${at(node)}: \`import()\` must name its module as a string.`)
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      problems.push(`${at(node)}: extensions may not use \`import.meta\`.`)
    } else if (ts.isIdentifier(node)) {
      if (names.has(node.text)) {
        problems.push(`${at(node)}: extensions may not use \`${node.text}\`.`)
      } else if (globals.has(node.text) && !isMemberName(node)) {
        problems.push(`${at(node)}: extensions may not use the global \`${node.text}\`.`)
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      (globals.has(node.argumentExpression.text) || names.has(node.argumentExpression.text))
    ) {
      problems.push(`${at(node)}: extensions may not use \`${node.argumentExpression.text}\`.`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return problems
}

/** The problems in every script of an extension's folder. */
export const checkFolder = (folder: string, rules: ImportRules) =>
  Effect.promise(async () => {
    const root = resolve(folder)
    const problems: Array<string> = []
    for (const file of await listFiles(root)) {
      if (!SCRIPT.has(extname(file))) continue
      const path = join(root, file)
      const fileRules = isTestFile(file) ? { ...rules, allow: [...rules.allow, ...(rules.testAllow ?? [])] } : rules
      problems.push(...findProblems(await readFile(path, 'utf8'), path, root, fileRules))
    }
    return problems
  })

/** A run check that refuses changed extensions whose code reaches beyond
 *  the allow-list. */
export const importCheck = (rules: ImportRules): Check => ({
  name: 'Imports',
  run: ({ snapshot, changed }) =>
    Effect.gen(function* () {
      const problems: Array<string> = []
      for (const id of changed) {
        problems.push(...(yield* checkFolder(join(snapshot, id), rules)).map(problem => `${id}/${problem}`))
      }
      if (problems.length > 0) {
        return yield* Effect.fail(
          `${problems.join('\n')}\n\nExtensions run inside the app's server: they may use the modules allowed above and the app's services, not the process, the file system or the network.`,
        )
      }
    }),
})
