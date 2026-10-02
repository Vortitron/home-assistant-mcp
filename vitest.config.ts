import { configDefaults, defineConfig } from "vitest/config";

// The Claude Code plugin's tests run under `claude plugin test`, against the engine, not here.
export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, "claude-plugin/**"]
	}
});
