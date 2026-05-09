import { sha256 } from "./hash.ts";
import { findingsBySeverity } from "./markdown.ts";
import type { CanvasDoc, CanvasEdge, CanvasTextNode, Finding, RepoSnapshot } from "./types.ts";

const COL_X = {
  overview: 0,
  components: 620,
  findings: 1240,
  actions: 1860,
};

const NODE_WIDTH = 520;
const NODE_HEIGHT = 160;
const ROW_GAP = 220;
const TOP_Y = 120;

export function buildCanvas(snapshot: RepoSnapshot, findings: Finding[]): CanvasDoc {
  const nodes: CanvasTextNode[] = [];
  const edges: CanvasEdge[] = [];

  const overview = createNode(
    "overview",
    COL_X.overview,
    TOP_Y,
    [
      `Repo: ${snapshot.repoName}`,
      `Commit: ${snapshot.gitSha.slice(0, 12)}`,
      `Profile: ${snapshot.profileId}`,
      `Components: ${snapshot.components.length}`,
      `Findings: ${findings.length}`,
    ].join("\n"),
  );
  nodes.push(overview);

  const componentSummary = createNode(
    "components:summary",
    COL_X.components,
    TOP_Y,
    [
      "Components",
      ...snapshot.components
        .slice(0, 8)
        .map((component) => `- ${component.name} (${component.path})`),
      snapshot.components.length > 8 ? `- +${snapshot.components.length - 8} more` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
    NODE_WIDTH,
    220,
  );
  nodes.push(componentSummary);
  edges.push(createEdge("overview->components", overview.id, componentSummary.id));

  const severityGroups = findingsBySeverity(findings);
  const severityOrder = ["P0", "P1", "P2", "P3"];

  const findingNodes: Array<{ severity: string; node: CanvasTextNode; findings: Finding[] }> = [];
  let findingRow = 0;

  for (const severity of severityOrder) {
    const group = severityGroups.get(severity);
    if (!group || group.length === 0) {
      continue;
    }

    const node = createNode(
      `finding_cluster:${severity}`,
      COL_X.findings,
      TOP_Y + findingRow * ROW_GAP,
      [
        `Severity ${severity}`,
        `Count: ${group.length}`,
        `Top components: ${topComponentsForFindings(group, snapshot)}`,
        ...group.slice(0, 3).map((finding) => `- ${finding.title}`),
      ].join("\n"),
      NODE_WIDTH,
      220,
    );

    nodes.push(node);
    findingNodes.push({ severity, node, findings: group });
    findingRow += 1;
  }

  if (findingNodes.length === 0) {
    const noFindingsNode = createNode(
      "finding_cluster:none",
      COL_X.findings,
      TOP_Y,
      "No findings detected",
    );
    nodes.push(noFindingsNode);
    findingNodes.push({ severity: "none", node: noFindingsNode, findings: [] });
  }

  for (const group of findingNodes) {
    edges.push(createEdge(`overview->${group.node.id}`, overview.id, group.node.id));
  }

  const actionNodes = buildActionNodesBySeverity(findingNodes, findings);
  actionNodes.forEach((actionNode) => {
    const node = createNode(
      `action:${actionNode.severity}:${actionNode.title}`,
      COL_X.actions,
      actionNode.y,
      actionNode.text,
      NODE_WIDTH,
      220,
    );
    nodes.push(node);

    const sourceNode = actionNode.sourceNode ?? overview;
    edges.push(createEdge(`${sourceNode.id}->${node.id}`, sourceNode.id, node.id));
  });

  const doc: CanvasDoc = {
    nodes: sortNodes(nodes),
    edges: sortEdges(edges),
  };

  return doc;
}

function createNode(
  seed: string,
  x: number,
  y: number,
  text: string,
  width: number = NODE_WIDTH,
  height: number = NODE_HEIGHT,
): CanvasTextNode {
  return {
    id: `n-${sha256(seed).slice(0, 12)}`,
    type: "text",
    text,
    x,
    y,
    width,
    height,
  };
}

function createEdge(seed: string, fromNode: string, toNode: string): CanvasEdge {
  return {
    id: `e-${sha256(seed).slice(0, 12)}`,
    fromNode,
    toNode,
    fromSide: "right",
    toSide: "left",
  };
}

function buildActionNodesBySeverity(
  findingNodes: Array<{ severity: string; node: CanvasTextNode; findings: Finding[] }>,
  findings: Finding[],
): Array<{
  severity: string;
  title: string;
  text: string;
  y: number;
  sourceNode?: CanvasTextNode;
}> {
  if (findings.length === 0) {
    return [
      {
        severity: "none",
        title: "maintain",
        y: TOP_Y,
        text: "Action\n- Keep tests green\n- Re-run deterministic report after major changes",
      },
    ];
  }

  return findingNodes.map((group, index) => {
    const primary = group.findings[0];
    return {
      severity: group.severity,
      title: primary?.title ?? `severity-${group.severity}`,
      y: TOP_Y + index * ROW_GAP,
      sourceNode: group.node,
      text: [
        `Action for ${group.severity}`,
        primary?.title ?? "No concrete issue title",
        primary?.file ? `File: ${primary.file}` : "File: n/a",
        "Mitigate and add regression coverage.",
      ].join("\n"),
    };
  });
}

function topComponentsForFindings(findings: Finding[], snapshot: RepoSnapshot): string {
  const componentCounts = new Map<string, number>();

  for (const finding of findings) {
    if (!finding.file) {
      continue;
    }

    for (const component of snapshot.components) {
      // Trailing `/package.json` (anchored to end-of-string) → trailing `/`.
      const componentDir = component.path.replace(/\/package\.json$/, "/");
      if (finding.file.startsWith(componentDir)) {
        componentCounts.set(component.name, (componentCounts.get(component.name) ?? 0) + 1);
      }
    }
  }

  if (componentCounts.size === 0) {
    return "n/a";
  }

  return [...componentCounts.entries()]
    .sort((a, b) => {
      if (a[1] !== b[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 3)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");
}

function sortNodes(nodes: CanvasTextNode[]): CanvasTextNode[] {
  return [...nodes].sort((a, b) => {
    if (a.x !== b.x) {
      return a.x - b.x;
    }
    if (a.y !== b.y) {
      return a.y - b.y;
    }
    return a.id.localeCompare(b.id);
  });
}

function sortEdges(edges: CanvasEdge[]): CanvasEdge[] {
  return [...edges].sort((a, b) => {
    const fromDiff = a.fromNode.localeCompare(b.fromNode);
    if (fromDiff !== 0) {
      return fromDiff;
    }

    const toDiff = a.toNode.localeCompare(b.toNode);
    if (toDiff !== 0) {
      return toDiff;
    }

    return a.id.localeCompare(b.id);
  });
}
