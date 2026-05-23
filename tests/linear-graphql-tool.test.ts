import { describe, expect, it } from "vitest";
import { executeLinearGraphql, handleClientToolCall, linearGraphqlClientTools } from "../src/runner/client-tools.js";
import { fakeServiceConfig } from "./fixtures/agentos-fakes.js";

describe("linear_graphql client tool", () => {
  it("advertises only for agent-owned Linear workflows with auth", () => {
    const agentOwned = fakeServiceConfig({ lifecycle: { ...fakeServiceConfig().lifecycle, mode: "agent-owned", clientTrackerTools: ["linear_graphql"] } });
    expect(linearGraphqlClientTools(agentOwned).map((tool) => tool.name)).toEqual(["linear_graphql"]);
    expect(linearGraphqlClientTools(fakeServiceConfig({ lifecycle: { ...fakeServiceConfig().lifecycle, mode: "agent-owned" } }))).toEqual([]);
    expect(linearGraphqlClientTools(fakeServiceConfig())).toEqual([]);
    expect(linearGraphqlClientTools(fakeServiceConfig({ tracker: { ...fakeServiceConfig().tracker, kind: "fake-test" } }))).toEqual([]);
    expect(
      linearGraphqlClientTools(
        fakeServiceConfig({
          lifecycle: { ...fakeServiceConfig().lifecycle, mode: "agent-owned", clientTrackerTools: ["linear_graphql"] },
          tracker: { ...fakeServiceConfig().tracker, apiKey: "" }
        })
      )
    ).toEqual([]);
  });

  it("runs a valid query with variables and reports success", async () => {
    const requests: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const result = await executeLinearGraphql(
      graphQlEnabledConfig(),
      { query: "query Test($id: String!) { issue(id: $id) { id } }", variables: { id: "AG-1" } },
      (async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
        return Response.json({ data: { issue: { id: "issue-1" } } });
      }) as typeof fetch
    );

    expect(result).toEqual({ success: true, response: { data: { issue: { id: "issue-1" } } } });
    expect(requests).toEqual([{ url: "https://linear.test/graphql", auth: "lin_test", body: { query: "query Test($id: String!) { issue(id: $id) { id } }", variables: { id: "AG-1" } } }]);
  });

  it("accepts raw string shorthand", async () => {
    await expect(
      executeLinearGraphql(graphQlEnabledConfig(), "{ viewer { id } }", (async () => Response.json({ data: { viewer: { id: "me" } } })) as typeof fetch)
    ).resolves.toMatchObject({ success: true });
  });

  it("preserves GraphQL errors as unsuccessful structured output", async () => {
    await expect(
      executeLinearGraphql(
        graphQlEnabledConfig(),
        "query Test { broken }",
        (async () => Response.json({ errors: [{ message: "bad field" }] })) as typeof fetch
      )
    ).resolves.toEqual({ success: false, response: { errors: [{ message: "bad field" }] } });
  });

  it("returns structured transport failures", async () => {
    await expect(
      executeLinearGraphql(
        graphQlEnabledConfig(),
        "query Test { viewer { id } }",
        (async () => {
          throw new Error("offline");
        }) as typeof fetch
      )
    ).resolves.toMatchObject({ success: false, error: { code: "transport_error", message: "offline" } });
  });

  it("rejects invalid input without transport", async () => {
    const config = graphQlEnabledConfig();
    await expect(executeLinearGraphql(config, { query: "query A { a } query B { b }" })).resolves.toMatchObject({ success: false, error: { code: "invalid_input" } });
    await expect(executeLinearGraphql(config, { query: 1 })).resolves.toMatchObject({ success: false, error: { code: "invalid_input" } });
    await expect(executeLinearGraphql(config, { query: "query A { a }", variables: [] })).resolves.toMatchObject({ success: false, error: { code: "invalid_input" } });
  });

  it("returns structured availability and unsupported-tool failures", async () => {
    await expect(
      executeLinearGraphql(
        fakeServiceConfig({
          lifecycle: { ...fakeServiceConfig().lifecycle, mode: "agent-owned", clientTrackerTools: ["linear_graphql"] },
          tracker: { ...fakeServiceConfig().tracker, apiKey: "" }
        }),
        "query Test { viewer { id } }"
      )
    ).resolves.toMatchObject({ success: false, error: { code: "missing_auth" } });
    await expect(
      executeLinearGraphql(fakeServiceConfig({ lifecycle: { ...fakeServiceConfig().lifecycle, mode: "agent-owned" } }), "query Test { viewer { id } }")
    ).resolves.toMatchObject({ success: false, error: { code: "tool_unavailable" } });
    await expect(executeLinearGraphql(fakeServiceConfig(), "query Test { viewer { id } }")).resolves.toMatchObject({ success: false, error: { code: "tool_unavailable" } });
    await expect(handleClientToolCall({ config: fakeServiceConfig(), name: "unknown_tool", arguments: {} })).resolves.toMatchObject({ success: false, error: { code: "unsupported_tool" } });
  });
});

function graphQlEnabledConfig() {
  return fakeServiceConfig({ lifecycle: { ...fakeServiceConfig().lifecycle, mode: "agent-owned", clientTrackerTools: ["linear_graphql"] } });
}
