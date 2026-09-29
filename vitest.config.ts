import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          OWNER_API_KEY: "test-owner-key",
          MEDIA_SIGNING_KEY: "test-media-key",
          OPENAI_API_KEY: "",
          TELNYX_API_KEY: "",
          TELNYX_PUBLIC_KEY: "",
          TELNYX_CONNECTION_ID: "",
          TELNYX_FROM_NUMBER: "",
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUDIENCE: "",
          CALLBACK_SIGNING_KEY: "",
          LIVE_ENABLED: "false",
          ACCOUNT_HEADROOM_VERIFIED: "true",
          ROLLOUT_VERIFIED: "true",
          PUBLIC_BASE_URL: "https://example.com",
          CONTROLLED_TEST_NUMBER: "",
          CONTROLLED_TEST_UNTIL: "0",
        },
      },
    }),
  ],
  test: { testTimeout: 15000 },
});
