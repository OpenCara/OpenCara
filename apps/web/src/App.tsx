import { useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from "@xyflow/react";

const initialNodes: Node[] = [
  { id: "trigger", position: { x: 0, y: 0 }, data: { label: "GitHub: issue.labeled(ready)" } },
  { id: "agent", position: { x: 280, y: 0 }, data: { label: "Dev agent" } },
];

const initialEdges: Edge[] = [
  { id: "trigger-agent", source: "trigger", target: "agent" },
];

export function App() {
  const [nodes] = useState<Node[]>(initialNodes);
  const [edges] = useState<Edge[]>(initialEdges);

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
