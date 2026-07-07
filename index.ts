import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
    OAuthCredentials,
    OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

const API_BASE_URL = "https://api.cline.bot";
const WORKOS_API_BASE_URL = "https://api.workos.com";
const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WORKOS_TOKEN_PREFIX = "workos:";

type ClineAuthResponse = {
    success?: boolean;
    data?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: string;
    };
};

type WorkOSDeviceAuthorizationResponse = {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
};

type WorkOSTokenResponse = {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
};

type ClineModelEntry = {
    id: string;
    name?: string;
    description?: string;
};

type ClineModelsPayload = {
    recommended?: ClineModelEntry[];
    free?: ClineModelEntry[];
};

type ModelsDevModel = {
    name?: string;
    tool_call?: boolean;
    reasoning?: boolean;
    release_date?: string;
    limit?: {
        context?: number;
        input?: number;
        output?: number;
    };
    cost?: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
    };
    modalities?: {
        input?: string[];
    };
    status?: string;
};

type ModelsDevPayload = Record<
    string,
    {
        models?: Record<string, ModelsDevModel>;
    }
>;

type PiModel = {
    id: string;
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
};

function clineUrl(path: string): string {
    return new URL(path, API_BASE_URL).toString();
}

function headers(contentType = "application/json"): Record<string, string> {
    return {
        Accept: "application/json",
        "Content-Type": contentType,
        "User-Agent": "pi-cline-oauth-extension",
        "X-CLIENT-TYPE": "pi",
    };
}

async function readError(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    if (!text) return `${response.status} ${response.statusText}`;
    try {
        const json = JSON.parse(text) as {
            error?: string;
            error_description?: string;
            message?: string;
        };
        return json.error_description ?? json.message ?? json.error ?? text;
    } catch {
        return text;
    }
}

function toCredentials(
    payload: ClineAuthResponse,
    fallback?: OAuthCredentials,
): OAuthCredentials {
    const data = payload.data;
    if (!payload.success || !data?.accessToken || !data.expiresAt) {
        throw new Error("Invalid token response from Cline");
    }
    const refreshToken = data.refreshToken ?? fallback?.refresh;
    if (!refreshToken)
        throw new Error("Token response did not include a refresh token");

    const expires = Date.parse(data.expiresAt);
    if (Number.isNaN(expires))
        throw new Error(
            `Invalid token expiration from Cline: ${data.expiresAt}`,
        );

    return {
        access: data.accessToken,
        refresh: refreshToken,
        expires: expires - REFRESH_BUFFER_MS,
    };
}

async function startDeviceAuthorization(): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresInSeconds: number;
    intervalSeconds: number;
}> {
    const response = await fetch(
        `${WORKOS_API_BASE_URL}/user_management/authorize/device`,
        {
            method: "POST",
            headers: headers("application/x-www-form-urlencoded"),
            body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
        },
    );
    const data = (await response
        .json()
        .catch(() => ({}))) as WorkOSDeviceAuthorizationResponse;
    if (
        !response.ok ||
        !data.device_code ||
        !data.user_code ||
        !data.verification_uri
    ) {
        throw new Error(
            `Cline device authorization failed: ${data.error_description ?? data.error ?? response.statusText}`,
        );
    }

    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        verificationUriComplete: data.verification_uri_complete,
        expiresInSeconds: data.expires_in ?? 300,
        intervalSeconds: data.interval ?? 5,
    };
}

async function pollDeviceAuthorization(params: {
    deviceCode: string;
    expiresInSeconds: number;
    intervalSeconds: number;
}): Promise<{ accessToken: string; refreshToken: string }> {
    const deadline = Date.now() + params.expiresInSeconds * 1000;
    let intervalSeconds = Math.max(1, params.intervalSeconds);

    while (Date.now() <= deadline) {
        const response = await fetch(
            `${WORKOS_API_BASE_URL}/user_management/authenticate`,
            {
                method: "POST",
                headers: headers("application/x-www-form-urlencoded"),
                body: new URLSearchParams({
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    device_code: params.deviceCode,
                    client_id: WORKOS_CLIENT_ID,
                }),
            },
        );
        const data = (await response
            .json()
            .catch(() => ({}))) as WorkOSTokenResponse;
        if (response.ok && data.access_token && data.refresh_token) {
            return {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
            };
        }

        if (data.error === "authorization_pending") {
            await new Promise((resolve) =>
                setTimeout(resolve, intervalSeconds * 1000),
            );
            continue;
        }
        if (data.error === "slow_down") {
            intervalSeconds += 1;
            await new Promise((resolve) =>
                setTimeout(resolve, intervalSeconds * 1000),
            );
            continue;
        }
        throw new Error(
            `Cline device authorization failed: ${data.error_description ?? data.error ?? response.statusText}`,
        );
    }

    throw new Error("Cline device authorization timed out");
}

async function registerWorkOSTokens(tokens: {
    accessToken: string;
    refreshToken: string;
}): Promise<OAuthCredentials> {
    const response = await fetch(clineUrl("/api/v1/auth/register"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(tokens),
    });
    if (!response.ok)
        throw new Error(
            `Cline token registration failed: ${await readError(response)}`,
        );
    return toCredentials((await response.json()) as ClineAuthResponse);
}

async function loginCline(
    callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
    const device = await startDeviceAuthorization();
    callbacks.onDeviceCode({
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        intervalSeconds: device.intervalSeconds,
        expiresInSeconds: device.expiresInSeconds,
    });
    callbacks.onAuth({
        url: device.verificationUriComplete ?? device.verificationUri,
    });

    const workosTokens = await pollDeviceAuthorization({
        deviceCode: device.deviceCode,
        expiresInSeconds: device.expiresInSeconds,
        intervalSeconds: device.intervalSeconds,
    });
    return registerWorkOSTokens(workosTokens);
}

async function refreshClineToken(
    credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
    const response = await fetch(clineUrl("/api/v1/auth/refresh"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
            refreshToken: credentials.refresh,
            grantType: "refresh_token",
        }),
    });
    if (!response.ok)
        throw new Error(
            `Cline token refresh failed: ${await readError(response)}`,
        );
    return toCredentials(
        (await response.json()) as ClineAuthResponse,
        credentials,
    );
}

function getClineApiKey(credentials: OAuthCredentials): string {
    return credentials.access.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
        ? credentials.access
        : `${WORKOS_TOKEN_PREFIX}${credentials.access}`;
}

const DEFAULT_MODEL: Omit<PiModel, "id" | "name"> = {
    reasoning: false,
    input: ["text"],
    cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 128_000,
};

function numberOrDefault(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;
}

function maxInputTokens(limit: ModelsDevModel["limit"]): number {
    const contextLimit = limit?.context;
    const inputLimit = limit?.input;
    if (typeof contextLimit === "number" && typeof inputLimit === "number") {
        return Math.min(contextLimit, inputLimit);
    }
    return numberOrDefault(
        inputLimit ?? contextLimit,
        DEFAULT_MODEL.contextWindow,
    );
}

function modelFromModelsDev(modelId: string, model: ModelsDevModel): PiModel {
    const inputModalities = new Set(model.modalities?.input ?? []);
    const contextWindow = numberOrDefault(
        model.limit?.context,
        maxInputTokens(model.limit),
    );

    return {
        id: modelId,
        name: model.name ?? modelId,
        reasoning: model.reasoning === true,
        input: inputModalities.has("image") ? ["text", "image"] : ["text"],
        cost: {
            input: numberOrDefault(model.cost?.input, 0),
            output: numberOrDefault(model.cost?.output, 0),
            cacheRead: numberOrDefault(model.cost?.cache_read, 0),
            cacheWrite: numberOrDefault(model.cost?.cache_write, 0),
        },
        contextWindow,
        maxTokens: Math.floor(
            numberOrDefault(model.limit?.output, DEFAULT_MODEL.maxTokens),
        ),
    };
}

function modelFromClineEntry(entry: ClineModelEntry): PiModel {
    return {
        id: entry.id,
        name: entry.name ?? entry.id,
        ...DEFAULT_MODEL,
    };
}

function isActiveToolModel(model: ModelsDevModel): boolean {
    return model.tool_call === true && model.status !== "deprecated";
}

function sortModelsByReleaseDate(
    models: [string, ModelsDevModel][],
): [string, ModelsDevModel][] {
    return models.sort(([, a], [, b]) => {
        const aTime = Date.parse(a.release_date ?? "");
        const bTime = Date.parse(b.release_date ?? "");
        const aRank = Number.isNaN(aTime) ? Number.NEGATIVE_INFINITY : aTime;
        const bRank = Number.isNaN(bTime) ? Number.NEGATIVE_INFINITY : bTime;
        if (aRank !== bRank) return bRank - aRank;
        return 0;
    });
}

function preferClineCanonicalIds(models: PiModel[]): PiModel[] {
    const ids = new Set(models.map((model) => model.id));
    return models.filter((model) => {
        if (!model.id.startsWith("z-ai/")) return true;
        return !ids.has(`zai/${model.id.slice("z-ai/".length)}`);
    });
}

async function fetchRecommendedClineModels(): Promise<PiModel[]> {
    const response = await fetch(
        clineUrl("/api/v1/ai/cline/recommended-models"),
    );
    if (!response.ok) {
        throw new Error(
            `Failed to fetch Cline recommended models: ${await readError(response)}`,
        );
    }
    const payload = (await response.json()) as ClineModelsPayload;
    return [...(payload.recommended ?? []), ...(payload.free ?? [])].map(
        modelFromClineEntry,
    );
}

async function fetchModelsDevClineModels(): Promise<PiModel[]> {
    const response = await fetch("https://models.dev/api.json");
    if (!response.ok) {
        throw new Error(
            `Failed to fetch models.dev catalog: ${await readError(response)}`,
        );
    }

    const payload = (await response.json()) as ModelsDevPayload;
    const openRouterModels = Object.entries(
        payload.openrouter?.models ?? {},
    ).filter(([, model]) => isActiveToolModel(model));
    const vercelCanonicalModels = Object.entries(
        payload.vercel?.models ?? {},
    ).filter(
        ([id, model]) => id.startsWith("zai/") && isActiveToolModel(model),
    );

    return preferClineCanonicalIds(
        sortModelsByReleaseDate([
            ...openRouterModels,
            ...vercelCanonicalModels,
        ]).map(([id, model]) => modelFromModelsDev(id, model)),
    );
}

async function fetchClineModels(): Promise<PiModel[]> {
    const [catalogResult, recommendedResult] = await Promise.allSettled([
        fetchModelsDevClineModels(),
        fetchRecommendedClineModels(),
    ]);

    const catalogModels =
        catalogResult.status === "fulfilled" ? catalogResult.value : [];
    const recommendedModels =
        recommendedResult.status === "fulfilled" ? recommendedResult.value : [];

    if (catalogModels.length === 0 && recommendedModels.length === 0) {
        if (catalogResult.status === "rejected") throw catalogResult.reason;
        if (recommendedResult.status === "rejected") {
            throw recommendedResult.reason;
        }
    }

    const byId = new Map<string, PiModel>();
    for (const model of [...recommendedModels, ...catalogModels]) {
        byId.set(model.id, { ...byId.get(model.id), ...model });
    }
    return [...byId.values()];
}

export default async function (pi: ExtensionAPI) {
    let models: PiModel[];
    try {
        models = await fetchClineModels();
    } catch (error) {
        console.warn(
            `[cline-oauth] ${error instanceof Error ? error.message : String(error)}`,
        );
        models = [];
    }

    pi.registerProvider("cline", {
        name: "Cline",
        baseUrl: `${API_BASE_URL}/api/v1`,
        apiKey: "$CLINE_API_KEY",
        authHeader: true,
        headers: headers(),
        api: "openai-completions",
        models,
        oauth: {
            name: "Cline",
            login: loginCline,
            refreshToken: refreshClineToken,
            getApiKey: getClineApiKey,
        },
    });
}
