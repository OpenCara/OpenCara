import { Hono } from "hono";
import { builtinFlows } from "@opencara/flows";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";

/**
 * Read-only catalogue of the built-in flow templates registered in
 * @opencara/flows. These are the seeds — every project gets its own editable
 * instance of each template, but the templates themselves live in code and
 * are exposed here so the UI can browse them without going through a project.
 */
export function flowTemplateRoutes() {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  r.get("/flow-templates", auth, (c) => {
    const templates = Object.values(builtinFlows).map(toSummary);
    return c.json({ templates });
  });

  r.get("/flow-templates/:slug", auth, (c) => {
    const slug = c.req.param("slug");
    const def = builtinFlows[slug];
    if (!def) return c.json({ error: "not found" }, 404);
    return c.json({
      template: {
        ...toSummary(def),
        graphJson: { nodes: def.nodes, edges: def.edges, description: def.description },
      },
    });
  });

  return r;
}

function toSummary(def: (typeof builtinFlows)[string]) {
  return {
    slug: def.slug,
    name: def.name,
    description: def.description,
    nodeCount: def.nodes.length,
    edgeCount: def.edges.length,
  };
}
