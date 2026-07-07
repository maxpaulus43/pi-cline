import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
    OAuthCredentials,
    OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

const API_BASE_URL = "https://api.cline.bot";
const PERSONAL_ACCOUNT_ID = "__personal__";

export type ClineAccountOrganization = {
    active?: boolean;
    memberId?: string;
    name?: string;
    organizationId?: string;
    roles?: string[];
};

export type ClineAccountUser = {
    email?: string;
    id?: string;
    organizations?: ClineAccountOrganization[];
};

function clineUrl(path: string): string {
    return new URL(path, API_BASE_URL).toString();
}

function headers(): Record<string, string> {
    return {
        Accept: "application/json",
        "Content-Type": "application/json",
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

async function readErrorFromParsed(
    response: Response,
    text: string,
    parsed: unknown,
): Promise<string> {
    if (typeof parsed === "object" && parsed !== null) {
        const json = parsed as {
            error?: string;
            error_description?: string;
            message?: string;
        };
        return json.error_description ?? json.message ?? json.error ?? text;
    }
    return text || `${response.status} ${response.statusText}`;
}

async function readJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    let parsed: unknown;
    try {
        parsed = text.trim() ? (JSON.parse(text) as unknown) : undefined;
    } catch {
        if (!response.ok) throw new Error(text || response.statusText);
        throw new Error("Cline account response was not valid JSON");
    }
    if (!response.ok) {
        throw new Error(await readErrorFromParsed(response, text, parsed));
    }
    if (typeof parsed === "object" && parsed !== null && "success" in parsed) {
        const envelope = parsed as {
            success?: boolean;
            error?: string;
            data?: T;
        };
        if (envelope.success === false) {
            throw new Error(envelope.error ?? "Cline account request failed");
        }
        return envelope.data as T;
    }
    return parsed as T;
}

async function getClineAccountToken(ctx: {
    modelRegistry: {
        authStorage: {
            getApiKey(provider: string): Promise<string | undefined>;
        };
    };
}): Promise<string> {
    const token = await ctx.modelRegistry.authStorage.getApiKey("cline");
    if (!token) {
        throw new Error(
            "No Cline OAuth credentials found. Run /login cline first.",
        );
    }
    return token;
}

async function fetchClineMe(token: string): Promise<ClineAccountUser> {
    const response = await fetch(clineUrl("/api/v1/users/me"), {
        headers: {
            Authorization: `Bearer ${token}`,
            ...headers(),
        },
    });
    return readJson<ClineAccountUser>(response);
}

async function switchClineOrganization(
    token: string,
    organizationId: string | null,
): Promise<void> {
    const response = await fetch(clineUrl("/api/v1/users/active-account"), {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${token}`,
            ...headers(),
        },
        body: JSON.stringify({ organizationId }),
    });
    if (!response.ok) {
        throw new Error(
            `Cline organization switch failed: ${await readError(response)}`,
        );
    }
}

function formatOrganizationLabel(
    organization: ClineAccountOrganization,
): string | undefined {
    const organizationId = organization.organizationId?.trim();
    if (!organizationId) return undefined;
    const name = organization.name?.trim() || organizationId;
    const roleText = organization.roles?.length
        ? ` (${organization.roles.join(", ")})`
        : "";
    return `${
        organization.active ? "✓" : " "
    } ${name}${roleText} — ${organizationId}`;
}

function personalAccountLabel(active: boolean): string {
    return `${active ? "✓" : " "} Personal account`;
}

type ClineAccountChoice = {
    id: string;
    label: string;
    organization: ClineAccountOrganization | null;
};

async function loadClineAccountChoices(
    token: string,
): Promise<ClineAccountChoice[]> {
    const me = await fetchClineMe(token);
    const organizations = me.organizations ?? [];
    const activeOrganization =
        organizations.find((organization) => organization.active) ?? null;
    const organizationChoices = organizations
        .map((organization) => {
            const organizationId = organization.organizationId?.trim();
            const label = formatOrganizationLabel(organization);
            if (!organizationId || !label) return undefined;
            return { id: organizationId, label, organization };
        })
        .filter((choice): choice is ClineAccountChoice => Boolean(choice));

    return [
        {
            id: PERSONAL_ACCOUNT_ID,
            label: personalAccountLabel(!activeOrganization),
            organization: null,
        },
        ...organizationChoices,
    ];
}

async function switchClineAccountChoice(
    token: string,
    choice: ClineAccountChoice,
): Promise<string> {
    const organizationId =
        choice.id === PERSONAL_ACCOUNT_ID
            ? null
            : choice.organization?.organizationId?.trim();
    if (choice.id !== PERSONAL_ACCOUNT_ID && !organizationId) {
        throw new Error(
            "Selected organization did not include an organization id",
        );
    }

    await switchClineOrganization(token, organizationId ?? null);
    return organizationId
        ? (choice.organization?.name?.trim() ?? organizationId)
        : "Personal account";
}

export async function selectClineOrganizationAfterLogin(
    credentials: OAuthCredentials,
    callbacks: OAuthLoginCallbacks,
    getApiKey: (credentials: OAuthCredentials) => string,
): Promise<void> {
    const token = getApiKey(credentials);
    const choices = await loadClineAccountChoices(token);
    if (choices.length <= 1) return;

    const selectedId = await callbacks.onSelect({
        message: "Choose your active Cline account",
        options: choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
        })),
    });
    if (!selectedId) return;

    const choice = choices.find((choice) => choice.id === selectedId);
    if (!choice) return;

    const name = await switchClineAccountChoice(token, choice);
    callbacks.onProgress?.(`Cline active account: ${name}`);
}

export function registerClineAccountCommand(pi: ExtensionAPI): void {
    pi.registerCommand("cline-org", {
        description: "Choose the active Cline organization/account",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                throw new Error("/cline-org requires an interactive UI");
            }

            const token = await getClineAccountToken(ctx);
            const choices = await loadClineAccountChoices(token);
            const label = await ctx.ui.select(
                "Active Cline account",
                choices.map((choice) => choice.label),
            );
            if (!label) return;

            const choice = choices.find((choice) => choice.label === label);
            if (!choice) return;

            const name = await switchClineAccountChoice(token, choice);
            ctx.ui.notify(`Cline active account: ${name}`, "info");
        },
    });
}
