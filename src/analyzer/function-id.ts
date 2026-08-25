/**
 * The shared stable-ID walk.
 *
 * Both the static analyzer (program-loaded ASTs) and the tracer's vite
 * plugin (standalone `ts.createSourceFile` parses) call `collectFunctions`
 * on the same source text and must get byte-identical IDs — every join in
 * gnosis goes through them. Keep this file free of checker dependencies.
 *
 * ID shape: `fn:<posix relPath>#<qualifiedName>[~n]` where qualifiedName is
 * the dot-joined chain of *named* enclosing declarations. Anonymous inline
 * callbacks are deliberately not records: their contents attribute to the
 * nearest named enclosing function, which keeps the graph at meaningful
 * granularity and makes runtime attribution of sync callbacks correct.
 * Function-like declarations without bodies (overload signatures, ambient
 * declares) are skipped, so overloads collapse onto the implementation.
 */
import ts from 'typescript';
import { functionId } from '../graph/schema.ts';

export type FunctionKind =
  | 'function'
  | 'arrow'
  | 'method'
  | 'constructor'
  | 'accessor'
  | 'classProperty';

export interface FunctionRecord {
  id: string;
  qualifiedName: string;
  /** Last segment of the qualified name. */
  name: string;
  kind: FunctionKind;
  /** The function-like AST node (arrow, function, method, accessor). */
  node: ts.Node;
  span: { start: number; end: number; line: number };
  /** The body to instrument: a block's braces span, or an arrow's expression span. */
  body: { start: number; end: number; isBlock: boolean };
  isExported: boolean;
  isAsync: boolean;
}

function propertyNameText(name: ts.PropertyName, sf: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return `[${name.getText(sf)}]`;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === kind) ?? false;
}

function isFunctionValue(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

export function collectFunctions(sourceFile: ts.SourceFile, relPath: string): FunctionRecord[] {
  const records: FunctionRecord[] = [];

  const record = (
    fn: ts.SignatureDeclarationBase & { body?: ts.Node },
    chain: string[],
    kind: FunctionKind,
    exported: boolean,
  ): boolean => {
    const body = fn.body;
    if (!body) return false;
    const isBlock = ts.isBlock(body);
    const start = fn.getStart(sourceFile);
    records.push({
      id: '',
      qualifiedName: chain.join('.'),
      name: chain[chain.length - 1] ?? '',
      kind,
      node: fn,
      span: {
        start,
        end: fn.end,
        line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
      },
      body: { start: body.getStart(sourceFile), end: body.end, isBlock },
      isExported: exported,
      isAsync: hasModifier(fn, ts.SyntaxKind.AsyncKeyword),
    });
    return true;
  };

  const visitChildren = (node: ts.Node, chain: string[]): void => {
    ts.forEachChild(node, (child) => visit(child, chain, false));
  };

  const visitClassMembers = (cls: ts.ClassLikeDeclaration, chain: string[]): void => {
    for (const member of cls.members) {
      if (ts.isConstructorDeclaration(member)) {
        const next = [...chain, 'constructor'];
        if (record(member, next, 'constructor', false)) visitChildren(member.body!, next);
      } else if (ts.isMethodDeclaration(member)) {
        const next = [...chain, propertyNameText(member.name, sourceFile)];
        if (record(member, next, 'method', false)) visitChildren(member.body!, next);
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        const tag = ts.isGetAccessorDeclaration(member) ? 'get' : 'set';
        const next = [...chain, `${propertyNameText(member.name, sourceFile)}[${tag}]`];
        if (record(member, next, 'accessor', false)) visitChildren(member.body!, next);
      } else if (ts.isPropertyDeclaration(member) && member.initializer) {
        const name = propertyNameText(member.name, sourceFile);
        if (isFunctionValue(member.initializer)) {
          const next = [...chain, name];
          if (record(member.initializer, next, 'classProperty', false)) {
            visitChildren(member.initializer.body, next);
          }
        } else if (ts.isObjectLiteralExpression(member.initializer)) {
          visitNamedObject(member.initializer, [...chain, name]);
        } else {
          visit(member.initializer, chain, false);
        }
      } else {
        visitChildren(member, chain);
      }
    }
  };

  const visitNamedObject = (obj: ts.ObjectLiteralExpression, chain: string[]): void => {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = propertyNameText(prop.name, sourceFile);
        if (isFunctionValue(prop.initializer)) {
          const next = [...chain, name];
          const kind = ts.isArrowFunction(prop.initializer) ? 'arrow' : 'function';
          if (record(prop.initializer, next, kind, false)) {
            visitChildren(prop.initializer.body, next);
          }
        } else if (ts.isObjectLiteralExpression(prop.initializer)) {
          visitNamedObject(prop.initializer, [...chain, name]);
        } else {
          visit(prop.initializer, chain, false);
        }
      } else if (ts.isMethodDeclaration(prop)) {
        const next = [...chain, propertyNameText(prop.name, sourceFile)];
        if (record(prop, next, 'method', false)) visitChildren(prop.body!, next);
      } else {
        visitChildren(prop, chain);
      }
    }
  };

  const visit = (node: ts.Node, chain: string[], topLevel: boolean): void => {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? 'default';
      const next = [...chain, name];
      const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      if (record(node, next, 'function', exported)) visitChildren(node.body!, next);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.text ?? (ts.isClassDeclaration(node) ? 'default' : undefined);
      if (name !== undefined) {
        visitClassMembers(node, [...chain, name]);
      } else {
        visitChildren(node, chain);
      }
      return;
    }
    if (ts.isVariableStatement(node)) {
      const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      for (const decl of node.declarationList.declarations) {
        visitVariable(decl, chain, exported);
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      visitVariable(node, chain, false);
      return;
    }
    if (isFunctionValue(node)) {
      // Anonymous position. A named function expression still gets a record;
      // a nameless one is a callback whose contents attribute to `chain`.
      if (ts.isFunctionExpression(node) && node.name) {
        const next = [...chain, node.name.text];
        if (record(node, next, 'function', false)) visitChildren(node.body, next);
      } else {
        visitChildren(node.body, chain);
      }
      return;
    }
    if (ts.isModuleDeclaration(node) && node.body) {
      visit(node.body, [...chain, node.name.getText(sourceFile)], false);
      return;
    }
    if (ts.isModuleBlock(node)) {
      for (const stmt of node.statements) visit(stmt, chain, false);
      return;
    }
    void topLevel;
    visitChildren(node, chain);
  };

  const visitVariable = (decl: ts.VariableDeclaration, chain: string[], exported: boolean): void => {
    const init = decl.initializer;
    if (!init || !ts.isIdentifier(decl.name)) {
      if (init) visit(init, chain, false);
      return;
    }
    const name = decl.name.text;
    if (isFunctionValue(init)) {
      const next = [...chain, name];
      const kind = ts.isArrowFunction(init) ? 'arrow' : 'function';
      if (record(init, next, kind, exported)) visitChildren(init.body, next);
    } else if (ts.isClassExpression(init)) {
      visitClassMembers(init, [...chain, name]);
    } else if (ts.isObjectLiteralExpression(init)) {
      visitNamedObject(init, [...chain, name]);
    } else {
      visit(init, chain, false);
    }
  };

  for (const stmt of sourceFile.statements) visit(stmt, [], true);

  // Assign IDs; genuine same-name redeclarations get ~1, ~2 in source order.
  const seen = new Map<string, number>();
  for (const r of records) {
    const n = seen.get(r.qualifiedName) ?? 0;
    seen.set(r.qualifiedName, n + 1);
    const qualified = n === 0 ? r.qualifiedName : `${r.qualifiedName}~${n}`;
    r.id = functionId(relPath, qualified);
  }
  return records;
}

/** Index records by their function-like AST node, for call attribution. */
export function recordsByNode(records: FunctionRecord[]): Map<ts.Node, FunctionRecord> {
  const map = new Map<ts.Node, FunctionRecord>();
  for (const r of records) map.set(r.node, r);
  return map;
}
