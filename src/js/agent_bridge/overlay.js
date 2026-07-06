/**
 * Full-screen blue gradient overlay shown while an MCP agent is actively
 * driving the Configurator, so it is unmistakable that the app is being
 * operated by an AI agent rather than the user. Pure DOM (no Vue) so it works
 * regardless of the active tab and sits above every dialog.
 */
let overlayEl = null;

function ensureOverlay(label) {
    if (overlayEl) {
        return overlayEl;
    }

    if (!document.getElementById("agent-bridge-overlay-style")) {
        const style = document.createElement("style");
        style.id = "agent-bridge-overlay-style";
        style.textContent = `
@keyframes agentBridgePulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 0.85; }
}
#agent-bridge-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s ease;
    background:
        radial-gradient(circle at 50% 0%, rgba(56, 152, 255, 0.30), transparent 60%),
        linear-gradient(160deg, rgba(20, 110, 240, 0.28) 0%, rgba(10, 60, 180, 0.14) 45%, rgba(56, 152, 255, 0.30) 100%);
    box-shadow: inset 0 0 0 4px rgba(56, 152, 255, 0.9), inset 0 0 120px 20px rgba(56, 152, 255, 0.55);
    animation: agentBridgePulse 2s ease-in-out infinite;
}
#agent-bridge-overlay.is-visible { opacity: 1; }
#agent-bridge-overlay .agent-bridge-overlay__badge {
    position: absolute;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 18px;
    border-radius: 999px;
    background: rgba(10, 60, 180, 0.92);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.02em;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
    white-space: nowrap;
}
#agent-bridge-overlay .agent-bridge-overlay__dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #7ec8ff;
    box-shadow: 0 0 8px 2px rgba(126, 200, 255, 0.9);
}`;
        document.head.appendChild(style);
    }

    const el = document.createElement("div");
    el.id = "agent-bridge-overlay";
    el.setAttribute("aria-hidden", "true");
    const badge = document.createElement("div");
    badge.className = "agent-bridge-overlay__badge";
    const dot = document.createElement("span");
    dot.className = "agent-bridge-overlay__dot";
    const text = document.createElement("span");
    text.className = "agent-bridge-overlay__text";
    text.textContent = label;
    badge.append(dot, text);
    el.appendChild(badge);
    document.body.appendChild(el);
    overlayEl = el;
    return el;
}

export function showAgentOverlay(label) {
    const el = ensureOverlay(label);
    const text = el.querySelector(".agent-bridge-overlay__text");
    if (text && label) {
        text.textContent = label;
    }
    // force reflow so the opacity transition runs even right after creation
    void el.offsetWidth;
    el.classList.add("is-visible");
}

export function hideAgentOverlay() {
    overlayEl?.classList.remove("is-visible");
}
