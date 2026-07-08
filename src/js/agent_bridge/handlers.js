import semver from "semver";
import FC from "../fc.js";
import MSP from "../msp.js";
import MSPCodes from "../msp/MSPCodes.js";
import { mspHelper } from "../msp/MSPHelper.js";
import CONFIGURATOR, { API_VERSION_1_45 } from "../data_storage.js";
import GUI from "../gui.js";
import { switchTab } from "../tab_switch.js";
import { sidebarItems } from "../../components/sidebar/sidebar_items.js";

const AXES = [
    ["roll", 0, "feedforwardRoll", "dMaxRoll"],
    ["pitch", 1, "feedforwardPitch", "dMaxPitch"],
    ["yaw", 2, "feedforwardYaw", "dMaxYaw"],
];
const PID_TERMS = [
    ["P", 0],
    ["I", 1],
    ["D", 2],
];

// Decode raw enum numbers into a read-only `_labels` companion object so
// consumers don't have to guess what the values mean. `_labels` never exists
// on the FC.* target objects, so set_* key validation is unaffected.
const FILTER_TYPE_LABELS = { 0: "PT1", 1: "BIQUAD", 2: "PT2", 3: "PT3" };
const ADVANCED_TUNING_ENUMS = {
    antiGravityMode: { 0: "SMOOTH", 1: "STEP" },
    itermRelax: { 0: "OFF", 1: "RP", 2: "RPY", 3: "RP_INC", 4: "RPY_INC" },
    itermRelaxType: { 0: "GYRO", 1: "SETPOINT" },
    feedforward_averaging: { 0: "OFF", 1: "2_POINT", 2: "3_POINT", 3: "4_POINT" },
    tpaMode: { 0: "PD", 1: "D" },
};
const FILTER_ENUMS = {
    gyro_lowpass_type: FILTER_TYPE_LABELS,
    gyro_lowpass2_type: FILTER_TYPE_LABELS,
    dterm_lowpass_type: FILTER_TYPE_LABELS,
    dterm_lowpass2_type: FILTER_TYPE_LABELS,
};
const RATES_ENUMS = {
    rates_type: { 0: "BETAFLIGHT", 1: "RACEFLIGHT", 2: "KISS", 3: "ACTUAL", 4: "QUICK" },
    throttleLimitType: { 0: "OFF", 1: "SCALE", 2: "CLIP" },
};
const SLIDER_ENUMS = {
    slider_pids_mode: { 0: "OFF", 1: "RP", 2: "RPY" },
};

function withLabels(values, enums) {
    const labels = {};
    for (const [key, map] of Object.entries(enums)) {
        if (values[key] !== undefined && map[values[key]] !== undefined) {
            labels[key] = map[values[key]];
        }
    }
    return { ...values, _labels: labels };
}

function requireFc() {
    if (!CONFIGURATOR.connectionValid) {
        throw new Error("FC not connected. Ask the user to connect the flight controller in the Configurator first.");
    }
}

// Tuning snapshot: per-axis PID terms, Angle/Horizon (level) settings and the
// whole advanced-tuning profile (TPA, anti-gravity, I-term relax, D-max,
// feedforward details, ...). The MSP messages are refreshed by the callers.
function pidSnapshot() {
    const pids = {};
    for (const [axis, index, ffKey, dMaxKey] of AXES) {
        pids[axis] = {
            P: FC.PIDS[index][0],
            I: FC.PIDS[index][1],
            D: FC.PIDS[index][2],
            D_MAX: FC.ADVANCED_TUNING[dMaxKey],
            FF: FC.ADVANCED_TUNING[ffKey],
        };
    }
    return {
        pids,
        level: {
            angleStrength: FC.PIDS[3][0],
            horizonStrength: FC.PIDS[3][1],
            horizonTransition: FC.PIDS[3][2],
            angleLimit: FC.ADVANCED_TUNING.levelAngleLimit,
        },
        advanced: withLabels({ ...FC.ADVANCED_TUNING }, ADVANCED_TUNING_ENUMS),
    };
}

function profileSnapshot() {
    const { profile, numProfiles, rateProfile, pidProfileNames, rateProfileNames } = FC.CONFIG;
    return {
        pidProfile: profile + 1,
        pidProfileName: pidProfileNames?.[profile] || null,
        numProfiles: numProfiles ?? null,
        rateProfile: rateProfile !== undefined ? rateProfile + 1 : null,
        rateProfileName: rateProfileNames?.[rateProfile] || null,
    };
}

async function refreshPids() {
    // The MSP layer matches responses by code and supports multiple in-flight
    // requests, so send the reads concurrently instead of paying round-trips.
    await Promise.all([
        MSP.promise(MSPCodes.MSP_PID, false),
        MSP.promise(MSPCodes.MSP_PID_ADVANCED, false),
        MSP.promise(MSPCodes.MSP_SIMPLIFIED_TUNING, false),
    ]);
    // Profile names come over MSP2_GET_TEXT (API 1.45+). Both queries share
    // one MSP code, so they must run sequentially, not concurrently.
    if (FC.CONFIG.apiVersion && semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_45)) {
        await MSP.promise(MSPCodes.MSP2_GET_TEXT, mspHelper.crunch(MSPCodes.MSP2_GET_TEXT, MSPCodes.PID_PROFILE_NAME));
        await MSP.promise(MSPCodes.MSP2_GET_TEXT, mspHelper.crunch(MSPCodes.MSP2_GET_TEXT, MSPCodes.RATE_PROFILE_NAME));
    }
}

// Shared read-modify-write cycle for flat numeric sections (rates, filters).
// One read (to preserve fields the caller didn't specify) + one write.
// No post-write read-back: the write echoes what we already hold in memory,
// so re-reading only adds a serial round-trip of latency.
async function updateSection({ readCode, writeCode, getTarget, values, enums = {} }) {
    requireFc();
    await MSP.promise(readCode, false);
    const target = getTarget();
    const unknown = Object.keys(values ?? {}).filter((key) => !(key in target));
    if (unknown.length > 0) {
        throw new Error(
            `Unknown parameter(s): ${unknown.join(", ")}. Valid parameters: ${Object.keys(target).join(", ")}`,
        );
    }
    Object.assign(target, values);
    await MSP.promise(writeCode, mspHelper.crunch(writeCode));
    return withLabels({ ...getTarget() }, enums);
}

export function createHandlers() {
    return {
        async get_status() {
            const { flightControllerIdentifier, flightControllerVersion, apiVersion, craftName, name } = FC.CONFIG;
            return {
                fcConnected: CONFIGURATOR.connectionValid,
                firmware: flightControllerIdentifier
                    ? `${flightControllerIdentifier} ${flightControllerVersion}`
                    : null,
                apiVersion: apiVersion ?? null,
                craftName: craftName || name || null,
                activeTab: GUI.active_tab || null,
                pidProfile: CONFIGURATOR.connectionValid ? FC.CONFIG.profile + 1 : null,
                rateProfile:
                    CONFIGURATOR.connectionValid && FC.CONFIG.rateProfile !== undefined
                        ? FC.CONFIG.rateProfile + 1
                        : null,
            };
        },

        async list_tabs() {
            return { tabs: sidebarItems.map((item) => item.tab ?? item.key).filter(Boolean) };
        },

        async switch_tab({ tab }) {
            const mode = CONFIGURATOR.connectionValid ? "connected" : "disconnected";
            const refused = switchTab(tab, { mode }) === false;
            if (refused) {
                throw new Error(
                    `Could not switch to tab '${tab}' (tab is locked, already active, or not allowed right now).`,
                );
            }
            return { activeTab: tab };
        },

        async get_pid_tuning() {
            requireFc();
            await refreshPids();
            return {
                profile: profileSnapshot(),
                ...pidSnapshot(),
                sliders: withLabels({ ...FC.TUNING_SLIDERS }, SLIDER_ENUMS),
            };
        },

        async set_pid_tuning(params) {
            requireFc();
            // P/I/D live in MSP_PID; FF and D_MAX live in MSP_PID_ADVANCED. Only
            // touch the message(s) actually affected, and read just those (to
            // preserve the fields we aren't changing) — avoids extra round-trips.
            const axisChanges = AXES.map(([axis]) => params?.[axis]).filter(Boolean);
            const touchesPid = axisChanges.some((c) => PID_TERMS.some(([term]) => c[term] !== undefined));
            const touchesAdvanced = axisChanges.some((c) => c.FF !== undefined || c.D_MAX !== undefined);

            const reads = [];
            if (touchesPid) {
                reads.push(MSP.promise(MSPCodes.MSP_PID, false));
            }
            if (touchesAdvanced) {
                reads.push(MSP.promise(MSPCodes.MSP_PID_ADVANCED, false));
            }
            await Promise.all(reads);
            for (const [axis, index, ffKey, dMaxKey] of AXES) {
                const changes = params?.[axis];
                if (!changes) {
                    continue;
                }
                for (const [term, termIndex] of PID_TERMS) {
                    if (changes[term] !== undefined) {
                        FC.PIDS[index][termIndex] = changes[term];
                    }
                }
                if (changes.FF !== undefined) {
                    FC.ADVANCED_TUNING[ffKey] = changes.FF;
                }
                if (changes.D_MAX !== undefined) {
                    FC.ADVANCED_TUNING[dMaxKey] = changes.D_MAX;
                }
            }
            const writes = [];
            if (touchesPid) {
                writes.push(MSP.promise(MSPCodes.MSP_SET_PID, mspHelper.crunch(MSPCodes.MSP_SET_PID)));
            }
            if (touchesAdvanced) {
                writes.push(
                    MSP.promise(MSPCodes.MSP_SET_PID_ADVANCED, mspHelper.crunch(MSPCodes.MSP_SET_PID_ADVANCED)),
                );
            }
            await Promise.all(writes);
            return pidSnapshot();
        },

        async set_advanced_tuning({ values } = {}) {
            return updateSection({
                readCode: MSPCodes.MSP_PID_ADVANCED,
                writeCode: MSPCodes.MSP_SET_PID_ADVANCED,
                getTarget: () => FC.ADVANCED_TUNING,
                values,
                enums: ADVANCED_TUNING_ENUMS,
            });
        },

        async get_rates() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_RC_TUNING, false);
            return withLabels({ ...FC.RC_TUNING }, RATES_ENUMS);
        },

        async set_rates({ values } = {}) {
            return updateSection({
                readCode: MSPCodes.MSP_RC_TUNING,
                writeCode: MSPCodes.MSP_SET_RC_TUNING,
                getTarget: () => FC.RC_TUNING,
                values,
                enums: RATES_ENUMS,
            });
        },

        async get_filters() {
            requireFc();
            // MSP_SIMPLIFIED_TUNING carries the gyro/D-term filter slider state
            // shown at the top of the Filter Settings tab.
            await Promise.all([
                MSP.promise(MSPCodes.MSP_FILTER_CONFIG, false),
                MSP.promise(MSPCodes.MSP_SIMPLIFIED_TUNING, false),
            ]);
            const sliders = FC.TUNING_SLIDERS;
            return {
                ...withLabels({ ...FC.FILTER_CONFIG }, FILTER_ENUMS),
                _sliders: {
                    gyro_filter_enabled: sliders.slider_gyro_filter,
                    gyro_filter_multiplier: sliders.slider_gyro_filter_multiplier,
                    dterm_filter_enabled: sliders.slider_dterm_filter,
                    dterm_filter_multiplier: sliders.slider_dterm_filter_multiplier,
                },
            };
        },

        async set_filters({ values } = {}) {
            return updateSection({
                readCode: MSPCodes.MSP_FILTER_CONFIG,
                writeCode: MSPCodes.MSP_SET_FILTER_CONFIG,
                getTarget: () => FC.FILTER_CONFIG,
                values,
                enums: FILTER_ENUMS,
            });
        },

        async save_to_flash() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_EEPROM_WRITE, false);
            return { saved: true };
        },

        async get_blackbox_info() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_DATAFLASH_SUMMARY, false);
            return { ...FC.DATAFLASH };
        },

        async read_dataflash_chunk({ address, size } = {}) {
            requireFc();
            const dataView = await new Promise((resolve, reject) => {
                mspHelper.dataflashRead(address, size ?? 4096, (chunkAddress, chunk) => {
                    if (chunk === null) {
                        reject(new Error(`Dataflash read failed at address ${address}`));
                    } else {
                        resolve(chunk);
                    }
                });
            });
            const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return { address, bytes: bytes.length, base64: btoa(binary) };
        },

        async erase_blackbox() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_DATAFLASH_ERASE, false);
            return { erased: true };
        },

        async msp_command({ code, data } = {}) {
            requireFc();
            const payload = Array.isArray(data) && data.length > 0 ? Uint8Array.from(data) : false;
            const response = await MSP.promise(code, payload);
            const view = response?.dataView;
            const bytes = view ? Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) : [];
            return { code, response: bytes };
        },
    };
}
