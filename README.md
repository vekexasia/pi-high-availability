# pi-high-availability 🔄

> ⚠️ **Security notice:** `~/.pi/agent/ha.json` stores OAuth refresh tokens and API keys in plaintext. Treat it like a password file — keep it out of version control (add to `.gitignore`), backups, and dotfile repos. The extension sets `chmod 600` automatically, but you are responsible for not exposing the file externally.

**pi-high-availability** automatically switches to fallback LLM providers when your primary provider hits quota limits or capacity constraints. Never get stuck waiting for quota resets again.

## ✨ Features

- **Slash-Command Management**: Create groups, rename credentials, activate or clear accounts directly from the chat with `/ha`, `/ha-group`, `/ha-rename`, `/ha-activate`, and `/ha-clear`.
- **Automatic Multi-Tier Failover**:
    1. **Account Failover**: Seamlessly switches between multiple accounts for the *same* provider.
    2. **Provider Failover**: Automatically jumps to the next provider in your group if all accounts for the current provider are exhausted.
- **Exhaustion Tracking**: Intelligent cooldown management marks specific accounts or providers as "exhausted" on 429/capacity errors, preventing retries until they recover.
- **Dynamic Provider Discovery**: Automatically detects all supported Pi providers (Anthropic, OpenAI, Gemini, Moonshot, Zai, etc.) without configuration.
- **Group Management**: Create custom failover chains (e.g., "Fast Tier" → "Backup Tier") with a single command.
- **Credential Sync & Storage**: Automatically captures OAuth logins and stores multiple accounts per provider.
- **Smart Error Detection**: Distinguishes between quota errors and transient capacity issues, including full support for Google Gemini's internal retry patterns.

## 🚀 Quick Start

### 1. Install the Extension

```bash
pi install npm:pi-high-availability
```

### 2. Check Status

```bash
/ha
```

### 3. Configure Your First Group

Use `/ha-group` to create a failover group with an ordered list of model IDs:

```
/ha-group default anthropic/claude-3-5-sonnet google-gemini-cli/gemini-1.5-pro openai/gpt-4o
```

This creates (or updates) a group named `default`, sets it as the active group, and configures the failover priority left-to-right.

## 💬 Commands

### `/ha`
Show current HA status: active group, all groups with their model entries, credentials per provider, and any currently exhausted items.

```
/ha
```

### `/ha-group <name> <model-id1> [model-id2 ...]`
Create or update a failover group. Sets the group as active and default immediately.

```
/ha-group fast anthropic/claude-3-5-sonnet openai/gpt-4o
/ha-group fallback google-gemini-cli/gemini-1.5-pro
```

Model IDs use the `provider/model-id` format. Provider-only entries (e.g., `anthropic`) are also valid and resolve to any available model for that provider.

### `/ha-rename <provider> <old-name> <new-name>`
Rename a stored credential for a provider.

```
/ha-rename anthropic primary work-account
/ha-rename anthropic backup-1 personal-account
```

### `/ha-activate <provider> <name>`
Manually activate a specific credential for a provider, writing it to `auth.json` immediately. Useful for switching accounts without triggering a failover.

```
/ha-activate anthropic personal-account
/ha-activate google-gemini-cli backup-1
```

### `/ha-clear [provider] [name|current]`
Remove stored credentials from `ha.json`. Useful for purging stale or burned tokens. Also clears any exhaustion state for the removed credentials.

```
/ha-clear                          # Clear ALL credentials for all providers
/ha-clear openai-codex             # Clear all credentials for a provider
/ha-clear openai-codex backup-1    # Clear a specific credential by name
/ha-clear openai-codex current     # Clear whichever credential is currently active
```

After clearing, run `/login` to re-authenticate and the extension will pick up the fresh token automatically.

## 🔍 How Failover Works

### The Failover Chain
When a quota or capacity error is detected:
1.  **Try Next Account** *(only for `next_key_then_provider` action)*: The extension looks for another credential for the *same* provider (e.g., your second Google account).
2.  **Mark Exhausted**: The current account is marked as exhausted and won't be used again until its cooldown expires.
3.  **Switch Provider**: If all accounts for that provider are exhausted (or the action is `next_provider`), the extension looks at the **Active Group** and switches to the next provider/model in the list.
4.  **Automatic Retry**: Pi automatically resends your last message using the new provider, making the transition transparent.

### Error Detection
The extension detects:
*   **Quota Errors**: HTTP 429, "rate limit", "insufficient quota", etc.
*   **Capacity Errors**: "No capacity available", "Engine Overloaded", etc.

## ⚙️ Configuration Guide (`ha.json`)

While you can use slash commands for most tasks, you can also manually edit `~/.pi/agent/ha.json`.

> ⚠️ **`ha.json` contains plaintext credentials.** Add it to your `.gitignore` and never commit or share it:
> ```
> echo 'ha.json' >> ~/.gitignore_global
> ```



```json
{
  "groups": {
    "pro": {
      "name": "Professional Tier",
      "entries": [
        { "id": "anthropic/claude-3-5-sonnet" },
        { "id": "google-gemini-cli/gemini-1.5-pro", "cooldownMs": 1800000 }
      ]
    }
  },
  "defaultGroup": "pro",
  "defaultCooldownMs": 3600000,
  "errorHandling": {
    "capacityErrorAction": "next_provider",
    "quotaErrorAction": "next_key_then_provider",
    "retryTimeoutMs": 300000
  },
  "credentials": {
    "anthropic": {
      "primary": { "type": "oauth", "refresh": "...", "access": "..." },
      "backup-1": { "type": "api_key", "key": "..." }
    }
  }
}
```

### Error Handling Configuration

The `errorHandling` section in `ha.json` lets you customize how the extension responds to different error types:

| Setting | Description | Default |
|---------|-------------|---------|
| `capacityErrorAction` | Action when provider has no capacity (affects all accounts) | `next_key_then_provider` |
| `quotaErrorAction` | Action when account hits rate limit (may not affect other accounts) | `next_key_then_provider` |
| `retryTimeoutMs` | How long to wait before retrying (in milliseconds) | `300000` (5 minutes) |

#### Understanding the Error Types

**Capacity Errors** occur when a provider's servers are overloaded. Examples:
- "No capacity available for this model"
- "Engine overloaded"
- "Service temporarily unavailable"

These errors affect the provider's infrastructure, so switching to a different account for the same provider typically won't help. Recommended action: `next_provider` or `retry`.

**Quota Errors** occur when an account exceeds its limits. Examples:
- "Rate limit exceeded (429)"
- "Insufficient quota"
- "Daily limit reached"

These errors are per-account, so switching to another OAuth entry or API key for the same provider may solve the problem. Recommended action: `next_key_then_provider` (default) or `next_provider` if you don't have backup accounts.

#### Available Actions

The following actions can be configured for both `capacityErrorAction` and `quotaErrorAction`:

| Action | Description |
|--------|-------------|
| `stop` | Stop the process and display the error |
| `retry` | Wait for `retryTimeoutMs` milliseconds, then retry the same request |
| `next_provider` | Immediately switch to the next provider in the current group |
| `next_key_then_provider` | Try the next account/key for the current provider, then move to next provider if all exhausted (default) |

**Note:** For capacity errors, `next_key_then_provider` is often not helpful since all accounts for the same provider typically share the same capacity pool. Use `next_provider` or `retry` for capacity errors instead.

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR on GitHub.

## 🙏 Credits

Built for the [pi coding agent](https://github.com/mariozechner/pi) community.
