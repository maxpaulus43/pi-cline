import assert from "node:assert/strict";
import test from "node:test";
import {
    getClinePromptCacheCompat,
    normalizeClinePromptCachePayload,
} from "./cline-cache.ts";

const noCacheCost = { cacheRead: 0, cacheWrite: 0 };

test("enables prompt caching for Claude models", () => {
    assert.deepEqual(
        getClinePromptCacheCompat(
            "anthropic/claude-fable-5",
            noCacheCost,
        ),
        {
            cacheControlFormat: "anthropic",
            supportsLongCacheRetention: false,
        },
    );
});

test("enables prompt caching only for cache-priced Qwen models", () => {
    assert.ok(
        getClinePromptCacheCompat("cline-pass/qwen3.7-plus", {
            cacheRead: 0.064,
            cacheWrite: 0.4,
        }),
    );
    assert.equal(
        getClinePromptCacheCompat("qwen/qwen-model-without-cache", noCacheCost),
        undefined,
    );
    assert.equal(
        getClinePromptCacheCompat("zai/glm-5.2", {
            cacheRead: 0.1,
            cacheWrite: 0,
        }),
        undefined,
    );
});

test("normalizes pi cache markers to Cline's request format", () => {
    const payload = {
        model: "anthropic/claude-fable-5",
        messages: [
            {
                role: "system",
                content: [
                    {
                        type: "text",
                        text: "System prompt",
                        cache_control: { type: "ephemeral", ttl: "1h" },
                    },
                ],
            },
            { role: "user", content: "First request" },
            { role: "assistant", content: "First response" },
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Latest request",
                        cache_control: { type: "ephemeral", ttl: "1h" },
                    },
                ],
            },
        ],
        tools: [
            {
                type: "function",
                function: {
                    name: "read",
                    parameters: {
                        properties: { cache_control: { type: "string" } },
                    },
                },
                cache_control: { type: "ephemeral", ttl: "1h" },
            },
        ],
        metadata: { cache_control: "preserve nested application data" },
    };

    assert.deepEqual(normalizeClinePromptCachePayload(payload), {
        model: "anthropic/claude-fable-5",
        cache_control: { type: "ephemeral" },
        messages: [
            {
                role: "system",
                content: [{ type: "text", text: "System prompt" }],
            },
            { role: "user", content: "First request" },
            { role: "assistant", content: "First response" },
            {
                role: "user",
                content: [{ type: "text", text: "Latest request" }],
                cache_control: { type: "ephemeral" },
            },
        ],
        tools: [
            {
                type: "function",
                function: {
                    name: "read",
                    parameters: {
                        properties: { cache_control: { type: "string" } },
                    },
                },
            },
        ],
        metadata: { cache_control: "preserve nested application data" },
    });
});

test("leaves payloads unchanged when pi disabled caching", () => {
    const payload = {
        model: "anthropic/claude-fable-5",
        messages: [{ role: "user", content: "Hello" }],
    };

    assert.equal(normalizeClinePromptCachePayload(payload), payload);
});
