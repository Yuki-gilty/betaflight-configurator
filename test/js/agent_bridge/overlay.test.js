import { describe, it, expect } from "vitest";
import { renderAgentStatus } from "../../../src/js/agent_bridge/overlay.js";

// The status badge is a module-level singleton (created once, reused), so these
// tests intentionally share it and run in order rather than resetting the DOM.
describe("agent bridge status badge", () => {
    it("renders a small top-right badge with a status dot and toggles visibility", () => {
        renderAgentStatus({ visible: true, tone: "connected", text: "接続中" });

        const el = document.getElementById("agent-bridge-status");
        expect(el).not.toBeNull();
        expect(el.classList.contains("is-visible")).toBe(true);
        expect(el.dataset.tone).toBe("connected");
        expect(el.querySelector(".agent-bridge-status__dot")).not.toBeNull();
        expect(el.querySelector(".agent-bridge-status__text").textContent).toBe("接続中");

        // positioned top-right and NOT a full-screen frame
        const style = document.getElementById("agent-bridge-status-style");
        expect(style.textContent).toMatch(/position: fixed/);
        expect(style.textContent).toMatch(/right: 12px/);
        expect(style.textContent).not.toMatch(/inset: 0/);
    });

    it("updates tone/text and hides when not visible", () => {
        renderAgentStatus({ visible: true, tone: "active", text: "操作中…" });
        const el = document.getElementById("agent-bridge-status");
        expect(el.dataset.tone).toBe("active");
        expect(el.querySelector(".agent-bridge-status__text").textContent).toBe("操作中…");

        renderAgentStatus({ visible: false, tone: "idle", text: "待機中" });
        expect(el.classList.contains("is-visible")).toBe(false);
        expect(document.querySelectorAll("#agent-bridge-status")).toHaveLength(1);
    });
});
