import { relative, sep } from 'node:path'
import { Option } from 'effect'
import * as Schema from 'effect/Schema'
import type { Plugin } from 'vite'

/**
 * Compiles Vercel Workflow's directives for the Cloudflare runtime in server environments:
 *
 * - `async function name(…) { 'use step'; … }` keeps its signature; its body becomes a durable
 *   step call (`workflowStep(name, '<module>#name', async () => body)`), so `name.maxRetries` set
 *   later still applies.
 * - `async function name(…) { 'use workflow'; … }` is registered as `<module>#name`, the id a
 *   run is started and replayed by.
 *
 * Only top-level function declarations carry directives, as in the platform's own compiler.
 */

type Edit = { readonly start: number; readonly end: number; readonly text: string }

// The parts of the ESTree program the transform reads; anything else is skipped.

const Directive = Schema.Literals(['use step', 'use workflow'])

type Directive = typeof Directive.Type

/** A directive prologue entry: `directive` in ESTree, else the string literal's `value`. */
const DirectiveStatement = Schema.Struct({
  type: Schema.Literal('ExpressionStatement'),
  directive: Schema.optional(Schema.String),
  expression: Schema.Struct({ value: Schema.optional(Schema.Unknown) })
})

const FunctionDeclaration = Schema.Struct({
  type: Schema.Literal('FunctionDeclaration'),
  id: Schema.Struct({ name: Schema.String }),
  end: Schema.Number,
  body: Schema.Struct({
    start: Schema.Number,
    end: Schema.Number,
    body: Schema.Array(Schema.Unknown)
  })
})

type FunctionDeclaration = typeof FunctionDeclaration.Type

const ExportDeclaration = Schema.Struct({
  type: Schema.Literals(['ExportNamedDeclaration', 'ExportDefaultDeclaration']),
  declaration: FunctionDeclaration
})

const Program = Schema.Struct({ body: Schema.Array(Schema.Unknown) })

const decodeDirective = Schema.decodeUnknownOption(Directive)

const decodeDirectiveStatement = Schema.decodeUnknownOption(DirectiveStatement)

const decodeFunctionDeclaration = Schema.decodeUnknownOption(FunctionDeclaration)

const decodeExportDeclaration = Schema.decodeUnknownOption(ExportDeclaration)

const decodeProgram = Schema.decodeUnknownOption(Program)

const directiveOf = (declaration: FunctionDeclaration): Directive | undefined =>
  Option.getOrUndefined(
    Option.flatMap(decodeDirectiveStatement(declaration.body.body[0]), statement =>
      decodeDirective(statement.directive ?? statement.expression.value)
    )
  )

/** Top-level function declarations, exported or not. */
const functionDeclarations = (program: unknown): ReadonlyArray<FunctionDeclaration> =>
  Option.match(decodeProgram(program), {
    onNone: () => [],
    onSome: ({ body }) =>
      body.flatMap(statement =>
        Option.toArray(
          Option.orElse(decodeFunctionDeclaration(statement), () =>
            Option.map(decodeExportDeclaration(statement), exported => exported.declaration)
          )
        )
      )
  })

/** The module compiled code imports `workflowStep` and `workflowEntry` from by default. */
export const workflowDirectivesRuntime = '@yolk-sdk/vercel-workflows/cloudflare/directives'

export type WorkflowDirectivesOptions = {
  /**
   * Directory workflow ids are relative to (`<module path>#<name>`). Default: Vite's `root`. Ids
   * are stored with runs, so moving or renaming a workflow module strands its in-flight runs.
   */
  readonly root?: string
  /** Module the compiled code imports `workflowStep` and `workflowEntry` from. */
  readonly runtime?: string
}

/**
 * Compiles one module's directives (see the module comment); `undefined` when it has none.
 * `parse` returns the module's ESTree `Program` with `start`/`end` offsets (Vite's `this.parse`).
 */
export const compileWorkflowDirectives = (
  code: string,
  options: {
    /** Module path the ids use, relative to the root, with `/` separators. */
    readonly modulePath: string
    readonly runtime: string
    readonly parse: (code: string) => unknown
  }
): string | undefined => {
  if (!code.includes('use step') && !code.includes('use workflow')) return undefined

  const edits: Array<Edit> = []

  for (const declaration of functionDeclarations(options.parse(code))) {
    const directive = directiveOf(declaration)

    if (directive === undefined) continue

    const name = declaration.id.name
    const workflowId = JSON.stringify(`${options.modulePath}#${name}`)
    const body = declaration.body

    if (directive === 'use step') {
      edits.push({
        start: body.start,
        end: body.end,
        text: `{ return __yolkWorkflowStep(${name}, ${workflowId}, async () => ${code.slice(body.start, body.end)}) }`
      })
    } else {
      edits.push({
        start: declaration.end,
        end: declaration.end,
        text: `\n__yolkWorkflowEntry(${name}, ${workflowId});`
      })
    }
  }

  if (edits.length === 0) return undefined

  let output = code

  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  }

  return `import { workflowStep as __yolkWorkflowStep, workflowEntry as __yolkWorkflowEntry } from ${JSON.stringify(options.runtime)};\n${output}`
}

/**
 * The Vite plugin that compiles `'use step'` and `'use workflow'` for the Cloudflare runtime in
 * every environment but `client`. Files under `node_modules` and virtual modules are left alone.
 */
export const workflowDirectives = (options: WorkflowDirectivesOptions = {}): Plugin => {
  let root = options.root
  const runtime = options.runtime ?? workflowDirectivesRuntime

  return {
    name: 'yolk:workflow-directives',
    configResolved(config) {
      root ??= config.root
    },
    transform(code, id) {
      if (this.environment.name === 'client') return null

      const file = id.split('?')[0] ?? id

      if (file.startsWith('\0') || file.includes('/node_modules/')) return null

      if (!/\.[cm]?[jt]sx?$/.test(file)) return null

      const modulePath = relative(root ?? process.cwd(), file)
        .split(sep)
        .join('/')

      const compiled = compileWorkflowDirectives(code, {
        modulePath,
        runtime,
        parse: source => this.parse(source)
      })

      return compiled === undefined ? null : { code: compiled, map: null }
    }
  }
}
