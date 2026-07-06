import { describe, it, expect } from "vitest";
import { showAgentOverlay, hideAgentOverlay } from "../../../src/js/agent_bridge/overlay.js";

// The overlay is a module-level singleton (created once, reused), so these
// tests intentionally share it and run in order rather than resetting the DOM.
describe("agent bridge overlay", () => {
    it("injects a blue gradient overlay with a label and toggles visibility", () => {
        showAgentOverlay("AIエージェントが操作中です");

        const el = document.getElementById("agent-bridge-overlay");
        expect(el).not.toBeNull();
        expect(el.classList.contains("is-visible")).toBe(true);
        expect(el.querySelector(".agent-bridge-overlay__text").textContent).toBe("AIエージェントが操作中です");

        // the gradient styling is present so the screen reads as "covered in blue"
        const style = document.getElementById("agent-bridge-overlay-style");
        expect(style.textContent).toMatch(/linear-gradient/);
        expect(style.textContent).toMatch(/rgba\(56, 152, 255/);

        hideAgentOverlay();
        expect(el.classList.contains("is-visible")).toBe(false);
    });

    it("reuses the same overlay element across calls", () => {
        showAgentOverlay("A");
        showAgentOverlay("B");
        expect(document.querySelectorAll("#agent-bridge-overlay")).toHaveLength(1);
        expect(document.querySelector(".agent-bridge-overlay__text").textContent).toBe("B");
    });
});
