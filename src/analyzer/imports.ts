/**
 * File-level import edges: static imports, re-exports, and literal dynamic
 * imports, resolved with the owning program's own compiler options so the
 * target's resolution style (bundler, explicit .ts extensions, workspace
 * packages) is honored. Resolved paths are realpath'd, so `@openflow/core`
 * lands on the real `core/src/...` file.
 */
import ts from 'typescript';
import { isInTarget, safeRealpath } from './programs.ts';

export interface ImportEdge {
  /** Realpath of the imported file. */
  toRealPath: string;
  line: number;
}

export function analyzeImports(
  sourceFile: ts.SourceFile,
  options: ts.CompilerOptions,
  targetRoot: string,
): ImportEdge[] {
  const edges: ImportEdge[] = [];

  const resolve = (specifier: string, at: ts.Node): void => {
    const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, options, ts.sys);
    const fileName = resolved.resolvedModule?.resolvedFileName;
    if (!fileName) return;
    const real = safeRealpath(fileName);
    if (!isInTarget(targetRoot, real)) return;
    edges.push({
      toRealPath: real,
      line: sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      resolve(node.moduleSpecifier.text, node);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      resolve((node.arguments[0] as ts.StringLiteralLike).text, node);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return edges;
}
