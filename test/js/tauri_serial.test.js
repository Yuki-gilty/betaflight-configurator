import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// The desktop (Tauri) port picker has no browser permission dialog as an escape
// hatch, so enumeration itself must surface every port a flight controller could
// be behind. These tests pin the port-visibility rules:
//   - every USB-type port is listed, known Betaflight VID/PID or not
//   - non-USB ports (Bluetooth, PCI, unknown) appear only with showAllSerialDevices
//   - macOS tty./cu. twins collapse to the cu. entry

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args) => invoke(...args) }));

vi.mock("../../src/js/gui", () => ({ default: { operating_system: "MacOS" } }));

const getConfig = vi.fn(() => ({ showAllSerialDevices: false }));
vi.mock("../../src/js/ConfigStorage", () => ({ get: (...args) => getConfig(...args) }));

vi.mock("../../src/js/protocols/devices.js", () => ({
    serialDevices: [{ vendorId: 1155, productId: 22336 }],
    vendorIdNames: { 1155: "STM Electronics" },
}));

const usbPort = (overrides = {}) => ({
    type: "USB",
    vid: "1155",
    pid: "22336",
    serial_number: "SN1",
    manufacturer: "Betaflight",
    product: "Betaflight FC",
    ...overrides,
});

let TauriSerial;
let protocol;

beforeEach(async () => {
    invoke.mockReset();
    invoke.mockResolvedValue({});
    getConfig.mockReset();
    getConfig.mockReturnValue({ showAllSerialDevices: false });
    ({ default: TauriSerial } = await import("../../src/js/protocols/TauriSerial.js"));
    protocol = new TauriSerial();
    protocol.stopDeviceMonitoring();
});

afterEach(() => {
    protocol.stopDeviceMonitoring();
});

describe("TauriSerial port visibility", () => {
    it("lists a known Betaflight VID/PID USB port with its friendly name", async () => {
        invoke.mockResolvedValue({ "/dev/cu.usbmodem0x660": usbPort() });

        const ports = await protocol.loadDevices();

        expect(ports).toHaveLength(1);
        expect(ports[0].path).toBe("/dev/cu.usbmodem0x660");
        expect(ports[0].displayName).toBe("Betaflight STM Electronics");
    });

    it("lists a USB port with unknown VID/PID (no whitelist lock-out on desktop)", async () => {
        invoke.mockResolvedValue({
            "/dev/cu.usbserial-0001": usbPort({ vid: "1027", pid: "24597", product: "FT231X USB UART" }),
        });

        const ports = await protocol.loadDevices();

        expect(ports).toHaveLength(1);
        expect(ports[0].path).toBe("/dev/cu.usbserial-0001");
        expect(ports[0].displayName).toBe("FT231X USB UART");
    });

    it("hides non-USB ports by default", async () => {
        invoke.mockResolvedValue({
            "/dev/cu.Bluetooth-Incoming-Port": { type: "Unknown", vid: "Unknown", pid: "Unknown" },
            "/dev/cu.usbmodem0x660": usbPort(),
        });

        const ports = await protocol.loadDevices();

        expect(ports.map((p) => p.path)).toEqual(["/dev/cu.usbmodem0x660"]);
    });

    it("shows non-USB ports when showAllSerialDevices is enabled", async () => {
        getConfig.mockReturnValue({ showAllSerialDevices: true });
        invoke.mockResolvedValue({
            "/dev/cu.Bluetooth-Incoming-Port": { type: "Unknown", vid: "Unknown", pid: "Unknown" },
        });

        const ports = await protocol.loadDevices();

        expect(ports.map((p) => p.path)).toEqual(["/dev/cu.Bluetooth-Incoming-Port"]);
    });

    it("collapses macOS tty./cu. twins to the cu. entry", async () => {
        invoke.mockResolvedValue({
            "/dev/tty.usbmodem0x660": usbPort(),
            "/dev/cu.usbmodem0x660": usbPort(),
        });

        const ports = await protocol.loadDevices();

        expect(ports.map((p) => p.path)).toEqual(["/dev/cu.usbmodem0x660"]);
    });

    it("emits addedDevice for a newly plugged-in unknown USB port", async () => {
        invoke.mockResolvedValue({});
        await protocol.loadDevices();

        const added = [];
        protocol.addEventListener("addedDevice", (e) => added.push(e.detail.path));

        invoke.mockResolvedValue({
            "/dev/cu.usbserial-0001": usbPort({ vid: "1027", pid: "24597", product: "FT231X USB UART" }),
        });
        await protocol.checkDeviceChanges();

        expect(added).toEqual(["/dev/cu.usbserial-0001"]);
    });

    it("requestPermissionDevice rescans honoring the show-all flag", async () => {
        invoke.mockResolvedValue({
            "/dev/cu.Bluetooth-Incoming-Port": { type: "Unknown", vid: "Unknown", pid: "Unknown" },
        });

        expect(await protocol.requestPermissionDevice(false)).toBeNull();

        const port = await protocol.requestPermissionDevice(true);
        expect(port?.path).toBe("/dev/cu.Bluetooth-Incoming-Port");
    });
});
