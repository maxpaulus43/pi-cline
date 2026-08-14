import assert from "node:assert/strict";
import test from "node:test";
import { registerClineAccountCommand } from "./cline-account.ts";

test("/cline-org resolves credentials through the model registry", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    registerClineAccountCommand({
        registerCommand(_name, command) {
            handler = command.handler;
        },
    } as any);

    const originalFetch = globalThis.fetch;
    const authorizationHeaders: string[] = [];
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        authorizationHeaders.push(headers.get("Authorization") ?? "");

        if (url.endsWith("/api/v1/users/me")) {
            return Response.json({ id: "user-1", organizations: [] });
        }
        if (url.endsWith("/api/v1/users/user-1/balance")) {
            return Response.json({ balance: 1_000_000 });
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    try {
        assert.ok(handler);
        await handler("", {
            hasUI: true,
            modelRegistry: {
                async getApiKeyForProvider(provider: string) {
                    assert.equal(provider, "cline");
                    return "workos:test-token";
                },
            },
            ui: {
                async select(_title: string, options: string[]) {
                    assert.deepEqual(options, ["✓ Personal account — $1.00"]);
                    return undefined;
                },
            },
        });
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.deepEqual(authorizationHeaders, [
        "Bearer workos:test-token",
        "Bearer workos:test-token",
    ]);
});
