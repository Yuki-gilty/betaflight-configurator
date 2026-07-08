import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFC = {
    PIDS: [],
    ADVANCED_TUNING: {},
    RC_TUNING: {},
    FILTER_CONFIG: {},
    CONFIG: {},
    DATAFLASH: {},
};
const mockMSP = { promise: vi.fn() };
const mockCONFIGURATOR = { connectionValid: true };
const mockGUI = { active_tab: "setup" };
const mockSwitchTab = vi.fn();
const mockCrunch = vi.fn(() => new Uint8Array([1, 2]));
const mockDataflashRead = vi.fn();

vi.mock("../../../src/js/fc.js", () => ({ default: mockFC }));
vi.mock("../../../src/js/msp.js", () => ({ default: mockMSP }));
vi.mock("../../../src/js/data_storage.js", () => ({ default: mockCONFIGURATOR, API_VERSION_1_45: "1.45.0" }));
vi.mock("../../../src/js/gui.js", () => ({ default: mockGUI }));
vi.mock("../../../src/js/tab_switch.js", () => ({ switchTab: mockSwitchTab }));
vi.mock("../../../src/js/msp/MSPHelper.js", () => ({
    mspHelper: { crunch: mockCrunch, dataflashRead: mockDataflashRead },
}));
vi.mock("../../../src/components/sidebar/sidebar_items.js", () => ({
    sidebarItems: [
        { tab: "setup", i18n: "tabSetup" },
        { key: "pid_tuning", i18n: "tabPidTuning" },
    ],
}));

const { createHandlers } = await import("../../../src/js/agent_bridge/handlers.js");
const MSPCodes = (await import("../../../src/js/msp/MSPCodes.js")).default;

describe("agent bridge handlers", () => {
    let handlers;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCONFIGURATOR.connectionValid = true;
        mockGUI.active_tab = "setup";
        mockMSP.promise.mockResolvedValue({});
        mockFC.PIDS = [
            [40, 30, 20],
            [41, 31, 21],
            [42, 32, 0],
            [50, 75, 75],
        ];
        mockFC.TUNING_SLIDERS = {
            slider_pids_mode: 2,
            slider_master_multiplier: 100,
            slider_d_gain: 100,
            slider_gyro_filter: 1,
            slider_gyro_filter_multiplier: 100,
            slider_dterm_filter: 1,
            slider_dterm_filter_multiplier: 110,
        };
        mockFC.ADVANCED_TUNING = {
            feedforwardRoll: 100,
            feedforwardPitch: 101,
            feedforwardYaw: 102,
            dMaxRoll: 30,
            dMaxPitch: 31,
            dMaxYaw: 0,
            dMaxGain: 37,
            tpaMode: 0,
            tpaRate: 0.65,
            tpaBreakpoint: 1350,
            antiGravityGain: 80,
            antiGravityMode: 0,
            itermRelax: 1,
            itermRelaxType: 1,
            itermRelaxCutoff: 15,
            throttleBoost: 5,
            levelAngleLimit: 60,
        };
        mockFC.RC_TUNING = { roll_rate: 0.7, rcYawRate: 1.0, rates_type: 3 };
        mockFC.FILTER_CONFIG = { gyro_lowpass_hz: 250, dterm_lowpass_hz: 150, gyro_lowpass_type: 0 };
        mockFC.CONFIG = {
            flightControllerIdentifier: "BTFL",
            flightControllerVersion: "4.5.1",
            apiVersion: "1.46.0",
            craftName: "testquad",
            name: "",
            profile: 0,
            numProfiles: 4,
            rateProfile: 2,
            pidProfileNames: ["race day", "", "", ""],
            rateProfileNames: ["", "", "smooth", ""],
        };
        handlers = createHandlers();
    });

    it("get_status reports connection, firmware, profiles and active tab", async () => {
        const status = await handlers.get_status();
        expect(status).toEqual({
            fcConnected: true,
            firmware: "BTFL 4.5.1",
            apiVersion: "1.46.0",
            craftName: "testquad",
            activeTab: "setup",
            pidProfile: 1,
            rateProfile: 3,
        });
    });

    it("get_status works while disconnected", async () => {
        mockCONFIGURATOR.connectionValid = false;
        mockFC.CONFIG.flightControllerIdentifier = "";
        const status = await handlers.get_status();
        expect(status.fcConnected).toBe(false);
        expect(status.firmware).toBeNull();
    });

    it("list_tabs returns tab keys from sidebar items", async () => {
        await expect(handlers.list_tabs()).resolves.toEqual({ tabs: ["setup", "pid_tuning"] });
    });

    it("switch_tab calls switchTab with connected mode and throws on refusal", async () => {
        mockSwitchTab.mockReturnValueOnce(undefined);
        await expect(handlers.switch_tab({ tab: "pid_tuning" })).resolves.toEqual({ activeTab: "pid_tuning" });
        expect(mockSwitchTab).toHaveBeenCalledWith("pid_tuning", { mode: "connected" });

        mockSwitchTab.mockReturnValueOnce(false);
        await expect(handlers.switch_tab({ tab: "osd" })).rejects.toThrow(/could not switch/i);
    });

    it("get_pid_tuning refreshes from MSP and returns per-axis values", async () => {
        const result = await handlers.get_pid_tuning();
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_PID, false);
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_PID_ADVANCED, false);
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_SIMPLIFIED_TUNING, false);
        expect(result.pids.roll).toEqual({ P: 40, I: 30, D: 20, D_MAX: 30, FF: 100 });
        expect(result.pids.yaw).toEqual({ P: 42, I: 32, D: 0, D_MAX: 0, FF: 102 });
    });

    it("get_pid_tuning returns profile info, level settings and tuning sliders", async () => {
        const result = await handlers.get_pid_tuning();
        expect(result.profile).toEqual({
            pidProfile: 1,
            pidProfileName: "race day",
            numProfiles: 4,
            rateProfile: 3,
            rateProfileName: "smooth",
        });
        // Profile names are fetched via MSP2_GET_TEXT on API 1.45+
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP2_GET_TEXT, MSPCodes.PID_PROFILE_NAME);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP2_GET_TEXT, MSPCodes.RATE_PROFILE_NAME);
        expect(result.level).toEqual({
            angleStrength: 50,
            horizonStrength: 75,
            horizonTransition: 75,
            angleLimit: 60,
        });
        expect(result.sliders).toMatchObject({ slider_master_multiplier: 100, slider_d_gain: 100 });
        expect(result.sliders._labels.slider_pids_mode).toBe("RPY");
    });

    it("get_pid_tuning returns the full advanced tuning profile with decoded labels", async () => {
        const result = await handlers.get_pid_tuning();
        expect(result.advanced).toMatchObject({
            tpaMode: 0,
            tpaRate: 0.65,
            tpaBreakpoint: 1350,
            antiGravityGain: 80,
            itermRelax: 1,
            itermRelaxType: 1,
            itermRelaxCutoff: 15,
            throttleBoost: 5,
            dMaxGain: 37,
        });
        expect(result.advanced._labels).toEqual({
            antiGravityMode: "SMOOTH",
            itermRelax: "RP",
            itermRelaxType: "SETPOINT",
            tpaMode: "PD",
        });
    });

    it("set_pid_tuning updates only the requested terms and writes both MSP messages", async () => {
        const result = await handlers.set_pid_tuning({ roll: { P: 47 }, pitch: { D: 38, FF: 120 } });
        expect(mockFC.PIDS[0][0]).toBe(47);
        expect(mockFC.PIDS[0][1]).toBe(30); // untouched
        expect(mockFC.PIDS[1][2]).toBe(38);
        expect(mockFC.ADVANCED_TUNING.feedforwardPitch).toBe(120);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_PID);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_PID_ADVANCED);
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_SET_PID, expect.any(Uint8Array));
        expect(result.pids.roll.P).toBe(47);
    });

    it("set_pid_tuning touches only MSP_PID when no advanced changes (fewer round-trips)", async () => {
        await handlers.set_pid_tuning({ roll: { P: 47 } });
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_PID);
        expect(mockCrunch).not.toHaveBeenCalledWith(MSPCodes.MSP_SET_PID_ADVANCED);
        expect(mockMSP.promise).not.toHaveBeenCalledWith(MSPCodes.MSP_PID_ADVANCED, false);
        // 2 round-trips total: one read (MSP_PID) + one write (MSP_SET_PID)
        expect(mockMSP.promise).toHaveBeenCalledTimes(2);
    });

    it("set_pid_tuning touches only MSP_PID_ADVANCED when only FF or D_MAX changes", async () => {
        await handlers.set_pid_tuning({ yaw: { FF: 90 }, pitch: { D_MAX: 42 } });
        expect(mockFC.ADVANCED_TUNING.feedforwardYaw).toBe(90);
        expect(mockFC.ADVANCED_TUNING.dMaxPitch).toBe(42);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_PID_ADVANCED);
        expect(mockCrunch).not.toHaveBeenCalledWith(MSPCodes.MSP_SET_PID);
        expect(mockMSP.promise).not.toHaveBeenCalledWith(MSPCodes.MSP_PID, false);
        expect(mockMSP.promise).toHaveBeenCalledTimes(2);
    });

    it("set_advanced_tuning updates known keys via MSP_SET_PID_ADVANCED and rejects unknown keys", async () => {
        const result = await handlers.set_advanced_tuning({ values: { tpaRate: 0.5, throttleBoost: 7 } });
        expect(mockFC.ADVANCED_TUNING.tpaRate).toBe(0.5);
        expect(mockFC.ADVANCED_TUNING.throttleBoost).toBe(7);
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_PID_ADVANCED, false);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_PID_ADVANCED);
        expect(result.tpaRate).toBe(0.5);
        expect(result._labels.tpaMode).toBe("PD");

        await expect(handlers.set_advanced_tuning({ values: { nope: 1 } })).rejects.toThrow(/unknown parameter.*nope/i);
    });

    it("set_rates applies with a single read + write (no read-back)", async () => {
        await handlers.set_rates({ values: { roll_rate: 0.9 } });
        // MSP_RC_TUNING read once, MSP_SET_RC_TUNING written once
        expect(mockMSP.promise).toHaveBeenCalledTimes(2);
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_RC_TUNING, false);
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_SET_RC_TUNING, expect.any(Uint8Array));
    });

    it("set_rates updates known keys and rejects unknown keys", async () => {
        const result = await handlers.set_rates({ values: { roll_rate: 0.9 } });
        expect(mockFC.RC_TUNING.roll_rate).toBe(0.9);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_RC_TUNING);
        expect(result.roll_rate).toBe(0.9);

        await expect(handlers.set_rates({ values: { nope: 1 } })).rejects.toThrow(/unknown parameter.*nope/i);
    });

    it("set_filters updates known keys via MSP_SET_FILTER_CONFIG", async () => {
        const result = await handlers.set_filters({ values: { gyro_lowpass_hz: 100 } });
        expect(mockFC.FILTER_CONFIG.gyro_lowpass_hz).toBe(100);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_FILTER_CONFIG);
        expect(result.gyro_lowpass_hz).toBe(100);
    });

    it("get_filters and get_rates decode enum fields into _labels", async () => {
        const filters = await handlers.get_filters();
        expect(filters._labels.gyro_lowpass_type).toBe("PT1");
        const rates = await handlers.get_rates();
        expect(rates._labels.rates_type).toBe("ACTUAL");
    });

    it("get_filters includes the filter multiplier slider state", async () => {
        const filters = await handlers.get_filters();
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_SIMPLIFIED_TUNING, false);
        expect(filters._sliders).toEqual({
            gyro_filter_enabled: 1,
            gyro_filter_multiplier: 100,
            dterm_filter_enabled: 1,
            dterm_filter_multiplier: 110,
        });
    });

    it("save_to_flash sends MSP_EEPROM_WRITE", async () => {
        await expect(handlers.save_to_flash()).resolves.toEqual({ saved: true });
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_EEPROM_WRITE, false);
    });

    it("msp_command forwards raw payload and returns response bytes", async () => {
        const buffer = Uint8Array.from([9, 8, 7]).buffer;
        mockMSP.promise.mockResolvedValueOnce({ dataView: new DataView(buffer) });
        const result = await handlers.msp_command({ code: 112, data: [1, 2] });
        expect(mockMSP.promise).toHaveBeenCalledWith(112, expect.any(Uint8Array));
        expect(result).toEqual({ code: 112, response: [9, 8, 7] });
    });

    it("get_blackbox_info refreshes the dataflash summary", async () => {
        mockFC.DATAFLASH = { ready: true, supported: true, sectors: 128, totalSize: 8388608, usedSize: 123456 };
        const info = await handlers.get_blackbox_info();
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_DATAFLASH_SUMMARY, false);
        expect(info).toEqual({ ready: true, supported: true, sectors: 128, totalSize: 8388608, usedSize: 123456 });
    });

    it("read_dataflash_chunk returns base64-encoded bytes", async () => {
        mockDataflashRead.mockImplementationOnce((address, size, cb) => {
            cb(address, new DataView(Uint8Array.from([1, 2, 3]).buffer));
        });
        const result = await handlers.read_dataflash_chunk({ address: 0, size: 4096 });
        expect(result).toEqual({ address: 0, bytes: 3, base64: btoa("\x01\x02\x03") });
    });

    it("read_dataflash_chunk rejects when the read fails", async () => {
        mockDataflashRead.mockImplementationOnce((address, size, cb) => cb(address, null));
        await expect(handlers.read_dataflash_chunk({ address: 100, size: 4096 })).rejects.toThrow(/failed/i);
    });

    it("erase_blackbox sends MSP_DATAFLASH_ERASE", async () => {
        await expect(handlers.erase_blackbox()).resolves.toEqual({ erased: true });
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_DATAFLASH_ERASE, false);
    });

    it("write handlers reject when FC is not connected", async () => {
        mockCONFIGURATOR.connectionValid = false;
        await expect(handlers.get_pid_tuning()).rejects.toThrow(/not connected/i);
        await expect(handlers.set_rates({ values: { roll_rate: 1 } })).rejects.toThrow(/not connected/i);
        await expect(handlers.save_to_flash()).rejects.toThrow(/not connected/i);
    });
});
