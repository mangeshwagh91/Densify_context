# Densify Context — Chrome Extension

> **Phase 2**: Browser extension that optimizes your LLM prompts directly on ChatGPT, Claude, Gemini, Perplexity, and more.

---

## Features

- **⚡ Inline Optimize Button** — A floating button appears when you focus any text input on supported LLM sites
- **📊 Token & Cost Savings** — See exactly how many tokens and dollars you save
- **🔄 One-Click Replace** — Swap your verbose prompt with the optimized version instantly
- **📋 Copy to Clipboard** — Copy the optimized prompt for use anywhere
- **🔒 100% Local** — No data ever leaves your browser. Zero API calls.
- **🌐 Works Offline** — Full functionality without internet

## Supported Sites

| Site | URL |
|------|-----|
| ChatGPT | chat.openai.com, chatgpt.com |
| Claude | claude.ai |
| Gemini | gemini.google.com |
| Perplexity | perplexity.ai |
| Poe | poe.com |
| Microsoft Copilot | copilot.microsoft.com |

The popup also works on **any page** — just paste your prompt manually.

## Installation (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `browser-extension/` folder from this project
5. The ⚡ icon appears in your toolbar — you're ready!

## How to Use

### Method 1: Inline Button (on supported sites)
1. Go to any supported LLM site (e.g., chatgpt.com)
2. Click on the text input area
3. A small ⚡ button appears at the top-right of the input
4. Type your verbose prompt, then click ⚡
5. An overlay shows the optimized version with savings
6. Click **Replace** to swap, or **Copy** to clipboard

### Method 2: Extension Popup (any page)
1. Click the Densify Context icon in the toolbar
2. Paste your prompt in the text area
3. Select your LLM model for cost estimation
4. Click **⚡ Optimize Prompt**
5. Review the optimized version and changes list
6. Click **Copy** or **Replace on Page**

### Method 3: Right-Click Context Menu
1. Select text on any page
2. Right-click → **Densify — Optimize selected text**

## File Structure

```
browser-extension/
├── manifest.json              # Chrome MV3 manifest
├── popup/
│   ├── popup.html             # Popup UI
│   ├── popup.css              # Dark-theme styles
│   └── popup.js               # Popup logic
├── content/
│   ├── content.js             # Content script (injected on LLM sites)
│   └── content.css            # Injected styles (dcx- prefixed)
├── background/
│   └── service-worker.js      # Background service worker
├── lib/
│   └── densify-engine.js      # Bundled optimization engine
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How It Works

1. **Content Script** (`content.js`) — Injected on supported LLM sites. Detects textareas and `contenteditable` elements, shows a floating ⚡ button, and displays an overlay with results.
2. **Popup** (`popup.html/js/css`) — Standalone optimization UI accessible from the toolbar icon. Works on any page.
3. **Engine** (`densify-engine.js`) — The Phase 1 optimization engine bundled as a single file. Loaded by both the content script and popup.
4. **Background Worker** (`service-worker.js`) — Handles extension lifecycle and context menu.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Optimize prompt (in popup) |
| `Escape` | Close overlay (on page) |

## Privacy

- ✅ No data sent to any server
- ✅ No analytics or tracking
- ✅ No cookies or storage (beyond Chrome's extension storage)
- ✅ Only `activeTab` permission required
- ✅ Works completely offline

## Adding More Sites

Edit `manifest.json` → `content_scripts` → `matches` to add more sites:

```json
"matches": [
  "https://your-site.com/*"
]
```

Then reload the extension in `chrome://extensions/`.
