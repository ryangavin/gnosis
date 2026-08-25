/**
 * Doc-comment extraction: TSDoc blocks on function records and file headers.
 *
 * The testbed writes rationale-heavy comments in two styles — `/** *\/`
 * blocks on exports and `//` header runs at the top of files — so both are
 * harvested. Summaries are the first sentence, where a blank line also ends
 * a sentence.
 */
import ts from 'typescript';

function flattenComment(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  if (comment === undefined) return '';
  if (typeof comment === 'string') return comment;
  return comment.map((part) => part.text).join('');
}

/** First sentence of a doc text: up to the first `. ` boundary or blank line. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const paragraph = trimmed.split(/\n\s*\n/, 1)[0]!.replace(/\s+/g, ' ');
  const match = paragraph.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : paragraph).trim();
}

/**
 * The doc comment for a function-like node. For arrows and function
 * expressions the comment sits on the enclosing variable statement or
 * property, so walk up through purely-syntactic wrappers first.
 */
export function docForFunction(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    const docs = ts.getJSDocCommentsAndTags(current).filter(ts.isJSDoc);
    if (docs.length > 0) {
      const text = flattenComment(docs[docs.length - 1]!.comment).trim();
      if (text) return text;
    }
    const parent: ts.Node | undefined = current.parent;
    if (
      parent &&
      (ts.isVariableDeclaration(parent) ||
        ts.isVariableDeclarationList(parent) ||
        ts.isVariableStatement(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isExportAssignment(parent))
    ) {
      current = parent;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The file's header comment: the leading block or `//` run before the first
 * statement, in either comment style.
 */
export function docForFile(sourceFile: ts.SourceFile): string | undefined {
  const text = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, 0);
  if (!ranges || ranges.length === 0) return undefined;

  const first = ranges[0]!;
  if (first.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
    const body = text
      .slice(first.pos, first.end)
      .replace(/^\/\*\*?/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\* ?/, ''))
      .join('\n')
      .trim();
    return body || undefined;
  }

  // A run of consecutive `//` lines.
  const lines: string[] = [];
  for (const range of ranges) {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) break;
    lines.push(text.slice(range.pos, range.end).replace(/^\/\/ ?/, ''));
  }
  const body = lines.join('\n').trim();
  return body || undefined;
}
