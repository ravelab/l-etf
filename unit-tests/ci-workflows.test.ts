import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";

type WorkflowJob = {
  needs?: string | string[];
  if?: string;
  steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
};

function dependencies(job: WorkflowJob) {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function uiSpecTags(): Array<{ file: string; name: string; tags: string[] }> {
  const directory = resolve(process.cwd(), "ui-tests/specs");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".spec.mjs"))
    .map((file) => {
      const source = readFileSync(resolve(directory, file), "utf8");
      const nameMatch = source.match(/export const name = "([^"]+)"/);
      const tagsMatch = source.match(/export const tags = (\[[^\]]*\])/);
      const tags = tagsMatch ? (JSON.parse(tagsMatch[1]) as string[]) : [];
      return { file, name: nameMatch?.[1] ?? file, tags };
    });
}

describe("deployment validation workflow", () => {
  const workflowPath = ".github/workflows/ui-after-deploy.yml";
  const workflowSource = () => readFileSync(resolve(process.cwd(), workflowPath), "utf8");

  it("sends the full UI suite to a preview and gives production only the smoke subset", () => {
    const workflow = parse(workflowSource()) as { jobs: Record<string, WorkflowJob> };
    const preview = workflow.jobs["ui-preview"]!;
    const smoke = workflow.jobs["smoke-production"]!;

    assert.deepEqual(dependencies(preview), ["target"]);
    assert.deepEqual(dependencies(smoke), ["target"]);
    assert.ok(!dependencies(smoke).includes("ui-preview"));

    assert.equal(
      preview.if,
      "needs.target.outputs.url != '' && needs.target.outputs.environment != 'Production'",
    );
    assert.equal(
      smoke.if,
      "needs.target.outputs.url != '' && needs.target.outputs.environment == 'Production'",
    );

    const previewRun = preview.steps?.find((step) => step.run?.includes("test:ui"));
    const smokeRun = smoke.steps?.find((step) => step.run?.includes("test:ui"));
    assert.equal(previewRun?.env?.UI_TEST_TAGS, undefined);
    assert.equal(smokeRun?.env?.UI_TEST_TAGS, "smoke");
  });

  it("points production at the public hostname when Vercel omits a deployment URL", () => {
    assert.match(workflowSource(), /url=https:\/\/l-etf\.com/);
    assert.doesNotMatch(workflowSource(), /l-etf\.vercel\.app/);
  });

  it("passes the Vercel bypass secret under its own name", () => {
    const workflow = parse(workflowSource()) as { jobs: Record<string, WorkflowJob> };
    for (const name of ["ui-preview", "smoke-production"] as const) {
      const step = workflow.jobs[name]!.steps?.find((candidate) => candidate.env?.UI_TEST_BASE_URL);
      assert.equal(
        step?.env?.VERCEL_AUTOMATION_BYPASS_SECRET,
        "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}",
        name,
      );
    }
  });

  it("has at least one smoke-tagged UI spec for production", () => {
    const smoke = uiSpecTags().filter((spec) => spec.tags.includes("smoke"));
    assert.ok(smoke.length >= 5, `expected smoke specs, found ${smoke.length}`);
  });
});

describe("source test workflow", () => {
  const workflowSource = () =>
    readFileSync(resolve(process.cwd(), ".github/workflows/test.yml"), "utf8");

  type Triggers = { push?: { branches?: string[] }; pull_request?: unknown };
  const triggers = () => (parse(workflowSource()) as { on: Triggers }).on;

  it("runs on pushes to dev and on pull requests, not on main", () => {
    assert.deepEqual(triggers().push?.branches, ["dev"]);
    assert.ok(triggers().pull_request !== undefined);
  });

  it("runs the unit suite (with coverage floor) — anything needing a deploy lives in ui-after-deploy", () => {
    const workflow = parse(workflowSource()) as { jobs: Record<string, WorkflowJob> };
    const commands = Object.values(workflow.jobs).flatMap(
      (job) => job.steps?.map((step) => step.run ?? "") ?? [],
    );
    assert.ok(commands.some((run) => run.includes("test:unit")));
    assert.ok(!commands.some((run) => run.includes("test:ui") || run.includes("ui-tests")));
    // Coverage is folded into test:unit (scripts/unit-test.sh), not a second step.
    assert.ok(workflowSource().includes("coverage floor"));
  });

  it("does not need repository secrets", () => {
    assert.doesNotMatch(workflowSource(), /secrets\./);
  });
});
