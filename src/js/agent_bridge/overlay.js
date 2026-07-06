/**
 * Small top-right status badge that shows the MCP agent bridge state
 * (waiting / connected / operating) with a colored status dot. Pure DOM
 * (no Vue) so it works regardless of the active tab and sits above dialogs.
 * Presentation only: index.js decides the tone/text from the bridge state.
 */
let badgeEl = null;

function ensureBadge() {
    if (badgeEl) {
        return badgeEl;
    }

    if (!document.getElementById("agent-bridge-status-style")) {
        const style = document.createElement("style");
        style.id = "agent-bridge-status-style";
        style.textContent = `
@keyframes agentBridgeDotPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
}
#agent-bridge-status {
    position: fixed;
    top: 10px;
    right: 12px;
    z-index: 2147483000;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(24, 28, 36, 0.85);
    color: #e8edf6;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.01em;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
    opacity: 0;
    transition: opacity 0.15s ease;
}
#agent-bridge-status.is-visible { opacity: 1; }
#agent-bridge-status .agent-bridge-status__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #9ca3af;
    flex: none;
}
#agent-bridge-status[data-tone="connected"] .agent-bridge-status__dot {
    background: #22c55e;
    box-shadow: 0 0 6px 1px rgba(34, 197, 94, 0.7);
}
#agent-bridge-status[data-tone="active"] .agent-bridge-status__dot {
    background: #3898ff;
    box-shadow: 0 0 6px 1px rgba(56, 152, 255, 0.8);
    animation: agentBridgeDotPulse 1s ease-in-out infinite;
}`;
        document.head.appendChild(style);
    }

    const el = document.createElement("div");
    el.id = "agent-bridge-status";
    el.setAttribute("aria-live", "polite");
    const dot = document.createElement("span");
    dot.className = "agent-bridge-status__dot";
    const text = document.createElement("span");
    text.className = "agent-bridge-status__text";
    el.append(dot, text);
    document.body.appendChild(el);
    badgeEl = el;
    return el;
}

/**
 * @param {{visible: boolean, tone: "idle"|"connected"|"active", text: string}} status
 */
export function renderAgentStatus({ visible, tone, text }) {
    if (!visible) {
        badgeEl?.classList.remove("is-visible");
        return;
    }
    const el = ensureBadge();
    el.dataset.tone = tone;
    el.querySelector(".agent-bridge-status__text").textContent = text;
    // force reflow so the opacity transition runs even right after creation
    void el.offsetWidth;
    el.classList.add("is-visible");
}
