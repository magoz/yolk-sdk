import { Array as Arr, Match, SchemaAST, type SchemaRepresentation } from 'effect'
import { toolJsonSchemaOmittedNullComment } from '@yolk-sdk/agent/protocol'

// `Schema.toCodecJson` encodes `undefined` as JSON `null`, so `Schema.optional(X)` is advertised
// as `anyOf: [X, { type: 'null' }]`, the same JSON as `Schema.optionalKey(Schema.NullOr(X))`.
// Only the AST tells them apart: the first `null` is an `Undefined` node whose encoding ends at
// `Null`, the second a plain `Null`. `SchemaRepresentation.toRepresentation` lowers the encoded
// side node for node, so walking both in lockstep marks exactly the codec-added nulls with
// `toolJsonSchemaOmittedNullComment`. Anything that does not line up is left unmarked.

const maxDepth = 512

type Representation = SchemaRepresentation.Representation

/** The JSON-side node of `ast`: the one `toRepresentation` lowers at this position. */
const jsonSide = (ast: SchemaAST.AST): SchemaAST.AST =>
  ast.encoding === undefined ? ast : jsonSide(Arr.lastNonEmpty(ast.encoding).to)

/** An `undefined` the JSON codec encodes as `null`, so that `null` decodes as `undefined`. */
const isCodecUndefined = (ast: SchemaAST.AST) =>
  (SchemaAST.isUndefined(ast) || SchemaAST.isVoid(ast)) &&
  ast.encoding !== undefined &&
  SchemaAST.isNull(jsonSide(ast))

const markAll = <A>(
  representations: ReadonlyArray<A>,
  asts: ReadonlyArray<SchemaAST.AST>,
  mark: (representation: A, ast: SchemaAST.AST) => A
): ReadonlyArray<A> =>
  representations.length === asts.length
    ? representations.map((representation, index) => {
        const ast = asts[index]

        return ast === undefined ? representation : mark(representation, ast)
      })
    : representations

/** Marks the codec-added nulls of a `toRepresentation(ast)` document. */
export const markOmittedNulls = (
  document: SchemaRepresentation.Document,
  ast: SchemaAST.AST
): SchemaRepresentation.Document => {
  const references = new Map(Object.entries(document.references))
  const visitedReferences = new Set<string>()

  const mark = (
    representation: Representation,
    input: SchemaAST.AST,
    depth: number
  ): Representation => {
    if (depth > maxDepth) return representation

    const ast = jsonSide(input)

    const next = (child: Representation, childAst: SchemaAST.AST): Representation =>
      mark(child, childAst, depth + 1)

    return Match.value(representation).pipe(
      Match.tags({
        Reference: reference => {
          const target = references.get(reference.$ref)

          if (target !== undefined && !visitedReferences.has(reference.$ref)) {
            visitedReferences.add(reference.$ref)
            references.set(reference.$ref, mark(target, input, depth + 1))
          }

          return reference
        },
        Null: (nullRepresentation): Representation =>
          isCodecUndefined(input)
            ? {
                ...nullRepresentation,
                annotations: {
                  ...nullRepresentation.annotations,
                  $comment: toolJsonSchemaOmittedNullComment
                }
              }
            : nullRepresentation,
        Union: (union): Representation =>
          SchemaAST.isUnion(ast)
            ? { ...union, types: markAll(union.types, ast.types, next) }
            : union,
        Objects: (objects): Representation =>
          SchemaAST.isObjects(ast)
            ? {
                ...objects,
                propertySignatures: markAll(
                  objects.propertySignatures,
                  ast.propertySignatures.map(property => property.type),
                  (property, type): SchemaRepresentation.PropertySignature => ({
                    ...property,
                    type: next(property.type, type)
                  })
                ),
                indexSignatures: markAll(
                  objects.indexSignatures,
                  ast.indexSignatures.map(index => index.type),
                  (index, type): SchemaRepresentation.IndexSignature => ({
                    ...index,
                    type: next(index.type, type)
                  })
                )
              }
            : objects,
        Arrays: (arrays): Representation =>
          SchemaAST.isArrays(ast)
            ? {
                ...arrays,
                elements: markAll(
                  arrays.elements,
                  ast.elements,
                  (element, type): SchemaRepresentation.Element => ({
                    ...element,
                    type: next(element.type, type)
                  })
                ),
                rest: markAll(arrays.rest, ast.rest, next)
              }
            : arrays,
        Suspend: (suspend): Representation =>
          SchemaAST.isSuspend(ast)
            ? { ...suspend, thunk: next(suspend.thunk, ast.thunk()) }
            : suspend,
        Declaration: (declaration): Representation =>
          SchemaAST.isDeclaration(ast)
            ? {
                ...declaration,
                typeParameters: markAll(declaration.typeParameters, ast.typeParameters, next)
              }
            : declaration
      }),
      Match.orElse(other => other)
    )
  }

  const representation = mark(document.representation, ast, 0)

  return { representation, references: Object.fromEntries(references) }
}
