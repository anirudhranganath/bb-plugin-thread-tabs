import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

test("source and tests use public SDK entrypoints and declared dependencies", () => {
    const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), {
        allow: [/^react(?:-dom)?(?:\/.*)?$/, /^@radix-ui\//, /^sonner$/, /^vaul$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^vitest$/, /^@testing-library\/react$/],
    });
    assert.deepEqual(scan.violations, []);
    assert.deepEqual(scan.privateDependencies, []);
});
