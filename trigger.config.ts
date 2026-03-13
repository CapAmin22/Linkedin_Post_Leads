import { defineConfig } from "@trigger.dev/sdk/v3";
import { playwright } from "@trigger.dev/build/extensions/playwright";

export default defineConfig({
  project: "proj_fbrnmqgatnqgidptkxqa",
  dirs: ["./src/trigger"],
  maxDuration: 600,
  build: {
    extensions: [playwright()],
  },
});
