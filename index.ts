import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
    OAuthCredentials,
    OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { normalizeClinePromptCachePayload } from "./cline-cache.ts";
import {
    registerClineAccountCommand,
    selectClineOrganizationAfterLogin,
    selectClinePersonalAccountAfterLogin,
} from "./cline-account.ts";
import {
    fetchClineModels,
    fetchClinePassModels,
    type PiModel,
} from "./cline-models.ts";

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

async function loginClineWithAccountSelection(
    callbacks: OAuthLoginCallbacks,
    selectAccount: (
        credentials: OAuthCredentials,
        callbacks: OAuthLoginCallbacks,
        getApiKey: (credentials: OAuthCredentials) => string,
    ) => Promise<void>,
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
    const credentials = await registerWorkOSTokens(workosTokens);
    await selectAccount(credentials, callbacks, getClineApiKey);
    return credentials;
}

async function loginCline(
    callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
    return loginClineWithAccountSelection(
        callbacks,
        selectClineOrganizationAfterLogin,
    );
}

async function loginClinePass(
    callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
    return loginClineWithAccountSelection(
        callbacks,
        selectClinePersonalAccountAfterLogin,
    );
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

    let clinePassModels: PiModel[];
    try {
        clinePassModels = await fetchClinePassModels();
    } catch (error) {
        console.warn(
            `[cline-pass] ${error instanceof Error ? error.message : String(error)}`,
        );
        clinePassModels = [];
    }

    pi.on("before_provider_request", (event, ctx) => {
        if (
            ctx.model?.provider !== "cline" &&
            ctx.model?.provider !== "cline-pass"
        ) {
            return;
        }
        return normalizeClinePromptCachePayload(event.payload);
    });

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

    pi.registerProvider("cline-pass", {
        name: "ClinePass",
        baseUrl: `${API_BASE_URL}/api/v1`,
        apiKey: "$CLINE_API_KEY",
        authHeader: true,
        headers: headers(),
        api: "openai-completions",
        models: clinePassModels,
        oauth: {
            name: "ClinePass",
            login: loginClinePass,
            refreshToken: refreshClineToken,
            getApiKey: getClineApiKey,
        },
    });

    registerClineAccountCommand(pi);
}
