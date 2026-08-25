/**
 * Static call edges: for every call, new-expression, and JSX element in a
 * file, resolve the callee through the type checker to a concrete function
 * record and attribute the edge to the nearest named enclosing function
 * (or to the file itself for module-level code).
 *
 * Calls that resolve only to a type signature — interface members,
 * callback-typed parameters — are dropped: they are dynamic dispatch, and
 * the runtime trace backfills them as `static: false` edges.
 */
import ts from 'typescript';
import { collectFunctions, recordsByNode, type FunctionRecord } from './function-id.ts';
import { isInTarget, safeRealpath, toRelPath } from './programs.ts';

export interface CallSite {
  fromId: string;
  toId: string;
  line: number;
  jsx: boolean;
}

export interface FileRecordCache {
  /** Records (and node index) for any file in the current program, cached. */
  recordsFor(sf: ts.SourceFile): { records: FunctionRecord[]; byNode: Map<ts.Node, FunctionRecord> };
}

export function createFileRecordCache(targetRoot: string): FileRecordCache {
  const cache = new Map<string, { records: FunctionRecord[]; byNode: Map<ts.Node, FunctionRecord> }>();
  return {
    recordsFor(sf) {
      let entry = cache.get(sf.fileName);
      if (!entry) {
        const relPath = toRelPath(targetRoot, safeRealpath(sf.fileName));
        const records = collectFunctions(sf, relPath);
        entry = { records, byNode: recordsByNode(records) };
        cache.set(sf.fileName, entry);
      }
      return entry;
    },
  };
}

/** Map a resolved declaration to the function record that represents it. */
function recordForDeclaration(
  decl: ts.Node,
  checker: ts.TypeChecker,
  targetRoot: string,
  cache: FileRecordCache,
): FunctionRecord | undefined {
  const sf = decl.getSourceFile();
  if (sf.isDeclarationFile) return undefined;
  if (!isInTarget(targetRoot, safeRealpath(sf.fileName))) return undefined;
  const { byNode } = cache.recordsFor(sf);

  const direct = byNode.get(decl);
  if (direct) return direct;

  // A variable declaration's function lives in its initializer.
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const viaInit = byNode.get(decl.initializer);
    if (viaInit) return viaInit;
  }
  if (ts.isPropertyAssignment(decl) && decl.initializer) {
    const viaInit = byNode.get(decl.initializer);
    if (viaInit) return viaInit;
  }
  // An overload signature: hop to the implementation via the symbol.
  const name = ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) ? decl.name : undefined;
  if (name) {
    const symbol = checker.getSymbolAtLocation(name);
    const impl = symbol?.valueDeclaration;
    if (impl && impl !== decl) {
      const viaImpl = byNode.get(impl);
      if (viaImpl) return viaImpl;
    }
  }
  return undefined;
}

function resolveCallee(
  callee: ts.Expression,
  checker: ts.TypeChecker,
): ts.Declaration | undefined {
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  if (!symbol) return undefined;
  return symbol.valueDeclaration ?? symbol.getDeclarations()?.[0];
}

export function analyzeCalls(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  fileNodeId: string,
  targetRoot: string,
  cache: FileRecordCache,
): CallSite[] {
  const sites: CallSite[] = [];
  const { byNode } = cache.recordsFor(sourceFile);
  const stack: FunctionRecord[] = [];

  const currentId = (): string => stack[stack.length - 1]?.id ?? fileNodeId;

  const emit = (decl: ts.Node | undefined, at: ts.Node, jsx: boolean): void => {
    if (!decl) return;
    const record = recordForDeclaration(decl, checker, targetRoot, cache);
    if (!record) return;
    sites.push({
      fromId: currentId(),
      toId: record.id,
      line: sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile)).line + 1,
      jsx,
    });
  };

  const visit = (node: ts.Node): void => {
    const record = byNode.get(node);
    if (record) stack.push(record);

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const sig = checker.getResolvedSignature(node);
      // Prefer a concrete signature declaration; a type-position signature
      // (interface member, callback parameter) means dynamic dispatch, so
      // fall back to the callee symbol and let that succeed or drop.
      let decl: ts.Node | undefined = sig?.getDeclaration();
      if (
        !decl ||
        ts.isJSDocSignature(decl) ||
        ts.isFunctionTypeNode(decl) ||
        ts.isMethodSignature(decl) ||
        ts.isCallSignatureDeclaration(decl) ||
        ts.isConstructSignatureDeclaration(decl)
      ) {
        decl = resolveCallee(node.expression, checker);
      }
      emit(decl, node, false);
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const isComponent =
        (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) || ts.isPropertyAccessExpression(tag);
      if (isComponent) {
        let symbol = checker.getSymbolAtLocation(tag);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        emit(symbol?.valueDeclaration ?? symbol?.getDeclarations()?.[0], node, true);
      }
    }

    ts.forEachChild(node, visit);
    if (record) stack.pop();
  };

  visit(sourceFile);
  return sites;
}
