import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const API_BASE_URL = "https://api.cline.bot";
const MODELS_DEV_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const MODELS_DEV_CACHE_PATH = join(
    userCacheDir(),
    "pi",
    "extensions",
    "pi-cline",
    "models-dev.json",
);

export type PiModel = {
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

function userCacheDir(): string {
    if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Caches");
    }
    if (process.platform === "win32") {
        return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    }
    return join(homedir(), ".cache");
}

function clineUrl(path: string): string {
    return new URL(path, API_BASE_URL).toString();
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

async function readCachedModelsDev(): Promise<ModelsDevPayload | undefined> {
    try {
        const stats = await stat(MODELS_DEV_CACHE_PATH);
        if (Date.now() - stats.mtimeMs > MODELS_DEV_CACHE_TTL_MS) {
            return undefined;
        }
        return JSON.parse(
            await readFile(MODELS_DEV_CACHE_PATH, "utf8"),
        ) as ModelsDevPayload;
    } catch {
        return undefined;
    }
}

async function writeCachedModelsDev(payload: ModelsDevPayload): Promise<void> {
    try {
        await mkdir(dirname(MODELS_DEV_CACHE_PATH), { recursive: true });
        await writeFile(MODELS_DEV_CACHE_PATH, JSON.stringify(payload));
    } catch {
        // Cache write failures are non-fatal.
    }
}

async function fetchModelsDevPayload(): Promise<ModelsDevPayload> {
    const cached = await readCachedModelsDev();
    if (cached) return cached;

    const response = await fetch("https://models.dev/api.json");
    if (!response.ok) {
        throw new Error(
            `Failed to fetch models.dev catalog: ${await readError(response)}`,
        );
    }
    const payload = (await response.json()) as ModelsDevPayload;
    await writeCachedModelsDev(payload);
    return payload;
}

async function fetchModelsDevClineModels(): Promise<PiModel[]> {
    const payload = await fetchModelsDevPayload();
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

export async function fetchClineModels(): Promise<PiModel[]> {
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
