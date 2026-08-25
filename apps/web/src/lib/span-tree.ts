import type { Span } from "./types";

export type SpanTreeNode = Span & { children: SpanTreeNode[] };

function timestamp(span: Span): number {
  if (!span.startedAt) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(span.startedAt);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function wouldCreateCycle(span: Span, byId: ReadonlyMap<string, Span>): boolean {
  const seen = new Set<string>([span.id]);
  let parentId = span.parentSpanId;
  while (parentId) {
    if (seen.has(parentId)) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentSpanId;
  }
  return false;
}

export function buildSpanForest(spans: readonly Span[]): SpanTreeNode[] {
  const unique = new Map<string, Span>();
  for (const span of spans) if (!unique.has(span.id)) unique.set(span.id, span);
  const nodes = new Map<string, SpanTreeNode>();
  for (const span of unique.values()) nodes.set(span.id, { ...span, children: [] });

  const roots: SpanTreeNode[] = [];
  for (const span of unique.values()) {
    const node = nodes.get(span.id);
    if (!node) continue;
    const parent = span.parentSpanId ? nodes.get(span.parentSpanId) : undefined;
    if (!parent || parent.id === span.id || wouldCreateCycle(span, unique)) roots.push(node);
    else parent.children.push(node);
  }

  const sortTree = (items: SpanTreeNode[]): void => {
    items.sort(
      (left, right) => timestamp(left) - timestamp(right) || left.id.localeCompare(right.id),
    );
    for (const item of items) sortTree(item.children);
  };
  sortTree(roots);
  return roots;
}

export function flattenSpanTree(
  roots: readonly SpanTreeNode[],
): Array<{ span: SpanTreeNode; depth: number }> {
  const rows: Array<{ span: SpanTreeNode; depth: number }> = [];
  const visit = (span: SpanTreeNode, depth: number): void => {
    rows.push({ span, depth });
    for (const child of span.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}
