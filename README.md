# pi-cline

Cline / ClinePass OAuth provider extension for [pi](https://pi.dev).

This package adds two providers to pi:

| Provider | ID | Account type | Typical use |
|----------|----|--------------|-------------|
| **Cline** | `cline` | Organization or personal Cline account | Recommended/free models plus a broader catalog |
| **ClinePass** | `cline-pass` | Personal Cline account | ClinePass model set |

After install and login, you can pick Cline models from `/model` and use them like any other pi provider.

## Install

Requires a working [pi](https://pi.dev) install.

```bash
# From npm
pi install npm:@maxpaulus/pi-cline

# From git
pi install git:github.com/maxpaulus43/pi-cline

# Local checkout (useful while developing)
pi install /absolute/path/to/pi-cline
# or
pi install ./relative/path/to/pi-cline
```

Install is user-scoped by default (`~/.pi/agent/settings.json`). Use `-l` to install into the current project instead:

```bash
pi install -l npm:@maxpaulus/pi-cline
```

Try it for a single run without installing:

```bash
pi -e npm:@maxpaulus/pi-cline
```

Update later with:

```bash
pi update --extensions
# or just this package
pi update npm:@maxpaulus/pi-cline
```

## Quick start

1. Install the package (see above).
2. Start pi.
3. Log in:

   ```text
   /login
   ```

   Then choose **Cline** or **ClinePass**.

4. Complete the device login in your browser when prompted.
5. Select a model:

   ```text
   /model
   ```

   Or from the CLI:

   ```bash
   pi --provider cline --model <model-id>
   pi --provider cline-pass --model cline-pass/deepseek-v4-flash
   ```

## Login

Both providers use WorkOS device-code OAuth against Cline (`api.cline.bot`).

### Cline (`/login` → Cline)

- Starts device authorization and opens/shows a verification URL.
- After auth succeeds, if your account has organizations, pi asks which account should be active (personal or an org).
- Tokens are stored by pi in `~/.pi/agent/auth.json` and refresh automatically.

### ClinePass (`/login` → ClinePass)

- Same device login flow.
- Forces the **personal** Cline account after login (ClinePass is personal-account based).

### Logout

```text
/logout
```

Then select the provider to clear stored credentials.

## Switch organization / account

After logging into **Cline**, switch the active personal vs organization account without re-logging in:

```text
/cline-org
```

This command:

- Requires an interactive UI session
- Requires existing Cline OAuth credentials (`/login` with Cline first)
- Shows personal and organization options, with credit balances when available
- Marks the currently active account with `✓`

ClinePass always uses the personal account after login; use `/cline-org` if you also use the `cline` provider and need to change orgs there.

## Models

### Cline provider (`cline`)

Model list is built at startup from:

1. Cline recommended/free models (`/api/v1/ai/cline/recommended-models`)
2. A broader catalog derived from [models.dev](https://models.dev) (OpenRouter + selected Vercel/ZAI entries), with a local cache under your user cache dir

If both sources fail, the provider still registers but may have an empty model list until the next successful fetch.

### ClinePass provider (`cline-pass`)

Uses Cline’s live `clinePass` recommended list when available, and falls back to a bundled catalog

List models after install:

```bash
pi --list-models cline
pi --list-models cline-pass
```

## Commands

| Command | Description |
|---------|-------------|
| `/login` | Authenticate with **Cline** or **ClinePass** (provider picker) |
| `/logout` | Clear stored credentials for a provider |
| `/model` | Pick a Cline / ClinePass model |
| `/cline-org` | Choose the active Cline personal or organization account |

## How it works

- Registers providers via `pi.registerProvider()`:
  - `cline` — org-aware login + full model catalog
  - `cline-pass` — personal-account login + ClinePass models
- API base: `https://api.cline.bot/api/v1`
- Auth: WorkOS device code → Cline token register/refresh
- Access tokens are sent as `Authorization: Bearer workos:…` (prefix added when needed)
- Client headers include `X-CLIENT-TYPE: pi` and `User-Agent: pi-cline-oauth-extension`

Source layout:

```text
index.ts          # providers, OAuth login/refresh
cline-account.ts  # /cline-org + post-login account selection
cline-models.ts   # model catalog fetch/cache + ClinePass fallbacks
```

## Development

```bash
npm install
npx changelogger install
```

Load a local checkout in pi:

```bash
pi install /absolute/path/to/pi-cline
# or one-shot
pi -e /absolute/path/to/pi-cline
```

Peer dependencies (provided by pi itself):

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

Publishing is handled by GitHub Actions on `main` when `package.json` version differs from npm (`@maxpaulus/pi-cline`).

## Links

- npm: [`@maxpaulus/pi-cline`](https://www.npmjs.com/package/@maxpaulus/pi-cline)
- Repository: [maxpaulus43/pi-cline](https://github.com/maxpaulus43/pi-cline)
- pi docs: [Packages](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md), [Providers](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md)
- Changelog: [CHANGELOG.md](./CHANGELOG.md)
