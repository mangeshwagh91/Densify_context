# Densify Context — VS Code Extension

> **Phase 3**: VS Code extension that optimizes LLM prompts directly in your editor.

---

## Features

- **⚡ Optimize Prompt** — Select text → Ctrl+Shift+D → see a diff of original vs optimized
- **🔄 Optimize & Replace** — Instant inline replacement
- **💡 Show Suggestions** — Cherry-pick individual optimizations from a multi-select list
- **📊 Token Counter** — Live token count in the status bar when text is selected
- **📋 Right-Click Menu** — All commands in the editor context menu
- **⚙️ Configurable** — Choose LLM model, toggle filler removal, etc.
- **🔒 100% Local** — Zero network calls

## Installation

### Method 1: From Source (Development)

1. Copy the `vscode-extension/` folder to your VS Code extensions directory:
   - **Windows**: `%USERPROFILE%\.vscode\extensions\densify-context`
   - **macOS/Linux**: `~/.vscode/extensions/densify-context`
2. Restart VS Code
3. The ⚡ icon appears in the status bar

### Method 2: Package as VSIX

```bash
# Install vsce if you don't have it
npm install -g @vscode/vsce

# Navigate to the extension directory
cd vscode-extension

# Package the extension
vsce package

# Install the generated .vsix file
code --install-extension densify-context-1.0.0.vsix
```

### Method 3: Debug in VS Code

1. Open the `vscode-extension/` folder in VS Code
2. Press `F5` to launch a new Extension Development Host window
3. The extension is active in the new window

## How to Use

### 1. Optimize Prompt (Diff View)
1. Select text in any file
2. Open the Command Palette (`Ctrl+Shift+P`)
3. Run **"Densify: Optimize Prompt"** (or press `Ctrl+Shift+D`)
4. A diff view opens showing original vs. optimized
5. A notification shows token savings with "Replace Selection" and "Copy" buttons

### 2. Optimize & Replace
1. Select text
2. Right-click → **Densify: Optimize & Replace**
3. The selected text is replaced instantly with the optimized version

### 3. Show Suggestions
1. Select text
2. Run **"Densify: Show Suggestions"**
3. A multi-select QuickPick shows each suggestion with:
   - Severity icon (🔴 high, 🟡 medium, 🟢 low)
   - Original text → replacement
   - Tokens saved and confidence
4. Select which suggestions to apply, then confirm

### 4. Count Tokens
1. Select text (or the whole document is used if no selection)
2. Run **"Densify: Count Tokens"**
3. See the token count and estimated cost for your selected model

### 5. Status Bar
When you select text, the status bar shows `⚡ N tokens`. Click it to see full cost details.

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `Densify: Optimize Prompt` | `Ctrl+Shift+D` | Diff view with savings |
| `Densify: Optimize & Replace` | — | Inline replacement |
| `Densify: Show Suggestions` | — | Multi-select suggestions |
| `Densify: Count Tokens` | — | Token & cost counter |

## Configuration

Open Settings → search "Densify":

| Setting | Default | Description |
|---------|---------|-------------|
| `densify.model` | `gpt-4o` | LLM model for cost estimation |
| `densify.removeFiller` | `true` | Remove filler words |
| `densify.removeCeremony` | `true` | Remove greetings/closings |
| `densify.showStatusBar` | `true` | Show token count in status bar |

## File Structure

```
vscode-extension/
├── package.json       # Extension manifest
├── extension.js       # Main extension logic
├── lib/
│   └── densify-engine.js  # Bundled optimization engine
├── icons/
│   └── icon128.png
├── .vscodeignore
└── README.md
```

## Supported File Types

The extension works in **all** file types. Commands are available whenever text is selected. Particularly useful in:

- `.md` — Markdown files for LLM prompts
- `.txt` — Plain text prompt files
- `.py`, `.js`, etc. — Comments and docstrings
- `.prompt` — Custom prompt files

## Privacy

- ✅ Zero network calls
- ✅ All optimization runs locally in the VS Code process
- ✅ No telemetry, analytics, or data collection
- ✅ No external dependencies at runtime
