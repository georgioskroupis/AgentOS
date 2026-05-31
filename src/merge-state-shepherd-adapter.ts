import type { DaemonPreflightResult } from "./env.js";
import type { JsonlLogger } from "./logging.js";
import type { MergeStateExtension } from "./merge-state-extension.js";
import { runLandingShepherdGate } from "./orchestrator-landing-preflight.js";
import type { RuntimeStateStore } from "./runtime-state.js";
import type { ServiceConfig } from "./types.js";

export interface MergeShepherdExtensionDeps {
  config(): ServiceConfig;
  preflight(): DaemonPreflightResult | null;
  runtimeState: Pick<RuntimeStateStore, "read">;
  logger: Pick<JsonlLogger, "write">;
  shepherd(): Promise<void>;
}

export function createMergeShepherdExtension(deps: MergeShepherdExtensionDeps): MergeStateExtension {
  return {
    name: "merge-shepherd",
    async processMergeState() {
      await runLandingShepherdGate({
        config: deps.config(),
        preflight: deps.preflight(),
        runtimeState: deps.runtimeState,
        logger: deps.logger,
        shepherd: deps.shepherd
      });
    }
  };
}
